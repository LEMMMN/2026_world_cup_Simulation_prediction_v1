const DEFAULT_MIN_WEIGHT = 8;
const FACTOR_SHRINKAGE = 10;

// 精算校准使用时间衰减、回填降权和小样本收缩，避免短期赛果过拟合。
export function buildCalibrationProfile(reviews = [], options = {}) {
  const usable = reviews.filter(hasExpectedGoals);
  const newestTime = Math.max(...usable.map((review) => timestamp(review.kickoffAt || review.reviewedAt)), 0);
  const rows = usable.map((review) => ({ review, weight: calibrationWeight(review, newestTime) }));
  const effectiveWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const minimumWeight = safeNumber(options.minimumWeight, DEFAULT_MIN_WEIGHT);
  const shrinkage = effectiveWeight / Math.max(1, effectiveWeight + 18);
  const homeResidual = weightedAverage(rows, (review) => safeNumber(review.actual?.home) - safeNumber(review.expectedGoals?.home));
  const awayResidual = weightedAverage(rows, (review) => safeNumber(review.actual?.away) - safeNumber(review.expectedGoals?.away));

  return {
    version: 1,
    enabled: effectiveWeight >= minimumWeight,
    sampleCount: usable.length,
    prematchCount: usable.filter((review) => review.reviewMode !== "retrospective").length,
    retrospectiveCount: usable.filter((review) => review.reviewMode === "retrospective").length,
    effectiveWeight: round(effectiveWeight),
    shrinkage: round(shrinkage),
    goalAdjustments: {
      home: round(clamp(homeResidual * shrinkage, -0.35, 0.35)),
      away: round(clamp(awayResidual * shrinkage, -0.35, 0.35))
    },
    factorMultipliers: buildFactorMultipliers(rows),
    methodology: "时间衰减 + 历史回填二次降权 + 小样本收缩"
  };
}

export function applyExpectedGoalCalibration(homeExpected, awayExpected, calibration = {}) {
  if (!calibration?.enabled) return { home: homeExpected, away: awayExpected, applied: false };
  const deploymentScale = clamp(safeNumber(calibration.deploymentScale, 0.5), 0, 1);
  return {
    home: homeExpected + safeNumber(calibration.goalAdjustments?.home) * deploymentScale,
    away: awayExpected + safeNumber(calibration.goalAdjustments?.away) * deploymentScale,
    applied: deploymentScale > 0
  };
}

export function factorMultiplier(calibration, label) {
  if (!calibration?.enabled) return 1;
  const deploymentScale = clamp(safeNumber(calibration.deploymentScale, 0.5), 0, 1);
  const raw = safeNumber(calibration.factorMultipliers?.[label]?.multiplier, 1);
  return 1 + (raw - 1) * deploymentScale;
}

// 走步回测只使用每场比赛之前的样本，防止未来结果泄漏到校准参数。
export function runCalibrationBacktest(reviews = []) {
  const ordered = reviews.filter(hasExpectedGoals)
    .filter((review) => review.reviewMode !== "retrospective")
    .sort((left, right) => timestamp(left.kickoffAt) - timestamp(right.kickoffAt));
  const baseline = emptyMetrics();
  const calibrated = emptyMetrics();
  let testCount = 0;

  for (let index = 5; index < ordered.length; index += 1) {
    const review = ordered[index];
    const profile = buildCalibrationProfile(ordered.slice(0, index), { minimumWeight: 4 });
    const base = review.expectedGoals;
    const adjusted = applyExpectedGoalCalibration(base.home, base.away, { ...profile, deploymentScale: 0.5 });
    updateMetrics(baseline, base.home, base.away, review.actual);
    updateMetrics(calibrated, adjusted.home, adjusted.away, review.actual);
    testCount += 1;
  }

  const baseResult = finalizeMetrics(baseline, testCount);
  const calibratedResult = finalizeMetrics(calibrated, testCount);
  const enough = testCount >= 8;
  const improved = enough
    && calibratedResult.logLoss < baseResult.logLoss
    && calibratedResult.avgGoalError < baseResult.avgGoalError;
  return {
    method: "prematch-walk-forward",
    testCount,
    status: enough ? (improved ? "accepted" : "rejected") : "provisional",
    baseline: baseResult,
    calibrated: calibratedResult,
    deploymentScale: improved ? 1 : 0
  };
}

function buildFactorMultipliers(rows) {
  const stats = {};
  for (const { review, weight } of rows) {
    const expectedMargin = safeNumber(review.expectedGoals?.home) - safeNumber(review.expectedGoals?.away);
    const actualMargin = safeNumber(review.actual?.home) - safeNumber(review.actual?.away);
    const residual = actualMargin - expectedMargin;
    if (Math.abs(residual) < 0.15) continue;

    for (const factor of review.snapshotFactors || []) {
      const effect = safeNumber(factor.effect);
      if (Math.abs(effect) < 0.03) continue;
      stats[factor.label] ||= { weight: 0, alignment: 0, count: 0 };
      const signal = Math.sign(effect) * Math.sign(residual);
      const strength = Math.min(1, Math.abs(effect) / 2) * Math.min(1, Math.abs(residual) / 2);
      stats[factor.label].weight += weight * strength;
      stats[factor.label].alignment += signal * weight * strength;
      stats[factor.label].count += 1;
    }
  }

  const multipliers = Object.fromEntries(Object.entries(stats).map(([label, item]) => {
    const alignment = item.weight ? item.alignment / item.weight : 0;
    const shrinkage = item.weight / (item.weight + FACTOR_SHRINKAGE);
    return [label, {
      count: item.count,
      effectiveWeight: round(item.weight),
      alignment: round(alignment),
      multiplier: round(clamp(1 + alignment * 0.22 * shrinkage, 0.82, 1.18))
    }];
  }));
  // 精算压力按赛前盘口方向相对模型方向的增益单独估计，避免零盘口变化导致永远没有权重。
  const actuary = buildActuaryMultiplier(rows);
  if (actuary) multipliers["赔率精算压力"] = actuary;
  return multipliers;
}

function buildActuaryMultiplier(rows) {
  const usable = rows.filter(({ review }) => review.reviewMode !== "retrospective" && review.oddsActuarySnapshot?.implied && review.actual?.result);
  if (!usable.length) return null;
  let total = 0;
  let marketHits = 0;
  let modelHits = 0;
  for (const { review, weight } of usable) {
    const implied = review.oddsActuarySnapshot.implied;
    const marketResult = ["home", "draw", "away"].sort((left, right) => safeNumber(implied[right]) - safeNumber(implied[left]))[0];
    total += weight;
    if (marketResult === review.actual.result) marketHits += weight;
    if (review.predicted?.result === review.actual.result) modelHits += weight;
  }
  const marketRate = total ? marketHits / total : 0;
  const modelRate = total ? modelHits / total : 0;
  const alignment = marketRate - modelRate;
  const shrinkage = total / (total + 12);
  return {
    count: usable.length,
    effectiveWeight: round(total),
    alignment: round(alignment),
    marketResultRate: round(marketRate),
    modelResultRate: round(modelRate),
    multiplier: round(clamp(1 + alignment * 0.35 * shrinkage, 0.9, 1.15))
  };
}

function hasExpectedGoals(review) {
  return Number.isFinite(Number(review?.expectedGoals?.home))
    && Number.isFinite(Number(review?.expectedGoals?.away))
    && Number.isFinite(Number(review?.actual?.home))
    && Number.isFinite(Number(review?.actual?.away));
}

function calibrationWeight(review, newestTime) {
  const ageDays = Math.max(0, (newestTime - timestamp(review.kickoffAt || review.reviewedAt)) / 86400000);
  const recency = 0.5 ** (ageDays / 45);
  const base = clamp(safeNumber(review.sampleWeight, 1), 0.1, 1);
  const retrospectivePenalty = review.reviewMode === "retrospective" ? 0.35 : 1;
  return base * retrospectivePenalty * recency;
}

function weightedAverage(rows, selector) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return total ? rows.reduce((sum, row) => sum + selector(row.review) * row.weight, 0) / total : 0;
}

function emptyMetrics() {
  return { goalError: 0, logLoss: 0, resultHits: 0, top3Hits: 0 };
}

function updateMetrics(metrics, homeExpected, awayExpected, actual = {}) {
  const distribution = scoreDistribution(homeExpected, awayExpected);
  const actualHome = safeNumber(actual.home);
  const actualAway = safeNumber(actual.away);
  const actualLabel = `${actualHome}-${actualAway}`;
  const actualResult = resultOf(actualHome, actualAway);
  const actualRow = distribution.find((row) => row.label === actualLabel);
  metrics.goalError += Math.abs(actualHome - homeExpected) + Math.abs(actualAway - awayExpected);
  metrics.logLoss += -Math.log(Math.max(0.0001, actualRow?.probability || 0.0001));
  metrics.resultHits += distribution[0]?.result === actualResult ? 1 : 0;
  metrics.top3Hits += distribution.slice(0, 3).some((row) => row.label === actualLabel) ? 1 : 0;
}

function finalizeMetrics(metrics, count) {
  if (!count) return { avgGoalError: 0, logLoss: 0, resultRate: 0, top3Rate: 0 };
  return {
    avgGoalError: round(metrics.goalError / count),
    logLoss: round(metrics.logLoss / count),
    resultRate: round(metrics.resultHits / count),
    top3Rate: round(metrics.top3Hits / count)
  };
}

function scoreDistribution(homeExpected, awayExpected) {
  const rows = [];
  for (let home = 0; home <= 7; home += 1) {
    for (let away = 0; away <= 7; away += 1) {
      rows.push({
        home,
        away,
        label: `${home}-${away}`,
        result: resultOf(home, away),
        probability: poisson(home, homeExpected) * poisson(away, awayExpected)
      });
    }
  }
  return rows.sort((left, right) => right.probability - left.probability);
}

function poisson(goals, expected) {
  const lambda = clamp(safeNumber(expected, 1), 0.2, 5);
  return Math.exp(-lambda) * (lambda ** goals) / factorial(goals);
}

function factorial(value) {
  let result = 1;
  for (let index = 2; index <= value; index += 1) result *= index;
  return result;
}

function resultOf(home, away) {
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

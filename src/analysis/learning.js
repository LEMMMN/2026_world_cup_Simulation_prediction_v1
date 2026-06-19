import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";
import { buildCalibrationProfile, runCalibrationBacktest } from "./calibration.js";

// 学习模块：自动保存赛前预测，赛后采集公开摘要数据，归因误差并生成轻量校准参数。
export async function readLearningModel() {
  const learning = await readJson(CONFIG.learningFile, defaultLearning());
  return { ...defaultLearning().model, ...(learning.model || {}) };
}

export async function updatePredictionMemory({
  events,
  summaries,
  analyses,
  weatherByEvent = {},
  oddsMarkets = {},
  oddsActuary = {},
  climateContexts = {},
  squadRatings = {},
  geopoliticalRisks = {},
  teamForms = {},
  headToHeads = {},
  bracketOutlook = {},
  tacticalProfiles = {},
  news = [],
  forceReport = false
}) {
  const now = new Date().toISOString();
  const snapshots = await readJson(CONFIG.predictionSnapshotsFile, {});
  const learning = normalizeLearning(await readJson(CONFIG.learningFile, defaultLearning()));
  let snapshotCount = 0;
  let reviewCount = 0;
  let refreshedReviewCount = 0;
  let backfillCount = 0;

  for (const event of events) {
    const analysis = analyses[event.id];
    if (!analysis) continue;
    if (event.status?.state !== "post") {
      const saved = saveSnapshot(snapshots, event, analysis, now);
      if (saved) snapshotCount += 1;
    }
  }

  for (const event of events) {
    if (event.status?.state !== "post") continue;
    const existingReview = learning.reviews[event.id];
    if (existingReview && !needsReviewRefresh(existingReview)) continue;
    const prematchSnapshot = pickPrematchSnapshot(snapshots[event.id], event.date);
    const snapshot = upgradeSnapshotForReview(prematchSnapshot || buildBackfillSnapshot(event, analyses[event.id], now), analyses[event.id]);
    if (!snapshot) continue;
    if (snapshot.retrospective && !existingReview) backfillCount += 1;
    learning.reviews[event.id] = buildReview(event, summaries[event.id], snapshot, {
      weather: weatherByEvent[event.id],
      oddsMarket: oddsMarkets[event.id],
      oddsActuary: oddsActuary[event.id],
      climate: climateContexts[event.id],
      squadRatings: {
        home: squadRatings[event.homeTeamId] || null,
        away: squadRatings[event.awayTeamId] || null
      },
      politicalRisk: geopoliticalRisks.eventRisks?.[event.id],
      teamForms: {
        home: teamForms[event.homeTeamId] || null,
        away: teamForms[event.awayTeamId] || null
      },
      headToHead: headToHeads[event.id] || null,
      bracketPaths: {
        home: bracketOutlook.teamPaths?.[event.homeTeamId] || null,
        away: bracketOutlook.teamPaths?.[event.awayTeamId] || null
      },
      tacticalProfiles,
      news
    });
    if (existingReview) refreshedReviewCount += 1;
    else reviewCount += 1;
  }

  learning.model = buildLearningModel(Object.values(learning.reviews));
  learning.updatedAt = now;

  const shouldReport = forceReport || !learning.lastReportAt || Date.now() - new Date(learning.lastReportAt).getTime() >= CONFIG.learning.intervalMs;
  let report = null;
  if (shouldReport) {
    report = buildReport(learning, snapshotCount, reviewCount, refreshedReviewCount, backfillCount, now);
    learning.lastReportAt = now;
    await writeReport(report);
  }

  await writeJson(CONFIG.predictionSnapshotsFile, snapshots);
  await writeJson(CONFIG.learningFile, learning);
  return { snapshotCount, reviewCount, refreshedReviewCount, backfillCount, report, model: learning.model };
}

function upgradeSnapshotForReview(snapshot, analysis) {
  // 旧赛前快照保留原预测比分，同时补入新版三比分和战术因子，便于最近完赛继续被新版模型复盘。
  if (!snapshot || !analysis) return snapshot;
  return {
    ...snapshot,
    scorePredictions: snapshot.scorePredictions?.length ? snapshot.scorePredictions : analysis.scorePredictions || [],
    expectedGoals: snapshot.expectedGoals || analysis.expectedGoals,
    probabilities: snapshot.probabilities || analysis.probabilities,
    oddsActuary: snapshot.oddsActuary || analysis.oddsActuary || null,
    climate: snapshot.climate || compactClimate(analysis.climate),
    squadRatings: snapshot.squadRatings || compactSquadPair(analysis.squadRatings),
    tactics: snapshot.tactics || analysis.tactics || null,
    factors: mergeSnapshotFactors(snapshot.factors || [], analysis.factors || [])
  };
}

function mergeSnapshotFactors(snapshotFactors, analysisFactors) {
  const tacticalLabels = new Set(["教练风格", "阵型克制", "球员熟悉度", "赔率精算压力", "气候与地理适应", "主场与球迷压力", "小组积分与晋级铺路", "阵容年龄与近期发挥"]);
  const seen = new Set(snapshotFactors.map((item) => item.label));
  const tacticalFactors = analysisFactors.filter((item) => tacticalLabels.has(item.label) && !seen.has(item.label));
  return [...snapshotFactors, ...tacticalFactors];
}

function compactClimate(climate) {
  if (!climate) return null;
  const compactTeam = (team) => team ? {
    teamId: team.teamId,
    teamName: team.teamName,
    score: team.score,
    penalty: team.penalty,
    tempDelta: team.tempDelta,
    humidityDelta: team.humidityDelta,
    distanceKm: team.distanceKm,
    timeZoneDelta: team.timeZoneDelta,
    label: team.label
  } : null;
  return {
    venue: climate.venue,
    home: compactTeam(climate.home),
    away: compactTeam(climate.away),
    crowd: climate.crowd,
    advantage: climate.advantage,
    label: climate.label
  };
}

function compactSquadPair(pair) {
  const compact = (item) => item ? {
    teamId: item.teamId,
    teamName: item.teamName,
    teamScore: item.teamScore,
    playerScore: item.playerScore,
    formScore: item.formScore,
    averageAge: item.averageAge,
    playerCount: item.playerCount,
    topPlayers: (item.topPlayers || []).slice(0, 5).map((player) => ({ id: player.id, name: player.name, age: player.age, rating: player.rating, recentLabel: player.recentLabel }))
  } : null;
  return { home: compact(pair?.home), away: compact(pair?.away) };
}

function needsReviewRefresh(review) {
  // 新版复盘需要包含三比分概率、战术快照和精算快照；旧样本会自动重算，避免历史比赛停在旧归因里。
  return review.reviewVersion !== 5
    || !Array.isArray(review.scorePredictions)
    || !review.expectedGoals
    || typeof review.top3Hit !== "boolean"
    || typeof review.top5Hit !== "boolean"
    || !review.tacticalSnapshot
    || !Object.prototype.hasOwnProperty.call(review, "oddsActuarySnapshot")
    || !Object.prototype.hasOwnProperty.call(review, "climateSnapshot")
    || !Object.prototype.hasOwnProperty.call(review, "squadRatingsSnapshot");
}

function saveSnapshot(snapshots, event, analysis, capturedAt) {
  snapshots[event.id] ||= [];
  const latest = snapshots[event.id].at(-1);
  const changed = latest?.predictedScore?.label !== analysis.predictedScore?.label
    || latest?.scorePredictions?.length !== analysis.scorePredictions?.length
    || !latest?.climate
    || !latest?.squadRatings;
  const gapEnough = !latest || Date.now() - new Date(latest.capturedAt).getTime() >= CONFIG.learning.snapshotMinGapMs;
  if (!changed && !gapEnough) return false;
  snapshots[event.id].push({
    eventId: event.id,
    capturedAt,
    kickoffAt: event.date,
    teams: analysis.teams,
    predictedScore: analysis.predictedScore,
    scorePredictions: analysis.scorePredictions || [],
    expectedGoals: analysis.expectedGoals,
    probabilities: analysis.probabilities,
    oddsActuary: analysis.oddsActuary || null,
    climate: compactClimate(analysis.climate),
    squadRatings: compactSquadPair(analysis.squadRatings),
    tactics: analysis.tactics || null,
    factors: analysis.factors
  });
  snapshots[event.id] = snapshots[event.id].slice(-18);
  return true;
}

function pickPrematchSnapshot(items = [], kickoffAt) {
  return items
    .filter((item) => new Date(item.capturedAt).getTime() <= new Date(kickoffAt).getTime())
    .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0] || null;
}

function buildBackfillSnapshot(event, analysis, capturedAt) {
  // 历史完赛场没有赛前快照时，用当前模型做回放预测，并以较低权重进入学习。
  if (!analysis?.predictedScore || !isRecentCompleted(event.date)) return null;
  return {
    eventId: event.id,
    capturedAt,
    kickoffAt: event.date,
    teams: analysis.teams,
    predictedScore: analysis.predictedScore,
    scorePredictions: analysis.scorePredictions || [],
    expectedGoals: analysis.expectedGoals,
    probabilities: analysis.probabilities,
    oddsActuary: analysis.oddsActuary || null,
    climate: compactClimate(analysis.climate),
    squadRatings: compactSquadPair(analysis.squadRatings),
    tactics: analysis.tactics || null,
    factors: analysis.factors,
    retrospective: true,
    sampleWeight: clamp(safeNumber(CONFIG.learning.backfillSampleWeight, 0.55), 0.1, 1),
    source: "历史回填：无赛前快照时，用当前模型预测回放并自动归因"
  };
}

function isRecentCompleted(kickoffAt) {
  const ageMs = Date.now() - new Date(kickoffAt).getTime();
  const maxAgeMs = safeNumber(CONFIG.learning.backfillRecentDays, 30) * 24 * 60 * 60 * 1000;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
}

function buildReview(event, summary, snapshot, context) {
  const actualHome = safeNumber(event.score?.home);
  const actualAway = safeNumber(event.score?.away);
  const predictedHome = safeNumber(snapshot.predictedScore?.home);
  const predictedAway = safeNumber(snapshot.predictedScore?.away);
  const actual = {
    home: actualHome,
    away: actualAway,
    label: `${actualHome}-${actualAway}`,
    result: resultOf(actualHome, actualAway)
  };
  const predicted = {
    ...snapshot.predictedScore,
    home: predictedHome,
    away: predictedAway,
    label: `${predictedHome}-${predictedAway}`,
    result: resultOf(predictedHome, predictedAway)
  };
  const goalError = Math.abs(actual.home - predicted.home) + Math.abs(actual.away - predicted.away);
  const exactHit = actual.home === predicted.home && actual.away === predicted.away;
  const top3Hit = (snapshot.scorePredictions || []).slice(0, 3).some((item) => Number(item.home) === actual.home && Number(item.away) === actual.away);
  const top5Hit = (snapshot.scorePredictions || []).slice(0, 5).some((item) => Number(item.home) === actual.home && Number(item.away) === actual.away);
  const resultHit = actual.result === predicted.result;
  const evidence = collectPostMatchEvidence({ event, summary, snapshot, context, actual, predicted });
  const reasonDetails = explainMiss({ evidence, snapshot, actual, predicted, exactHit, top3Hit, top5Hit, resultHit, goalError });

  return {
    reviewVersion: 5,
    eventId: event.id,
    reviewedAt: new Date().toISOString(),
    kickoffAt: event.date,
    reviewMode: snapshot.retrospective ? "retrospective" : "prematch",
    sampleWeight: snapshot.sampleWeight || 1,
    retrospective: Boolean(snapshot.retrospective),
    source: snapshot.source || "赛前快照",
    teams: snapshot.teams,
    predicted,
    actual,
    exactHit,
    top3Hit,
    top5Hit,
    resultHit,
    goalError,
    expectedGoals: snapshot.expectedGoals || null,
    probabilities: snapshot.probabilities || null,
    snapshotFactors: snapshot.factors || [],
    scorePredictions: snapshot.scorePredictions || [],
    oddsActuarySnapshot: snapshot.oddsActuary || null,
    climateSnapshot: snapshot.climate || null,
    squadRatingsSnapshot: snapshot.squadRatings || null,
    tacticalSnapshot: snapshot.tactics || null,
    evidence,
    reasonDetails,
    reasons: reasonDetails.map((item) => item.text),
    reasonTags: reasonDetails.map((item) => item.tag)
  };
}

function collectPostMatchEvidence({ event, summary = {}, snapshot, context, actual, predicted }) {
  const goals = (summary.goals || []).map((item) => ({
    minute: item.minute,
    minuteNumber: minuteNumber(item.minute),
    teamId: item.teamId,
    teamName: item.teamName,
    text: item.text || item.shortText || item.label
  }));
  const cards = (summary.cards || []).map((item) => ({
    kind: item.kind,
    minute: item.minute,
    minuteNumber: minuteNumber(item.minute),
    teamId: item.teamId,
    teamName: item.teamName,
    text: item.text || item.shortText || item.label
  }));
  const starters = summarizeStarters(summary, event);
  const odds = summarizeOdds(context.oddsMarket);
  const actuary = summarizeActuary(context.oddsActuary, snapshot.oddsActuary);
  const matchNews = summarizeNews(event, summary, context.news);

  return {
    scoreDelta: {
      home: actual.home - predicted.home,
      away: actual.away - predicted.away,
      total: actual.home + actual.away - predicted.home - predicted.away,
      margin: actual.home - actual.away - (predicted.home - predicted.away)
    },
    goals,
    earlyGoals: goals.filter((item) => item.minuteNumber !== null && item.minuteNumber <= 20),
    lateGoals: goals.filter((item) => item.minuteNumber !== null && item.minuteNumber >= 75),
    cardStats: summarizeCards(cards),
    substitutionCount: summary.substitutions?.length || 0,
    starters,
    referee: {
      name: summary.referee?.name || "待公布",
      officials: summary.officials?.length || 0
    },
    weather: summarizeWeather(context.weather),
    odds,
    actuary,
    climate: summarizeClimate(context.climate || snapshot.climate),
    squadRatings: summarizeSquadRatings(context.squadRatings || snapshot.squadRatings),
    form: summarizeForms(context.teamForms),
    headToHead: summarizeHeadToHead(context.headToHead),
    bracketPaths: summarizeBracketPaths(context.bracketPaths),
    politicalRisk: context.politicalRisk || null,
    news: matchNews,
    sourceUrls: [summary.sourceUrl, context.weather?.sourceUrl].filter(Boolean),
    snapshotCapturedAt: snapshot.capturedAt
  };
}

function explainMiss({ evidence, snapshot, actual, predicted, exactHit, top3Hit, top5Hit, resultHit, goalError }) {
  const details = [];
  const push = (tag, text, weight = 1) => details.push({ tag, text, weight });
  if (exactHit) {
    push("exact-hit", "比分完全命中，保持当前权重观察。", 0);
    return details;
  }
  if (top3Hit) {
    push("top3-score-hit", "准确比分未命中首选，但已被前三比分方案覆盖，说明概率分布方向可保留。", 0.6);
  } else if (top5Hit) {
    push("top5-score-hit", "准确比分未命中前三，但已被五比分方案覆盖，说明扩展比分分布有效。", 0.5);
  }
  if (snapshot.retrospective) push("retrospective-backfill", "该场没有真实赛前快照，已作为历史回填样本低权重学习。", 0.4);

  if (!resultHit) push("result-miss", "胜平负方向未命中，说明基础强弱、战意或赔率权重需要重新校准。", 3);
  if (goalError >= 2) push("goal-error", `总进球误差为${goalError}，需要复查首发、红黄牌、天气和大小球线。`, 2);

  if (evidence.cardStats.redCards > 0) push("red-card", `赛后出现${evidence.cardStats.redCards}张红牌，红牌会显著改变比分走势。`, 3);
  if (evidence.cardStats.total >= 5) push("cards", `本场牌数较多（${evidence.cardStats.total}张），纪律和裁判尺度可能放大偏差。`, 2);
  if (evidence.earlyGoals.length) push("early-goal", `前20分钟出现${evidence.earlyGoals.length}个进球，早段进球会打乱原有节奏。`, 2);
  if (evidence.lateGoals.length) push("late-goal", `75分钟后出现${evidence.lateGoals.length}个进球，末段体能和换人影响较大。`, 1.5);

  const predictedTotal = predicted.home + predicted.away;
  const actualTotal = actual.home + actual.away;
  if (actualTotal > predictedTotal) push("total-under", "实际进球数高于预测，后续会适当上调开放比赛的总进球倾向。", 1.5);
  if (actualTotal < predictedTotal) push("total-over", "实际进球数低于预测，后续会适当降低谨慎比赛的总进球倾向。", 1.5);

  if (evidence.odds?.favorite && evidence.odds.favorite !== predicted.result && evidence.odds.favorite === actual.result) {
    push("odds-correct", "赔率市场方向比本模型更接近赛果，后续需要提高盘口信号权重。", 2);
  } else if (evidence.odds?.favorite && evidence.odds.favorite === predicted.result && !resultHit) {
    push("odds-miss", "赔率市场与本模型同向但一起偏离，说明本场存在赛后突发或低概率事件。", 1.5);
  }
  if (Number.isFinite(evidence.odds?.overUnder) && Math.abs(actualTotal - evidence.odds.overUnder) >= 1.5) {
    push("total-line-miss", `实际总进球${actualTotal}与大小球线${evidence.odds.overUnder}差距明显，需调整总进球模型。`, 1.5);
  }
  if (evidence.actuary?.bestForBook && !resultHit) {
    push("actuary-pressure", `庄家边际最高方向为${evidence.actuary.bestForBook}，与赛果/模型偏差有关，后续提高精算压力复盘权重。`, 1.8);
  }
  if (evidence.actuary?.movementLabel && evidence.actuary.volatility >= 0.02 && goalError >= 2) {
    push("odds-movement", `盘口变化较明显：${evidence.actuary.movementLabel}，比分误差需要结合10分钟赔率快照复盘。`, 1.6);
  }
  if (evidence.climate?.maxPenalty >= 0.28 && (!resultHit || goalError >= 2)) {
    push("climate-adaptation", `气候/时差适应差异较大（最高惩罚${evidence.climate.maxPenalty}），需提高异地环境权重。`, 1.5);
  }
  if (evidence.climate?.crowdGap >= 0.35 && !resultHit) {
    push("crowd-pressure", "现场球迷支持差距明显，主客场心理压力可能影响模型方向。", 1.3);
  }
  if (evidence.squadRatings?.scoreGap >= 6 && !resultHit) {
    push("squad-rating-miss", `双方阵容评分相差${evidence.squadRatings.scoreGap}分但赛果未按该方向展开，需复查年龄、首发和球员状态权重。`, 1.5);
  }

  if (evidence.starters.preMatchUnknown && evidence.starters.complete) {
    push("lineup-late", "赛前首发未完整发布，赛后首发已完整，阵容信息延迟可能导致预测偏差。", 1.5);
  }
  if (evidence.weather.severe) push("weather", `比赛日天气异常：${evidence.weather.label}，可能压低或改变节奏。`, 1.2);
  if (evidence.politicalRisk?.score > 0) push("political-risk", `存在政治/签证/旅行风险线索：${evidence.politicalRisk.level || "需关注"}。`, 1);
  if (evidence.bracketPaths.caution) push("bracket-incentive", "32强路径存在轮换/保守控风险，战意判断需要继续校正。", 1.2);
  if (hasTacticalFactors(snapshot) && (!resultHit || goalError >= 2)) {
    push("tactical-miss", "教练风格、阵型克制或球员熟悉度可能解释偏差，后续会提高战术匹配复盘权重。", 1.4);
  }
  if (evidence.news.length) push("post-news", `赛后/赛前相关新闻命中${evidence.news.length}条，需结合标题复盘阵容和突发因素。`, 1);

  const topFactors = (snapshot.factors || []).slice().sort((a, b) => Math.abs(safeNumber(b.effect)) - Math.abs(safeNumber(a.effect))).slice(0, 3);
  if (topFactors.length) push("factor-weight", `赛前主要权重：${topFactors.map((item) => `${item.label}(${safeNumber(item.effect)})`).join("、")}。`, 1);
  if (!details.length) push("unclear", "公开赛后数据暂未显示单一主因，将等待后续新闻和摘要补全后继续学习。", 0.5);

  return details.sort((a, b) => b.weight - a.weight);
}

function buildLearningModel(reviews) {
  const reviewed = reviews.filter(Boolean);
  if (!reviewed.length) return defaultLearning().model;
  const totalWeight = reviewed.reduce((sum, item) => sum + reviewWeight(item), 0);
  const exactHits = weightedAverage(reviewed.map((item) => item.exactHit ? 1 : 0), reviewed.map(reviewWeight));
  const top3Hits = weightedAverage(reviewed.map((item) => item.top3Hit ? 1 : 0), reviewed.map(reviewWeight));
  const top5Hits = weightedAverage(reviewed.map((item) => item.top5Hit ? 1 : 0), reviewed.map(reviewWeight));
  const resultHits = weightedAverage(reviewed.map((item) => item.resultHit ? 1 : 0), reviewed.map(reviewWeight));
  const homeBias = weightedAverage(reviewed.map((item) => item.actual.home - item.predicted.home), reviewed.map(reviewWeight));
  const awayBias = weightedAverage(reviewed.map((item) => item.actual.away - item.predicted.away), reviewed.map(reviewWeight));
  const totalBias = weightedAverage(reviewed.map((item) => item.actual.home + item.actual.away - item.predicted.home - item.predicted.away), reviewed.map(reviewWeight));
  const factorStats = buildFactorStats(reviewed);
  const reasonStats = buildReasonStats(reviewed);
  const sandboxBacktest = runCalibrationBacktest(reviewed);
  const calibration = {
    ...buildCalibrationProfile(reviewed),
    deploymentScale: sandboxBacktest.deploymentScale,
    validationStatus: sandboxBacktest.status
  };

  return {
    reviewCount: reviewed.length,
    prematchReviewCount: reviewed.filter((item) => item.reviewMode !== "retrospective").length,
    backfillReviewCount: reviewed.filter((item) => item.reviewMode === "retrospective").length,
    weightedReviewCount: round(totalWeight),
    exactRate: round(exactHits),
    top3Rate: round(top3Hits),
    top5Rate: round(top5Hits),
    resultRate: round(resultHits),
    avgGoalError: round(weightedAverage(reviewed.map((item) => item.goalError), reviewed.map(reviewWeight))),
    homeGoalBias: clamp(round(homeBias), -0.5, 0.5),
    awayGoalBias: clamp(round(awayBias), -0.5, 0.5),
    totalGoalBias: clamp(round(totalBias), -0.8, 0.8),
    factorReliability: factorStats,
    reasonStats,
    calibration,
    sandboxBacktest,
    correctionNotes: buildCorrectionNotes(reasonStats, totalBias, sandboxBacktest)
  };
}

function buildFactorStats(reviews) {
  const stats = {};
  for (const review of reviews) {
    const weight = reviewWeight(review);
    for (const factor of review.snapshotFactors || []) {
      stats[factor.label] ||= { count: 0, weightedCount: 0, misses: 0, weightedMisses: 0, avgEffect: 0 };
      stats[factor.label].count += 1;
      stats[factor.label].weightedCount += weight;
      stats[factor.label].avgEffect += safeNumber(factor.effect) * weight;
      if (!review.resultHit) {
        stats[factor.label].misses += 1;
        stats[factor.label].weightedMisses += weight;
      }
    }
  }
  return Object.fromEntries(Object.entries(stats).map(([label, item]) => [label, {
    count: item.count,
    weightedCount: round(item.weightedCount),
    missRate: round(item.weightedMisses / Math.max(0.01, item.weightedCount)),
    avgEffect: round(item.avgEffect / Math.max(0.01, item.weightedCount)),
    reliability: round(1 - item.weightedMisses / Math.max(0.01, item.weightedCount))
  }]));
}

function buildReasonStats(reviews) {
  const stats = {};
  for (const review of reviews) {
    const weight = reviewWeight(review);
    for (const detail of review.reasonDetails || []) {
      stats[detail.tag] ||= { count: 0, sampleWeight: 0, weight: 0, label: reasonLabel(detail.tag) };
      stats[detail.tag].count += 1;
      stats[detail.tag].sampleWeight += weight;
      stats[detail.tag].weight += safeNumber(detail.weight) * weight;
    }
  }
  return Object.fromEntries(Object.entries(stats)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 8)
    .map(([tag, item]) => [tag, { ...item, sampleWeight: round(item.sampleWeight), weight: round(item.weight) }]));
}

function buildCorrectionNotes(reasonStats, totalBias, sandboxBacktest) {
  const notes = [];
  if (sandboxBacktest?.status === "rejected") notes.push("走步回测未同时改善损失与进球误差，新校准参数暂不投入线上预测。");
  if (sandboxBacktest?.status === "provisional") notes.push("赛前留出样本不足，校准参数暂不投入线上预测。");
  if (totalBias >= 0.4) notes.push("近期实际总进球偏高，自动上调总进球倾向。");
  if (totalBias <= -0.4) notes.push("近期实际总进球偏低，自动下调总进球倾向。");
  if (reasonStats["odds-correct"]?.count) notes.push("赔率方向多次更接近实际，盘口信号权重需要提高。");
  if (reasonStats["actuary-pressure"]?.count || reasonStats["odds-movement"]?.count) notes.push("赔率精算压力已进入复盘，庄家边际、比分赔率和盘口变化权重需要继续校准。");
  if (reasonStats["lineup-late"]?.count) notes.push("首发发布延迟影响较多，临场阵容权重要提高。");
  if (reasonStats["red-card"]?.count || reasonStats.cards?.count) notes.push("红黄牌影响较多，纪律和裁判尺度权重需要提高。");
  if (reasonStats["tactical-miss"]?.count) notes.push("战术匹配偏差进入复盘，教练风格、阵型克制和球员关系权重需要继续校准。");
  if (reasonStats["top3-score-hit"]?.count) notes.push("部分比赛命中前三比分但未命中首选，后续优先优化比分排序。");
  if (reasonStats["top5-score-hit"]?.count) notes.push("部分比赛只被五比分范围覆盖，扩展比分分布有效但前三排序仍需优化。");
  if (reasonStats["climate-adaptation"]?.count || reasonStats["crowd-pressure"]?.count) notes.push("气候适应与球迷压力已进入复盘，需要继续校准异地比赛权重。");
  if (reasonStats["squad-rating-miss"]?.count) notes.push("阵容年龄和球员近期评分出现偏差，需要继续校准球员状态权重。");
  return notes.slice(0, 5);
}

function buildReport(learning, snapshotCount, reviewCount, refreshedReviewCount, backfillCount, now) {
  const reviews = Object.values(learning.reviews);
  const recent = reviews.slice(-12);
  return {
    generatedAt: now,
    intervalHours: CONFIG.learning.intervalMs / 60 / 60 / 1000,
    snapshotCount,
    newReviewCount: reviewCount,
    refreshedReviewCount,
    newBackfillCount: backfillCount,
    totalReviewed: reviews.length,
    model: learning.model,
    recent: recent.map((item) => ({
      eventId: item.eventId,
      reviewMode: item.reviewMode,
      sampleWeight: item.sampleWeight,
      teams: item.teams,
      predicted: item.predicted.label,
      scorePredictions: item.scorePredictions?.map((score) => `${score.label} ${score.percent || ""}`).slice(0, 3),
      oddsActuary: item.oddsActuarySnapshot ? {
        bestForBook: item.oddsActuarySnapshot.bestForBook?.label,
        movement: item.oddsActuarySnapshot.movement?.label,
        scoreImpact: item.oddsActuarySnapshot.scoreImpact?.label
      } : null,
      actual: item.actual.label,
      exactHit: item.exactHit,
      top3Hit: item.top3Hit,
      top5Hit: item.top5Hit,
      resultHit: item.resultHit,
      goalError: item.goalError,
      reasons: item.reasons,
      evidence: compactEvidence(item.evidence)
    }))
  };
}

async function writeReport(report) {
  await fs.mkdir(CONFIG.learningReportsDir, { recursive: true });
  const safeName = report.generatedAt.replace(/[:.]/g, "-");
  await fs.writeFile(path.join(CONFIG.learningReportsDir, `${safeName}.json`), JSON.stringify(report, null, 2), "utf8");
}

function summarizeCards(cards) {
  return {
    total: cards.length,
    yellowCards: cards.filter((item) => item.kind === "yellow-card").length,
    redCards: cards.filter((item) => item.kind === "red-card").length,
    teams: cards.reduce((acc, item) => {
      const key = item.teamId || item.teamName || "unknown";
      acc[key] ||= 0;
      acc[key] += 1;
      return acc;
    }, {})
  };
}

function summarizeStarters(summary, event) {
  const home = summary.starters?.find((item) => item.teamId === event.homeTeamId);
  const away = summary.starters?.find((item) => item.teamId === event.awayTeamId);
  const homeCount = home?.players?.length || 0;
  const awayCount = away?.players?.length || 0;
  return {
    homeCount,
    awayCount,
    complete: homeCount >= 11 && awayCount >= 11,
    preMatchUnknown: !homeCount || !awayCount,
    formations: {
      home: home?.formation || null,
      away: away?.formation || null
    }
  };
}

function summarizeWeather(weather) {
  if (!weather || weather.status !== "ok") return { label: "天气数据待补全", severe: false };
  const temp = safeNumber(weather.temperature);
  const rain = safeNumber(weather.precipitationProbability);
  const wind = safeNumber(weather.windSpeed);
  const notes = [];
  if (Number.isFinite(temp)) notes.push(`${temp}°C`);
  if (Number.isFinite(rain)) notes.push(`降水${rain}%`);
  if (Number.isFinite(wind)) notes.push(`风速${wind}km/h`);
  return {
    temperature: temp,
    precipitationProbability: rain,
    windSpeed: wind,
    severe: temp >= 30 || temp <= 8 || rain >= 65 || wind >= 28,
    label: notes.join("，") || "天气条件中性"
  };
}

function summarizeOdds(market) {
  const implied = market?.consensus?.implied || market?.primary?.implied;
  if (!implied) return null;
  const favorite = implied.home > implied.away && implied.home > implied.draw ? "home"
    : implied.away > implied.home && implied.away > implied.draw ? "away"
      : "draw";
  return {
    provider: market.primary?.provider || "境外市场",
    favorite,
    implied,
    overUnder: market.consensus?.overUnder || market.primary?.overUnder || null
  };
}

function summarizeActuary(contextActuary, snapshotActuary) {
  const actuary = snapshotActuary || contextActuary;
  if (!actuary?.available && !actuary?.bestForBook) return null;
  return {
    marketMargin: actuary.marketMargin,
    overround: actuary.overround,
    bestForBook: actuary.bestForBook?.label || null,
    publicLean: actuary.publicLean || null,
    movementLabel: actuary.movement?.label || null,
    volatility: safeNumber(actuary.volatility),
    scoreImpact: actuary.scoreImpact?.label || null,
    label: actuary.label || null
  };
}

function summarizeClimate(climate) {
  if (!climate) return null;
  const homePenalty = safeNumber(climate.home?.penalty);
  const awayPenalty = safeNumber(climate.away?.penalty);
  return {
    homePenalty,
    awayPenalty,
    maxPenalty: round(Math.max(homePenalty, awayPenalty)),
    adaptationGap: round(Math.abs(homePenalty - awayPenalty)),
    crowdGap: round(Math.abs(safeNumber(climate.crowd?.home) - safeNumber(climate.crowd?.away))),
    label: climate.label
  };
}

function summarizeSquadRatings(pair) {
  const home = safeNumber(pair?.home?.teamScore, 50);
  const away = safeNumber(pair?.away?.teamScore, 50);
  return {
    home,
    away,
    scoreGap: round(Math.abs(home - away)),
    stronger: home > away ? "home" : away > home ? "away" : "level",
    homeAverageAge: pair?.home?.averageAge,
    awayAverageAge: pair?.away?.averageAge
  };
}

function summarizeForms(teamForms) {
  const summarize = (item) => ({
    matches: item?.matches?.length || 0,
    points: item?.points || 0,
    goalDiff: item?.goalDiff || 0,
    label: item?.label || "近况待补全"
  });
  return {
    home: summarize(teamForms?.home),
    away: summarize(teamForms?.away)
  };
}

function summarizeHeadToHead(headToHead) {
  return {
    count: headToHead?.records?.length || 0,
    homeWins: headToHead?.homeWins || 0,
    awayWins: headToHead?.awayWins || 0,
    draws: headToHead?.draws || 0
  };
}

function summarizeBracketPaths(paths) {
  return {
    caution: Boolean(paths?.home?.incentive?.caution || paths?.away?.incentive?.caution),
    home: paths?.home?.incentive?.label || "路径待定",
    away: paths?.away?.incentive?.label || "路径待定"
  };
}

function summarizeNews(event, summary, news = []) {
  const teamNames = (event.competitors || []).map((item) => item.team?.name).filter(Boolean);
  const riskyWords = ["injury", "injured", "suspended", "lineup", "starter", "coach", "visa", "travel", "war", "conflict", "伤", "伤病", "停赛", "首发", "签证", "旅行", "战争", "冲突"];
  const allNews = [...(summary.matchNews || []), ...news];
  return allNews.filter((item) => {
    const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
    return teamNames.some((name) => text.includes(name.toLowerCase())) && riskyWords.some((word) => text.includes(word));
  }).slice(0, 6).map((item) => ({
    title: item.title,
    publishedAt: item.publishedAt,
    source: item.source,
    url: item.url
  }));
}

function compactEvidence(evidence) {
  return {
    scoreDelta: evidence.scoreDelta,
    cardStats: evidence.cardStats,
    earlyGoals: evidence.earlyGoals.length,
    lateGoals: evidence.lateGoals.length,
    starters: evidence.starters,
    weather: evidence.weather,
    odds: evidence.odds,
    actuary: evidence.actuary,
    climate: evidence.climate,
    squadRatings: evidence.squadRatings,
    newsCount: evidence.news.length
  };
}

function normalizeLearning(learning) {
  const base = defaultLearning();
  return {
    ...base,
    ...learning,
    reviews: learning.reviews || {},
    model: { ...base.model, ...(learning.model || {}) }
  };
}

function defaultLearning() {
  return {
    updatedAt: null,
    lastReportAt: null,
    reviews: {},
    model: {
      reviewCount: 0,
      prematchReviewCount: 0,
      backfillReviewCount: 0,
      weightedReviewCount: 0,
      exactRate: 0,
      top3Rate: 0,
      top5Rate: 0,
      resultRate: 0,
      avgGoalError: 0,
      homeGoalBias: 0,
      awayGoalBias: 0,
      totalGoalBias: 0,
      factorReliability: {},
      reasonStats: {},
      calibration: {
        version: 1,
        enabled: false,
        deploymentScale: 0,
        validationStatus: "provisional",
        goalAdjustments: { home: 0, away: 0 },
        factorMultipliers: {}
      },
      sandboxBacktest: {
        method: "prematch-walk-forward",
        testCount: 0,
        status: "provisional",
        deploymentScale: 0
      },
      correctionNotes: []
    }
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

function resultOf(home, away) {
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function minuteNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function reasonLabel(tag) {
  return {
    "retrospective-backfill": "历史回填样本",
    "top3-score-hit": "前三比分覆盖",
    "top5-score-hit": "前五比分覆盖",
    "result-miss": "胜平负方向偏差",
    "goal-error": "总进球误差",
    "red-card": "红牌影响",
    cards: "牌数偏多",
    "early-goal": "早段进球",
    "late-goal": "末段进球",
    "total-under": "实际进球偏高",
    "total-over": "实际进球偏低",
    "odds-correct": "赔率更接近",
    "odds-miss": "赔率共同偏离",
    "actuary-pressure": "精算压力偏差",
    "odds-movement": "盘口变化偏差",
    "climate-adaptation": "气候适应偏差",
    "crowd-pressure": "球迷压力偏差",
    "squad-rating-miss": "阵容评分偏差",
    "total-line-miss": "大小球线偏差",
    "lineup-late": "首发信息延迟",
    weather: "天气影响",
    "political-risk": "政治/旅行风险",
    "bracket-incentive": "路径战意偏差",
    "tactical-miss": "战术匹配偏差",
    "post-news": "新闻线索",
    "factor-weight": "赛前权重复盘",
    unclear: "原因待补全",
    "exact-hit": "完全命中"
  }[tag] || tag;
}

function average(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function hasTacticalFactors(snapshot) {
  return (snapshot.factors || []).some((item) => ["教练风格", "阵型克制", "球员熟悉度"].includes(item.label));
}

function weightedAverage(values, weights) {
  const pairs = values.map((value, index) => ({ value: Number(value), weight: safeNumber(weights[index], 1) }))
    .filter((item) => Number.isFinite(item.value) && item.weight > 0);
  const totalWeight = pairs.reduce((sum, item) => sum + item.weight, 0);
  return totalWeight ? pairs.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight : 0;
}

function reviewWeight(review) {
  return clamp(safeNumber(review.sampleWeight, review.reviewMode === "retrospective" ? 0.55 : 1), 0.1, 1);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

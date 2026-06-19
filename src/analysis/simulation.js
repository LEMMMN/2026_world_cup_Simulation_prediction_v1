const DEFAULT_ITERATIONS = 12000;

// 沙盘使用固定种子蒙特卡洛，同一场比赛在同一组输入下可重复验证。
export function simulateMatchScenarios({
  eventId,
  homeExpected,
  awayExpected,
  homeCardRisk = 0,
  awayCardRisk = 0,
  weatherMultiplier = 1,
  lineupKnown = false,
  iterations = DEFAULT_ITERATIONS
}) {
  const runCount = Math.max(2000, Math.round(safeNumber(iterations, DEFAULT_ITERATIONS)));
  const random = seededRandom(String(eventId || "world-cup"));
  const scenarioRates = buildScenarioRates({ homeCardRisk, awayCardRisk, weatherMultiplier, lineupKnown });
  const results = { home: 0, draw: 0, away: 0 };
  const scoreCounts = new Map();
  const totalCounts = new Map();
  const scenarioCounts = Object.fromEntries(Object.keys(scenarioRates).map((key) => [key, 0]));
  let homeGoalsTotal = 0;
  let awayGoalsTotal = 0;

  for (let index = 0; index < runCount; index += 1) {
    const scenario = pickScenario(random(), scenarioRates);
    const expected = scenarioExpectedGoals(scenario, homeExpected, awayExpected);
    const home = samplePoisson(expected.home, random);
    const away = samplePoisson(expected.away, random);
    const result = home > away ? "home" : away > home ? "away" : "draw";
    const label = `${home}-${away}`;
    const total = home + away;
    results[result] += 1;
    scoreCounts.set(label, (scoreCounts.get(label) || 0) + 1);
    totalCounts.set(total, (totalCounts.get(total) || 0) + 1);
    scenarioCounts[scenario] += 1;
    homeGoalsTotal += home;
    awayGoalsTotal += away;
  }

  return {
    version: 1,
    iterations: runCount,
    probabilities: mapRates(results, runCount),
    expectedGoals: {
      home: round(homeGoalsTotal / runCount),
      away: round(awayGoalsTotal / runCount)
    },
    topScores: Array.from(scoreCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([label, count]) => ({ label, probability: round(count / runCount), percent: percent(count / runCount) })),
    totalGoalsRange: {
      p10: quantileFromCounts(totalCounts, runCount, 0.1),
      p50: quantileFromCounts(totalCounts, runCount, 0.5),
      p90: quantileFromCounts(totalCounts, runCount, 0.9)
    },
    scenarios: Object.fromEntries(Object.entries(scenarioCounts).map(([key, count]) => [key, {
      label: scenarioLabel(key),
      probability: round(count / runCount)
    }])),
    uncertainty: round(1 - Math.max(...Object.values(results)) / runCount),
    note: "沙盘是风险分布而非确定结果，会随首发、天气和盘口刷新"
  };
}

function buildScenarioRates({ homeCardRisk, awayCardRisk, weatherMultiplier, lineupKnown }) {
  const lineupRisk = lineupKnown ? 0 : 0.025;
  const homeDisruption = clamp(0.035 + safeNumber(homeCardRisk) * 0.012 + lineupRisk, 0.03, 0.12);
  const awayDisruption = clamp(0.035 + safeNumber(awayCardRisk) * 0.012 + lineupRisk, 0.03, 0.12);
  const cautious = clamp(weatherMultiplier < 0.97 ? 0.12 : 0.06, 0.05, 0.15);
  const open = clamp(weatherMultiplier > 1.03 ? 0.12 : 0.07, 0.05, 0.15);
  const baseline = Math.max(0.45, 1 - homeDisruption - awayDisruption - cautious - open);
  const total = baseline + homeDisruption + awayDisruption + cautious + open;
  return {
    baseline: baseline / total,
    homeDisruption: homeDisruption / total,
    awayDisruption: awayDisruption / total,
    cautious: cautious / total,
    open: open / total
  };
}

function pickScenario(value, rates) {
  let cursor = 0;
  for (const [key, rate] of Object.entries(rates)) {
    cursor += rate;
    if (value <= cursor) return key;
  }
  return "baseline";
}

function scenarioExpectedGoals(scenario, home, away) {
  const base = { home: clamp(home, 0.2, 5), away: clamp(away, 0.2, 5) };
  if (scenario === "homeDisruption") return { home: base.home * 0.72, away: base.away * 1.16 };
  if (scenario === "awayDisruption") return { home: base.home * 1.16, away: base.away * 0.72 };
  if (scenario === "cautious") return { home: base.home * 0.8, away: base.away * 0.8 };
  if (scenario === "open") return { home: base.home * 1.22, away: base.away * 1.22 };
  return base;
}

function samplePoisson(expected, random) {
  const lambda = clamp(safeNumber(expected, 1), 0.05, 6);
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= Math.max(Number.EPSILON, random());
  } while (product > limit && count < 12);
  return count - 1;
}

function seededRandom(seed) {
  let state = hash(seed) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hash(value) {
  let result = 2166136261;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function quantileFromCounts(counts, total, quantile) {
  const target = total * quantile;
  let cumulative = 0;
  for (const [value, count] of Array.from(counts.entries()).sort((left, right) => left[0] - right[0])) {
    cumulative += count;
    if (cumulative >= target) return value;
  }
  return 0;
}

function mapRates(values, total) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value / total)]));
}

function scenarioLabel(key) {
  return {
    baseline: "常规赛事",
    homeDisruption: "主队阵容/纪律扰动",
    awayDisruption: "客队阵容/纪律扰动",
    cautious: "谨慎低节奏",
    open: "开放对攻"
  }[key] || key;
}

function percent(value) {
  return `${Math.round(safeNumber(value) * 1000) / 10}%`;
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

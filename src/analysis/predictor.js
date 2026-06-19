import { analyzeTacticalMatchup } from "./tactics.js";
import { enrichScorePredictionsWithActuary } from "./actuary.js";
import { applyExpectedGoalCalibration, factorMultiplier } from "./calibration.js";
import { simulateMatchScenarios } from "./simulation.js";

// 预测模块只做学习用途的启发式分析，不代表投注建议或确定结果。
export function buildAnalyses({ events, teams, summaries, rosters, weatherByEvent, news, bracketOutlook, geopoliticalRisks, oddsMarkets, oddsActuary, climateContexts, squadRatings, tacticalProfiles, learningModel }) {
  const teamMap = Object.fromEntries(teams.map((team) => [team.id, team]));
  const refereeStats = buildRefereeStats(summaries);
  const teamCards = buildTeamCardStats(summaries);
  const standings = buildGroupStandings(events);

  return Object.fromEntries(events.map((event) => {
    const summary = summaries[event.id] || {};
    const home = teamMap[event.homeTeamId] || event.competitors?.find((item) => item.homeAway === "home")?.team;
    const away = teamMap[event.awayTeamId] || event.competitors?.find((item) => item.homeAway === "away")?.team;
    const analysis = analyzeMatch({ event, home, away, summary, rosters, weather: weatherByEvent[event.id], news, refereeStats, teamCards, standings, bracketOutlook, geopoliticalRisks, oddsMarket: oddsMarkets?.[event.id], oddsActuary: oddsActuary?.[event.id], climate: climateContexts?.[event.id], squadRatings, tacticalProfiles, learningModel });
    return [event.id, analysis];
  }));
}

const EMPTY_CARD_STATS = { yellow: 0, red: 0, risk: 0 };

function analyzeMatch(context) {
  const { event, home, away, summary, rosters, weather, news, refereeStats, teamCards, standings, bracketOutlook, geopoliticalRisks, oddsMarket, oddsActuary, climate, squadRatings, tacticalProfiles, learningModel } = context;
  const homeForm = formScore(summary.lastFive?.find((item) => item.teamId === home?.id));
  const awayForm = formScore(summary.lastFive?.find((item) => item.teamId === away?.id));
  const h2h = headToHeadScore(summary.headToHead, home?.id, away?.id);
  const homeSquad = squadDepth(rosters[home?.id]);
  const awaySquad = squadDepth(rosters[away?.id]);
  const homeNewsRisk = newsRisk(home?.name, news);
  const awayNewsRisk = newsRisk(away?.name, news);
  const homeCards = safeCardStats(teamCards[home?.id]);
  const awayCards = safeCardStats(teamCards[away?.id]);
  const ref = summary.referee?.name ? refereeStats[summary.referee.name] : null;
  const weatherEffect = weatherFactor(weather);
  const crowd = climate?.crowd || { home: 0, away: 0, label: "球迷压力样本不足" };
  const group = groupPressure(event, home, away, standings);
  const qualification = qualificationFactor(bracketOutlook, home, away);
  const lineup = lineupStatus(summary, home, away);
  const path = bracketPathFactor(bracketOutlook, home, away);
  const politics = geopoliticalFactor(geopoliticalRisks, event, home, away);
  const odds = oddsFactor(oddsMarket, home, away);
  const tactics = analyzeTacticalMatchup({ event, home, away, summary, rosters, tacticalProfiles });
  const homeRating = squadRatings?.[home?.id] || null;
  const awayRating = squadRatings?.[away?.id] || null;

  let homeExpected = 1.18;
  let awayExpected = 1.05;

  homeExpected += homeForm.attack - awayForm.defense * 0.35;
  awayExpected += awayForm.attack - homeForm.defense * 0.35;
  homeExpected += h2h.home * 0.18 + crowd.home * 0.18 + group.home * 0.08 + qualification.home * 0.1;
  awayExpected += h2h.away * 0.18 + crowd.away * 0.18 + group.away * 0.08 + qualification.away * 0.1;
  homeExpected += (homeSquad.depth - awaySquad.depth) * 0.05 - homeNewsRisk.score * 0.12 - homeCards.risk * 0.07;
  awayExpected += (awaySquad.depth - homeSquad.depth) * 0.05 - awayNewsRisk.score * 0.12 - awayCards.risk * 0.07;
  homeExpected += lineup.home * 0.08;
  awayExpected += lineup.away * 0.08;
  homeExpected += path.home * 0.08 - politics.home * 0.08;
  awayExpected += path.away * 0.08 - politics.away * 0.08;
  homeExpected -= safeNumber(climate?.home?.penalty) * 0.24;
  awayExpected -= safeNumber(climate?.away?.penalty) * 0.24;
  homeExpected += clamp((safeNumber(homeRating?.teamScore, 50) - safeNumber(awayRating?.teamScore, 50)) * 0.008, -0.24, 0.24);
  awayExpected += clamp((safeNumber(awayRating?.teamScore, 50) - safeNumber(homeRating?.teamScore, 50)) * 0.008, -0.24, 0.24);
  homeExpected += tactics.formation.home * 0.16 + tactics.coach.home * 0.14 + tactics.relations.home * 0.08;
  awayExpected += tactics.formation.away * 0.16 + tactics.coach.away * 0.14 + tactics.relations.away * 0.08;
  homeExpected += odds.home * 0.28;
  awayExpected += odds.away * 0.28;
  homeExpected += safeNumber(oddsActuary?.influence?.home);
  awayExpected += safeNumber(oddsActuary?.influence?.away);
  homeExpected += safeNumber(oddsActuary?.influence?.totalGoals) * 0.5;
  awayExpected += safeNumber(oddsActuary?.influence?.totalGoals) * 0.5;

  // 只对已经存在的基础贡献应用保守乘数，不让小样本凭空创造大幅度信号。
  const applyFactorDelta = (label, homeContribution, awayContribution) => {
    const delta = factorMultiplier(learningModel?.calibration, label) - 1;
    homeExpected += homeContribution * delta;
    awayExpected += awayContribution * delta;
  };
  applyFactorDelta("近期状态", homeForm.attack - awayForm.defense * 0.35, awayForm.attack - homeForm.defense * 0.35);
  applyFactorDelta("历史对战", h2h.home * 0.18, h2h.away * 0.18);
  applyFactorDelta("主场与球迷压力", crowd.home * 0.18, crowd.away * 0.18);
  applyFactorDelta("小组形势", group.home * 0.08, group.away * 0.08);
  applyFactorDelta("小组积分与晋级铺路", qualification.home * 0.1, qualification.away * 0.1);
  applyFactorDelta("伤病与阵容消息", -homeNewsRisk.score * 0.12, -awayNewsRisk.score * 0.12);
  applyFactorDelta("吃牌风险", -homeCards.risk * 0.07, -awayCards.risk * 0.07);
  applyFactorDelta("首发完整度", lineup.home * 0.08, lineup.away * 0.08);
  applyFactorDelta("32强路径战意", path.home * 0.08, path.away * 0.08);
  applyFactorDelta("政治/旅行风险", -politics.home * 0.08, -politics.away * 0.08);
  applyFactorDelta("气候与地理适应", -safeNumber(climate?.home?.penalty) * 0.24, -safeNumber(climate?.away?.penalty) * 0.24);
  applyFactorDelta("阵容年龄与近期发挥", clamp((safeNumber(homeRating?.teamScore, 50) - safeNumber(awayRating?.teamScore, 50)) * 0.008, -0.24, 0.24), clamp((safeNumber(awayRating?.teamScore, 50) - safeNumber(homeRating?.teamScore, 50)) * 0.008, -0.24, 0.24));
  applyFactorDelta("教练风格", tactics.coach.home * 0.14, tactics.coach.away * 0.14);
  applyFactorDelta("阵型克制", tactics.formation.home * 0.16, tactics.formation.away * 0.16);
  applyFactorDelta("球员熟悉度", tactics.relations.home * 0.08, tactics.relations.away * 0.08);
  applyFactorDelta("赔率市场预期", odds.home * 0.28, odds.away * 0.28);
  applyFactorDelta("赔率精算压力", safeNumber(oddsActuary?.influence?.home) + safeNumber(oddsActuary?.influence?.totalGoals) * 0.5, safeNumber(oddsActuary?.influence?.away) + safeNumber(oddsActuary?.influence?.totalGoals) * 0.5);

  const calibrated = applyExpectedGoalCalibration(homeExpected, awayExpected, learningModel?.calibration);
  homeExpected = calibrated.home;
  awayExpected = calibrated.away;

  const refereeAdjustment = refereeFactor(ref);
  homeExpected *= weatherEffect.goalMultiplier * refereeAdjustment.goalMultiplier;
  awayExpected *= weatherEffect.goalMultiplier * refereeAdjustment.goalMultiplier;

  // 任一来源字段缺失时都回落到基础期望，避免页面出现 NaN 比分。
  homeExpected = clamp(safeNumber(homeExpected, 1.1), 0.2, 4.5);
  awayExpected = clamp(safeNumber(awayExpected, 1.0), 0.2, 4.5);

  const simulation = simulateMatchScenarios({
    eventId: event.id,
    homeExpected,
    awayExpected,
    homeCardRisk: homeCards.risk,
    awayCardRisk: awayCards.risk,
    weatherMultiplier: weatherEffect.goalMultiplier,
    lineupKnown: lineup.homeStarters >= 11 && lineup.awayStarters >= 11
  });

  let scorePredictions = scorelineProbabilities(homeExpected, awayExpected, event.id);
  const scoreActuary = enrichScorePredictionsWithActuary(scorePredictions, oddsActuary);
  scorePredictions = scoreActuary.rows;
  const topScore = scorePredictions[0] || { home: 0, away: 0, label: "0-0" };
  const homeGoals = topScore.home;
  const awayGoals = topScore.away;
  const probabilities = probabilitiesFromExpected(homeExpected, awayExpected);
  const favorite = probabilities.home > probabilities.away && probabilities.home > probabilities.draw ? home?.name
    : probabilities.away > probabilities.home && probabilities.away > probabilities.draw ? away?.name
      : "平局倾向";

  return {
    eventId: event.id,
    teams: { home: home?.name, away: away?.name },
    predictedScore: { home: homeGoals, away: awayGoals, label: `${homeGoals}-${awayGoals}` },
    scorePredictions,
    expectedGoals: { home: round(homeExpected), away: round(awayExpected) },
    probabilities,
    favorite,
    confidence: confidenceScore({ summary, weather, homeSquad, awaySquad, newsRisk: homeNewsRisk.score + awayNewsRisk.score }),
    calibration: {
      applied: calibrated.applied,
      version: learningModel?.calibration?.version || 1,
      validationStatus: learningModel?.calibration?.validationStatus || "provisional",
      deploymentScale: safeNumber(learningModel?.calibration?.deploymentScale)
    },
    simulation,
    trend: buildTrendText({ home, away, homeExpected, awayExpected, probabilities, weatherEffect, refereeAdjustment, lineup }),
    factors: [
      factor("历史对战", h2h.label, h2h.home - h2h.away),
      factor("近期状态", `${home?.name || "主队"} ${homeForm.label} / ${away?.name || "客队"} ${awayForm.label}`, homeForm.total - awayForm.total),
      factor("伤病与阵容消息", `${homeNewsRisk.label}；${awayNewsRisk.label}`, awayNewsRisk.score - homeNewsRisk.score),
      factor("吃牌风险", `${home?.name || "主队"} 黄${homeCards.yellow}红${homeCards.red} / ${away?.name || "客队"} 黄${awayCards.yellow}红${awayCards.red}`, awayCards.risk - homeCards.risk),
      factor("比赛日天气", weatherEffect.label, weatherEffect.score),
      factor("气候与地理适应", climate?.label || "气候适应数据待补全", safeNumber(climate?.advantage)),
      factor("裁判影响", refereeAdjustment.label, refereeAdjustment.score),
      factor("主场与球迷压力", crowd.label, crowd.home - crowd.away),
      factor("小组形势", group.label, group.home - group.away),
      factor("小组积分与晋级铺路", qualification.label, qualification.home - qualification.away),
      factor("32强路径战意", path.label, path.home - path.away),
      factor("赔率市场预期", odds.label, odds.home - odds.away),
      factor("赔率精算压力", actuaryLabel(oddsActuary, scoreActuary.summary), safeNumber(oddsActuary?.influence?.home) - safeNumber(oddsActuary?.influence?.away)),
      factor("教练风格", tactics.coach.label, tactics.coach.home - tactics.coach.away),
      factor("阵型克制", tactics.formation.label, tactics.formation.home - tactics.formation.away),
      factor("球员熟悉度", tactics.relations.label, tactics.relations.home - tactics.relations.away),
      factor("阵容年龄与近期发挥", squadRatingLabel(home, away, homeRating, awayRating), (safeNumber(homeRating?.teamScore, 50) - safeNumber(awayRating?.teamScore, 50)) / 20),
      factor("政治/旅行风险", politics.label, politics.away - politics.home),
      factor("自我学习校准", learningLabel(learningModel), safeNumber(learningModel?.resultRate) - 0.5),
      factor("首发完整度", lineup.label, lineup.home - lineup.away)
    ],
    referee: {
      name: summary.referee?.name || "待公布",
      influence: refereeAdjustment.label,
      stats: ref || null
    },
    weather: weather || null,
    odds: oddsMarket || null,
    oddsActuary: oddsActuary?.available ? { ...oddsActuary, scoreImpact: scoreActuary.summary } : null,
    climate: climate || null,
    squadRatings: { home: homeRating, away: awayRating },
    tactics,
    lineup,
    warnings: buildWarnings({ summary, weather, homeNewsRisk, awayNewsRisk, politics, path })
  };
}

function formScore(group) {
  const events = group?.events || [];
  if (!events.length) return { total: 0, attack: 0, defense: 0, label: "暂无近况" };
  let points = 0;
  let diff = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  for (const item of events.slice(0, 5)) {
    points += item.result === "W" ? 3 : item.result === "D" ? 1 : 0;
    const isHome = item.homeTeamId === group.teamId;
    const forGoals = Number(isHome ? item.homeTeamScore : item.awayTeamScore) || 0;
    const againstGoals = Number(isHome ? item.awayTeamScore : item.homeTeamScore) || 0;
    goalsFor += forGoals;
    goalsAgainst += againstGoals;
    diff += forGoals - againstGoals;
  }
  const total = points / Math.max(1, events.length);
  return {
    total,
    attack: (goalsFor / Math.max(1, events.length) - 1.1) * 0.18 + total * 0.06,
    defense: Math.max(0, goalsAgainst / Math.max(1, events.length) - 0.9) * 0.16,
    label: `${points}分，净胜${diff}`
  };
}

function headToHeadScore(events = [], homeId, awayId) {
  if (!events.length) return { home: 0, away: 0, label: "暂无直接交锋数据" };
  let home = 0;
  let away = 0;
  for (const item of events.slice(0, 6)) {
    const homeScore = Number(item.homeTeamScore);
    const awayScore = Number(item.awayTeamScore);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    const itemHomeWon = homeScore > awayScore;
    const itemAwayWon = awayScore > homeScore;
    if (item.homeTeamId === homeId) {
      home += itemHomeWon ? 1 : itemAwayWon ? -1 : 0;
      away += itemAwayWon ? 1 : itemHomeWon ? -1 : 0;
    } else if (item.awayTeamId === homeId) {
      home += itemAwayWon ? 1 : itemHomeWon ? -1 : 0;
      away += itemHomeWon ? 1 : itemAwayWon ? -1 : 0;
    }
  }
  return { home, away, label: `${events.length}场历史记录，倾向值 ${home - away}` };
}

function squadDepth(roster) {
  const count = roster?.players?.length || 0;
  const positionKinds = new Set((roster?.players || []).map((player) => player.positionAbbr || player.position).filter(Boolean));
  return {
    count,
    depth: Math.min(1.2, count / 26 + positionKinds.size * 0.03),
    label: count ? `${count}人名单` : "名单未采集到"
  };
}

function newsRisk(teamName, news = []) {
  if (!teamName) return { score: 0, label: "未知球队消息" };
  const name = teamName.toLowerCase();
  const riskyWords = ["injury", "injured", "doubt", "suspended", "out", "伤", "伤病", "停赛", "缺阵", "变更", "替换"];
  const hits = news.filter((item) => {
    const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
    return text.includes(name) && riskyWords.some((word) => text.includes(word));
  });
  return {
    score: Math.min(2, hits.length * 0.6),
    label: hits.length ? `${teamName} 有 ${hits.length} 条阵容风险新闻` : `${teamName} 暂无明显阵容风险新闻`
  };
}

function weatherFactor(weather) {
  if (!weather || weather.status !== "ok") return { goalMultiplier: 1, score: 0, label: "天气暂无可用数据" };
  const temp = Number(weather.temperature);
  const rain = Number(weather.precipitationProbability);
  const wind = Number(weather.windSpeed);
  let multiplier = 1;
  const notes = [];
  if (temp >= 30) {
    multiplier -= 0.08;
    notes.push(`高温${temp}°C`);
  } else if (temp <= 8) {
    multiplier -= 0.04;
    notes.push(`低温${temp}°C`);
  } else if (Number.isFinite(temp)) {
    notes.push(`${temp}°C`);
  }
  if (rain >= 65) {
    multiplier -= 0.1;
    notes.push(`降水概率${rain}%`);
  }
  if (wind >= 28) {
    multiplier -= 0.06;
    notes.push(`风速${wind}km/h`);
  }
  return {
    goalMultiplier: clamp(multiplier, 0.75, 1.06),
    score: round(multiplier - 1),
    label: notes.length ? notes.join("，") : "天气条件中性"
  };
}

function refereeFactor(refStats) {
  if (!refStats) return { goalMultiplier: 1, score: 0, label: "裁判待公布或样本不足" };
  const cardsPerMatch = refStats.cards / Math.max(1, refStats.matches);
  if (cardsPerMatch >= 5) return { goalMultiplier: 0.92, score: -0.2, label: `执法偏严，场均${round(cardsPerMatch)}张牌` };
  if (cardsPerMatch <= 2) return { goalMultiplier: 1.04, score: 0.15, label: `判罚较宽，场均${round(cardsPerMatch)}张牌` };
  return { goalMultiplier: 1, score: 0, label: `判罚中性，场均${round(cardsPerMatch)}张牌` };
}

function hostFactor(event, home, away) {
  const country = event.venue?.country || "";
  const homeScore = isHost(country, home) ? 1 : 0;
  const awayScore = isHost(country, away) ? 1 : 0;
  const label = homeScore || awayScore ? `东道主地利：${homeScore ? home?.name : away?.name}` : "无明显东道主地利";
  return { home: homeScore, away: awayScore, label };
}

function isHost(country, team) {
  const name = `${team?.name || ""} ${team?.abbreviation || ""}`.toLowerCase();
  const normalizedCountry = country.toLowerCase();
  return (normalizedCountry.includes("mexico") && name.includes("mex"))
    || (normalizedCountry.includes("canada") && (name.includes("canada") || name.includes("can")))
    || ((normalizedCountry === "usa" || normalizedCountry.includes("united states")) && (name.includes("united states") || name.includes("usa")));
}

function lineupStatus(summary, home, away) {
  const homeStarters = summary.starters?.find((item) => item.teamId === home?.id)?.players?.length || 0;
  const awayStarters = summary.starters?.find((item) => item.teamId === away?.id)?.players?.length || 0;
  const homeScore = homeStarters >= 11 ? 1 : homeStarters > 0 ? 0.4 : 0;
  const awayScore = awayStarters >= 11 ? 1 : awayStarters > 0 ? 0.4 : 0;
  const label = homeStarters || awayStarters ? `首发 ${homeStarters}-${awayStarters} 人` : "首发名单待发布";
  return { home: homeScore, away: awayScore, label, homeStarters, awayStarters };
}

function groupPressure(event, home, away, standings) {
  if (!event.group) return { home: 0, away: 0, label: "淘汰赛或分组未知" };
  const table = standings[event.group] || [];
  const homeRow = table.find((item) => item.teamId === home?.id);
  const awayRow = table.find((item) => item.teamId === away?.id);
  if (!homeRow || !awayRow) return { home: 0, away: 0, label: "小组形势样本不足" };
  const homeNeed = homeRow.rank > awayRow.rank ? 0.6 : 0.2;
  const awayNeed = awayRow.rank > homeRow.rank ? 0.6 : 0.2;
  return { home: homeNeed, away: awayNeed, label: `${event.group}：${home?.name}第${homeRow.rank}，${away?.name}第${awayRow.rank}` };
}

function qualificationFactor(bracketOutlook, home, away) {
  const homeForecast = bracketOutlook?.teamPaths?.[home?.id]?.forecast;
  const awayForecast = bracketOutlook?.teamPaths?.[away?.id]?.forecast;
  const urgency = (forecast) => {
    if (!forecast) return 0;
    if (forecast.remainingMatches <= 0) return 0;
    if (forecast.qualificationProbability >= 0.88) return -0.18;
    if (forecast.projectedRank >= 3) return 0.5;
    if (forecast.qualificationProbability < 0.65) return 0.32;
    return 0.1;
  };
  const describe = (team, forecast) => forecast
    ? `${team?.name || "球队"}现${forecast.points}分、预测第${forecast.projectedRank}、晋级${Math.round(forecast.qualificationProbability * 100)}%、剩${forecast.remainingMatches}场`
    : `${team?.name || "球队"}晋级预测待补全`;
  return {
    home: urgency(homeForecast),
    away: urgency(awayForecast),
    label: `${describe(home, homeForecast)}；${describe(away, awayForecast)}。高概率球队可能控风险，第三名附近球队抢分更强。`
  };
}

function bracketPathFactor(bracketOutlook, home, away) {
  const homePath = bracketOutlook?.teamPaths?.[home?.id];
  const awayPath = bracketOutlook?.teamPaths?.[away?.id];
  const homeScore = safeNumber(homePath?.incentive?.score);
  const awayScore = safeNumber(awayPath?.incentive?.score);
  const homeLabel = homePath?.incentive?.label || "路径待定";
  const awayLabel = awayPath?.incentive?.label || "路径待定";
  return {
    home: homeScore,
    away: awayScore,
    label: `${home?.name || "主队"}：${homeLabel}；${away?.name || "客队"}：${awayLabel}`,
    caution: Boolean(homePath?.incentive?.caution || awayPath?.incentive?.caution)
  };
}

function squadRatingLabel(home, away, homeRating, awayRating) {
  const describe = (team, rating) => rating
    ? `${team?.name || "球队"}${rating.teamScore}分（均龄${rating.averageAge}，近况${rating.formScore}）`
    : `${team?.name || "球队"}阵容评分待补全`;
  return `${describe(home, homeRating)}；${describe(away, awayRating)}`;
}

function geopoliticalFactor(geopoliticalRisks, event, home, away) {
  const eventRisk = geopoliticalRisks?.eventRisks?.[event.id];
  const homeRisk = geopoliticalRisks?.teamRisks?.[home?.id];
  const awayRisk = geopoliticalRisks?.teamRisks?.[away?.id];
  const homeScore = safeNumber(homeRisk?.score) + safeNumber(eventRisk?.hostCountry === "USA" ? 0.05 : 0);
  const awayScore = safeNumber(awayRisk?.score) + safeNumber(eventRisk?.hostCountry === "USA" ? 0.05 : 0);
  const total = safeNumber(eventRisk?.score, homeScore + awayScore);
  return {
    home: Math.min(3, homeScore),
    away: Math.min(3, awayScore),
    total,
    level: eventRisk?.level || "正常",
    label: `${home?.name || "主队"}风险${homeRisk?.level || "正常"}；${away?.name || "客队"}风险${awayRisk?.level || "正常"}`
  };
}

function oddsFactor(oddsMarket, home, away) {
  const implied = oddsMarket?.consensus?.implied || oddsMarket?.primary?.implied;
  if (!implied) return { home: 0, away: 0, label: "暂无赔率市场数据" };
  const homeEdge = safeNumber(implied.home) - safeNumber(implied.draw) * 0.25;
  const awayEdge = safeNumber(implied.away) - safeNumber(implied.draw) * 0.25;
  const provider = oddsMarket?.primary?.provider || "境外市场";
  const total = oddsMarket?.consensus?.overUnder || oddsMarket?.primary?.overUnder;
  const totalText = total ? `，大小球${total}` : "";
  return {
    home: homeEdge,
    away: awayEdge,
    label: `${provider}隐含概率：${home?.name || "主队"} ${percent(implied.home)} / 平 ${percent(implied.draw)} / ${away?.name || "客队"} ${percent(implied.away)}${totalText}`
  };
}

function actuaryLabel(oddsActuary, scoreImpact) {
  if (!oddsActuary?.available) return "暂无可用赔率快照，精算压力按中性处理";
  const scoreText = scoreImpact?.safestScore ? `；比分低赔付压力：${scoreImpact.safestScore}` : "";
  return `${oddsActuary.label}${scoreText}`;
}

function learningLabel(model) {
  if (!model?.reviewCount) return "暂无赛后复盘样本";
  const totalBias = safeNumber(model.totalGoalBias);
  const biasText = totalBias ? `，总进球校正${totalBias > 0 ? "+" : ""}${totalBias}` : "";
  return `已复盘${model.reviewCount}场，胜平负命中率${percent(model.resultRate)}，平均进球误差${model.avgGoalError}${biasText}`;
}

function buildRefereeStats(summaries) {
  const stats = {};
  for (const summary of Object.values(summaries)) {
    const name = summary.referee?.name;
    if (!name) continue;
    stats[name] ||= { matches: 0, cards: 0, redCards: 0, yellowCards: 0 };
    stats[name].matches += 1;
    stats[name].yellowCards += (summary.cards || []).filter((item) => item.kind === "yellow-card").length;
    stats[name].redCards += (summary.cards || []).filter((item) => item.kind === "red-card").length;
    stats[name].cards = stats[name].yellowCards + stats[name].redCards;
  }
  return stats;
}

function buildTeamCardStats(summaries) {
  const stats = {};
  for (const summary of Object.values(summaries)) {
    for (const card of summary.cards || []) {
      if (!card.teamId) continue;
      stats[card.teamId] ||= { yellow: 0, red: 0, risk: 0 };
      if (card.kind === "yellow-card") stats[card.teamId].yellow += 1;
      if (card.kind === "red-card") stats[card.teamId].red += 1;
      stats[card.teamId].risk = stats[card.teamId].yellow * 0.12 + stats[card.teamId].red * 0.6;
    }
  }
  return stats;
}

function buildGroupStandings(events) {
  const groups = {};
  for (const event of events) {
    if (!event.group || !event.status?.completed || event.score?.home === null || event.score?.away === null) continue;
    const homeId = event.homeTeamId;
    const awayId = event.awayTeamId;
    groups[event.group] ||= {};
    groups[event.group][homeId] ||= row(homeId);
    groups[event.group][awayId] ||= row(awayId);
    applyResult(groups[event.group][homeId], event.score.home, event.score.away);
    applyResult(groups[event.group][awayId], event.score.away, event.score.home);
  }

  return Object.fromEntries(Object.entries(groups).map(([group, rows]) => {
    const table = Object.values(rows).sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor);
    table.forEach((item, index) => { item.rank = index + 1; });
    return [group, table];
  }));
}

function row(teamId) {
  return { teamId, played: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, rank: 0 };
}

function applyResult(rowData, goalsFor, goalsAgainst) {
  rowData.played += 1;
  rowData.goalsFor += goalsFor;
  rowData.goalsAgainst += goalsAgainst;
  rowData.goalDiff = rowData.goalsFor - rowData.goalsAgainst;
  rowData.points += goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
}

function probabilitiesFromExpected(homeExpected, awayExpected) {
  const safeHome = safeNumber(homeExpected, 1.1);
  const safeAway = safeNumber(awayExpected, 1.0);
  const homeRaw = Math.exp(safeHome - safeAway + 0.1);
  const awayRaw = Math.exp(safeAway - safeHome);
  const drawRaw = Math.exp(-Math.abs(safeHome - safeAway) + 0.35);
  const total = homeRaw + awayRaw + drawRaw;
  return {
    home: Math.round((homeRaw / total) * 100),
    draw: Math.round((drawRaw / total) * 100),
    away: Math.round((awayRaw / total) * 100)
  };
}

function scorelineProbabilities(homeExpected, awayExpected, seed) {
  // 用简化 Poisson 分布给出前五个最可能比分，保留一点确定性扰动避免同质化。
  const rows = [];
  for (let home = 0; home <= 5; home += 1) {
    for (let away = 0; away <= 5; away += 1) {
      const base = poisson(home, homeExpected) * poisson(away, awayExpected);
      const jitter = 1 + (seedNoise(seed, home * 11 + away * 7) - 0.5) * 0.04;
      rows.push({
        home,
        away,
        label: `${home}-${away}`,
        probability: roundProbability(base * jitter),
        result: resultOf(home, away)
      });
    }
  }
  return rows
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5)
    .map((item) => ({ ...item, percent: `${Math.round(item.probability * 100)}%` }));
}

function poisson(k, lambda) {
  const safeLambda = clamp(safeNumber(lambda, 1), 0.2, 5);
  return Math.exp(-safeLambda) * (safeLambda ** k) / factorial(k);
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

function confidenceScore({ summary, weather, homeSquad, awaySquad, newsRisk }) {
  let score = 52;
  if (summary.lastFive?.length >= 2) score += 12;
  if (summary.headToHead?.length) score += 5;
  if (summary.starters?.some((item) => item.players?.length >= 11)) score += 10;
  if (weather?.status === "ok") score += 5;
  if (homeSquad.count >= 20 && awaySquad.count >= 20) score += 8;
  score -= Math.min(12, newsRisk * 4);
  return Math.round(clamp(score, 35, 86));
}

function buildTrendText({ home, away, homeExpected, awayExpected, probabilities, weatherEffect, refereeAdjustment, lineup }) {
  const gap = homeExpected - awayExpected;
  const lean = Math.abs(gap) < 0.22 ? "比赛更接近均势" : gap > 0 ? `${home?.name || "主队"}更可能占据主动` : `${away?.name || "客队"}更可能占据主动`;
  const tempo = weatherEffect.goalMultiplier < 0.95 || refereeAdjustment.goalMultiplier < 0.95 ? "节奏可能偏谨慎" : "节奏预计正常展开";
  const lineupText = lineup.homeStarters || lineup.awayStarters ? "首发信息已纳入预测" : "首发未完全发布，预测会随刷新变化";
  return `${lean}，${tempo}，胜平负约为 ${probabilities.home}/${probabilities.draw}/${probabilities.away}，${lineupText}。`;
}

function buildWarnings({ summary, weather, homeNewsRisk, awayNewsRisk, politics, path }) {
  const warnings = [];
  if (!summary.referee?.name) warnings.push("裁判暂未公布，裁判影响按中性处理");
  if (!summary.starters?.some((item) => item.players?.length >= 11)) warnings.push("首发名单未完全发布，阵容权重较低");
  if (!weather || weather.status !== "ok") warnings.push("天气接口暂不可用或远期预报未开放");
  if (homeNewsRisk.score || awayNewsRisk.score) warnings.push("新闻中出现伤病/停赛/变更关键词，请打开原文复核");
  if (path?.caution) warnings.push("32强路径差异可能影响轮换、控分或比赛动机");
  if (politics?.total >= 1) warnings.push("存在政治、签证、旅行或安全新闻线索，请打开原文复核");
  return warnings;
}

function factor(label, value, effect) {
  return { label, value, effect: round(effect) };
}

function safeCardStats(stats) {
  return {
    yellow: safeNumber(stats?.yellow, EMPTY_CARD_STATS.yellow),
    red: safeNumber(stats?.red, EMPTY_CARD_STATS.red),
    risk: safeNumber(stats?.risk, EMPTY_CARD_STATS.risk)
  };
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percent(value) {
  return `${Math.round(safeNumber(value) * 100)}%`;
}

function seedNoise(seed, salt) {
  const text = `${seed}:${salt}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundProbability(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

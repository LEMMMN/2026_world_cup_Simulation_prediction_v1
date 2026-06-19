import { readCache, writeCache, isFresh } from "./cache.js";
import { fetchEspnNews, fetchEspnRosters, fetchEspnScoreboard, fetchEspnSummaries, fetchEspnTeams } from "./sources/espn.js";
import { buildMatchKey, fetchOpenFootballSchedule } from "./sources/openFootball.js";
import { fetchWorldCupApiTeams } from "./sources/worldCupApi.js";
import { fetchGeopoliticalNews, fetchWorldCupNews } from "./sources/news.js";
import { fetchWeatherForEvents } from "./sources/weather.js";
import { buildAnalyses } from "../analysis/predictor.js";
import { buildHeadToHeads, buildTeamForms } from "../analysis/history.js";
import { buildBracketOutlook } from "../analysis/bracket.js";
import { buildGeopoliticalRisks } from "../analysis/geopolitics.js";
import { buildOddsMarkets } from "../analysis/odds.js";
import { buildActuaryMarkets, readOddsHistory, updateOddsHistory } from "../analysis/actuary.js";
import { buildTacticalProfiles } from "../analysis/tactics.js";
import { buildClimateContexts } from "../analysis/climate.js";
import { buildSquadRatings } from "../analysis/squadRating.js";
import { enrichRostersWithPlayerProfiles } from "../analysis/playerRelations.js";
import { readLearningModel, updatePredictionMemory } from "../analysis/learning.js";
import { normalizeName } from "../utils/text.js";

let activeRefresh = null;

// 对外统一入口：优先返回新鲜缓存，强制刷新时才重新采集全部来源。
export async function getWorldCupData({ force = false } = {}) {
  const cached = await readCache();
  if (!force && isFresh(cached)) return { ...cached, meta: { ...cached.meta, cacheHit: true } };
  if (activeRefresh) return activeRefresh;

  activeRefresh = collectAll({ cached })
    .then(async (payload) => {
      await writeCache(payload);
      return payload;
    })
    .finally(() => {
      activeRefresh = null;
    });

  try {
    return await activeRefresh;
  } catch (error) {
    if (cached) {
      return {
        ...cached,
        meta: {
          ...cached.meta,
          cacheHit: true,
          stale: true,
          refreshError: error.message
        }
      };
    }
    throw error;
  }
}

export async function collectAll({ cached = null } = {}) {
  const startedAt = new Date();
  const sourceStatus = [];

  const scoreboard = await timed("ESPN 实时赛程", sourceStatus, () => fetchEspnScoreboard());
  const openFootball = await optional("OpenFootball 赛程补充", sourceStatus, () => fetchOpenFootballSchedule(), { matches: [] });
  const espnTeams = await timed("ESPN 球队", sourceStatus, () => fetchEspnTeams());
  // 补充源短暂失败时保留上一版小组字段，避免用空数据覆盖已验证信息。
  const worldCupTeams = await optional("worldcup26 球队补充", sourceStatus, () => fetchWorldCupApiTeams(), { teams: cached?.teams || [] });

  const events = mergeEvents(scoreboard.events, openFootball.matches);
  const teams = mergeTeams(espnTeams.teams.length ? espnTeams.teams : teamsFromEvents(events), worldCupTeams.teams, events);

  const [rosterResult, summaryResult, weatherResult, espnNewsResult, worldNewsResult, geopoliticalNewsResult] = await Promise.all([
    optional("ESPN 球员名单", sourceStatus, () => fetchEspnRosters(teams), { rosters: {}, errors: [] }),
    optional("ESPN 单场摘要", sourceStatus, () => fetchEspnSummaries(events), { summaries: {}, errors: [] }),
    optional("Open-Meteo 天气", sourceStatus, () => fetchWeatherForEvents(events), {}),
    optional("ESPN 新闻", sourceStatus, () => fetchEspnNews(40), { articles: [] }),
    optional("Google News 动态", sourceStatus, () => fetchWorldCupNews(), []),
    optional("Google News 政治/旅行风险", sourceStatus, () => fetchGeopoliticalNews(), [])
  ]);

  const news = dedupeNews([
    ...(espnNewsResult.articles || []),
    ...(Array.isArray(worldNewsResult) ? worldNewsResult : []),
    ...(Array.isArray(geopoliticalNewsResult) ? geopoliticalNewsResult : [])
  ]);

  const summaries = summaryResult.summaries || {};
  const playerProfileResult = await enrichRostersWithPlayerProfiles(rosterResult.rosters || {});
  const rosters = playerProfileResult.rosters;
  const teamForms = buildTeamForms({ teams, summaries });
  const headToHeads = buildHeadToHeads({ events, summaries });
  const squadRatings = buildSquadRatings({ teams, rosters, summaries, teamForms });
  const bracketOutlook = buildBracketOutlook({ events, teams });
  const oddsMarkets = buildOddsMarkets({ events, summaries });
  const oddsHistory = await readOddsHistory();
  const oddsActuary = buildActuaryMarkets({ events, oddsMarkets, history: oddsHistory });
  const climateContexts = buildClimateContexts({ events, teams, weatherByEvent: weatherResult || {} });
  const tacticalProfiles = buildTacticalProfiles({ events, teams, rosters, summaries });
  const geopoliticalRisks = buildGeopoliticalRisks({ teams, events, articles: Array.isArray(geopoliticalNewsResult) ? geopoliticalNewsResult : [] });
  const learningModel = await readLearningModel();
  const analyses = buildAnalyses({ events, teams, summaries, rosters, weatherByEvent: weatherResult || {}, news, bracketOutlook, geopoliticalRisks, oddsMarkets, oddsActuary, climateContexts, squadRatings, tacticalProfiles, learningModel });
  const oddsHistoryUpdate = await updateOddsHistory({ events, oddsMarkets, actuaryMarkets: oddsActuary, analyses });
  const learning = await updatePredictionMemory({
    events,
    summaries,
    analyses,
    weatherByEvent: weatherResult || {},
    oddsMarkets,
    geopoliticalRisks,
    teamForms,
    headToHeads,
    bracketOutlook,
    oddsActuary,
    climateContexts,
    squadRatings,
    tacticalProfiles,
    news
  });

  return {
    meta: {
      updatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      cacheHit: false,
      counts: {
        matches: events.length,
        teams: teams.length,
        rosters: Object.keys(rosters).length,
        summaries: Object.keys(summaries).length,
        teamForms: Object.values(teamForms).filter((item) => item.matches.length).length,
        headToHeads: Object.values(headToHeads).filter((item) => item.records.length).length,
        bracketPaths: Object.keys(bracketOutlook.teamPaths).length,
        oddsMarkets: Object.values(oddsMarkets).filter((item) => item.primary || item.consensus).length,
        oddsActuary: Object.values(oddsActuary).filter((item) => item.available).length,
        oddsSnapshots: oddsHistoryUpdate.snapshotCount,
        climateContexts: Object.keys(climateContexts).length,
        squadRatings: Object.keys(squadRatings).length,
        projectedRoundOf32: bracketOutlook.projectedRoundOf32.length,
        tacticalProfiles: Object.keys(tacticalProfiles.teamProfiles).length,
        playerProfiles: playerProfileResult.profiles.coverage?.players || 0,
        playerClubCoverage: playerProfileResult.profiles.coverage?.club || 0,
        playerLeagueCoverage: playerProfileResult.profiles.coverage?.league || 0,
        politicalRisks: Object.values(geopoliticalRisks.eventRisks).filter((item) => item.score > 0).length,
        predictionReviews: learning.model.reviewCount,
        news: news.length
      }
    },
    sources: {
      status: sourceStatus,
      primary: ["ESPN Site API", "Open-Meteo", "Google News RSS"],
      note: "本项目仅聚合公开页面/API 返回的数据；若来源字段为空，页面会显示待发布或待采集。"
    },
    events,
    teams,
    rosters,
    summaries,
    teamForms,
    headToHeads,
    squadRatings,
    bracketOutlook,
    oddsMarkets,
    oddsActuary,
    oddsHistory: oddsHistoryUpdate,
    climateContexts,
    tacticalProfiles,
    playerProfiles: playerProfileResult.profiles,
    geopoliticalRisks,
    learning,
    weather: weatherResult || {},
    news,
    analyses,
    errors: {
      rosters: rosterResult.errors || [],
      summaries: summaryResult.errors || []
    }
  };
}

async function timed(name, status, task) {
  const started = Date.now();
  try {
    const result = await task();
    status.push({ name, ok: true, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    status.push({ name, ok: false, durationMs: Date.now() - started, error: error.message });
    throw error;
  }
}

async function optional(name, status, task, fallback) {
  const started = Date.now();
  try {
    const result = await task();
    status.push({ name, ok: true, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    status.push({ name, ok: false, durationMs: Date.now() - started, error: error.message });
    return fallback;
  }
}

function mergeEvents(espnEvents, openMatches) {
  const openByKey = new Map(openMatches.map((match) => [match.key, match]));
  return espnEvents.map((event) => {
    const homeName = event.competitors?.find((item) => item.homeAway === "home")?.team?.name;
    const awayName = event.competitors?.find((item) => item.homeAway === "away")?.team?.name;
    const key = buildMatchKey(String(event.date || "").slice(0, 10), homeName, awayName);
    const supplement = openByKey.get(key);
    return {
      ...event,
      group: supplement?.group || event.group,
      round: event.round || supplement?.round,
      ground: supplement?.ground || event.venue?.name,
      openFootball: supplement || null
    };
  }).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function mergeTeams(espnTeams, supplementalTeams, events) {
  const groupsByAbbr = Object.fromEntries(supplementalTeams.map((team) => [team.abbreviation, team]));
  const groupsByName = Object.fromEntries(supplementalTeams.map((team) => [normalizeName(team.name), team]));
  const eventGroups = groupByEvent(events);

  return espnTeams.map((team) => {
    const supplement = groupsByAbbr[team.abbreviation] || groupsByName[normalizeName(team.name)] || {};
    return {
      ...team,
      group: supplement.group || eventGroups[team.id] || null,
      flag: supplement.flag || team.logo,
      iso2: supplement.iso2 || null,
      rosterCount: 0
    };
  }).sort((a, b) => String(a.group || "Z").localeCompare(String(b.group || "Z")) || a.name.localeCompare(b.name));
}

function teamsFromEvents(events) {
  const teams = new Map();
  for (const event of events) {
    for (const competitor of event.competitors || []) {
      if (competitor.team?.id) teams.set(competitor.team.id, competitor.team);
    }
  }
  return Array.from(teams.values());
}

function groupByEvent(events) {
  const groups = {};
  for (const event of events) {
    for (const competitor of event.competitors || []) {
      if (event.group && competitor.team?.id) groups[competitor.team.id] = event.group;
    }
  }
  return groups;
}

function dedupeNews(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.url || item.id || item.title;
    if (key && !map.has(key)) map.set(key, item);
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

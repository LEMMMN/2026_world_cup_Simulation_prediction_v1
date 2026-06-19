import { CONFIG } from "../../config.js";
import { fetchJson, mapLimit } from "../../utils/http.js";
import { compact } from "../../utils/text.js";

const SITE_BASE = CONFIG.sources.espnSite;

// ESPN site API 是本项目的实时主数据源：赛程、球队、roster、单场摘要都从这里归一化。
export async function fetchEspnScoreboard() {
  const { startDate, endDate } = CONFIG.worldCup;
  const dates = `${startDate.replaceAll("-", "")}-${endDate.replaceAll("-", "")}`;
  const url = `${SITE_BASE}/scoreboard?dates=${dates}&limit=200`;
  const raw = await fetchJson(url, { retries: 2 });
  return {
    league: raw.leagues?.[0] || null,
    events: (raw.events || []).map(normalizeEvent),
    rawCount: raw.events?.length || 0,
    sourceUrl: url
  };
}

export async function fetchEspnTeams() {
  const url = `${SITE_BASE}/teams`;
  const raw = await fetchJson(url, { retries: 2 });
  const teams = raw.sports?.[0]?.leagues?.[0]?.teams || [];
  return {
    teams: teams.map((item) => normalizeTeam(item.team || item)),
    sourceUrl: url
  };
}

export async function fetchEspnRoster(team) {
  const url = `${SITE_BASE}/teams/${team.id}/roster`;
  const raw = await fetchJson(url, { retries: 1 });
  return normalizeRoster(team, raw, url);
}

export async function fetchEspnRosters(teams) {
  const settled = await mapLimit(teams, 6, async (team) => {
    try {
      return { ok: true, value: await fetchEspnRoster(team) };
    } catch (error) {
      return { ok: false, teamId: team.id, teamName: team.name, error: error.message };
    }
  });

  return {
    rosters: Object.fromEntries(settled.filter((item) => item.ok).map((item) => [item.value.teamId, item.value])),
    errors: settled.filter((item) => !item.ok)
  };
}

export async function fetchEspnSummary(event) {
  const url = `${SITE_BASE}/summary?event=${event.id}`;
  const raw = await fetchJson(url, { retries: 1 });
  return normalizeSummary(event.id, raw, url);
}

export async function fetchEspnSummaries(events) {
  const settled = await mapLimit(events, 5, async (event) => {
    try {
      return { ok: true, value: await fetchEspnSummary(event) };
    } catch (error) {
      return { ok: false, eventId: event.id, match: event.name, error: error.message };
    }
  });

  return {
    summaries: Object.fromEntries(settled.filter((item) => item.ok).map((item) => [item.value.eventId, item.value])),
    errors: settled.filter((item) => !item.ok)
  };
}

export async function fetchEspnNews(limit = 30) {
  const url = `${SITE_BASE}/news?limit=${limit}`;
  const raw = await fetchJson(url, { retries: 1 });
  return {
    articles: (raw.articles || []).map((item) => compact({
      id: String(item.id || item.nowId || item.headline),
      title: item.headline,
      description: item.description,
      publishedAt: item.published || item.lastModified,
      url: item.links?.web?.href || item.link || item.url,
      image: item.images?.[0]?.url,
      source: "ESPN"
    })),
    sourceUrl: url
  };
}

function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = (competition.competitors || []).map((item) => normalizeCompetitor(item));
  const home = competitors.find((item) => item.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item.homeAway === "away") || competitors[1];
  const statusType = event.status?.type || {};

  return compact({
    id: String(event.id),
    uid: event.uid,
    name: event.name,
    shortName: event.shortName,
    date: event.date || competition.date,
    round: event.season?.type?.name || event.season?.slug,
    status: {
      state: statusType.state || "pre",
      name: statusType.name,
      detail: statusType.detail,
      shortDetail: statusType.shortDetail,
      completed: Boolean(statusType.completed),
      displayClock: event.status?.displayClock,
      period: event.status?.period
    },
    venue: normalizeVenue(competition.venue),
    competitors,
    homeTeamId: home?.team?.id,
    awayTeamId: away?.team?.id,
    score: home && away ? {
      home: Number.isFinite(Number(home.score)) ? Number(home.score) : null,
      away: Number.isFinite(Number(away.score)) ? Number(away.score) : null
    } : undefined,
    links: normalizeLinks(event.links || competition.links),
    broadcasts: (competition.broadcasts || []).map((item) => item.names?.join(", ") || item.name).filter(Boolean)
  });
}

function normalizeCompetitor(item) {
  return compact({
    id: String(item.id || item.team?.id),
    homeAway: item.homeAway,
    score: item.score ?? null,
    winner: item.winner,
    team: normalizeTeam(item.team || {}),
    records: item.records || []
  });
}

function normalizeTeam(team) {
  const logo = team.logo || team.logos?.find((item) => item.rel?.includes("default"))?.href || team.logos?.[0]?.href;
  return compact({
    id: String(team.id || ""),
    uid: team.uid,
    name: team.displayName || team.name || team.location,
    shortName: team.shortDisplayName || team.name,
    abbreviation: team.abbreviation,
    slug: team.slug,
    color: team.color,
    alternateColor: team.alternateColor,
    logo,
    links: normalizeLinks(team.links)
  });
}

function normalizeVenue(venue = {}) {
  return compact({
    id: venue.id ? String(venue.id) : undefined,
    name: venue.fullName || venue.shortName,
    city: venue.address?.city,
    country: venue.address?.country,
    address: venue.address
  });
}

function normalizeRoster(team, raw, sourceUrl) {
  return {
    teamId: String(team.id),
    teamName: team.name,
    updatedAt: raw.timestamp || new Date().toISOString(),
    sourceUrl,
    coaches: (raw.coach || raw.coaches || []).map((coach) => compact({
      id: coach.id ? String(coach.id) : undefined,
      name: coach.displayName || coach.fullName || [coach.firstName, coach.lastName].filter(Boolean).join(" "),
      firstName: coach.firstName,
      lastName: coach.lastName
    })),
    players: (raw.athletes || []).map((player) => normalizeAthlete(player))
  };
}

function normalizeAthlete(player) {
  // 国家队名单只返回俱乐部和联赛引用，保留引用 ID 供关系画像长期学习。
  return compact({
    id: String(player.id || ""),
    name: player.displayName || player.fullName,
    fullName: player.fullName,
    shortName: player.shortName,
    age: player.age,
    jersey: player.jersey,
    position: player.position?.displayName || player.position?.name || player.position?.abbreviation,
    positionAbbr: player.position?.abbreviation,
    height: player.displayHeight,
    weight: player.displayWeight,
    birthDate: player.dateOfBirth,
    citizenship: player.citizenship || player.citizenshipCountry,
    birthPlace: player.birthPlace?.displayText || [player.birthPlace?.city, player.birthPlace?.country].filter(Boolean).join(", "),
    club: player.defaultTeam?.displayName || player.team?.displayName,
    league: player.defaultLeague?.displayName || player.league?.displayName,
    clubId: player.defaultTeam?.id || refSegment(player.defaultTeam?.$ref, "teams"),
    leagueId: player.defaultLeague?.id || refSegment(player.defaultLeague?.$ref, "leagues"),
    headshot: player.headshot?.href,
    links: normalizeLinks(player.links)
  });
}

function refSegment(value, segment) {
  const match = String(value || "").match(new RegExp(`/${segment}/([^/?]+)`));
  return match?.[1] || undefined;
}

function normalizeSummary(eventId, raw, sourceUrl) {
  const officials = (raw.gameInfo?.officials || []).map((item) => compact({
    name: item.displayName || item.fullName,
    role: item.position?.displayName || item.position?.name,
    order: item.order
  }));
  const referee = officials.find((item) => String(item.role || "").toLowerCase() === "referee") || officials[0] || null;
  const rosters = (raw.rosters || []).map((item) => normalizeMatchRoster(item));
  const keyEvents = (raw.keyEvents || []).map(normalizeKeyEvent);

  return compact({
    eventId: String(eventId),
    updatedAt: new Date().toISOString(),
    sourceUrl,
    venue: normalizeVenue(raw.gameInfo?.venue),
    attendance: raw.gameInfo?.attendance,
    officials,
    referee,
    broadcasts: normalizeBroadcasts(raw.broadcasts),
    rosters,
    starters: rosters.map((item) => ({
      teamId: item.teamId,
      teamName: item.teamName,
      formation: item.formation,
      players: item.players.filter((player) => player.starter)
    })),
    keyEvents,
    goals: keyEvents.filter((item) => item.kind === "goal"),
    cards: keyEvents.filter((item) => item.kind === "yellow-card" || item.kind === "red-card"),
    substitutions: keyEvents.filter((item) => item.kind === "substitution"),
    lastFive: normalizeLastFive(raw.lastFiveGames),
    headToHead: normalizeHeadToHead(raw.headToHeadGames),
    teamStats: normalizeTeamStats(raw.boxscore?.teams),
    matchNews: (raw.news?.articles || raw.news || []).slice(0, 8).map(normalizeNewsArticle),
    standings: raw.standings || null,
    odds: raw.odds || raw.pickcenter || null
  });
}

function normalizeMatchRoster(item) {
  return {
    teamId: String(item.team?.id || ""),
    teamName: item.team?.displayName,
    homeAway: item.homeAway,
    winner: item.winner,
    formation: item.formation,
    players: (item.roster || []).map((player) => compact({
      id: String(player.athlete?.id || ""),
      name: player.athlete?.displayName || player.athlete?.fullName,
      jersey: player.jersey,
      active: player.active,
      starter: Boolean(player.starter),
      subbedIn: player.subbedIn,
      subbedOut: player.subbedOut,
      formationPlace: player.formationPlace,
      position: player.position?.displayName || player.position?.name || player.position?.abbreviation,
      stats: Object.fromEntries((player.stats || []).map((stat) => [stat.name, stat.value ?? stat.displayValue]))
    }))
  };
}

function normalizeKeyEvent(item) {
  const type = item.type?.type || item.type?.text;
  return compact({
    id: String(item.id || ""),
    kind: type,
    label: item.type?.text,
    text: item.text || item.shortText,
    shortText: item.shortText,
    minute: item.clock?.displayValue,
    period: item.period?.number,
    teamId: item.team?.id ? String(item.team.id) : undefined,
    teamName: item.team?.displayName,
    players: (item.participants || []).map((participant) => compact({
      id: participant.athlete?.id ? String(participant.athlete.id) : undefined,
      name: participant.athlete?.displayName
    })),
    wallclock: item.wallclock
  });
}

function normalizeLastFive(groups = []) {
  return groups.map((group) => ({
    teamId: String(group.team?.id || ""),
    teamName: group.team?.displayName,
    abbreviation: group.team?.abbreviation,
    events: (group.events || []).map((event) => compact({
      id: String(event.id || ""),
      date: event.gameDate,
      opponent: event.opponent?.displayName,
      opponentId: event.opponent?.id ? String(event.opponent.id) : undefined,
      result: event.gameResult,
      score: event.score,
      homeTeamScore: parseScore(event.homeTeamScore),
      awayTeamScore: parseScore(event.awayTeamScore),
      homeTeamId: event.homeTeamId ? String(event.homeTeamId) : undefined,
      awayTeamId: event.awayTeamId ? String(event.awayTeamId) : undefined,
      competition: event.competitionName,
      note: event.matchNote
    }))
  }));
}

function normalizeHeadToHead(groups = []) {
  const events = groups.flatMap((group) => group.events || []);
  return events.map((event) => compact({
    id: String(event.id || ""),
    date: event.gameDate,
    name: event.name || event.shortName,
    score: event.score,
    homeTeamId: event.homeTeamId ? String(event.homeTeamId) : undefined,
    awayTeamId: event.awayTeamId ? String(event.awayTeamId) : undefined,
    homeTeamScore: parseScore(event.homeTeamScore),
    awayTeamScore: parseScore(event.awayTeamScore),
    competition: event.competitionName || event.leagueName,
    result: event.gameResult
  }));
}

function parseScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTeamStats(teams = []) {
  return teams.map((item) => ({
    teamId: String(item.team?.id || ""),
    teamName: item.team?.displayName,
    statistics: Object.fromEntries((item.statistics || []).map((stat) => [stat.name, stat.displayValue ?? stat.value]))
  }));
}

function normalizeBroadcasts(broadcasts = []) {
  return broadcasts.map((item) => item.name || item.names?.join(", ") || item.market).filter(Boolean);
}

function normalizeNewsArticle(item) {
  return compact({
    id: String(item.id || item.nowId || item.headline || ""),
    title: item.headline,
    description: item.description,
    publishedAt: item.published || item.lastModified,
    url: item.links?.web?.href || item.url,
    image: item.images?.[0]?.url,
    source: "ESPN"
  });
}

function normalizeLinks(links = []) {
  const result = {};
  for (const link of links || []) {
    const key = Array.isArray(link.rel) ? link.rel[0] : link.text || link.shortText;
    if (key && link.href) result[key] = link.href;
  }
  return Object.keys(result).length ? result : undefined;
}

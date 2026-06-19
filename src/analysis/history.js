// 历史与近况模块：把单场摘要里的 lastFive/headToHead 抽成可展示的数据集。
export function buildTeamForms({ teams, summaries }) {
  const teamMap = Object.fromEntries(teams.map((team) => [team.id, team]));
  const buckets = {};

  for (const summary of Object.values(summaries)) {
    for (const group of summary.lastFive || []) {
      if (!group.teamId) continue;
      buckets[group.teamId] ||= new Map();
      for (const match of group.events || []) {
        const key = match.id || `${match.date}-${match.opponent}-${match.score}`;
        buckets[group.teamId].set(key, normalizeRecentMatch(group.teamId, match, summary.eventId));
      }
    }
  }

  return Object.fromEntries(teams.map((team) => {
    const matches = Array.from(buckets[team.id]?.values() || [])
      .filter((match) => match.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);

    return [team.id, {
      teamId: team.id,
      teamName: team.name,
      teamAbbreviation: team.abbreviation,
      source: "ESPN lastFiveGames",
      matches,
      summary: summarizeRecentMatches(matches, teamMap)
    }];
  }));
}

export function buildHeadToHeads({ events, summaries }) {
  return Object.fromEntries(events.map((event) => {
    const summary = summaries[event.id] || {};
    const records = dedupeRecords(summary.headToHead || [])
      .filter((record) => isSameMatchup(record, event.homeTeamId, event.awayTeamId))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    return [event.id, {
      eventId: event.id,
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      source: "ESPN headToHeadGames",
      records,
      summary: summarizeHeadToHead(records, event.homeTeamId, event.awayTeamId)
    }];
  }));
}

function normalizeRecentMatch(teamId, match, sourceEventId) {
  const isHome = match.homeTeamId === teamId;
  const goalsFor = safeNumber(isHome ? match.homeTeamScore : match.awayTeamScore, null);
  const goalsAgainst = safeNumber(isHome ? match.awayTeamScore : match.homeTeamScore, null);
  return {
    id: match.id,
    sourceEventId,
    date: match.date,
    opponent: match.opponent,
    opponentId: match.opponentId,
    homeAway: isHome ? "home" : "away",
    result: normalizeResult(match.result, goalsFor, goalsAgainst),
    score: match.score,
    goalsFor,
    goalsAgainst,
    goalDiff: Number.isFinite(goalsFor) && Number.isFinite(goalsAgainst) ? goalsFor - goalsAgainst : null,
    competition: match.competition,
    note: match.note
  };
}

function summarizeRecentMatches(matches) {
  const summary = { played: matches.length, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0, form: "" };
  for (const match of matches) {
    if (match.result === "W") {
      summary.wins += 1;
      summary.points += 3;
    } else if (match.result === "D") {
      summary.draws += 1;
      summary.points += 1;
    } else if (match.result === "L") {
      summary.losses += 1;
    }
    summary.goalsFor += safeNumber(match.goalsFor);
    summary.goalsAgainst += safeNumber(match.goalsAgainst);
  }
  summary.goalDiff = summary.goalsFor - summary.goalsAgainst;
  summary.form = matches.map((match) => match.result || "-").join("");
  return summary;
}

function dedupeRecords(records) {
  const map = new Map();
  for (const record of records) {
    const key = record.id || `${record.date}-${record.homeTeamId}-${record.awayTeamId}-${record.score}`;
    map.set(key, {
      id: record.id,
      date: record.date,
      name: record.name,
      score: record.score,
      homeTeamId: record.homeTeamId,
      awayTeamId: record.awayTeamId,
      homeTeamScore: safeNumber(record.homeTeamScore, null),
      awayTeamScore: safeNumber(record.awayTeamScore, null),
      competition: record.competition,
      result: record.result
    });
  }
  return Array.from(map.values());
}

function summarizeHeadToHead(records, homeTeamId, awayTeamId) {
  const summary = { played: records.length, homeWins: 0, awayWins: 0, draws: 0, homeGoals: 0, awayGoals: 0 };
  for (const record of records) {
    const homeGoals = goalsForTeam(record, homeTeamId);
    const awayGoals = goalsForTeam(record, awayTeamId);
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
    summary.homeGoals += homeGoals;
    summary.awayGoals += awayGoals;
    if (homeGoals > awayGoals) summary.homeWins += 1;
    else if (awayGoals > homeGoals) summary.awayWins += 1;
    else summary.draws += 1;
  }
  return summary;
}

function isSameMatchup(record, teamA, teamB) {
  const ids = new Set([record.homeTeamId, record.awayTeamId]);
  return ids.has(teamA) && ids.has(teamB);
}

function goalsForTeam(record, teamId) {
  if (record.homeTeamId === teamId) return record.homeTeamScore;
  if (record.awayTeamId === teamId) return record.awayTeamScore;
  return null;
}

function normalizeResult(result, goalsFor, goalsAgainst) {
  if (result === "W" || result === "D" || result === "L") return result;
  if (!Number.isFinite(goalsFor) || !Number.isFinite(goalsAgainst)) return result || null;
  return goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D";
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

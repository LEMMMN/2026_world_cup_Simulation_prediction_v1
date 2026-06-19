// 阵容评分模块：汇总球员年龄、首发、进球、助攻、红黄牌和球队近5场，生成队伍当前评分。
export function buildSquadRatings({ teams, rosters, summaries, teamForms }) {
  const evidence = collectPlayerEvidence(summaries);
  return Object.fromEntries(teams.map((team) => {
    const roster = rosters[team.id] || {};
    const players = (roster.players || []).map((player) => ratePlayer(player, evidence[team.id]?.[player.id]));
    const ranked = players.slice().sort((a, b) => b.rating - a.rating);
    const core = ranked.slice(0, Math.min(18, ranked.length));
    const averageAge = average(players.map((player) => player.age).filter(Number.isFinite));
    const ageBalance = ageBalanceScore(players);
    const depthScore = clamp(players.length / 26 * 100, 0, 100);
    const formScore = teamFormScore(teamForms[team.id]);
    const playerScore = average(core.map((player) => player.rating));
    const teamScore = round(clamp(playerScore * 0.58 + formScore * 0.24 + depthScore * 0.1 + ageBalance * 0.08, 0, 100));
    return [team.id, {
      teamId: team.id,
      teamName: team.name,
      teamScore,
      playerScore: round(playerScore),
      formScore: round(formScore),
      depthScore: round(depthScore),
      ageBalance: round(ageBalance),
      averageAge: round(averageAge),
      playerCount: players.length,
      peakAgeCount: players.filter((player) => player.age >= 24 && player.age <= 29).length,
      veteranCount: players.filter((player) => player.age >= 32).length,
      youngCount: players.filter((player) => player.age > 0 && player.age <= 22).length,
      coaches: roster.coaches || [],
      players,
      topPlayers: ranked.slice(0, 5),
      label: `阵容${players.length}人，平均${round(averageAge)}岁，当前综合评分${teamScore}`
    }];
  }));
}

function collectPlayerEvidence(summaries) {
  const teams = {};
  for (const summary of Object.values(summaries)) {
    for (const roster of summary.rosters || []) {
      if (!roster.teamId) continue;
      teams[roster.teamId] ||= {};
      for (const player of roster.players || []) {
        if (!player.id) continue;
        const row = teams[roster.teamId][player.id] ||= emptyEvidence();
        row.matches += player.active ? 1 : 0;
        row.starts += player.starter ? 1 : 0;
        row.minutes += statNumber(player.stats, ["minutes", "minutesPlayed"]);
        row.goals += statNumber(player.stats, ["goals", "totalGoals"]);
        row.assists += statNumber(player.stats, ["assists", "goalAssists"]);
        const rating = statNumber(player.stats, ["rating", "playerRating"]);
        if (rating > 0) row.ratings.push(rating);
      }
    }
    for (const event of summary.keyEvents || []) {
      for (const player of event.players || []) {
        if (!player.id || !event.teamId) continue;
        const row = teams[event.teamId]?.[player.id];
        if (!row) continue;
        if (event.kind === "goal" && player === event.players[0]) row.goals += 1;
        if (event.kind === "yellow-card") row.yellowCards += 1;
        if (event.kind === "red-card") row.redCards += 1;
      }
      const assister = event.kind === "goal" ? event.players?.[1] : null;
      const assistRow = assister?.id && event.teamId ? teams[event.teamId]?.[assister.id] : null;
      if (assistRow) assistRow.assists += 1;
    }
  }
  return teams;
}

function ratePlayer(player, evidence = emptyEvidence()) {
  const age = safeNumber(player.age, null);
  const ageScore = ageCurve(age);
  const matchScore = clamp(evidence.matches * 3 + evidence.starts * 4, 0, 18);
  const outputScore = clamp(evidence.goals * 5 + evidence.assists * 3, 0, 24);
  const discipline = evidence.yellowCards * 1.5 + evidence.redCards * 5;
  const sourceRating = evidence.ratings.length ? average(evidence.ratings) * 5 : 0;
  const rating = round(clamp(38 + ageScore + matchScore + outputScore + sourceRating - discipline, 25, 95));
  return {
    ...player,
    age,
    rating,
    recent: {
      matches: evidence.matches,
      starts: evidence.starts,
      minutes: evidence.minutes,
      goals: evidence.goals,
      assists: evidence.assists,
      yellowCards: evidence.yellowCards,
      redCards: evidence.redCards,
      sourceRating: round(average(evidence.ratings))
    },
    recentLabel: evidence.matches
      ? `${evidence.matches}场/${evidence.starts}首发，${evidence.goals}球${evidence.assists}助，评分${rating}`
      : `近期国家队细项待补全，年龄结构评分${rating}`
  };
}

function teamFormScore(form) {
  const summary = form?.summary || {};
  const played = safeNumber(summary.played);
  if (!played) return 50;
  const pointsRate = safeNumber(summary.points) / Math.max(1, played * 3);
  const goalDiffRate = safeNumber(summary.goalDiff) / Math.max(1, played);
  return clamp(35 + pointsRate * 50 + goalDiffRate * 6, 15, 95);
}

function ageBalanceScore(players) {
  if (!players.length) return 45;
  const peak = players.filter((player) => player.age >= 24 && player.age <= 29).length / players.length;
  const veteran = players.filter((player) => player.age >= 32).length / players.length;
  const young = players.filter((player) => player.age > 0 && player.age <= 22).length / players.length;
  return clamp(55 + peak * 45 + young * 12 - veteran * 18, 30, 95);
}

function ageCurve(age) {
  if (!Number.isFinite(age)) return 8;
  if (age >= 24 && age <= 29) return 20;
  if (age >= 21 && age <= 31) return 16;
  if (age <= 20) return 11;
  if (age <= 34) return 10;
  return 5;
}

function statNumber(stats = {}, keys = []) {
  for (const key of keys) {
    const value = Number(stats[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function emptyEvidence() {
  return { matches: 0, starts: 0, minutes: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, ratings: [] };
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function average(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

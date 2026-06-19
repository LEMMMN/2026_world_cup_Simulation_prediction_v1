// 32强路径模块：根据当前小组积分和淘汰赛占位，估算每队不同排名的潜在对手。
export function buildBracketOutlook({ events, teams }) {
  const tables = buildGroupTables(events, teams);
  const roundOf32 = buildRoundOf32Slots(events);
  const qualificationForecast = buildQualificationForecast(tables);
  const projectedRoundOf32 = buildProjectedRoundOf32(roundOf32, qualificationForecast);
  const teamPaths = Object.fromEntries(teams.map((team) => [team.id, buildTeamPath(team, tables, roundOf32, qualificationForecast)]));

  return {
    updatedAt: new Date().toISOString(),
    rules: "12个小组前两名和8个成绩最好的小组第三进入32强；第三名具体落位取决于8个晋级小组组合。",
    tables,
    qualificationForecast,
    roundOf32,
    projectedRoundOf32,
    teamPaths,
    source: "ESPN赛程占位 + 当前小组赛结果"
  };
}

export function buildGroupTables(events, teams) {
  const groups = {};
  for (const team of teams) {
    if (!team.group) continue;
    const group = normalizeGroup(team.group);
    groups[group] ||= {};
    groups[group][team.id] ||= emptyRow(team, group);
  }

  for (const event of events) {
    const group = normalizeGroup(event.group);
    if (!group || !event.status?.completed || !Number.isFinite(Number(event.score?.home)) || !Number.isFinite(Number(event.score?.away))) continue;
    const home = event.competitors?.find((item) => item.homeAway === "home")?.team;
    const away = event.competitors?.find((item) => item.homeAway === "away")?.team;
    if (!home?.id || !away?.id) continue;
    groups[group] ||= {};
    groups[group][home.id] ||= emptyRow(home, group);
    groups[group][away.id] ||= emptyRow(away, group);
    applyResult(groups[group][home.id], Number(event.score.home), Number(event.score.away));
    applyResult(groups[group][away.id], Number(event.score.away), Number(event.score.home));
  }

  return Object.fromEntries(Object.entries(groups).map(([group, rows]) => {
    const table = Object.values(rows).sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor || a.teamName.localeCompare(b.teamName));
    table.forEach((row, index) => {
      row.rank = index + 1;
      row.slot = `${row.rank}${group}`;
    });
    return [group, table];
  }));
}

function buildRoundOf32Slots(events) {
  const matches = events
    .filter((event) => event.round === "round-of-32")
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((event, index) => {
      const home = event.competitors?.find((item) => item.homeAway === "home")?.team?.name || "";
      const away = event.competitors?.find((item) => item.homeAway === "away")?.team?.name || "";
      return {
        id: event.id,
        order: index + 1,
        date: event.date,
        venue: event.venue,
        homeSlot: parseSlot(home),
        awaySlot: parseSlot(away),
        label: `${slotLabel(parseSlot(home))} vs ${slotLabel(parseSlot(away))}`
      };
    });
  return matches;
}

function buildTeamPath(team, tables, roundOf32, qualificationForecast) {
  const group = normalizeGroup(team.group);
  const table = tables[group] || [];
  const row = table.find((item) => item.teamId === team.id) || null;
  const rank = row?.rank || null;
  const firstPath = findSlotPath({ rank: 1, group }, roundOf32);
  const secondPath = findSlotPath({ rank: 2, group }, roundOf32);
  const thirdPaths = roundOf32.filter((match) => [match.homeSlot, match.awaySlot].some((slot) => slot.rank === 3 && slot.groups?.includes(group)));
  const firstDifficulty = pathDifficulty(firstPath, "first");
  const secondDifficulty = pathDifficulty(secondPath, "second");
  const forecast = qualificationForecast.groups?.[group]?.find((item) => item.teamId === team.id) || null;

  return {
    teamId: team.id,
    teamName: team.name,
    group,
    currentRank: rank,
    tableRow: row,
    forecast,
    ifFirst: firstPath,
    ifSecond: secondPath,
    ifThird: thirdPaths,
    incentive: buildIncentive(firstDifficulty, secondDifficulty, rank, row, forecast)
  };
}

function findSlotPath(slotQuery, roundOf32) {
  const match = roundOf32.find((item) => slotMatches(item.homeSlot, slotQuery) || slotMatches(item.awaySlot, slotQuery));
  if (!match) return null;
  const ownSide = slotMatches(match.homeSlot, slotQuery) ? "home" : "away";
  const opponentSlot = ownSide === "home" ? match.awaySlot : match.homeSlot;
  return {
    matchId: match.id,
    order: match.order,
    date: match.date,
    venue: match.venue,
    ownSlot: ownSide === "home" ? match.homeSlot : match.awaySlot,
    opponentSlot,
    opponentLabel: slotLabel(opponentSlot),
    difficulty: slotDifficulty(opponentSlot)
  };
}

function buildIncentive(firstDifficulty, secondDifficulty, currentRank, row, forecast) {
  if (!firstDifficulty || !secondDifficulty) return { label: "路径信息不足", score: 0, caution: false };
  const gap = firstDifficulty.score - secondDifficulty.score;
  const tableText = row ? `${row.points}分，净胜${signed(row.goalDiff)}，剩${forecast?.remainingMatches ?? Math.max(0, 3 - row.played)}场` : "积分未知";
  const qualificationText = forecast ? `，晋级概率${Math.round(forecast.qualificationProbability * 100)}%` : "";
  if (gap >= 1) {
    const rankText = currentRank === 2 ? "当前第二且第二路径更友好" : "小组第一路径可能更难";
    return { label: `${rankText}，存在轮换/保守控风险（${tableText}${qualificationText}）`, score: -0.45, caution: true };
  }
  if (gap <= -1) {
    const rankText = currentRank === 2 ? "争第一可获得更友好路径" : "小组第一路径更友好";
    return { label: `${rankText}，争胜动机偏强（${tableText}${qualificationText}）`, score: 0.45, caution: false };
  }
  if (currentRank && currentRank <= 3) return { label: `第一/第二路径差距不大，常规争分动机（${tableText}${qualificationText}）`, score: 0.12, caution: false };
  return { label: "仍需抢分进入晋级区", score: 0.2, caution: false };
}

function buildQualificationForecast(tables) {
  const groups = Object.fromEntries(Object.entries(tables).map(([group, rows]) => {
    const forecast = rows.map((row) => projectGroupRow(row));
    forecast.sort((a, b) => b.projectedPoints - a.projectedPoints || b.projectedGoalDiff - a.projectedGoalDiff || b.points - a.points);
    forecast.forEach((row, index) => {
      row.projectedRank = index + 1;
      row.qualificationProbability = qualificationProbability(row);
      row.status = qualificationStatus(row.qualificationProbability, row.projectedRank);
    });
    return [group, forecast];
  }));
  const bestThird = Object.values(groups).map((rows) => rows.find((row) => row.projectedRank === 3)).filter(Boolean)
    .sort((a, b) => b.projectedPoints - a.projectedPoints || b.projectedGoalDiff - a.projectedGoalDiff);
  bestThird.forEach((row, index) => {
    row.bestThirdRank = index + 1;
    row.projectedBestThirdQualified = index < 8;
    if (row.projectedRank === 3) row.qualificationProbability = clamp(row.qualificationProbability + (index < 8 ? 0.18 : -0.12), 0.05, 0.9);
  });
  return {
    updatedAt: new Date().toISOString(),
    groups,
    bestThird,
    note: "按当前积分、净胜球、剩余场次和已赛场均表现推算；不是官方最终排名。"
  };
}

function projectGroupRow(row) {
  const remainingMatches = Math.max(0, 3 - row.played);
  const pointsPerGame = row.played ? row.points / row.played : 1.25;
  const goalDiffPerGame = row.played ? row.goalDiff / row.played : 0;
  const expectedPointsPerMatch = clamp(1.15 + (pointsPerGame - 1.25) * 0.52 + goalDiffPerGame * 0.12, 0.45, 2.45);
  return {
    ...row,
    remainingMatches,
    pointsPerGame: round(pointsPerGame),
    expectedPointsPerMatch: round(expectedPointsPerMatch),
    projectedPoints: round(row.points + remainingMatches * expectedPointsPerMatch),
    projectedGoalDiff: round(row.goalDiff + remainingMatches * goalDiffPerGame),
    projectedRank: 0,
    qualificationProbability: 0,
    status: "待预测"
  };
}

function qualificationProbability(row) {
  const rankBase = { 1: 0.9, 2: 0.76, 3: 0.46, 4: 0.12 }[row.projectedRank] || 0.1;
  const pointsBoost = (row.projectedPoints - 4) * 0.045;
  const goalBoost = row.projectedGoalDiff * 0.025;
  const certainty = row.remainingMatches === 0 ? 0.08 : 0;
  return round(clamp(rankBase + pointsBoost + goalBoost + certainty, 0.03, 0.98));
}

function qualificationStatus(probability, projectedRank) {
  if (probability >= 0.9 && projectedRank <= 2) return "接近锁定";
  if (probability >= 0.7) return "大概率晋级";
  if (probability >= 0.4) return "晋级争夺";
  return "出线危险";
}

function buildProjectedRoundOf32(roundOf32, forecast) {
  return roundOf32.map((match) => ({
    ...match,
    projectedHome: resolveProjectedSlot(match.homeSlot, forecast),
    projectedAway: resolveProjectedSlot(match.awaySlot, forecast)
  }));
}

function resolveProjectedSlot(slot, forecast) {
  if (!slot) return null;
  if (slot.rank === 1 || slot.rank === 2) {
    const team = forecast.groups?.[slot.group]?.find((row) => row.projectedRank === slot.rank);
    return projectedTeam(team, slotLabel(slot));
  }
  if (slot.rank === 3) {
    const team = forecast.bestThird.find((row) => slot.groups?.includes(row.group) && row.projectedBestThirdQualified);
    return projectedTeam(team, slotLabel(slot));
  }
  return { teamId: null, teamName: slot.label || "待定", probability: 0, slotLabel: slotLabel(slot) };
}

function projectedTeam(team, fallback) {
  return {
    teamId: team?.teamId || null,
    teamName: team?.teamName || fallback,
    probability: team?.qualificationProbability || 0,
    projectedRank: team?.projectedRank || null,
    group: team?.group || null,
    slotLabel: fallback
  };
}

function pathDifficulty(path, label) {
  if (!path) return null;
  return { label, score: path.difficulty };
}

function slotMatches(slot, query) {
  return slot?.rank === query.rank && slot.group === query.group;
}

function parseSlot(value) {
  const text = String(value || "");
  const winner = text.match(/^Group ([A-Z]) Winner$/);
  if (winner) return { rank: 1, group: winner[1], label: `1${winner[1]}` };
  const runnerUp = text.match(/^Group ([A-Z]) 2nd Place$/);
  if (runnerUp) return { rank: 2, group: runnerUp[1], label: `2${runnerUp[1]}` };
  const third = text.match(/^Third Place Group ([A-Z/]+)$/);
  if (third) return { rank: 3, groups: third[1].split("/"), label: `3${third[1]}` };
  return { rank: null, group: null, label: text || "待定" };
}

function slotLabel(slot) {
  if (!slot) return "待定";
  if (slot.rank === 1) return `${slot.group}组第1`;
  if (slot.rank === 2) return `${slot.group}组第2`;
  if (slot.rank === 3) return `${slot.groups.join("/")}组成绩较好第3`;
  return slot.label || "待定";
}

function slotDifficulty(slot) {
  if (!slot) return 1.5;
  if (slot.rank === 1) return 3;
  if (slot.rank === 2) return 2;
  if (slot.rank === 3) return 1.35;
  return 1.8;
}

function emptyRow(team, group) {
  return {
    teamId: team.id,
    teamName: team.name,
    abbreviation: team.abbreviation,
    group,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDiff: 0,
    rank: 0
  };
}

function applyResult(row, goalsFor, goalsAgainst) {
  row.played += 1;
  row.goalsFor += goalsFor;
  row.goalsAgainst += goalsAgainst;
  row.goalDiff = row.goalsFor - row.goalsAgainst;
  if (goalsFor > goalsAgainst) {
    row.wins += 1;
    row.points += 3;
  } else if (goalsFor === goalsAgainst) {
    row.draws += 1;
    row.points += 1;
  } else {
    row.losses += 1;
  }
}

function normalizeGroup(value) {
  if (!value) return null;
  const match = String(value).match(/(?:Group\s*)?([A-L])$/i);
  return match ? match[1].toUpperCase() : null;
}

function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

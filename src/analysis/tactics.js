// 战术模块：基于公开摘要里的教练、阵型、换人、红黄牌和球员关系，生成可复用的战术画像。
export function buildTacticalProfiles({ events, teams, rosters, summaries }) {
  const teamProfiles = Object.fromEntries(teams.map((team) => [team.id, emptyProfile(team, rosters[team.id])]));
  const coachPairHistory = {};

  for (const event of events) {
    const summary = summaries[event.id] || {};
    const home = event.homeTeamId;
    const away = event.awayTeamId;
    if (home && teamProfiles[home]) addMatchSample(teamProfiles[home], event, summary, "home");
    if (away && teamProfiles[away]) addMatchSample(teamProfiles[away], event, summary, "away");
    addCoachPairHistory(coachPairHistory, event, summary, rosters);
  }

  for (const profile of Object.values(teamProfiles)) finalizeProfile(profile);

  return {
    updatedAt: new Date().toISOString(),
    source: "ESPN roster coach + ESPN match summary formation/events",
    note: "教练和阵型来自公开数据；球员俱乐部关系只有在来源提供俱乐部/联赛字段时才计入。",
    teamProfiles,
    coachPairHistory
  };
}

export function analyzeTacticalMatchup({ event, home, away, summary, rosters, tacticalProfiles }) {
  const homeProfile = tacticalProfiles?.teamProfiles?.[home?.id] || emptyProfile(home, rosters?.[home?.id]);
  const awayProfile = tacticalProfiles?.teamProfiles?.[away?.id] || emptyProfile(away, rosters?.[away?.id]);
  const homeFormation = currentFormation(summary, home?.id) || homeProfile.primaryFormation;
  const awayFormation = currentFormation(summary, away?.id) || awayProfile.primaryFormation;
  const formation = compareFormations(homeFormation, awayFormation, home?.name, away?.name);
  const coach = compareCoachStyles(homeProfile, awayProfile, tacticalProfiles?.coachPairHistory);
  const relations = comparePlayerRelations(rosters?.[home?.id], rosters?.[away?.id]);

  return {
    home: round(formation.home + coach.home + relations.home),
    away: round(formation.away + coach.away + relations.away),
    label: `${formation.label}；${coach.label}；${relations.label}`,
    homeFormation,
    awayFormation,
    formation,
    coach,
    relations,
    homeProfile: compactProfile(homeProfile),
    awayProfile: compactProfile(awayProfile)
  };
}

function emptyProfile(team = {}, roster = {}) {
  const coaches = roster?.coaches || [];
  return {
    teamId: team?.id || roster?.teamId,
    teamName: team?.name || roster?.teamName,
    coaches,
    primaryCoach: coaches[0]?.name || "教练待采集",
    samples: [],
    formations: {},
    primaryFormation: null,
    attackIndex: 0,
    defenseIndex: 0,
    pressIndex: 0,
    rotationIndex: 0,
    disciplineRisk: 0,
    styleLabel: "样本不足，按中性处理"
  };
}

function addMatchSample(profile, event, summary, side) {
  const starter = summary.starters?.find((item) => item.teamId === (side === "home" ? event.homeTeamId : event.awayTeamId));
  const goalsFor = side === "home" ? event.score?.home : event.score?.away;
  const goalsAgainst = side === "home" ? event.score?.away : event.score?.home;
  const teamId = side === "home" ? event.homeTeamId : event.awayTeamId;
  const formation = normalizeFormation(starter?.formation);
  if (formation) profile.formations[formation] = (profile.formations[formation] || 0) + 1;
  if (event.status?.completed && Number.isFinite(Number(goalsFor)) && Number.isFinite(Number(goalsAgainst))) {
    const cards = (summary.cards || []).filter((item) => item.teamId === teamId);
    const substitutions = (summary.substitutions || []).filter((item) => item.teamId === teamId);
    profile.samples.push({
      eventId: event.id,
      formation,
      goalsFor: Number(goalsFor),
      goalsAgainst: Number(goalsAgainst),
      substitutions: substitutions.length,
      yellowCards: cards.filter((item) => item.kind === "yellow-card").length,
      redCards: cards.filter((item) => item.kind === "red-card").length
    });
  }
}

function finalizeProfile(profile) {
  const formations = Object.entries(profile.formations).sort((a, b) => b[1] - a[1]);
  profile.primaryFormation = formations[0]?.[0] || null;
  const played = profile.samples.length;
  if (!played) return;
  const goalsFor = average(profile.samples.map((item) => item.goalsFor));
  const goalsAgainst = average(profile.samples.map((item) => item.goalsAgainst));
  const subs = average(profile.samples.map((item) => item.substitutions));
  const cards = average(profile.samples.map((item) => item.yellowCards + item.redCards * 2));
  const shape = formationShape(profile.primaryFormation);

  profile.attackIndex = round((goalsFor - 1.1) * 0.45 + (shape.forwards - 2) * 0.12 + shape.width * 0.08);
  profile.defenseIndex = round((1.1 - goalsAgainst) * 0.45 + (shape.defenders - 4) * 0.12);
  profile.pressIndex = round(profile.attackIndex - profile.defenseIndex * 0.2 + cards * 0.04);
  profile.rotationIndex = round((subs - 3) * 0.12);
  profile.disciplineRisk = round(cards * 0.18);
  profile.styleLabel = styleLabel(profile);
}

function compareFormations(homeFormation, awayFormation, homeName = "主队", awayName = "客队") {
  const home = formationShape(homeFormation);
  const away = formationShape(awayFormation);
  let homeScore = 0;
  let awayScore = 0;
  const notes = [];

  if (!homeFormation || !awayFormation) return { home: 0, away: 0, label: "阵型待公布，按中性处理" };

  homeScore += (home.midfield - away.midfield) * 0.06;
  awayScore += (away.midfield - home.midfield) * 0.06;
  homeScore += (home.width - away.width) * 0.08;
  awayScore += (away.width - home.width) * 0.08;
  homeScore -= Math.max(0, away.defenders - 4) * 0.08;
  awayScore -= Math.max(0, home.defenders - 4) * 0.08;
  homeScore += Math.max(0, home.forwards - away.defenders + 3) * 0.04;
  awayScore += Math.max(0, away.forwards - home.defenders + 3) * 0.04;

  if (home.midfield > away.midfield) notes.push(`${homeName}中场人数更厚`);
  if (away.midfield > home.midfield) notes.push(`${awayName}中场人数更厚`);
  if (home.width > away.width) notes.push(`${homeName}边路宽度更强`);
  if (away.width > home.width) notes.push(`${awayName}边路宽度更强`);
  if (home.defenders >= 5 || away.defenders >= 5) notes.push("五后卫/三中卫体系会压低空间");

  return {
    home: round(homeScore),
    away: round(awayScore),
    label: `${homeFormation} 对 ${awayFormation}：${notes.join("，") || "阵型克制不明显"}`
  };
}

function compareCoachStyles(homeProfile, awayProfile, coachPairHistory = {}) {
  const pairKey = coachPairKey(homeProfile.primaryCoach, awayProfile.primaryCoach);
  const pair = coachPairHistory[pairKey];
  let home = homeProfile.attackIndex * 0.12 - awayProfile.defenseIndex * 0.1 + homeProfile.rotationIndex * 0.04 - homeProfile.disciplineRisk * 0.04;
  let away = awayProfile.attackIndex * 0.12 - homeProfile.defenseIndex * 0.1 + awayProfile.rotationIndex * 0.04 - awayProfile.disciplineRisk * 0.04;
  if (pair?.played) {
    home += pair.homeCoachWins > pair.awayCoachWins ? 0.08 : 0;
    away += pair.awayCoachWins > pair.homeCoachWins ? 0.08 : 0;
  }
  return {
    home: round(home),
    away: round(away),
    label: `${homeProfile.primaryCoach}（${homeProfile.styleLabel}） vs ${awayProfile.primaryCoach}（${awayProfile.styleLabel}）${pair?.played ? `，历史交手${pair.played}场` : "，暂无直接教练交手样本"}`
  };
}

function comparePlayerRelations(homeRoster = {}, awayRoster = {}) {
  const homePlayers = homeRoster?.players || [];
  const awayPlayers = awayRoster?.players || [];
  const homeClubs = countBy(homePlayers.map(clubKey).filter(Boolean));
  const awayClubs = countBy(awayPlayers.map(clubKey).filter(Boolean));
  const homeLeagues = countBy(homePlayers.map(leagueKey).filter(Boolean));
  const awayLeagues = countBy(awayPlayers.map(leagueKey).filter(Boolean));
  const sharedClubs = sharedKeys(homeClubs, awayClubs);
  const sharedLeagues = sharedKeys(homeLeagues, awayLeagues);
  const teammatePairs = findTeammatePairs(homePlayers, awayPlayers);
  const homeCohesion = rosterCohesion(homePlayers);
  const awayCohesion = rosterCohesion(awayPlayers);
  const crossFamiliarity = Math.min(0.12, teammatePairs.length * 0.015 + sharedLeagues.length * 0.008);
  const label = teammatePairs.length || sharedLeagues.length
    ? `球员关系：现/曾同俱乐部${teammatePairs.length}对，同联赛${sharedLeagues.length}组；${leagueStyleLabel(homePlayers, awayPlayers)}`
    : "球员俱乐部/联赛关系暂无公开字段，按中性处理";
  return {
    home: round(homeCohesion - crossFamiliarity / 2),
    away: round(awayCohesion - crossFamiliarity / 2),
    label,
    sharedClubs,
    sharedLeagues,
    teammatePairs: teammatePairs.slice(0, 12),
    homeCohesion: round(homeCohesion),
    awayCohesion: round(awayCohesion)
  };
}

function findTeammatePairs(homePlayers, awayPlayers) {
  const pairs = [];
  for (const home of homePlayers) {
    const homeHistory = new Set((home.clubHistory || []).map((item) => item.id).filter(Boolean));
    if (home.clubId) homeHistory.add(home.clubId);
    for (const away of awayPlayers) {
      const awayHistory = new Set((away.clubHistory || []).map((item) => item.id).filter(Boolean));
      if (away.clubId) awayHistory.add(away.clubId);
      const clubId = [...homeHistory].find((id) => awayHistory.has(id));
      if (clubId) pairs.push({ homePlayer: home.name, awayPlayer: away.name, clubId, current: home.clubId === clubId && away.clubId === clubId });
    }
  }
  return pairs;
}

function rosterCohesion(players) {
  const clubs = countBy(players.map(clubKey).filter(Boolean));
  const leagues = countBy(players.map(leagueKey).filter(Boolean));
  const clubLinks = Object.values(clubs).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const leagueLinks = Object.values(leagues).reduce((sum, count) => sum + Math.max(0, count - 2), 0);
  return Math.min(0.2, clubLinks * 0.018 + leagueLinks * 0.006);
}

function leagueStyleLabel(homePlayers, awayPlayers) {
  const home = dominantValue(homePlayers.map((player) => player.leagueStyle));
  const away = dominantValue(awayPlayers.map((player) => player.leagueStyle));
  return `主队以${home || "综合联赛风格"}为主，客队以${away || "综合联赛风格"}为主`;
}

function dominantValue(values) {
  return Object.entries(countBy(values.filter(Boolean))).sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function clubKey(player) {
  return cleanKey(player.clubId || player.club);
}

function leagueKey(player) {
  return cleanKey(player.leagueId || player.league);
}

function addCoachPairHistory(history, event, summary, rosters) {
  if (!event.status?.completed) return;
  const homeCoach = rosters[event.homeTeamId]?.coaches?.[0]?.name;
  const awayCoach = rosters[event.awayTeamId]?.coaches?.[0]?.name;
  if (!homeCoach || !awayCoach) return;
  const key = coachPairKey(homeCoach, awayCoach);
  history[key] ||= { played: 0, homeCoach: homeCoach, awayCoach: awayCoach, homeCoachWins: 0, awayCoachWins: 0, draws: 0 };
  history[key].played += 1;
  if (event.score?.home > event.score?.away) history[key].homeCoachWins += 1;
  else if (event.score?.away > event.score?.home) history[key].awayCoachWins += 1;
  else history[key].draws += 1;
}

function formationShape(value) {
  const parts = String(value || "").split("-").map((item) => Number(item)).filter(Number.isFinite);
  const defenders = parts[0] || 4;
  const forwards = parts.at(-1) || 2;
  const midfield = parts.slice(1, -1).reduce((sum, item) => sum + item, 0) || Math.max(0, 10 - defenders - forwards);
  const width = (defenders >= 5 ? 1.1 : 0.8) + (forwards >= 3 ? 0.4 : 0) + (parts.length >= 4 ? 0.2 : 0);
  return { defenders, midfield, forwards, width };
}

function currentFormation(summary, teamId) {
  return normalizeFormation(summary?.starters?.find((item) => item.teamId === teamId)?.formation);
}

function normalizeFormation(value) {
  const text = String(value || "").trim();
  return /^\d(-\d)+$/.test(text) ? text : null;
}

function styleLabel(profile) {
  if (profile.defenseIndex >= 0.25 && profile.attackIndex < 0.1) return "防守优先/低位稳守";
  if (profile.attackIndex >= 0.25 && profile.pressIndex >= 0.15) return "主动进攻/高压倾向";
  if (profile.rotationIndex >= 0.12) return "临场换人积极";
  if (profile.disciplineRisk >= 0.5) return "对抗强硬/牌面风险偏高";
  return "均衡务实";
}

function compactProfile(profile) {
  return {
    teamId: profile.teamId,
    teamName: profile.teamName,
    coach: profile.primaryCoach,
    primaryFormation: profile.primaryFormation,
    styleLabel: profile.styleLabel,
    attackIndex: profile.attackIndex,
    defenseIndex: profile.defenseIndex,
    pressIndex: profile.pressIndex,
    rotationIndex: profile.rotationIndex,
    disciplineRisk: profile.disciplineRisk
  };
}

function coachPairKey(a, b) {
  return [a || "", b || ""].sort().join("::");
}

function countBy(items) {
  return items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
}

function sharedKeys(a, b) {
  return Object.keys(a).filter((key) => b[key]);
}

function cleanKey(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function average(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";

const LEAGUE_STYLES = {
  "eng.1": "高节奏压迫与快速转换",
  "esp.1": "技术控球与位置进攻",
  "ita.1": "战术纪律与防守组织",
  "ger.1": "纵向推进与高位压迫",
  "fra.1": "身体对抗与快速推进",
  "ned.1": "主动控球与空间轮转",
  "por.1": "技术推进与边路创造",
  "usa.1": "高强度跑动与攻防转换",
  "mex.1": "技术传控与高原节奏",
  "bra.1": "个人创造与快速进攻",
  "arg.1": "强对抗与直接推进",
  "ksa.1": "控球组织与中场推进"
};

// 球员画像跨刷新保留俱乐部和联赛历史，使当前同队与曾经同队关系可持续学习。
export async function enrichRostersWithPlayerProfiles(rosters = {}) {
  const state = await readJson(CONFIG.playerProfilesFile, { version: 1, updatedAt: null, players: {} });
  const now = new Date().toISOString();
  let clubCoverage = 0;
  let leagueCoverage = 0;

  for (const roster of Object.values(rosters)) {
    for (const player of roster.players || []) {
      const profile = state.players[player.id] || emptyProfile(player, roster);
      profile.name = player.name || profile.name;
      profile.nationalTeams = unique([...profile.nationalTeams, roster.teamId]);
      profile.clubHistory = updateHistory(profile.clubHistory, player.clubId, player.club, now);
      profile.leagueHistory = updateHistory(profile.leagueHistory, player.leagueId, player.league, now);
      profile.currentClubId = player.clubId || profile.currentClubId || null;
      profile.currentLeagueId = player.leagueId || profile.currentLeagueId || null;
      profile.leagueStyle = leagueStyle(profile.currentLeagueId);
      profile.updatedAt = now;
      state.players[player.id] = profile;

      player.clubId = profile.currentClubId;
      player.leagueId = profile.currentLeagueId;
      player.club = player.club || latestName(profile.clubHistory);
      player.league = player.league || latestName(profile.leagueHistory);
      player.leagueStyle = profile.leagueStyle;
      player.clubHistory = profile.clubHistory;
      player.leagueHistory = profile.leagueHistory;
      if (player.clubId) clubCoverage += 1;
      if (player.leagueId) leagueCoverage += 1;
    }
  }

  state.updatedAt = now;
  state.coverage = { players: Object.keys(state.players).length, club: clubCoverage, league: leagueCoverage };
  await writeJsonAtomic(CONFIG.playerProfilesFile, state);
  return { rosters, profiles: state };
}

export function leagueStyle(leagueId) {
  return LEAGUE_STYLES[String(leagueId || "").toLowerCase()] || "综合联赛风格";
}

function emptyProfile(player, roster) {
  return {
    playerId: player.id,
    name: player.name,
    nationalTeams: [roster.teamId],
    currentClubId: null,
    currentLeagueId: null,
    clubHistory: [],
    leagueHistory: [],
    leagueStyle: "综合联赛风格",
    updatedAt: null
  };
}

function updateHistory(items = [], id, name, now) {
  if (!id) return items;
  const next = items.map((item) => ({ ...item }));
  const existing = next.find((item) => item.id === id);
  if (existing) {
    existing.name = name || existing.name || null;
    existing.lastSeenAt = now;
  } else {
    next.push({ id, name: name || null, firstSeenAt: now, lastSeenAt: now });
  }
  return next.slice(-12);
}

function latestName(items = []) {
  return items.at(-1)?.name || null;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(temporary, file);
}

import { CONFIG } from "../../config.js";
import { fetchJson } from "../../utils/http.js";
import { normalizeName } from "../../utils/text.js";

// OpenFootball 作为赛程与分组的备用源，主要补 ESPN 有时缺失的 group/ground 字段。
export async function fetchOpenFootballSchedule() {
  const url = CONFIG.sources.openFootball;
  const raw = await fetchJson(url, { retries: 1 });
  const matches = (raw.matches || []).map((item, index) => ({
    id: `openfootball-${index + 1}`,
    date: item.date,
    time: item.time,
    round: item.round,
    group: item.group,
    ground: item.ground,
    team1: item.team1,
    team2: item.team2,
    key: buildMatchKey(item.date, item.team1, item.team2),
    score: item.score || null
  }));

  return { name: raw.name, matches, sourceUrl: url };
}

export function buildMatchKey(date, teamA, teamB) {
  const names = [normalizeName(teamA), normalizeName(teamB)].sort().join("-");
  return `${date}-${names}`;
}

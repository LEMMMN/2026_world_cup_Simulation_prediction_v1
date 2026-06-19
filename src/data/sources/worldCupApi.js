import { CONFIG } from "../../config.js";
import { fetchJson } from "../../utils/http.js";

// worldcup26.ir 只做球队分组、国旗和 ISO 代码补充，不覆盖 ESPN 的实时状态。
export async function fetchWorldCupApiTeams() {
  const url = CONFIG.sources.worldCupApi;
  const raw = await fetchJson(url, { retries: 1 });
  const teams = (raw.teams || []).map((team) => ({
    id: String(team.id || team._id || ""),
    name: team.name_en,
    abbreviation: team.fifa_code,
    group: team.groups,
    flag: team.flag,
    iso2: team.iso2
  }));

  return { teams, sourceUrl: url };
}

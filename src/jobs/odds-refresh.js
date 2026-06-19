import { buildActuaryMarkets, readOddsHistory, updateOddsHistory } from "../analysis/actuary.js";
import { buildOddsMarkets } from "../analysis/odds.js";
import { readCache, writeCache } from "../data/cache.js";
import { fetchEspnSummaries } from "../data/sources/espn.js";

// 十分钟任务只刷新赛况与赔率，避免重复运行天气、新闻、球员和蒙特卡洛沙盘。
const cached = await readCache();
if (!cached?.events?.length) throw new Error("缺少基础缓存，请先运行小时全量任务");

const summaryResult = await fetchEspnSummaries(cached.events);
const summaries = { ...(cached.summaries || {}), ...(summaryResult.summaries || {}) };
const oddsMarkets = buildOddsMarkets({ events: cached.events, summaries });
const history = await readOddsHistory();
const oddsActuary = buildActuaryMarkets({ events: cached.events, oddsMarkets, history });
const oddsHistory = await updateOddsHistory({ events: cached.events, oddsMarkets, actuaryMarkets: oddsActuary, analyses: cached.analyses || {} });

await writeCache({
  ...cached,
  summaries,
  oddsMarkets,
  oddsActuary,
  oddsHistory,
  meta: { ...cached.meta, oddsUpdatedAt: oddsHistory.updatedAt }
});

console.log(JSON.stringify({ ok: true, errors: summaryResult.errors?.length || 0, ...oddsHistory }));

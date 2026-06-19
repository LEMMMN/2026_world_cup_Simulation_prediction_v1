import { getWorldCupData } from "./data/collector.js";

// 手动/定时复盘入口：刷新全量数据，保存预测快照，并在有完赛和赛前快照时自动归因学习。
const data = await getWorldCupData({ force: true });
console.log(JSON.stringify({
  ok: true,
  updatedAt: data.meta.updatedAt,
  counts: data.meta.counts,
  learning: data.learning?.model || null,
  report: data.learning?.report || null
}, null, 2));

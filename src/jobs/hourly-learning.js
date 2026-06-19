import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CONFIG } from "../config.js";
import { getWorldCupData } from "../data/collector.js";

// 小时任务完成全量采集、复盘、校准与逐场沙盘，并保留七天压缩运行证据。
const data = await getWorldCupData({ force: true });
const generatedAt = new Date().toISOString();
const report = {
  generatedAt,
  dataUpdatedAt: data.meta.updatedAt,
  durationMs: data.meta.durationMs,
  model: data.learning?.model || null,
  groups: data.bracketOutlook?.qualificationForecast || null,
  events: Object.fromEntries(Object.entries(data.analyses || {}).map(([eventId, analysis]) => [eventId, {
    predictedScore: analysis.predictedScore,
    expectedGoals: analysis.expectedGoals,
    probabilities: analysis.probabilities,
    oddsActuary: analysis.oddsActuary,
    simulation: analysis.simulation
  }]))
};

await fs.mkdir(CONFIG.simulationRunsDir, { recursive: true });
const fileName = `simulation-${generatedAt.replace(/[:.]/g, "-")}.json.gz`;
await fs.writeFile(path.join(CONFIG.simulationRunsDir, fileName), gzipSync(JSON.stringify(report), { level: 6 }));
await retainRecentRuns(168);

console.log(JSON.stringify({
  ok: true,
  generatedAt,
  matches: data.events.length,
  reviews: data.learning?.model?.reviewCount || 0,
  backtest: data.learning?.model?.sandboxBacktest,
  oddsSnapshots: data.oddsHistory?.snapshotCount || 0,
  simulationFile: fileName
}));

async function retainRecentRuns(limit) {
  const files = (await fs.readdir(CONFIG.simulationRunsDir)).filter((name) => name.endsWith(".json.gz")).sort();
  await Promise.all(files.slice(0, -limit).map((name) => fs.unlink(path.join(CONFIG.simulationRunsDir, name))));
}

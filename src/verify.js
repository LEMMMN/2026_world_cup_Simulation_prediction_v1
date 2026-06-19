import fs from "node:fs/promises";
import { getWorldCupData } from "./data/collector.js";
import { CONFIG } from "./config.js";

// 功能校验脚本：刷新一次全量数据，并检查核心功能是否都有数据支撑。
const data = await getWorldCupData({ force: true });
const learningFile = await readJson(CONFIG.learningFile, { reviews: {} });
const oddsCoverage = Object.values(data.oddsMarkets || {}).filter((item) => item.primary || item.consensus).length;
const actuaryCoverage = Object.values(data.oddsActuary || {}).filter((item) => item.available).length;
const scoreOddsCoverage = Object.values(data.analyses || {}).filter((item) => item.scorePredictions?.every((score) => Number.isFinite(Number(score.houseOdds)))).length;
const scoreOptionCoverage = Object.values(data.analyses || {}).filter((item) => item.scorePredictions?.length === 5).length;
const tacticalAnalysisCoverage = Object.values(data.analyses || {}).filter((item) => item.tactics?.coach && item.tactics?.formation && item.tactics?.relations).length;
const simulationCoverage = Object.values(data.analyses || {}).filter((item) => item.simulation?.iterations >= 12000 && Math.abs(Object.values(item.simulation.probabilities || {}).reduce((sum, value) => sum + Number(value || 0), 0) - 1) <= 0.001).length;
const climateCoverage = Object.values(data.climateContexts || {}).filter((item) => item.home?.score >= 0 && item.away?.score >= 0).length;
const squadCoverage = Object.values(data.squadRatings || {}).filter((item) => item.playerCount > 0 && Number.isFinite(Number(item.teamScore))).length;
const forecastGroups = Object.keys(data.bracketOutlook?.qualificationForecast?.groups || {}).length;
const playerProfileCoverage = data.playerProfiles?.coverage || {};
const activeOddsSnapshots = Number(data.oddsHistory?.activeSnapshotCount ?? data.oddsHistory?.snapshotCount ?? 0);
const upgradedReviewCoverage = Object.values(learningFile.reviews || {}).filter((item) => item.reviewVersion === 5 && item.expectedGoals && item.tacticalSnapshot && item.top5Hit !== undefined && Array.isArray(item.scorePredictions) && Object.prototype.hasOwnProperty.call(item, "oddsActuarySnapshot") && Object.prototype.hasOwnProperty.call(item, "climateSnapshot") && Object.prototype.hasOwnProperty.call(item, "squadRatingsSnapshot")).length;
const checks = [
  ["赛程采集", data.events.length >= 100, `${data.events.length} 场`],
  ["球队采集", data.teams.length >= 48, `${data.teams.length} 支`],
  ["球员名单", Object.keys(data.rosters).length >= 40, `${Object.keys(data.rosters).length} 支球队有名单`],
  ["球员联赛画像", playerProfileCoverage.club >= 500 && playerProfileCoverage.league >= 500, `${playerProfileCoverage.club || 0} 名含俱乐部，${playerProfileCoverage.league || 0} 名含联赛`],
  ["首发/单场摘要", Object.keys(data.summaries).length >= 80, `${Object.keys(data.summaries).length} 场有摘要`],
  ["新闻动态", data.news.length > 0, `${data.news.length} 条`],
  ["天气采集", Object.keys(data.weather).length >= 80, `${Object.keys(data.weather).length} 场有天气对象`],
  ["近5场采集", Object.values(data.teamForms || {}).filter((item) => item.matches?.length >= 5).length >= 40, `${Object.values(data.teamForms || {}).filter((item) => item.matches?.length >= 5).length} 支球队有近5场`],
  ["历史交锋采集", Object.values(data.headToHeads || {}).filter((item) => item.records?.length).length >= 40, `${Object.values(data.headToHeads || {}).filter((item) => item.records?.length).length} 场有交锋记录`],
  ["32强路径", Object.keys(data.bracketOutlook?.teamPaths || {}).length >= 48, `${Object.keys(data.bracketOutlook?.teamPaths || {}).length} 支球队有路径分析`],
  ["赔率采集", oddsCoverage > 0, `${oddsCoverage}/${data.events.length} 场已有公开盘口`],
  ["赔率精算", actuaryCoverage > 0, `${actuaryCoverage}/${data.events.length} 场已有庄家边际分析`],
  ["比分赔率影响", scoreOddsCoverage === data.events.length, `${scoreOddsCoverage}/${data.events.length} 场五比分含理论赔率`],
  ["赔率快照", data.oddsHistory?.snapshotCount > 0, `${data.oddsHistory?.snapshotCount || 0} 条10分钟赔率快照`],
  ["赔率分片压缩", activeOddsSnapshots < CONFIG.oddsArchiveChunkSize, `活跃${activeOddsSnapshots}条，已压缩${data.oddsHistory?.archivedSnapshotCount || 0}条`],
  ["气候地理适应", climateCoverage === data.events.length, `${climateCoverage}/${data.events.length} 场含温差、湿度、时差和旅程分析`],
  ["阵容综合评分", squadCoverage >= 40, `${squadCoverage} 支球队含年龄与近期发挥评分`],
  ["小组晋级预测", forecastGroups >= 12, `${forecastGroups} 个小组含预测排名和晋级概率`],
  ["32强预测表", data.bracketOutlook?.projectedRoundOf32?.length >= 16, `${data.bracketOutlook?.projectedRoundOf32?.length || 0} 场预测对阵`],
  ["战术画像", Object.keys(data.tacticalProfiles?.teamProfiles || {}).length >= 40, `${Object.keys(data.tacticalProfiles?.teamProfiles || {}).length} 支球队有教练/阵型画像`],
  ["五比分概率", scoreOptionCoverage === data.events.length, `${scoreOptionCoverage}/${data.events.length} 场有五档比分概率`],
  ["战术因子分析", tacticalAnalysisCoverage === data.events.length, `${tacticalAnalysisCoverage}/${data.events.length} 场纳入教练/阵型/球员关系`],
  ["政治/旅行风险", Array.isArray(data.geopoliticalRisks?.articles), `${data.geopoliticalRisks?.articles?.length || 0} 条风险新闻线索`],
  ["学习复盘", Boolean(data.learning?.model), `${data.learning?.model?.reviewCount || 0} 场已复盘`],
  ["历史回填复盘", data.learning?.model?.backfillReviewCount > 0, `${data.learning?.model?.backfillReviewCount || 0} 场历史完赛已回填`],
  ["新版复盘升级", upgradedReviewCoverage >= data.learning?.model?.reviewCount, `${upgradedReviewCoverage}/${data.learning?.model?.reviewCount || 0} 场含五比分、气候、阵容、战术和精算快照`],
  ["学习归因结构", data.learning?.model && typeof data.learning.model.reasonStats === "object", `${Object.keys(data.learning?.model?.reasonStats || {}).length} 类偏差原因`],
  ["精算校准模型", data.learning?.model?.calibration?.version === 1, `${data.learning?.model?.calibration?.effectiveWeight || 0} 有效样本权重`],
  ["精算压力权重", Number.isFinite(Number(data.learning?.model?.calibration?.factorMultipliers?.["赔率精算压力"]?.multiplier)), `候选倍率${data.learning?.model?.calibration?.factorMultipliers?.["赔率精算压力"]?.multiplier || 1}`],
  ["走步沙盘回测", Boolean(data.learning?.model?.sandboxBacktest), `${data.learning?.model?.sandboxBacktest?.testCount || 0} 场留出测试`],
  ["多情景沙盘", simulationCoverage === data.events.length, `${simulationCoverage}/${data.events.length} 场完成概率守恒模拟`],
  ["回测部署门禁", data.learning?.model?.sandboxBacktest?.status === "accepted" || data.learning?.model?.calibration?.deploymentScale === 0, `状态${data.learning?.model?.sandboxBacktest?.status || "unknown"}，部署强度${data.learning?.model?.calibration?.deploymentScale ?? "-"}`],
  ["智能分析", Object.keys(data.analyses).length === data.events.length, `${Object.keys(data.analyses).length} 场有分析`]
];

let failed = false;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "通过" : "失败"} - ${name}: ${detail}`);
  if (!ok) failed = true;
}

console.log(`缓存时间: ${data.meta.updatedAt}`);
console.log(`采集耗时: ${data.meta.durationMs}ms`);
console.log(`来源状态: ${data.sources.status.map((item) => `${item.name}${item.ok ? "成功" : "失败"}`).join("；")}`);

if (failed) process.exit(1);

async function readJson(file, fallback) {
  // 校验脚本读取落盘学习文件，确认历史样本已经升级，而不是只看本次返回摘要。
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

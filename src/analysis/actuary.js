import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CONFIG } from "../config.js";

const OUTCOMES = ["home", "draw", "away"];

// 精算模块：记录赔率快照、计算庄家边际和盘口变化压力，只用于学习分析，不提供投注建议。
export async function readOddsHistory() {
  return normalizeHistory(await readJson(CONFIG.oddsHistoryFile, defaultHistory()));
}

export function buildActuaryMarkets({ events, oddsMarkets, history }) {
  return Object.fromEntries(events.map((event) => {
    const market = oddsMarkets[event.id];
    const snapshot = buildMarketSnapshot(event, market, new Date().toISOString());
    const previous = lastSnapshot(history?.events?.[event.id]?.snapshots);
    return [event.id, analyzeMarketSnapshot(snapshot, previous)];
  }));
}

export async function updateOddsHistory({ events, oddsMarkets, actuaryMarkets = {}, analyses = {} }) {
  const now = new Date().toISOString();
  const history = await readOddsHistory();
  let savedCount = 0;

  for (const event of events) {
    const snapshot = buildMarketSnapshot(event, oddsMarkets[event.id], now);
    if (!snapshot) continue;
    const eventHistory = history.events[event.id] || { eventId: event.id, snapshots: [] };
    const latest = lastSnapshot(eventHistory.snapshots);
    if (!shouldSaveSnapshot(latest, snapshot)) {
      history.events[event.id] = eventHistory;
      continue;
    }
    eventHistory.snapshots.push({
      ...snapshot,
      actuary: compactActuary(actuaryMarkets[event.id]),
      scorePrices: (analyses[event.id]?.scorePredictions || []).map(compactScorePrice)
    });
    eventHistory.snapshots = eventHistory.snapshots.slice(-144);
    history.events[event.id] = eventHistory;
    savedCount += 1;
  }

  history.updatedAt = now;
  history.intervalMinutes = CONFIG.oddsRefreshIntervalMs / 60 / 1000;
  const archived = await archiveSnapshotChunks(history, now);
  await writeJson(CONFIG.oddsHistoryFile, history);
  const activeSnapshotCount = countSnapshots(history);
  return {
    savedCount,
    eventCount: Object.keys(history.events).length,
    intervalMinutes: history.intervalMinutes,
    snapshotCount: activeSnapshotCount + safeNumber(history.archivedSnapshotCount),
    activeSnapshotCount,
    archivedSnapshotCount: safeNumber(history.archivedSnapshotCount),
    archiveCount: history.archives?.length || 0,
    archivedThisRun: archived,
    updatedAt: history.updatedAt
  };
}

async function archiveSnapshotChunks(history, now) {
  const chunkSize = Math.max(1000, Math.round(safeNumber(CONFIG.oddsArchiveChunkSize, 5000)));
  let archived = 0;
  let sequence = 0;
  while (countSnapshots(history) >= chunkSize) {
    // 每场至少保留最近两条供盘口变化计算，其余按全局时间从旧到新归档。
    const candidates = Object.values(history.events).flatMap((event) => (event.snapshots || [])
      .slice(0, -2)
      .map((snapshot) => ({ eventId: event.eventId, capturedAt: snapshot.capturedAt, snapshot })))
      .sort((left, right) => new Date(left.capturedAt) - new Date(right.capturedAt));
    if (candidates.length < chunkSize) break;
    const chunk = candidates.slice(0, chunkSize);
    const selected = new Set(chunk.map((item) => `${item.eventId}:${item.capturedAt}`));
    for (const event of Object.values(history.events)) {
      event.snapshots = (event.snapshots || []).filter((snapshot) => !selected.has(`${event.eventId}:${snapshot.capturedAt}`));
    }

    await fs.mkdir(CONFIG.oddsArchivesDir, { recursive: true });
    const stamp = now.replace(/[:.]/g, "-");
    const fileName = `odds-${stamp}-${String(sequence).padStart(2, "0")}-${chunkSize}.jsonl.gz`;
    const lines = chunk.map((item) => JSON.stringify({ eventId: item.eventId, ...item.snapshot })).join("\n") + "\n";
    await fs.writeFile(path.join(CONFIG.oddsArchivesDir, fileName), gzipSync(lines, { level: 6 }));
    history.archives ||= [];
    history.archives.push({ file: fileName, count: chunk.length, firstCapturedAt: chunk[0]?.capturedAt, lastCapturedAt: chunk.at(-1)?.capturedAt, createdAt: now });
    history.archivedSnapshotCount = safeNumber(history.archivedSnapshotCount) + chunk.length;
    archived += chunk.length;
    sequence += 1;
  }
  return archived;
}

function countSnapshots(history) {
  return Object.values(history.events || {}).reduce((sum, item) => sum + (item.snapshots?.length || 0), 0);
}

export function enrichScorePredictionsWithActuary(rows, actuaryMarket) {
  const margin = clamp(safeNumber(actuaryMarket?.marketMargin, 0.06), 0.03, 0.18);
  const enriched = (rows || []).map((row) => {
    const probability = clamp(safeNumber(row.probability), 0.0001, 0.95);
    const fairOdds = 1 / probability;
    const houseOdds = fairOdds / (1 + margin);
    const liabilityIndex = houseOdds;
    const bookmakerScore = probability / Math.max(0.01, houseOdds) + margin;
    return {
      ...row,
      fairOdds: round2(fairOdds),
      houseOdds: round2(houseOdds),
      bookmakerMargin: round(margin),
      bookmakerEdge: percent(margin / (1 + margin)),
      liabilityIndex: round2(liabilityIndex),
      bookmakerScore: round(bookmakerScore),
      houseLabel: liabilityIndex <= 8 ? "庄家低赔付压力" : liabilityIndex <= 14 ? "庄家中等赔付压力" : "庄家高赔付压力"
    };
  });
  const safest = enriched.slice().sort((a, b) => b.bookmakerScore - a.bookmakerScore)[0] || null;
  return {
    rows: enriched,
    summary: safest ? {
      safestScore: safest.label,
      safestScorePercent: safest.percent,
      fairOdds: safest.fairOdds,
      houseOdds: safest.houseOdds,
      label: `${safest.label} 是当前前三比分里庄家赔付压力最低的模型化比分，理论庄家赔率约 ${safest.houseOdds}`
    } : null
  };
}

function analyzeMarketSnapshot(snapshot, previous) {
  if (!snapshot) {
    return {
      available: false,
      label: "暂无可用赔率，精算压力按中性处理",
      influence: { home: 0, away: 0, totalGoals: 0 }
    };
  }

  const movement = buildMovement(snapshot, previous);
  const pressures = buildOutcomePressures(snapshot);
  const bestForBook = pressures.slice().sort((a, b) => b.bookmakerEdge - a.bookmakerEdge || a.decimalOdds - b.decimalOdds)[0] || null;
  const publicLean = OUTCOMES.slice().sort((a, b) => safeNumber(snapshot.implied[b]) - safeNumber(snapshot.implied[a]))[0];
  const volatility = round(OUTCOMES.reduce((sum, key) => sum + Math.abs(movement[key] || 0), 0) + Math.abs(movement.overUnder || 0) * 0.02);
  const influence = {
    home: clamp(safeNumber(movement.home) * 1.6, -0.18, 0.18),
    away: clamp(safeNumber(movement.away) * 1.6, -0.18, 0.18),
    totalGoals: clamp(safeNumber(movement.overUnder) * 0.06, -0.2, 0.2)
  };

  return {
    available: true,
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    providerCount: snapshot.providerCount,
    implied: snapshot.implied,
    rawImplied: snapshot.rawImplied,
    overround: snapshot.overround,
    marketMargin: snapshot.margin,
    overUnder: snapshot.overUnder,
    movement,
    volatility,
    pressures,
    bestForBook,
    publicLean,
    influence,
    label: buildActuaryLabel(snapshot, movement, bestForBook, publicLean)
  };
}

function buildMarketSnapshot(event, market, capturedAt) {
  const consensus = market?.consensus || {};
  const primary = market?.primary || {};
  const implied = consensus.implied || primary.implied;
  if (!implied) return null;
  const rawImplied = consensus.rawImplied || primary.rawImplied || implied;
  return {
    eventId: event.id,
    capturedAt,
    source: market.source || "ESPN odds / sportsbook feed",
    providerCount: market.providerCount || market.markets?.length || 0,
    provider: primary.provider || "境外市场",
    implied: roundOutcome(implied),
    rawImplied: roundOutcome(rawImplied),
    moneyline: primary.moneyline || null,
    decimalOdds: primary.decimalOdds || decimalFromRaw(rawImplied),
    overround: round(consensus.overround || primary.overround || sum(rawImplied)),
    margin: round(consensus.margin || primary.margin || Math.max(0, sum(rawImplied) - 1)),
    overUnder: Number.isFinite(Number(consensus.overUnder || primary.overUnder)) ? Number(consensus.overUnder || primary.overUnder) : null,
    favorite: consensus.favorite || primary.favorite || null
  };
}

function buildMovement(snapshot, previous) {
  if (!previous) {
    return { home: 0, draw: 0, away: 0, overUnder: 0, margin: 0, label: "首次赔率快照，等待下一次10分钟刷新形成变化趋势" };
  }
  const movement = {
    home: round(snapshot.implied.home - safeNumber(previous.implied?.home)),
    draw: round(snapshot.implied.draw - safeNumber(previous.implied?.draw)),
    away: round(snapshot.implied.away - safeNumber(previous.implied?.away)),
    overUnder: round(safeNumber(snapshot.overUnder) - safeNumber(previous.overUnder)),
    margin: round(snapshot.margin - safeNumber(previous.margin))
  };
  const biggest = OUTCOMES.slice().sort((a, b) => Math.abs(movement[b]) - Math.abs(movement[a]))[0];
  movement.label = Math.abs(movement[biggest]) >= 0.005
    ? `${outcomeName(biggest)}隐含概率${movement[biggest] > 0 ? "上升" : "下降"}${percent(Math.abs(movement[biggest]))}`
    : "胜平负盘口变化较小";
  return movement;
}

function buildOutcomePressures(snapshot) {
  return OUTCOMES.map((outcome) => {
    const raw = safeNumber(snapshot.rawImplied?.[outcome]);
    const noVig = safeNumber(snapshot.implied?.[outcome]);
    const decimalOdds = safeNumber(snapshot.decimalOdds?.[outcome], raw ? 1 / raw : 0);
    const bookmakerEdge = Math.max(0, raw - noVig);
    return {
      outcome,
      label: outcomeName(outcome),
      implied: noVig,
      rawImplied: raw,
      decimalOdds: round2(decimalOdds),
      bookmakerEdge: round(bookmakerEdge),
      bookmakerEdgeText: percent(bookmakerEdge),
      payoutPressure: round(noVig * decimalOdds)
    };
  });
}

function buildActuaryLabel(snapshot, movement, bestForBook, publicLean) {
  const marginText = percent(snapshot.margin);
  const safeText = bestForBook ? `${bestForBook.label}对庄家边际最高（${bestForBook.bookmakerEdgeText}）` : "庄家边际待补全";
  return `庄家水位约${marginText}，${safeText}；市场倾向${outcomeName(publicLean)}，${movement.label}`;
}

function shouldSaveSnapshot(latest, snapshot) {
  if (!latest) return true;
  const gapMs = new Date(snapshot.capturedAt).getTime() - new Date(latest.capturedAt).getTime();
  if (gapMs >= CONFIG.oddsRefreshIntervalMs) return true;
  return OUTCOMES.some((key) => Math.abs(safeNumber(snapshot.implied[key]) - safeNumber(latest.implied?.[key])) >= 0.01)
    || Math.abs(safeNumber(snapshot.margin) - safeNumber(latest.margin)) >= 0.005;
}

function compactActuary(item = {}) {
  return {
    marketMargin: item.marketMargin,
    overround: item.overround,
    movement: item.movement,
    bestForBook: item.bestForBook,
    publicLean: item.publicLean,
    volatility: item.volatility,
    label: item.label
  };
}

function compactScorePrice(item = {}) {
  return {
    label: item.label,
    probability: item.probability,
    percent: item.percent,
    fairOdds: item.fairOdds,
    houseOdds: item.houseOdds,
    bookmakerEdge: item.bookmakerEdge,
    houseLabel: item.houseLabel
  };
}

function defaultHistory() {
  return {
    updatedAt: null,
    intervalMinutes: CONFIG.oddsRefreshIntervalMs / 60 / 1000,
    archivedSnapshotCount: 0,
    archives: [],
    events: {}
  };
}

function normalizeHistory(history) {
  const base = defaultHistory();
  return {
    ...base,
    ...history,
    archivedSnapshotCount: safeNumber(history.archivedSnapshotCount),
    archives: history.archives || [],
    events: history.events || {}
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

function lastSnapshot(items = []) {
  return items.filter(Boolean).slice().sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0] || null;
}

function roundOutcome(values = {}) {
  return {
    home: round(values.home),
    draw: round(values.draw),
    away: round(values.away)
  };
}

function decimalFromRaw(rawImplied = {}) {
  return Object.fromEntries(OUTCOMES.map((key) => [key, rawImplied[key] ? round2(1 / rawImplied[key]) : null]));
}

function outcomeName(value) {
  return { home: "主胜", draw: "平局", away: "客胜" }[value] || "未知结果";
}

function percent(value) {
  return `${Math.round(safeNumber(value) * 1000) / 10}%`;
}

function sum(values = {}) {
  return OUTCOMES.reduce((total, key) => total + safeNumber(values[key]), 0);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

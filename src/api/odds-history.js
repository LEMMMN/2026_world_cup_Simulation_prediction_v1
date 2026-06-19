import { CONFIG } from "../config.js";
import { readJsonFile } from "./json-file.js";

const DEFAULT_SNAPSHOT_LIMIT = 72;
const SNAPSHOT_FIELDS = ["capturedAt", "implied", "moneyline", "decimalOdds", "margin", "overUnder", "actuary", "scorePrices"];

// 指定比赛时返回最近快照，未指定时只返回全局与逐场摘要。
export async function getOddsHistoryResponse(eventId, limit = DEFAULT_SNAPSHOT_LIMIT) {
  const history = await readJsonFile(CONFIG.oddsHistoryFile, { updatedAt: null, intervalMinutes: null, events: {} });
  if (!eventId) return summarizeOddsHistory(history);

  const event = history.events?.[eventId];
  if (!event) return null;

  const snapshots = sortSnapshots(event.snapshots).slice(-limit).map(compactSnapshot);
  return {
    eventId,
    updatedAt: history.updatedAt || null,
    intervalMinutes: history.intervalMinutes ?? null,
    snapshotCount: event.snapshots?.length || 0,
    returnedCount: snapshots.length,
    snapshots
  };
}

export function summarizeOddsHistory(history = {}) {
  const events = Object.values(history.events || {}).map((event) => {
    const snapshots = sortSnapshots(event.snapshots);
    return {
      eventId: String(event.eventId || ""),
      snapshotCount: snapshots.length,
      firstCapturedAt: snapshots[0]?.capturedAt || null,
      lastCapturedAt: snapshots.at(-1)?.capturedAt || null,
      latest: snapshots.length ? compactSummarySnapshot(snapshots.at(-1)) : null
    };
  });

  return {
    updatedAt: history.updatedAt || null,
    intervalMinutes: history.intervalMinutes ?? null,
    eventCount: events.length,
    snapshotCount: events.reduce((sum, event) => sum + event.snapshotCount, 0) + Number(history.archivedSnapshotCount || 0),
    activeSnapshotCount: events.reduce((sum, event) => sum + event.snapshotCount, 0),
    archivedSnapshotCount: Number(history.archivedSnapshotCount || 0),
    archiveCount: history.archives?.length || 0,
    events
  };
}

function compactSnapshot(snapshot = {}) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, snapshot[field]]));
}

function compactSummarySnapshot(snapshot = {}) {
  return {
    capturedAt: snapshot.capturedAt,
    implied: snapshot.implied,
    margin: snapshot.margin,
    overUnder: snapshot.overUnder,
    actuary: {
      bestForBook: snapshot.actuary?.bestForBook || null,
      publicLean: snapshot.actuary?.publicLean || null,
      volatility: snapshot.actuary?.volatility ?? null,
      label: snapshot.actuary?.label || null
    }
  };
}

function sortSnapshots(snapshots = []) {
  return snapshots.filter(Boolean).slice().sort((left, right) => timestamp(left.capturedAt) - timestamp(right.capturedAt));
}

function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

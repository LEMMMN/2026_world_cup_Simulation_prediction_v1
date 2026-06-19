// 首屏接口只组装列表与汇总数据，详情重对象继续由原有接口按需提供。
export function buildOverview(data = {}) {
  return {
    meta: data.meta || {},
    events: data.events || [],
    teams: data.teams || [],
    news: data.news || [],
    sources: data.sources || {},
    learning: { model: data.learning?.model || {} },
    oddsHistory: compactOddsSummary(data.oddsHistory, data.oddsMarkets),
    bracketOutlook: compactBracketOutlook(data.bracketOutlook)
  };
}

function compactOddsSummary(history = {}, markets = {}) {
  return {
    updatedAt: history.updatedAt || null,
    intervalMinutes: history.intervalMinutes ?? null,
    savedCount: history.savedCount ?? null,
    eventCount: history.eventCount || 0,
    snapshotCount: history.snapshotCount || 0,
    activeSnapshotCount: history.activeSnapshotCount ?? history.snapshotCount ?? 0,
    archivedSnapshotCount: history.archivedSnapshotCount || 0,
    archiveCount: history.archiveCount || 0,
    eventIds: Object.entries(markets || {})
      .filter(([, market]) => market?.primary || market?.consensus)
      .map(([eventId]) => eventId)
  };
}

function compactBracketOutlook(outlook = {}) {
  return {
    updatedAt: outlook.updatedAt || null,
    rules: outlook.rules || {},
    tables: outlook.tables || {},
    qualificationForecast: outlook.qualificationForecast || {},
    roundOf32: outlook.roundOf32 || [],
    projectedRoundOf32: outlook.projectedRoundOf32 || [],
    source: outlook.source || null
  };
}

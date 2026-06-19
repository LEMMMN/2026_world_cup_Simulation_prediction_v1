// 赔率模块：从 ESPN 返回的境外 sportsbook odds 中提取市场概率，只做学习分析，不提供投注建议。
export function buildOddsMarkets({ events, summaries }) {
  return Object.fromEntries(events.map((event) => {
    const odds = summaries[event.id]?.odds || [];
    return [event.id, normalizeEventOdds(event, odds)];
  }));
}

function normalizeEventOdds(event, odds) {
  const markets = odds.map((item) => normalizeProviderOdds(event, item)).filter(Boolean);
  const primary = markets[0] || null;
  return {
    eventId: event.id,
    source: "ESPN odds / sportsbook feed",
    providerCount: markets.length,
    primary,
    markets,
    consensus: buildConsensus(markets)
  };
}

function normalizeProviderOdds(event, item) {
  const homeId = event.homeTeamId;
  const awayId = event.awayTeamId;
  const homeMoneyLine = item.homeTeamOdds?.moneyLine ?? americanFromDisplay(item.moneyline?.home?.close?.odds);
  const awayMoneyLine = item.awayTeamOdds?.moneyLine ?? americanFromDisplay(item.moneyline?.away?.close?.odds);
  const drawMoneyLine = item.drawOdds?.moneyLine ?? americanFromDisplay(item.moneyline?.draw?.close?.odds);
  if (![homeMoneyLine, awayMoneyLine, drawMoneyLine].some((value) => Number.isFinite(Number(value)))) return null;

  const rawImplied = {
    home: impliedProbability(homeMoneyLine),
    draw: impliedProbability(drawMoneyLine),
    away: impliedProbability(awayMoneyLine)
  };
  const overround = Object.values(rawImplied).reduce((sum, value) => sum + safeNumber(value), 0);
  const implied = normalizeNoVig(rawImplied);

  return {
    provider: item.provider?.name || "Unknown",
    details: item.details,
    homeTeamId: homeId,
    awayTeamId: awayId,
    moneyline: {
      home: homeMoneyLine,
      draw: drawMoneyLine,
      away: awayMoneyLine
    },
    decimalOdds: {
      home: decimalFromAmerican(homeMoneyLine),
      draw: decimalFromAmerican(drawMoneyLine),
      away: decimalFromAmerican(awayMoneyLine)
    },
    rawImplied: roundImplied(rawImplied),
    implied,
    overround: round(overround),
    margin: round(Math.max(0, overround - 1)),
    spread: Number.isFinite(Number(item.spread)) ? Number(item.spread) : null,
    overUnder: Number.isFinite(Number(item.overUnder)) ? Number(item.overUnder) : null,
    movement: {
      home: lineMovement(item.moneyline?.home),
      draw: lineMovement(item.moneyline?.draw),
      away: lineMovement(item.moneyline?.away)
    },
    favorite: implied.home > implied.away && implied.home > implied.draw ? "home"
      : implied.away > implied.home && implied.away > implied.draw ? "away"
        : "draw"
  };
}

function buildConsensus(markets) {
  if (!markets.length) return null;
  const totals = markets.reduce((acc, market) => {
    acc.home += market.implied.home;
    acc.draw += market.implied.draw;
    acc.away += market.implied.away;
    acc.rawHome += market.rawImplied?.home || 0;
    acc.rawDraw += market.rawImplied?.draw || 0;
    acc.rawAway += market.rawImplied?.away || 0;
    acc.margin += market.margin || 0;
    acc.overround += market.overround || 0;
    if (Number.isFinite(market.overUnder)) {
      acc.overUnder += market.overUnder;
      acc.overUnderCount += 1;
    }
    return acc;
  }, { home: 0, draw: 0, away: 0, rawHome: 0, rawDraw: 0, rawAway: 0, margin: 0, overround: 0, overUnder: 0, overUnderCount: 0 });
  return {
    implied: {
      home: round(totals.home / markets.length),
      draw: round(totals.draw / markets.length),
      away: round(totals.away / markets.length)
    },
    rawImplied: {
      home: round(totals.rawHome / markets.length),
      draw: round(totals.rawDraw / markets.length),
      away: round(totals.rawAway / markets.length)
    },
    overround: round(totals.overround / markets.length),
    margin: round(totals.margin / markets.length),
    overUnder: totals.overUnderCount ? round(totals.overUnder / totals.overUnderCount) : null,
    favorite: totals.home > totals.away && totals.home > totals.draw ? "home"
      : totals.away > totals.home && totals.away > totals.draw ? "away"
        : "draw"
  };
}

function impliedProbability(american) {
  const value = Number(american);
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 100 / (value + 100) : Math.abs(value) / (Math.abs(value) + 100);
}

function normalizeNoVig(probabilities) {
  const total = Object.values(probabilities).reduce((sum, value) => sum + safeNumber(value), 0);
  if (!total) return { home: 0, draw: 0, away: 0 };
  return {
    home: round(probabilities.home / total),
    draw: round(probabilities.draw / total),
    away: round(probabilities.away / total)
  };
}

function americanFromDisplay(value) {
  if (value === undefined || value === null) return null;
  const number = Number(String(value).replace("+", ""));
  return Number.isFinite(number) ? number : null;
}

function decimalFromAmerican(american) {
  const value = Number(american);
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? round(1 + value / 100) : round(1 + 100 / Math.abs(value));
}

function lineMovement(side = {}) {
  const open = americanFromDisplay(side.open?.odds);
  const close = americanFromDisplay(side.close?.odds);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
  return close - open;
}

function roundImplied(probabilities) {
  return {
    home: round(probabilities.home),
    draw: round(probabilities.draw),
    away: round(probabilities.away)
  };
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

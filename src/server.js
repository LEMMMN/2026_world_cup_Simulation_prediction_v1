import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { getWorldCupData } from "./data/collector.js";
import { getLearningResponse } from "./api/learning.js";
import { getOddsHistoryResponse } from "./api/odds-history.js";
import { buildOverview } from "./api/overview.js";
import { readJsonFile } from "./api/json-file.js";
import { authorizeAdmin, createRefreshLimiter } from "./api/security.js";

const consumeRefreshQuota = createRefreshLimiter();

// 零依赖 HTTP 服务：同时提供 API 和静态前端页面。
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message, stack: process.env.NODE_ENV === "development" ? error.stack : undefined });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`世界杯采集器已启动: http://${CONFIG.host}:${CONFIG.port}`);
  if (CONFIG.backgroundJobsEnabled) {
    startBackgroundLearningCycle();
    startBackgroundOddsCycle();
  }
});

function startBackgroundLearningCycle() {
  // 服务运行期间按配置周期刷新数据并触发赛后复盘；失败只记录日志，不影响网页访问。
  setInterval(async () => {
    try {
      const data = await getWorldCupData({ force: true });
      console.log(`自动学习复盘完成: ${data.meta.updatedAt}，已复盘 ${data.learning?.model?.reviewCount || 0} 场`);
    } catch (error) {
      console.error(`自动学习复盘失败: ${error.message}`);
    }
  }, CONFIG.learning.intervalMs).unref?.();
}

function startBackgroundOddsCycle() {
  // 赔率刷新频率更高，只刷新公开数据并保存盘口快照；学习报告仍按6小时节奏落盘。
  setInterval(async () => {
    try {
      const data = await getWorldCupData({ force: true });
      console.log(`10分钟赔率刷新完成: ${data.meta.updatedAt}，赔率快照 ${data.oddsHistory?.snapshotCount || 0} 条`);
    } catch (error) {
      console.error(`10分钟赔率刷新失败: ${error.message}`);
    }
  }, CONFIG.oddsRefreshIntervalMs).unref?.();
}

async function handleApi(request, response, url) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.setHeader("referrer-policy", "same-origin");

  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/data") {
    if (!requireAdmin(request, response)) return;
    const data = await getWorldCupData({ force: false });
    sendJson(response, 200, { ok: true, data });
    return;
  }

  if (url.pathname === "/api/refresh") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "刷新接口仅允许 POST" });
      return;
    }
    if (!requireAdmin(request, response)) return;
    const quota = consumeRefreshQuota();
    if (!quota.ok) {
      response.setHeader("retry-after", quota.retryAfterSeconds);
      sendJson(response, quota.statusCode, { ok: false, error: quota.error });
      return;
    }
    const data = await getWorldCupData({ force: true });
    sendJson(response, 200, { ok: true, data: buildOverview(data) });
    return;
  }

  if (url.pathname === "/api/learning") {
    const learning = await getLearningResponse();
    sendJson(response, 200, { ok: true, data: learning, meta: { updatedAt: learning.updatedAt } });
    return;
  }

  if (url.pathname === "/api/odds-history") {
    const eventId = url.searchParams.get("eventId");
    const oddsHistory = await getOddsHistoryResponse(eventId);
    if (eventId && !oddsHistory) {
      sendJson(response, 404, { ok: false, error: "赔率历史不存在" });
      return;
    }
    sendJson(response, 200, { ok: true, data: oddsHistory, meta: { updatedAt: oddsHistory.updatedAt } });
    return;
  }

  if (url.pathname === "/api/overview") {
    // 普通打开网页直接读取落盘缓存，手动刷新时才等待全量采集。
    const force = url.searchParams.get("refresh") === "1";
    if (force && !requireAdmin(request, response)) return;
    const cached = force ? null : await readJsonFile(CONFIG.cacheFile, null);
    const data = cached?.events?.length ? cached : await getWorldCupData({ force });
    sendJson(response, 200, { ok: true, data: buildOverview(data) });
    return;
  }

  const data = await getWorldCupData({ force: false });

  if (url.pathname === "/api/events") {
    sendJson(response, 200, { ok: true, data: data.events, meta: data.meta });
    return;
  }

  if (url.pathname === "/api/teams") {
    const teams = data.teams.map((team) => ({ ...team, rosterCount: data.rosters[team.id]?.players?.length || 0 }));
    sendJson(response, 200, { ok: true, data: teams, meta: data.meta });
    return;
  }

  const teamMatch = url.pathname.match(/^\/api\/team\/([^/]+)$/);
  if (teamMatch) {
    const teamId = decodeURIComponent(teamMatch[1]);
    const team = data.teams.find((item) => item.id === teamId);
    if (!team) {
      sendJson(response, 404, { ok: false, error: "球队不存在" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      data: {
        team,
        roster: data.rosters[teamId] || null,
        squadRating: data.squadRatings?.[teamId] || null,
        form: data.teamForms?.[teamId] || null,
        bracketPath: data.bracketOutlook?.teamPaths?.[teamId] || null,
        qualificationForecast: data.bracketOutlook?.teamPaths?.[teamId]?.forecast || null,
        groupTable: data.bracketOutlook?.tables?.[normalizeGroupKey(team.group)] || null,
        politicalRisk: data.geopoliticalRisks?.teamRisks?.[teamId] || null,
        matches: data.events.filter((event) => event.homeTeamId === teamId || event.awayTeamId === teamId),
        news: data.news.filter((item) => `${item.title || ""} ${item.description || ""}`.toLowerCase().includes(team.name.toLowerCase()))
      },
      meta: data.meta
    });
    return;
  }

  const matchMatch = url.pathname.match(/^\/api\/match\/([^/]+)$/);
  if (matchMatch) {
    const eventId = decodeURIComponent(matchMatch[1]);
    const event = data.events.find((item) => item.id === eventId);
    if (!event) {
      sendJson(response, 404, { ok: false, error: "比赛不存在" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      data: {
        event,
        summary: data.summaries[eventId] || null,
        headToHead: data.headToHeads?.[eventId] || null,
        teamForms: {
          home: data.teamForms?.[event.homeTeamId] || null,
          away: data.teamForms?.[event.awayTeamId] || null
        },
        bracketPaths: {
          home: data.bracketOutlook?.teamPaths?.[event.homeTeamId] || null,
          away: data.bracketOutlook?.teamPaths?.[event.awayTeamId] || null
        },
        groupTable: data.bracketOutlook?.tables?.[normalizeGroupKey(event.group)] || null,
        oddsMarket: data.oddsMarkets?.[eventId] || null,
        oddsActuary: data.oddsActuary?.[eventId] || null,
        climate: data.climateContexts?.[eventId] || null,
        squadRatings: {
          home: data.squadRatings?.[event.homeTeamId] || null,
          away: data.squadRatings?.[event.awayTeamId] || null
        },
        politicalRisk: data.geopoliticalRisks?.eventRisks?.[eventId] || null,
        weather: data.weather[eventId] || null,
        analysis: data.analyses[eventId] || null,
        news: data.news.slice(0, 30)
      },
      meta: data.meta
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "接口不存在" });
}

function requireAdmin(request, response) {
  const authorization = authorizeAdmin(request, CONFIG.refreshToken);
  if (authorization.ok) return true;
  sendJson(response, authorization.statusCode, { ok: false, error: authorization.error });
  return false;
}

async function serveStatic(response, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(CONFIG.publicDir, safePath);
  if (!filePath.startsWith(CONFIG.publicDir)) {
    sendText(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    sendBuffer(response, 200, content, mimeType(filePath));
  } catch (error) {
    if (error.code === "ENOENT") {
      const fallback = await fs.readFile(path.join(CONFIG.publicDir, "index.html"));
      sendBuffer(response, 200, fallback, "text/html; charset=utf-8");
      return;
    }
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  const spacing = process.env.NODE_ENV === "development" ? 2 : 0;
  sendText(response, statusCode, JSON.stringify(payload, null, spacing), "application/json; charset=utf-8");
}

function sendText(response, statusCode, text, contentType) {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(text);
}

function sendBuffer(response, statusCode, buffer, contentType) {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(buffer);
}

function normalizeGroupKey(value) {
  // ESPN 和补充源的小组字段写法不同，接口统一转成 A-L 方便读取积分榜。
  const match = String(value || "").match(/(?:Group\s*)?([A-L])$/i);
  return match ? match[1].toUpperCase() : value;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

import { CONFIG } from "../config.js";

// 统一 fetch，集中处理超时、重试和来源标识，便于后续替换采集源。
export async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs || CONFIG.fetchTimeoutMs;
  const retries = options.retries ?? 1;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "WorldCupCollector/1.0 (+local-learning-project)",
          accept: options.accept || "*/*",
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(500 + attempt * 500);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// JSON 抓取单独封装，保留原始错误上下文方便页面展示采集状态。
export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, accept: "application/json,text/plain,*/*" });
  return JSON.parse(text);
}

// 简单并发池，避免一次性请求 48 支球队或 104 场比赛把远端打爆。
export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

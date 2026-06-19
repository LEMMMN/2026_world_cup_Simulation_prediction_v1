import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";

// 缓存保存在挂载盘 data/cache.json，离线打开页面时也能看到上次采集结果。
export async function readCache() {
  try {
    const text = await fs.readFile(CONFIG.cacheFile, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCache(payload) {
  await fs.mkdir(path.dirname(CONFIG.cacheFile), { recursive: true });
  const tmpFile = `${CONFIG.cacheFile}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpFile, CONFIG.cacheFile);
}

export function isFresh(cache) {
  if (!cache?.meta?.updatedAt) return false;
  return Date.now() - new Date(cache.meta.updatedAt).getTime() < CONFIG.cacheMaxAgeMs;
}

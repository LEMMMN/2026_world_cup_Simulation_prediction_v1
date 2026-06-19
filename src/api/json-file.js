import fs from "node:fs/promises";

// 统一处理 API 数据文件缺失，避免各路由重复容错代码。
export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

import crypto from "node:crypto";

// 管理接口使用定长 Bearer Token，避免密钥比较泄露时序信息。
export function authorizeAdmin(request, expectedToken) {
  if (!expectedToken) return { ok: false, statusCode: 503, error: "服务器未配置管理令牌" };
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);
  const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return valid ? { ok: true } : { ok: false, statusCode: 401, error: "管理令牌无效" };
}

export function createRefreshLimiter(intervalMs = 60_000) {
  let lastRefreshAt = 0;
  return () => {
    const remainingMs = intervalMs - (Date.now() - lastRefreshAt);
    if (remainingMs > 0) {
      return { ok: false, statusCode: 429, error: "刷新请求过于频繁", retryAfterSeconds: Math.ceil(remainingMs / 1000) };
    }
    lastRefreshAt = Date.now();
    return { ok: true };
  };
}

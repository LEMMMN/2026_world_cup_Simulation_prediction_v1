import path from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录始终定位到挂载盘里的当前项目，避免运行目录变化导致文件写到别处。
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIG = {
  rootDir: ROOT_DIR,
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8787),
  refreshToken: process.env.REFRESH_TOKEN || "",
  backgroundJobsEnabled: process.env.BACKGROUND_JOBS !== "false",
  cacheFile: path.join(ROOT_DIR, "data", "cache.json"),
  predictionSnapshotsFile: path.join(ROOT_DIR, "data", "prediction-snapshots.json"),
  oddsHistoryFile: path.join(ROOT_DIR, "data", "odds-history.json"),
  oddsArchivesDir: path.join(ROOT_DIR, "data", "odds-archives"),
  playerProfilesFile: path.join(ROOT_DIR, "data", "player-profiles.json"),
  simulationRunsDir: path.join(ROOT_DIR, "data", "simulation-runs"),
  learningFile: path.join(ROOT_DIR, "data", "learning.json"),
  learningReportsDir: path.join(ROOT_DIR, "data", "learning-reports"),
  publicDir: path.join(ROOT_DIR, "public"),
  cacheMaxAgeMs: Number(process.env.CACHE_MAX_AGE_MS || 4 * 60 * 1000),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 16 * 1000),
  oddsRefreshIntervalMs: Number(process.env.ODDS_REFRESH_INTERVAL_MS || 10 * 60 * 1000),
  oddsArchiveChunkSize: Number(process.env.ODDS_ARCHIVE_CHUNK_SIZE || 5000),
  learning: {
    intervalMs: Number(process.env.LEARNING_INTERVAL_MS || 6 * 60 * 60 * 1000),
    snapshotMinGapMs: Number(process.env.PREDICTION_SNAPSHOT_GAP_MS || 3 * 60 * 60 * 1000),
    backfillRecentDays: Number(process.env.LEARNING_BACKFILL_DAYS || 30),
    backfillSampleWeight: Number(process.env.LEARNING_BACKFILL_WEIGHT || 0.55)
  },
  worldCup: {
    year: 2026,
    startDate: "2026-06-11",
    endDate: "2026-07-19",
    espnLeague: "fifa.world"
  },
  sources: {
    espnSite: "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world",
    espnCore: "https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world",
    openFootball: "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json",
    worldCupApi: "https://worldcup26.ir/get/teams",
    googleNews: "https://news.google.com/rss/search",
    openMeteoForecast: "https://api.open-meteo.com/v1/forecast",
    openMeteoArchive: "https://archive-api.open-meteo.com/v1/archive"
  }
};

// 球场城市坐标用于比赛日天气采集；同城不同球场按城市中心或球场附近取点。
export const HOST_CITY_COORDS = {
  "Mexico City": { lat: 19.4326, lon: -99.1332, tz: "America/Mexico_City" },
  Guadalajara: { lat: 20.6597, lon: -103.3496, tz: "America/Mexico_City" },
  Zapopan: { lat: 20.7214, lon: -103.3918, tz: "America/Mexico_City" },
  Monterrey: { lat: 25.6866, lon: -100.3161, tz: "America/Monterrey" },
  Toronto: { lat: 43.6532, lon: -79.3832, tz: "America/Toronto" },
  Vancouver: { lat: 49.2827, lon: -123.1207, tz: "America/Vancouver" },
  Seattle: { lat: 47.6062, lon: -122.3321, tz: "America/Los_Angeles" },
  "Santa Clara": { lat: 37.3541, lon: -121.9552, tz: "America/Los_Angeles" },
  "San Francisco": { lat: 37.7749, lon: -122.4194, tz: "America/Los_Angeles" },
  Inglewood: { lat: 33.9533, lon: -118.3390, tz: "America/Los_Angeles" },
  "Los Angeles": { lat: 34.0522, lon: -118.2437, tz: "America/Los_Angeles" },
  Arlington: { lat: 32.7357, lon: -97.1081, tz: "America/Chicago" },
  Dallas: { lat: 32.7767, lon: -96.7970, tz: "America/Chicago" },
  Houston: { lat: 29.7604, lon: -95.3698, tz: "America/Chicago" },
  "Kansas City": { lat: 39.0997, lon: -94.5786, tz: "America/Chicago" },
  Atlanta: { lat: 33.7490, lon: -84.3880, tz: "America/New_York" },
  "Miami Gardens": { lat: 25.9420, lon: -80.2456, tz: "America/New_York" },
  Miami: { lat: 25.7617, lon: -80.1918, tz: "America/New_York" },
  Philadelphia: { lat: 39.9526, lon: -75.1652, tz: "America/New_York" },
  Foxborough: { lat: 42.0654, lon: -71.2478, tz: "America/New_York" },
  Boston: { lat: 42.3601, lon: -71.0589, tz: "America/New_York" },
  "East Rutherford": { lat: 40.8339, lon: -74.0971, tz: "America/New_York" },
  "New York": { lat: 40.7128, lon: -74.0060, tz: "America/New_York" }
};

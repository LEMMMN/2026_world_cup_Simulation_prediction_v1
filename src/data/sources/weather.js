import { CONFIG, HOST_CITY_COORDS } from "../../config.js";
import { fetchJson, mapLimit } from "../../utils/http.js";

// 比赛天气按球场城市与当地开球小时采集，远期不可预报时返回明确状态。
export async function fetchWeatherForEvents(events) {
  const uniqueRequests = new Map();
  for (const event of events) {
    const cityInfo = findCity(event.venue?.city || event.venue?.name || "");
    if (!cityInfo || !event.date) continue;
    const local = getLocalDateHour(event.date, cityInfo.tz);
    uniqueRequests.set(`${cityInfo.city}-${local.date}`, { cityInfo, local });
  }

  const results = await mapLimit(Array.from(uniqueRequests.values()), 4, async (request) => {
    try {
      return { key: `${request.cityInfo.city}-${request.local.date}`, value: await fetchWeather(request.cityInfo, request.local) };
    } catch (error) {
      return {
        key: `${request.cityInfo.city}-${request.local.date}`,
        value: { city: request.cityInfo.city, date: request.local.date, status: "unavailable", note: error.message }
      };
    }
  });

  const byCityDate = Object.fromEntries(results.map((item) => [item.key, item.value]));
  return Object.fromEntries(events.map((event) => {
    const cityInfo = findCity(event.venue?.city || event.venue?.name || "");
    if (!cityInfo || !event.date) return [event.id, { status: "missing-location", note: "未匹配到球场城市坐标" }];
    const local = getLocalDateHour(event.date, cityInfo.tz);
    const weather = byCityDate[`${cityInfo.city}-${local.date}`] || { status: "unavailable" };
    return [event.id, pickHourWeather(weather, local.hour)];
  }));
}

export function findCity(value = "") {
  const text = String(value).toLowerCase();
  const matched = Object.keys(HOST_CITY_COORDS).find((city) => text.includes(city.toLowerCase()));
  if (!matched) return null;
  return { city: matched, ...HOST_CITY_COORDS[matched] };
}

async function fetchWeather(cityInfo, local) {
  const endpoint = shouldUseArchive(local.date) ? CONFIG.sources.openMeteoArchive : CONFIG.sources.openMeteoForecast;
  const params = new URLSearchParams({
    latitude: String(cityInfo.lat),
    longitude: String(cityInfo.lon),
    timezone: "auto",
    start_date: local.date,
    end_date: local.date,
    hourly: "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,relative_humidity_2m"
  });
  const raw = await fetchJson(`${endpoint}?${params.toString()}`, { retries: 1 });
  return {
    city: cityInfo.city,
    date: local.date,
    timezone: raw.timezone,
    status: "ok",
    units: raw.hourly_units || {},
    hourly: raw.hourly || {}
  };
}

function pickHourWeather(weather, hour) {
  if (weather.status !== "ok") return weather;
  const times = weather.hourly.time || [];
  const index = times.findIndex((time) => Number(time.slice(11, 13)) === hour);
  const safeIndex = index >= 0 ? index : Math.max(0, Math.min(times.length - 1, 14));
  return {
    city: weather.city,
    date: weather.date,
    timezone: weather.timezone,
    status: "ok",
    localTime: times[safeIndex],
    temperature: readHourly(weather, "temperature_2m", safeIndex),
    precipitationProbability: readHourly(weather, "precipitation_probability", safeIndex),
    precipitation: readHourly(weather, "precipitation", safeIndex),
    windSpeed: readHourly(weather, "wind_speed_10m", safeIndex),
    humidity: readHourly(weather, "relative_humidity_2m", safeIndex),
    units: weather.units
  };
}

function readHourly(weather, key, index) {
  const values = weather.hourly[key] || [];
  return values[index] ?? null;
}

function getLocalDateHour(isoDate, timeZone) {
  const date = new Date(isoDate);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(date).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === "24" ? "0" : parts.hour)
  };
}

function shouldUseArchive(dateText) {
  const day = new Date(`${dateText}T00:00:00Z`);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return day < todayUtc;
}

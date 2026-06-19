import { HOST_CITY_COORDS } from "../config.js";

// 气候适应模块：比较球队本土常见气候与比赛日环境，并估算跨时区、长途旅行和球迷压力。
export function buildClimateContexts({ events, teams, weatherByEvent }) {
  const teamMap = Object.fromEntries(teams.map((team) => [team.id, team]));
  return Object.fromEntries(events.map((event) => {
    const home = teamMap[event.homeTeamId] || {};
    const away = teamMap[event.awayTeamId] || {};
    const venue = venueProfile(event);
    const weather = weatherByEvent[event.id] || {};
    const homeAdaptation = analyzeTeamAdaptation(home, venue, weather, event.date);
    const awayAdaptation = analyzeTeamAdaptation(away, venue, weather, event.date);
    const crowd = analyzeCrowdImpact(event, home, away, venue);
    return [event.id, {
      eventId: event.id,
      weather,
      venue,
      home: homeAdaptation,
      away: awayAdaptation,
      crowd,
      advantage: round(awayAdaptation.penalty - homeAdaptation.penalty),
      label: `${home.name || "主队"}适应分${homeAdaptation.score}，${away.name || "客队"}适应分${awayAdaptation.score}；${crowd.label}`
    }];
  }));
}

const TEAM_CLIMATES = {
  CZE: profile(10, 70, 49.8, 15.5, 1, "温带大陆性"), MEX: profile(20, 55, 23.6, -102.5, -6, "高原暖温带"),
  RSA: profile(18, 55, -30.6, 22.9, 2, "南半球温暖干燥"), KOR: profile(14, 65, 36.5, 127.9, 9, "东亚季风"),
  BIH: profile(12, 70, 44.2, 17.7, 1, "巴尔干温带"), CAN: profile(7, 65, 56.1, -106.3, -5, "寒温带"),
  QAT: profile(29, 45, 25.3, 51.2, 3, "炎热干旱"), SUI: profile(9, 70, 46.8, 8.2, 1, "高山温带"),
  BRA: profile(25, 75, -14.2, -51.9, -3, "热带湿润"), HAI: profile(27, 78, 19, -72.3, -5, "加勒比热带"),
  MAR: profile(20, 55, 31.8, -7.1, 1, "北非干暖"), SCO: profile(9, 78, 56.5, -4.2, 0, "海洋性凉湿"),
  AUS: profile(22, 55, -25.3, 133.8, 10, "南半球暖热"), PAR: profile(24, 70, -23.4, -58.4, -4, "亚热带湿热"),
  TUR: profile(16, 60, 39, 35.2, 3, "地中海大陆过渡"), USA: profile(16, 60, 39.8, -98.6, -6, "跨气候带"),
  CUW: profile(28, 76, 12.2, -69, -4, "加勒比炎热"), ECU: profile(22, 72, -1.8, -78.2, -5, "赤道高原"),
  GER: profile(10, 72, 51.2, 10.5, 1, "温带海洋性"), CIV: profile(27, 82, 7.5, -5.5, 0, "西非湿热"),
  JPN: profile(15, 68, 36.2, 138.3, 9, "东亚海洋季风"), NED: profile(11, 78, 52.1, 5.3, 1, "海洋性湿润"),
  SWE: profile(7, 72, 60.1, 18.6, 1, "北欧凉冷"), TUN: profile(22, 52, 33.9, 9.5, 1, "北非干热"),
  BEL: profile(11, 78, 50.5, 4.5, 1, "海洋性湿润"), EGY: profile(27, 42, 26.8, 30.8, 2, "炎热干旱"),
  IRN: profile(19, 42, 32.4, 53.7, 3.5, "高原干燥"), NZL: profile(13, 75, -40.9, 174.9, 12, "南半球海洋性"),
  CPV: profile(25, 68, 16.5, -23, -1, "海岛干暖"), KSA: profile(29, 38, 23.9, 45.1, 3, "炎热沙漠"),
  ESP: profile(17, 55, 40.5, -3.7, 1, "地中海干暖"), URU: profile(18, 72, -32.5, -55.8, -3, "南温带湿润"),
  FRA: profile(12, 72, 46.2, 2.2, 1, "温带海洋性"), IRQ: profile(27, 38, 33.2, 43.7, 3, "炎热干旱"),
  NOR: profile(6, 75, 60.5, 8.5, 1, "北欧寒凉"), SEN: profile(28, 70, 14.5, -14.5, 0, "西非热带"),
  ALG: profile(23, 42, 28, 1.7, 1, "北非干热"), ARG: profile(17, 62, -38.4, -63.6, -3, "南温带"),
  AUT: profile(10, 70, 47.5, 14.6, 1, "中欧温带"), JOR: profile(22, 40, 30.6, 36.2, 3, "西亚干燥"),
  COL: profile(24, 78, 4.6, -74.3, -5, "热带高原"), COD: profile(25, 82, -4, 21.8, 1, "赤道湿热"),
  POR: profile(17, 67, 39.4, -8.2, 0, "大西洋地中海"), UZB: profile(17, 45, 41.4, 64.6, 5, "中亚大陆性"),
  CRO: profile(14, 68, 45.1, 15.2, 1, "亚得里亚温带"), ENG: profile(11, 78, 52.4, -1.2, 0, "海洋性凉湿"),
  GHA: profile(27, 80, 7.9, -1, 0, "西非湿热"), PAN: profile(28, 82, 8.5, -80.8, -5, "中美洲湿热")
};

function analyzeTeamAdaptation(team, venue, weather, kickoffAt) {
  const baseline = TEAM_CLIMATES[team?.abbreviation] || profile(18, 65, 0, 0, 0, "气候基线待补全");
  const temperature = finite(weather.temperature, 22);
  const humidity = finite(weather.humidity, 60);
  const tempDelta = Math.abs(temperature - baseline.temperature);
  const humidityDelta = Math.abs(humidity - baseline.humidity);
  const distanceKm = venue ? haversineKm(baseline.lat, baseline.lon, venue.lat, venue.lon) : 0;
  const venueOffset = venue?.tz ? timeZoneOffsetHours(kickoffAt, venue.tz) : baseline.utcOffset;
  const timeZoneDelta = Math.min(12, Math.abs(venueOffset - baseline.utcOffset));
  const penalty = clamp(tempDelta / 24 * 0.38 + humidityDelta / 55 * 0.2 + timeZoneDelta / 12 * 0.22 + distanceKm / 14000 * 0.2, 0, 0.75);
  const score = Math.round((1 - penalty) * 100);
  return {
    teamId: team?.id,
    teamName: team?.name,
    baseline,
    temperature,
    humidity,
    tempDelta: round(tempDelta),
    humidityDelta: round(humidityDelta),
    distanceKm: Math.round(distanceKm),
    timeZoneDelta: round(timeZoneDelta),
    penalty: round(penalty),
    score,
    label: `${baseline.climate}，温差${round(tempDelta)}°C、湿度差${round(humidityDelta)}%、跨${round(timeZoneDelta)}小时区、旅程约${Math.round(distanceKm)}公里`
  };
}

function analyzeCrowdImpact(event, home, away, venue) {
  const homeHost = isHostTeam(event, home);
  const awayHost = isHostTeam(event, away);
  const homeDistance = teamDistance(home, venue);
  const awayDistance = teamDistance(away, venue);
  const homeSupport = homeHost ? 1 : regionalSupport(homeDistance) + 0.05;
  const awaySupport = awayHost ? 1 : regionalSupport(awayDistance);
  const favored = homeSupport > awaySupport ? home?.name : awaySupport > homeSupport ? away?.name : "双方接近";
  return {
    home: round(homeSupport),
    away: round(awaySupport),
    homeHost,
    awayHost,
    favored,
    label: homeHost || awayHost
      ? `东道主球迷优势偏向${homeHost ? home?.name : away?.name}，客队需承受更强现场压力`
      : `非东道主对阵，按旅程和区域球迷基础估算，现场支持偏向${favored}`
  };
}

function venueProfile(event) {
  const text = `${event.venue?.city || ""} ${event.venue?.name || ""}`.toLowerCase();
  const city = Object.keys(HOST_CITY_COORDS).find((name) => text.includes(name.toLowerCase()));
  return city ? { city, ...HOST_CITY_COORDS[city] } : null;
}

function isHostTeam(event, team) {
  const country = String(event.venue?.country || "").toLowerCase();
  const abbreviation = String(team?.abbreviation || "").toUpperCase();
  return (country.includes("mexico") && abbreviation === "MEX")
    || (country.includes("canada") && abbreviation === "CAN")
    || ((country === "usa" || country.includes("united states")) && abbreviation === "USA");
}

function teamDistance(team, venue) {
  const baseline = TEAM_CLIMATES[team?.abbreviation];
  return baseline && venue ? haversineKm(baseline.lat, baseline.lon, venue.lat, venue.lon) : 9000;
}

function regionalSupport(distanceKm) {
  if (distanceKm <= 1800) return 0.3;
  if (distanceKm <= 4000) return 0.18;
  if (distanceKm <= 7000) return 0.08;
  return 0.02;
}

function timeZoneOffsetHours(isoDate, timeZone) {
  const date = new Date(isoDate || Date.now());
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  const utc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return (utc - date.getTime()) / 3600000;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function profile(temperature, humidity, lat, lon, utcOffset, climate) {
  return { temperature, humidity, lat, lon, utcOffset, climate };
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

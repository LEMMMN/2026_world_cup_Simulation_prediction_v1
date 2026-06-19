// 政治/签证/旅行风险模块：只从公开新闻线索提取风险，不把传闻写死成事实。
const RISK_KEYWORDS = [
  "visa", "visas", "travel ban", "travel restrictions", "war", "conflict", "protest", "security",
  "entry", "denied", "blocked", "delay", "detained", "immigration", "sanction", "boycott",
  "签证", "旅行禁令", "入境", "战争", "冲突", "抗议", "安全", "延误", "拒签", "制裁", "外交"
];

const TEAM_ALIASES = {
  "Algeria": ["阿尔及利亚"],
  "Argentina": ["阿根廷"],
  "Australia": ["澳大利亚"],
  "Austria": ["奥地利"],
  "Belgium": ["比利时"],
  "Bosnia-Herzegovina": ["波黑", "波斯尼亚"],
  "Brazil": ["巴西"],
  "Canada": ["加拿大"],
  "Cape Verde": ["佛得角"],
  "Colombia": ["哥伦比亚"],
  "Congo DR": ["刚果", "刚果（金）"],
  "Croatia": ["克罗地亚"],
  "Curaçao": ["库拉索"],
  "Czechia": ["捷克"],
  "Ecuador": ["厄瓜多尔"],
  "Egypt": ["埃及"],
  "England": ["英格兰"],
  "France": ["法国"],
  "Germany": ["德国"],
  "Ghana": ["加纳"],
  "Haiti": ["海地"],
  "Iran": ["伊朗"],
  "Iraq": ["伊拉克"],
  "Ivory Coast": ["科特迪瓦"],
  "Japan": ["日本"],
  "Jordan": ["约旦"],
  "Mexico": ["墨西哥"],
  "Morocco": ["摩洛哥"],
  "Netherlands": ["荷兰"],
  "New Zealand": ["新西兰"],
  "Norway": ["挪威"],
  "Panama": ["巴拿马"],
  "Paraguay": ["巴拉圭"],
  "Portugal": ["葡萄牙"],
  "Qatar": ["卡塔尔"],
  "Saudi Arabia": ["沙特", "沙特阿拉伯"],
  "Scotland": ["苏格兰"],
  "Senegal": ["塞内加尔"],
  "South Africa": ["南非"],
  "South Korea": ["韩国"],
  "Spain": ["西班牙"],
  "Sweden": ["瑞典"],
  "Switzerland": ["瑞士"],
  "Tunisia": ["突尼斯"],
  "Türkiye": ["土耳其"],
  "United States": ["美国"],
  "Uruguay": ["乌拉圭"],
  "Uzbekistan": ["乌兹别克"]
};

const HOST_TEAM_ALIASES = {
  "United States": ["usmnt", "united states team", "usa team", "美国队", "美国男足"],
  "Canada": ["canada national team", "canada soccer", "加拿大队", "加拿大男足"],
  "Mexico": ["mexico national team", "selección mexicana", "墨西哥队", "墨西哥男足"]
};

export function buildGeopoliticalRisks({ teams, events, articles }) {
  const teamRisks = Object.fromEntries(teams.map((team) => [team.id, buildTeamRisk(team, articles)]));
  const eventRisks = Object.fromEntries(events.map((event) => [event.id, buildEventRisk(event, teamRisks)]));
  const headlineRisks = articles.filter((article) => riskScoreForText(articleText(article)) > 0).slice(0, 30);

  return {
    updatedAt: new Date().toISOString(),
    note: "风险根据新闻关键词和比赛地点动态估算，用于提醒签证、旅行、安全、战争/外交因素，需打开原文复核。",
    teamRisks,
    eventRisks,
    articles: headlineRisks
  };
}

function buildTeamRisk(team, articles) {
  // 东道主国名经常只表示地点或政策主体，必须匹配到明确的国家队实体才能归因。
  const aliases = (HOST_TEAM_ALIASES[team.name] || [team.name, team.abbreviation, ...(TEAM_ALIASES[team.name] || [])])
    .filter(Boolean)
    .map((item) => String(item).toLowerCase());
  const matched = articles.filter((article) => {
    const text = articleText(article).toLowerCase();
    return aliases.some((alias) => text.includes(alias)) && riskScoreForText(text) > 0;
  }).slice(0, 8);
  const score = Math.min(3, matched.reduce((sum, article) => sum + riskScoreForText(articleText(article)), 0));
  return {
    teamId: team.id,
    teamName: team.name,
    score: round(score),
    level: riskLevel(score),
    reasons: matched.map((article) => ({
      title: article.title,
      source: article.source,
      publishedAt: article.publishedAt,
      url: article.url
    }))
  };
}

function buildEventRisk(event, teamRisks) {
  const homeRisk = teamRisks[event.homeTeamId] || { score: 0, reasons: [] };
  const awayRisk = teamRisks[event.awayTeamId] || { score: 0, reasons: [] };
  const hostScore = event.venue?.country === "USA" ? 0.25 : 0;
  const score = Math.min(4, homeRisk.score + awayRisk.score + hostScore);
  return {
    eventId: event.id,
    score: round(score),
    level: riskLevel(score),
    hostCountry: event.venue?.country,
    teams: [homeRisk, awayRisk],
    reasons: [...(homeRisk.reasons || []), ...(awayRisk.reasons || [])].slice(0, 6)
  };
}

function riskScoreForText(text) {
  const lower = String(text || "").toLowerCase();
  return RISK_KEYWORDS.reduce((score, keyword) => lower.includes(keyword.toLowerCase()) ? score + 0.35 : score, 0);
}

function articleText(article) {
  return `${article.title || ""} ${article.description || ""} ${article.source || ""}`;
}

function riskLevel(score) {
  if (score >= 2) return "高";
  if (score >= 1) return "中";
  if (score > 0) return "低";
  return "正常";
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

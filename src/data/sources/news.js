import { CONFIG } from "../../config.js";
import { fetchText } from "../../utils/http.js";
import { decodeHtml, stripTags } from "../../utils/text.js";

// Google News RSS 用于补充“伤病、首发、阵容变化”等实时中文/英文新闻线索。
export async function fetchGoogleNews(query, limit = 12) {
  const params = new URLSearchParams({
    q: query,
    hl: "zh-CN",
    gl: "CN",
    ceid: "CN:zh-Hans"
  });
  const url = `${CONFIG.sources.googleNews}?${params.toString()}`;
  const xml = await fetchText(url, { accept: "application/rss+xml,text/xml,*/*", retries: 1 });
  return parseRss(xml, url).slice(0, limit);
}

export async function fetchWorldCupNews() {
  const queries = [
    "2026 FIFA World Cup lineup injury squad change",
    "2026 世界杯 首发 伤病 阵容 变更",
    "2026 FIFA World Cup referee team news"
  ];
  const settled = await Promise.allSettled(queries.map((query) => fetchGoogleNews(query, 10)));
  const items = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
  const unique = new Map();
  for (const item of items) {
    unique.set(item.url || item.title, item);
  }
  return Array.from(unique.values()).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

export async function fetchGeopoliticalNews() {
  const queries = [
    "2026 World Cup visa travel ban team Iran United States",
    "2026 世界杯 签证 入境 政治 风险 伊朗 美国",
    "2026 FIFA World Cup security protest travel restrictions national team",
    "2026 World Cup war conflict sanctions national team travel"
  ];
  const settled = await Promise.allSettled(queries.map((query) => fetchGoogleNews(query, 12)));
  const items = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
  const unique = new Map();
  for (const item of items) {
    unique.set(item.url || item.title, { ...item, category: "政治/旅行风险" });
  }
  return Array.from(unique.values()).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

function parseRss(xml, sourceUrl) {
  const items = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of matches) {
    const block = match[1];
    items.push({
      id: getTag(block, "guid") || getTag(block, "link") || getTag(block, "title"),
      title: stripTags(getTag(block, "title")),
      description: stripTags(getTag(block, "description")),
      publishedAt: getTag(block, "pubDate"),
      url: decodeHtml(getTag(block, "link")),
      source: stripTags(getTag(block, "source")) || "Google News",
      sourceUrl
    });
  }
  return items;
}

function getTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1].trim()) : "";
}

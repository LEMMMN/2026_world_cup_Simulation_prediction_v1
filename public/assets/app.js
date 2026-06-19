// 页面只在首屏读取轻量概览，比赛、球队、复盘和赔率按需请求并缓存。
const state = {
  overview: null,
  activeTab: "dashboard",
  selectedEventId: null,
  selectedTeamId: null,
  matchFilter: "",
  groupFilter: "all",
  statusFilter: "all",
  playerUrl: "",
  learning: null,
  detailLoading: "",
  error: ""
};

const cache = {
  matches: new Map(),
  teams: new Map(),
  odds: new Map()
};

const TEAM_NAME_ZH = {
  Algeria: "阿尔及利亚", Argentina: "阿根廷", Australia: "澳大利亚", Austria: "奥地利",
  Belgium: "比利时", Brazil: "巴西", Canada: "加拿大", Colombia: "哥伦比亚",
  Croatia: "克罗地亚", Czechia: "捷克", Ecuador: "厄瓜多尔", Egypt: "埃及",
  England: "英格兰", France: "法国", Germany: "德国", Ghana: "加纳", Haiti: "海地",
  Iran: "伊朗", Iraq: "伊拉克", Japan: "日本", Jordan: "约旦", Mexico: "墨西哥",
  Morocco: "摩洛哥", Netherlands: "荷兰", "New Zealand": "新西兰", Norway: "挪威",
  Panama: "巴拿马", Paraguay: "巴拉圭", Portugal: "葡萄牙", Qatar: "卡塔尔",
  "Saudi Arabia": "沙特阿拉伯", Scotland: "苏格兰", Senegal: "塞内加尔",
  "South Africa": "南非", "South Korea": "韩国", Spain: "西班牙", Sweden: "瑞典",
  Switzerland: "瑞士", Tunisia: "突尼斯", Türkiye: "土耳其", "United States": "美国",
  Uruguay: "乌拉圭", Uzbekistan: "乌兹别克斯坦"
};

const view = document.querySelector("#view");
const statusGrid = document.querySelector("#statusGrid");
const metaLine = document.querySelector("#metaLine");
const refreshButton = document.querySelector("#refreshButton");
const openCacheButton = document.querySelector("#openCacheButton");

init();

async function init() {
  bindChrome();
  showLoading("正在读取轻量概览");
  await loadOverview(false);
  setInterval(() => loadOverview(false), 120000);
}

function bindChrome() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeTab = button.dataset.tab;
      syncTabs();
      await prepareActiveView();
    });
  });

  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = "…";
    clearCaches();
    await loadOverview(false);
    refreshButton.disabled = false;
    refreshButton.textContent = "⟳";
  });

  openCacheButton.addEventListener("click", () => {
    window.open("/api/overview", "_blank", "noopener,noreferrer");
  });
}

// 请求模块统一处理后端包装格式，方便静态开发时显示可读错误。
async function requestJson(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload.data ?? payload;
}

async function loadOverview(force) {
  try {
    const suffix = force ? "?refresh=1" : "";
    state.overview = normalizeOverview(await requestJson(`/api/overview${suffix}`));
    state.error = "";
    state.selectedEventId ||= nextInterestingMatch()?.id || events()[0]?.id || null;
    state.selectedTeamId ||= teams()[0]?.id || null;
    await prepareActiveView();
  } catch (error) {
    state.error = error.message;
    renderError("概览暂不可用", error.message);
  }
}

function normalizeOverview(data = {}) {
  return {
    meta: data.meta || {}, events: data.events || [], teams: data.teams || [], news: data.news || [],
    sources: data.sources || { status: [] }, learning: data.learning || { model: null },
    oddsHistory: data.oddsHistory || {}, bracketOutlook: data.bracketOutlook || {}
  };
}

function clearCaches() {
  cache.matches.clear();
  cache.teams.clear();
  cache.odds.clear();
  state.learning = null;
}

async function prepareActiveView() {
  renderChrome();
  if (["dashboard", "watch"].includes(state.activeTab) && state.selectedEventId) {
    await ensureMatch(state.selectedEventId);
  }
  if (state.activeTab === "teams" && state.selectedTeamId) await ensureTeam(state.selectedTeamId);
  if (state.activeTab === "reviews") await ensureLearning();
  if (state.activeTab === "odds") {
    // 进入赔率页时默认选择有公开盘口的比赛，避免首屏空状态。
    const oddsEvents = eventsWithOdds();
    if (!oddsEvents.some((event) => event.id === state.selectedEventId)) state.selectedEventId = oddsEvents[0]?.id || null;
    if (state.selectedEventId) await ensureOdds(state.selectedEventId);
  }
  render();
}

async function loadCached(map, key, path) {
  if (map.has(key)) return map.get(key);
  state.detailLoading = key;
  render();
  try {
    const data = await requestJson(path);
    map.set(key, data);
    state.error = "";
    return data;
  } catch (error) {
    state.error = error.message;
    return null;
  } finally {
    state.detailLoading = "";
  }
}

function ensureMatch(id) {
  return loadCached(cache.matches, id, `/api/match/${encodeURIComponent(id)}`);
}

function ensureTeam(id) {
  return loadCached(cache.teams, id, `/api/team/${encodeURIComponent(id)}`);
}

async function ensureLearning() {
  if (state.learning) return state.learning;
  state.detailLoading = "learning";
  render();
  try {
    const data = await requestJson("/api/learning");
    state.learning = { model: data.model || null, reviews: normalizeReviews(data.reviews) };
    state.error = "";
  } catch (error) {
    state.error = error.message;
  } finally {
    state.detailLoading = "";
  }
  return state.learning;
}

function normalizeReviews(reviews) {
  return (Array.isArray(reviews) ? reviews : Object.values(reviews || {})).sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt));
}

function ensureOdds(id) {
  return loadCached(cache.odds, id, `/api/odds-history?eventId=${encodeURIComponent(id)}`);
}

function render() {
  if (!state.overview) return;
  renderChrome();
  const renderers = {
    dashboard: renderDashboard, matches: renderMatches, teams: renderTeams, reviews: renderReviews,
    odds: renderOdds, news: renderNews, watch: renderWatch
  };
  (renderers[state.activeTab] || renderDashboard)();
}

function renderChrome() {
  if (!state.overview) return;
  const meta = state.overview.meta;
  const counts = meta.counts || {};
  metaLine.textContent = `更新 ${formatDateTime(meta.updatedAt)}，${counts.matches ?? events().length} 场，${counts.teams ?? teams().length} 队${meta.stale ? "，使用旧缓存" : ""}`;
  const sourceRows = Array.isArray(state.overview.sources) ? state.overview.sources : state.overview.sources.status || [];
  const sourceOk = sourceRows.filter((item) => item.ok).length;
  statusGrid.innerHTML = [
    metric("赛程", counts.matches ?? events().length, "轻量事件索引"),
    metric("球队", counts.teams ?? teams().length, "按选择读取详情"),
    metric("复盘", counts.predictionReviews ?? state.overview.learning?.model?.reviewCount ?? 0, "学习样本"),
    metric("赔率快照", counts.oddsSnapshots ?? state.overview.oddsHistory?.snapshotCount ?? 0, oddsStorageLabel()),
    metric("采集源", `${sourceOk}/${sourceRows.length}`, "当前可用来源")
  ].join("");
}

function oddsStorageLabel() {
  // 同时显示活跃与压缩数量，便于直接观察服务器历史文件是否持续瘦身。
  const history = state.overview.oddsHistory || {};
  return `${history.activeSnapshotCount || 0} 活跃 · ${history.archivedSnapshotCount || 0} 已压缩`;
}

function renderDashboard() {
  const selected = selectedEvent();
  const detail = selected ? cache.matches.get(selected.id) : null;
  view.className = "layout";
  view.innerHTML = `
    <section class="panel">
      <div class="panel-header"><h2>最新比赛进程</h2><span class="badge">${events().length} 场</span></div>
      ${matchList(latestEvents().slice(0, 18))}
    </section>
    <section class="panel">${detailPanel(selected, detail)}</section>`;
  bindMatchRows("dashboard");
}

function detailPanel(event, detail) {
  if (!event) return emptyBlock("暂无比赛");
  if (state.detailLoading === event.id) return loadingBlock("正在读取比赛详情");
  if (!detail) return errorBlock("比赛详情暂不可用");
  const analysis = detail.analysis || {};
  return `
    <div class="panel-header"><h2>${escapeHtml(matchTitle(event))}</h2><span class="badge">${escapeHtml(groupName(event.group || event.round))}</span></div>
    <div class="detail">
      ${scoreboard(event, analysis)}
      ${analysisBlock(analysis)}
      ${matchContextBlock(detail)}
      ${lineupBlock(detail.summary)}
      ${eventTimeline(detail.summary)}
    </div>`;
}

function scoreboard(event, analysis) {
  const home = teamById(event.homeTeamId);
  const away = teamById(event.awayTeamId);
  return `<div class="scoreboard">
    <div class="score-team">${logo(home, true)}<strong>${escapeHtml(teamName(home, "主队"))}</strong></div>
    <div class="score-value">${escapeHtml(scoreText(event, analysis))}</div>
    <div class="score-team">${logo(away, true)}<strong>${escapeHtml(teamName(away, "客队"))}</strong></div>
  </div>`;
}

function analysisBlock(analysis) {
  if (!analysis.predictedScore && !analysis.scorePredictions?.length) return emptyBlock("分析待生成");
  return `
    <div class="analysis-grid">
      <div class="analysis-item"><span>首选比分</span><strong>${escapeHtml(analysis.predictedScore?.label || "-")}</strong></div>
      <div class="analysis-item"><span>倾向</span><strong>${escapeHtml(analysis.favorite || "-")}</strong></div>
      <div class="analysis-item"><span>可信度</span><strong>${escapeHtml(analysis.confidence ?? "-")}${analysis.confidence != null ? "%" : ""}</strong></div>
    </div>
    ${scoreOptions(analysis.scorePredictions)}
    ${simulationBlock(analysis.simulation)}
    ${analysis.factors?.length ? `<h3 class="section-title">影响因素</h3><div class="factor-list">${analysis.factors.map(factorRow).join("")}</div>` : ""}`;
}

function simulationBlock(simulation) {
  if (!simulation?.iterations) return "";
  const probabilities = simulation.probabilities || {};
  const range = simulation.totalGoalsRange || {};
  const scenarios = Object.values(simulation.scenarios || {});
  return `<h3 class="section-title">精算沙盘 <span class="section-note">${escapeHtml(simulation.iterations)} 次情景模拟</span></h3>
    <div class="sandbox-card">
      <div class="sandbox-probabilities">
        <span><small>主胜</small><strong>${percentText(probabilities.home)}</strong></span>
        <span><small>平局</small><strong>${percentText(probabilities.draw)}</strong></span>
        <span><small>客胜</small><strong>${percentText(probabilities.away)}</strong></span>
        <span><small>总进球区间</small><strong>${escapeHtml(`${range.p10 ?? "-"}-${range.p90 ?? "-"}`)}</strong></span>
      </div>
      <div class="sandbox-scores">${(simulation.topScores || []).slice(0, 5).map((item) => `<span><b>${escapeHtml(item.label)}</b>${escapeHtml(item.percent || percentText(item.probability))}</span>`).join("")}</div>
      <div class="sandbox-scenarios">${scenarios.map((item) => `<span>${escapeHtml(item.label)} <b>${percentText(item.probability)}</b></span>`).join("")}</div>
      <p class="muted">${escapeHtml(simulation.note || "沙盘结果会随公开数据刷新")}</p>
    </div>`;
}

function scoreOptions(rows = []) {
  if (!rows.length) return "";
  return `<h3 class="section-title">比分概率 <span class="section-note">前三档重点，保留五档参考</span></h3>
    <div class="score-options">${rows.slice(0, 5).map((item, index) => `
      <div class="score-option ${index < 3 ? "primary" : "secondary"}">
        <span class="badge">${index + 1}</span><strong>${escapeHtml(item.label || scorePair(item.home, item.away))}</strong>
        <span class="muted">${escapeHtml(item.percent || percentText(item.probability))}</span>
        ${item.fairOdds ? `<small>公平赔率 ${decimalText(item.fairOdds)} · 庄家赔率 ${decimalText(item.houseOdds)}</small>` : ""}
      </div>`).join("")}</div>`;
}

function factorRow(item) {
  const effect = Number(item.effect) || 0;
  return `<div class="factor-row"><strong>${escapeHtml(item.label)}</strong><span class="muted">${escapeHtml(item.value)}</span><span class="effect ${effect > 0 ? "positive" : effect < 0 ? "negative" : ""}">${effect > 0 ? "+" : ""}${effect}</span></div>`;
}

function matchContextBlock(detail) {
  const blocks = [];
  if (detail.weather) blocks.push(infoCard("比赛天气", detail.weather.label || `${detail.weather.temperature ?? "-"}°C`));
  if (detail.climate?.label) blocks.push(infoCard("气候适应", detail.climate.label));
  if (detail.oddsActuary?.label) blocks.push(infoCard("赔率精算", detail.oddsActuary.label));
  if (detail.politicalRisk?.score > 0) blocks.push(infoCard("旅行风险", `${detail.politicalRisk.level}风险`));
  return blocks.length ? `<h3 class="section-title">比赛环境</h3><div class="context-grid">${blocks.join("")}</div>` : "";
}

function infoCard(title, text) {
  return `<div class="context-card"><strong>${escapeHtml(title)}</strong><span class="muted">${escapeHtml(text)}</span></div>`;
}

function renderMatches() {
  const groups = unique(events().map((event) => event.group).filter(Boolean));
  const rows = filteredEvents();
  view.className = "layout single";
  view.innerHTML = `<section class="panel">
    <div class="panel-header"><h2>完整赛程</h2><span class="badge">${rows.length} 场</span></div>
    <div class="toolbar">
      <input id="matchSearch" placeholder="搜索球队 / 球场" value="${escapeAttr(state.matchFilter)}">
      <select id="groupFilter"><option value="all">全部小组</option>${groups.map((group) => `<option value="${escapeAttr(group)}" ${state.groupFilter === group ? "selected" : ""}>${escapeHtml(groupName(group))}</option>`).join("")}</select>
      <select id="statusFilter">${selectOption("all", "全部状态", state.statusFilter)}${selectOption("pre", "未开始", state.statusFilter)}${selectOption("in", "进行中", state.statusFilter)}${selectOption("post", "已结束", state.statusFilter)}</select>
    </div>${matchList(rows)}</section>`;
  document.querySelector("#matchSearch").addEventListener("input", (event) => { state.matchFilter = event.target.value; renderMatches(); });
  document.querySelector("#groupFilter").addEventListener("change", (event) => { state.groupFilter = event.target.value; renderMatches(); });
  document.querySelector("#statusFilter").addEventListener("change", (event) => { state.statusFilter = event.target.value; renderMatches(); });
  bindMatchRows("dashboard");
}

function renderTeams() {
  const selected = selectedTeam();
  const detail = selected ? cache.teams.get(selected.id) : null;
  view.className = "layout";
  view.innerHTML = `
    <section class="panel"><div class="panel-header"><h2>参赛球队</h2><span class="badge">${teams().length} 支</span></div><div class="detail"><div class="team-grid">${teams().map(teamButton).join("")}</div></div></section>
    <section class="panel">${teamDetailPanel(selected, detail)}</section>`;
  document.querySelectorAll("[data-team-id]").forEach((button) => button.addEventListener("click", async () => {
    state.selectedTeamId = button.dataset.teamId;
    renderTeams();
    await ensureTeam(state.selectedTeamId);
    renderTeams();
  }));
  bindMatchRows("dashboard");
}

function teamButton(team) {
  return `<button class="team-row ${state.selectedTeamId === team.id ? "active" : ""}" data-team-id="${escapeAttr(team.id)}">${logo(team)}<span><strong>${escapeHtml(teamName(team))}</strong><br><span class="muted">${escapeHtml(groupName(team.group))}</span></span><span class="badge">${escapeHtml(team.rosterCount ?? "详情")}</span></button>`;
}

function teamDetailPanel(team, detail) {
  if (!team) return emptyBlock("请选择球队");
  if (state.detailLoading === team.id) return loadingBlock("正在读取球队详情");
  if (!detail) return errorBlock("球队详情暂不可用");
  const roster = detail.roster || {};
  return `<div class="panel-header"><h2>${escapeHtml(teamName(team))}</h2><span class="badge">${escapeHtml(groupName(team.group))}</span></div>
    <div class="detail"><div class="score-team">${logo(team, true)}<strong>${escapeHtml(team.abbreviation || "")}</strong></div>
    ${detail.squadRating ? `<h3 class="section-title">阵容评分</h3>${squadCard(detail.squadRating)}` : ""}
    ${detail.form ? `<h3 class="section-title">近期状态</h3>${formCard(detail.form)}` : ""}
    <h3 class="section-title">球员名单</h3>${roster.players?.length ? rosterTable(detail.squadRating?.players || roster.players) : emptyBlock("名单暂未采集")}
    <h3 class="section-title">本队赛程</h3>${matchList(detail.matches || [])}</div>`;
}

function squadCard(item) {
  return `<div class="context-card"><strong>${escapeHtml(item.teamScore ?? "-")} 分</strong><span class="muted">均龄 ${escapeHtml(item.averageAge ?? "-")} · 近期 ${escapeHtml(item.formScore ?? "-")} · 深度 ${escapeHtml(item.depthScore ?? "-")}</span></div>`;
}

function formCard(form) {
  const summary = form.summary || {};
  return `<div class="context-card"><strong>${summary.wins || 0}胜 ${summary.draws || 0}平 ${summary.losses || 0}负</strong><span class="muted">${summary.points || 0} 分 · 净胜球 ${signed(summary.goalDiff)}</span></div>`;
}

function rosterTable(players) {
  return `<div class="table-scroll"><table class="roster-table"><thead><tr><th>号码</th><th>球员</th><th>位置</th><th>年龄</th><th>评分</th></tr></thead><tbody>${players.map((player) => `<tr><td>${escapeHtml(player.jersey || "-")}</td><td>${escapeHtml(player.name)}</td><td>${escapeHtml(player.position || player.positionAbbr || "-")}</td><td>${escapeHtml(player.age ?? "-")}</td><td><strong>${escapeHtml(player.rating ?? "-")}</strong></td></tr>`).join("")}</tbody></table></div>`;
}

function renderReviews() {
  view.className = "layout single";
  if (state.detailLoading === "learning") {
    view.innerHTML = `<section class="panel">${loadingBlock("正在读取复盘数据")}</section>`;
    return;
  }
  if (!state.learning) {
    view.innerHTML = `<section class="panel">${errorBlock("复盘数据暂不可用")}</section>`;
    return;
  }
  const { model, reviews } = state.learning;
  view.innerHTML = `<section class="panel">
    <div class="panel-header"><h2>预测复盘</h2><span class="badge">${reviews.length} 场</span></div>
    <div class="detail">${learningMetrics(model)}<div class="review-list">${reviews.map(reviewCard).join("") || emptyBlock("暂无已完成复盘")}</div></div>
  </section>`;
}

function learningMetrics(model = {}) {
  const calibration = model.calibration || {};
  const backtest = model.sandboxBacktest || {};
  return `<div class="learning-card">
    ${learningMetric(model.reviewCount, "已复盘")}${learningMetric(percentText(model.exactRate), "精确命中")}
    ${learningMetric(percentText(model.top3Rate), "前三覆盖")}${learningMetric(percentText(model.resultRate), "胜平负命中")}
    ${learningMetric(model.avgGoalError ?? "-", "平均进球误差")}${learningMetric(model.backfillReviewCount ?? 0, "历史回填")}
    ${learningMetric(calibration.effectiveWeight ?? 0, "校准有效权重")}${learningMetric(backtestStatusText(backtest.status), "走步回测状态")}
  </div>`;
}

function learningMetric(value, label) {
  return `<div><strong>${escapeHtml(value ?? 0)}</strong><span class="muted">${escapeHtml(label)}</span></div>`;
}

function backtestStatusText(status) {
  return { accepted: "已通过", rejected: "未通过，参数未上线", provisional: "样本不足" }[status] || "待回测";
}

function reviewCard(review) {
  const scores = (review.scorePredictions || []).slice(0, 3);
  const reasons = review.reasonDetails || review.reasons || [];
  const tacticalTags = (review.reasonTags || []).filter((tag) => /tactical|coach|formation|relation/i.test(tag));
  const actuaryTags = (review.reasonTags || []).filter((tag) => /actuary|odds|market/i.test(tag));
  return `<article class="review-card">
    <div class="review-head"><div><strong>${escapeHtml(teamNameByText(review.teams?.home || "主队"))} 对 ${escapeHtml(teamNameByText(review.teams?.away || "客队"))}</strong><span class="muted">${escapeHtml(formatDateTime(review.kickoffAt))}</span></div><span class="badge ${review.exactHit ? "done" : ""}">${review.exactHit ? "精确命中" : review.top3Hit ? "前三覆盖" : "未覆盖"}</span></div>
    <div class="review-scores"><div><span>首选比分</span><strong>${escapeHtml(review.predicted?.label || "-")}</strong></div><div><span>前三比分</span><strong>${scores.map((item) => escapeHtml(item.label || scorePair(item.home, item.away))).join(" / ") || "-"}</strong></div><div><span>实际比分</span><strong>${escapeHtml(review.actual?.label || "-")}</strong></div></div>
    <div class="hit-strip">${hitBadge("精确", review.exactHit)}${hitBadge("前三", review.top3Hit)}${hitBadge("胜平负", review.resultHit)}</div>
    ${reasons.length ? `<p class="review-reason"><strong>偏差原因</strong>${reasons.slice(0, 4).map((item) => escapeHtml(item.text || item.label || item)).join("；")}</p>` : ""}
    <div class="tag-row">${tagGroup("战术标签", tacticalTags)}${tagGroup("精算标签", actuaryTags)}</div>
  </article>`;
}

function hitBadge(label, hit) {
  return `<span class="hit-badge ${hit ? "hit" : "miss"}">${escapeHtml(label)} ${hit ? "命中" : "未中"}</span>`;
}

function tagGroup(label, tags) {
  return `<span class="tag-group"><b>${escapeHtml(label)}</b>${tags.length ? tags.map((tag) => `<i>${escapeHtml(tag)}</i>`).join("") : "<i>无</i>"}</span>`;
}

function renderOdds() {
  const event = selectedEvent();
  const history = event ? cache.odds.get(event.id) : null;
  const availableEvents = eventsWithOdds();
  view.className = "layout single";
  view.innerHTML = `<section class="panel">
    <div class="panel-header"><h2>赔率轨迹</h2><span class="badge">10分钟快照</span></div>
    <div class="toolbar"><select id="oddsMatch">${availableEvents.map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === state.selectedEventId ? "selected" : ""}>${escapeHtml(formatDateTime(item.date))} · ${escapeHtml(matchTitle(item))}</option>`).join("")}</select></div>
    <div class="detail">${oddsPanel(event, history)}</div>
  </section>`;
  document.querySelector("#oddsMatch")?.addEventListener("change", async (change) => {
    state.selectedEventId = change.target.value;
    renderOdds();
    await ensureOdds(state.selectedEventId);
    renderOdds();
  });
}

function oddsPanel(event, history) {
  if (!event) return emptyBlock("请选择比赛");
  if (state.detailLoading === event.id) return loadingBlock("正在读取赔率快照");
  if (!history) return errorBlock("赔率快照暂不可用");
  const snapshots = normalizeSnapshots(history, event.id);
  if (!snapshots.length) return emptyBlock("该比赛暂无赔率快照");
  const latest = snapshots[0];
  const actuary = latest.actuary || latest.oddsActuary || {};
  const prices = latest.scorePrices || latest.scorePredictions || [];
  return `
    <div class="odds-summary"><div><span>最近快照</span><strong>${escapeHtml(formatDateTime(latest.capturedAt || latest.updatedAt))}</strong></div><div><span>庄家边际</span><strong>${percentText(actuary.marketMargin ?? latest.marketMargin)}</strong></div><div><span>快照数量</span><strong>${snapshots.length}</strong></div></div>
    ${marketOddsBlock(actuary, latest)}
    ${scorePriceBlock(prices)}
    <h3 class="section-title">胜平负概率 / 赔率变化</h3>${oddsHistoryTable(snapshots.slice(0, 12))}`;
}

function normalizeSnapshots(data, eventId) {
  const eventGroup = data.events?.[eventId] || data.byEvent?.[eventId];
  const raw = Array.isArray(data) ? data : data.snapshots || eventGroup?.snapshots || eventGroup || [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => !item.eventId || String(item.eventId) === String(eventId)).sort((a, b) => new Date(b.capturedAt || b.updatedAt) - new Date(a.capturedAt || a.updatedAt));
}

function marketOddsBlock(actuary, snapshot = {}) {
  const rows = actuary.pressures || ["home", "draw", "away"].map((outcome, index) => ({
    outcome,
    label: ["主胜", "平局", "客胜"][index],
    implied: snapshot.implied?.[outcome],
    decimalOdds: snapshot.decimalOdds?.[outcome],
    payoutPressure: null
  })).filter((item) => item.implied != null || item.decimalOdds != null);
  if (!rows.length) return "";
  return `<h3 class="section-title">当前胜平负市场</h3><div class="pressure-list">${rows.map((item) => `<span>${escapeHtml(item.label)}<strong>${percentText(item.implied)}</strong><small>十进制赔率 ${decimalText(item.decimalOdds)}</small>${item.payoutPressure == null ? "" : `<small>赔付压力 ${decimalText(item.payoutPressure)}</small>`}</span>`).join("")}</div>`;
}

function scorePriceBlock(prices) {
  if (!prices.length) return "";
  return `<h3 class="section-title">比分公平赔率与庄家赔率</h3><div class="score-price-grid">${prices.slice(0, 5).map((item, index) => `<div class="score-price ${index < 3 ? "primary" : ""}"><span>${escapeHtml(item.label || scorePair(item.home, item.away))}</span><strong>${escapeHtml(item.percent || percentText(item.probability))}</strong><small>公平 ${decimalText(item.fairOdds)} · 庄家 ${decimalText(item.houseOdds)}</small></div>`).join("")}</div>`;
}

function oddsHistoryTable(snapshots) {
  return `<div class="table-scroll"><table class="compact-table"><thead><tr><th>时间</th><th>主胜概率 / 赔率</th><th>平局概率 / 赔率</th><th>客胜概率 / 赔率</th><th>边际</th></tr></thead><tbody>${snapshots.map((snapshot) => {
    const actuary = snapshot.actuary || snapshot.oddsActuary || {};
    const rows = Object.fromEntries((actuary.pressures || []).map((item) => [item.outcome, item]));
    ["home", "draw", "away"].forEach((key) => {
      rows[key] ||= { implied: snapshot.implied?.[key], decimalOdds: snapshot.decimalOdds?.[key] };
    });
    return `<tr><td>${escapeHtml(formatDateTime(snapshot.capturedAt || snapshot.updatedAt))}</td>${["home", "draw", "away"].map((key) => `<td>${percentText(rows[key]?.implied)} / ${decimalText(rows[key]?.decimalOdds)}</td>`).join("")}<td>${percentText(actuary.marketMargin)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderNews() {
  const sourceRows = Array.isArray(state.overview.sources) ? state.overview.sources : state.overview.sources.status || [];
  view.className = "layout";
  view.innerHTML = `<section class="panel"><div class="panel-header"><h2>实时消息</h2><span class="badge">${state.overview.news.length} 条</span></div><div class="news-list">${state.overview.news.map(newsRow).join("") || emptyBlock("暂无消息")}</div></section>
    <section class="panel"><div class="panel-header"><h2>采集源状态</h2></div><div class="detail source-table">${sourceRows.map((item) => `<div class="source-row"><strong>${escapeHtml(item.name)}</strong><span class="effect ${item.ok ? "positive" : "negative"}">${item.ok ? "成功" : "失败"}${item.durationMs != null ? ` · ${item.durationMs}ms` : ""}</span></div>`).join("")}</div></section>`;
}

function newsRow(item) {
  return `<article class="news-row"><a href="${escapeAttr(item.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "未命名消息")}</a><p class="muted">${escapeHtml(item.description || "")}</p><span class="badge">${escapeHtml(item.source || "消息")} · ${escapeHtml(formatDateTime(item.publishedAt))}</span></article>`;
}

function renderWatch() {
  const event = selectedEvent();
  const detail = event ? cache.matches.get(event.id) : null;
  view.className = "layout single";
  view.innerHTML = `<section class="panel"><div class="panel-header"><h2>观赛入口</h2><span class="badge">${event ? escapeHtml(matchTitle(event)) : "未选择"}</span></div>
    <div class="toolbar"><select id="watchMatch">${events().map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === state.selectedEventId ? "selected" : ""}>${escapeHtml(formatDateTime(item.date))} · ${escapeHtml(matchTitle(item))}</option>`).join("")}</select><input id="playerUrl" placeholder="合法直播 / 回放 URL" value="${escapeAttr(state.playerUrl)}"><button class="icon-button" id="loadPlayer">▶</button></div>
    <div class="detail watch-grid"><div><video class="player" id="localPlayer" controls playsinline></video><p class="muted">播放器只加载你有权访问的直播或回放地址。</p></div><div>${watchLinks(event, detail)}</div></div></section>`;
  document.querySelector("#watchMatch")?.addEventListener("change", async (change) => { state.selectedEventId = change.target.value; await ensureMatch(state.selectedEventId); renderWatch(); });
  document.querySelector("#playerUrl")?.addEventListener("input", (input) => { state.playerUrl = input.target.value; });
  document.querySelector("#loadPlayer")?.addEventListener("click", () => { const player = document.querySelector("#localPlayer"); player.src = state.playerUrl; player.load(); });
}

function watchLinks(event, detail) {
  if (!event) return emptyBlock("请选择比赛");
  const espn = event.links?.summary || `https://www.espn.com/soccer/match/_/gameId/${event.id}`;
  return `<h3 class="section-title">官方入口</h3><div class="link-list"><a class="link-button" href="${escapeAttr(espn)}" target="_blank" rel="noopener noreferrer">ESPN 比赛中心</a><a class="link-button" href="https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026" target="_blank" rel="noopener noreferrer">FIFA 官方</a></div><h3 class="section-title">转播信息</h3><p class="muted">${escapeHtml((detail?.summary?.broadcasts || event.broadcasts || []).join("、") || "暂未采集")}</p>`;
}

function matchList(rows) {
  return `<div class="match-list">${rows.map(matchRow).join("") || emptyBlock("没有匹配赛程")}</div>`;
}

function matchRow(event) {
  const home = teamById(event.homeTeamId);
  const away = teamById(event.awayTeamId);
  const status = event.status?.state || "pre";
  const score = status !== "pre" && event.score?.home != null ? `${event.score.home}-${event.score.away}` : "vs";
  return `<button class="match-row ${state.selectedEventId === event.id ? "active" : ""}" data-event-id="${escapeAttr(event.id)}"><span class="date-chip">${escapeHtml(shortDate(event.date))}</span><span><span class="teams-line">${logo(home)} ${escapeHtml(teamName(home))} <span class="muted">${score}</span> ${logo(away)} ${escapeHtml(teamName(away))}</span><span class="muted">${escapeHtml(groupName(event.group || event.round))} · ${escapeHtml(venueName(event))}</span><span class="muted">开球 ${escapeHtml(formatDateTime(event.date))}</span></span><span class="badge ${status === "in" ? "live" : status === "post" ? "done" : ""}">${escapeHtml(statusName(event.status))}</span></button>`;
}

function bindMatchRows(targetTab) {
  document.querySelectorAll("[data-event-id]").forEach((button) => button.addEventListener("click", async () => {
    state.selectedEventId = button.dataset.eventId;
    state.activeTab = targetTab;
    syncTabs();
    render();
    await ensureMatch(state.selectedEventId);
    render();
  }));
}

function lineupBlock(summary) {
  const starters = summary?.starters || [];
  if (!starters.some((item) => item.players?.length)) return "";
  return `<h3 class="section-title">首发名单</h3><div class="analysis-grid">${starters.map((item) => `<div class="analysis-item"><span>${escapeHtml(teamNameByText(item.teamName))} ${escapeHtml(item.formation || "")}</span><strong>${item.players?.length || 0} 人</strong><p class="muted">${(item.players || []).map((player) => escapeHtml(player.name)).join("、")}</p></div>`).join("")}</div>`;
}

function eventTimeline(summary) {
  const rows = (summary?.keyEvents || []).filter((item) => ["goal", "yellow-card", "red-card", "substitution"].includes(item.kind)).slice(0, 18);
  return rows.length ? `<h3 class="section-title">关键事件</h3><div class="event-list">${rows.map((item) => `<div class="event-row"><strong>${escapeHtml(item.minute || "")} ${escapeHtml(item.label || item.kind)}</strong><span class="muted">${escapeHtml(item.shortText || item.text || item.players?.[0]?.name || "")}</span></div>`).join("")}</div>` : "";
}

function filteredEvents() {
  const query = state.matchFilter.trim().toLowerCase();
  return events().filter((event) => {
    const text = `${event.name || ""} ${matchTitle(event)} ${venueName(event)}`.toLowerCase();
    return (state.groupFilter === "all" || event.group === state.groupFilter)
      && (state.statusFilter === "all" || event.status?.state === state.statusFilter)
      && (!query || text.includes(query));
  });
}

function latestEvents() {
  const now = Date.now();
  return [...events()].sort((a, b) => {
    const rank = (item) => item.status?.state === "in" ? 0 : new Date(item.date).getTime() >= now ? 1 : 2;
    return rank(a) - rank(b) || Math.abs(new Date(a.date) - now) - Math.abs(new Date(b.date) - now);
  });
}

function nextInterestingMatch() {
  const now = Date.now();
  return events().find((item) => item.status?.state === "in") || events().find((item) => new Date(item.date).getTime() >= now) || events().at(-1);
}

function events() { return state.overview?.events || []; }
function eventsWithOdds() {
  const ids = new Set((state.overview?.oddsHistory?.eventIds || []).map(String));
  return events().filter((event) => ids.has(String(event.id)));
}
function teams() { return state.overview?.teams || []; }
function selectedEvent() { return events().find((item) => item.id === state.selectedEventId) || nextInterestingMatch(); }
function selectedTeam() { return teams().find((item) => item.id === state.selectedTeamId) || teams()[0]; }
function teamById(id) { return teams().find((item) => String(item.id) === String(id)); }
function teamName(team, fallback = "待定") { return teamNameByText(team?.name || team?.shortName || fallback); }
function teamNameByText(value) { return TEAM_NAME_ZH[value] || value || "待定"; }

function scoreText(event, analysis) {
  return event.status?.state !== "pre" && event.score?.home != null ? `${event.score.home}-${event.score.away}` : analysis.predictedScore?.label || "vs";
}

function logo(team, large = false) {
  const source = team?.logo || team?.flag;
  return source ? `<img class="team-logo ${large ? "large" : ""}" src="${escapeAttr(source)}" alt="">` : "";
}

function syncTabs() {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === state.activeTab));
}

function metric(label, value, hint) { return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><span>${escapeHtml(hint)}</span></div>`; }
function loadingBlock(text) { return `<div class="empty-state compact"><span class="loading-dot"></span><strong>${escapeHtml(text)}</strong></div>`; }
function emptyBlock(text) { return `<div class="empty-state compact"><strong>${escapeHtml(text)}</strong></div>`; }
function errorBlock(text) { return `<div class="empty-state compact"><strong>${escapeHtml(text)}</strong><span>${escapeHtml(state.error)}</span></div>`; }
function renderError(title, message) { view.className = "layout single"; view.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`; }
function showLoading(text) { view.className = "layout single"; view.innerHTML = loadingBlock(text); }
function selectOption(value, label, selected) { return `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`; }
function unique(items) { return [...new Set(items)]; }
function signed(value) { const number = Number(value) || 0; return number > 0 ? `+${number}` : String(number); }
function percentText(value) { const number = Number(value); return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "-"; }
function decimalText(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number.toFixed(2) : "-"; }
function scorePair(home, away) { return `${Number.isFinite(Number(home)) ? home : "-"}-${Number.isFinite(Number(away)) ? away : "-"}`; }

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function groupName(value) {
  if (!value) return "分组待定";
  const match = String(value).match(/(?:Group\s*)?([A-L])$/i);
  return match ? `${match[1].toUpperCase()}组` : String(value).replace("group-stage", "小组赛");
}

function statusName(status = {}) {
  if (status.state === "post" || status.completed) return "完场";
  if (status.state === "in") return status.displayClock ? `进行中 ${status.displayClock}` : "进行中";
  return "未开始";
}

function venueName(event) {
  const venue = event.venue?.name || event.ground || "球场待定";
  return `${venue}${event.venue?.city ? ` · ${event.venue.city}` : ""}`;
}

function matchTitle(event) {
  return `${teamName(teamById(event.homeTeamId), "待定")} 对 ${teamName(teamById(event.awayTeamId), "待定")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

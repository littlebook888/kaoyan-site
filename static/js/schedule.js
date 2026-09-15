/* =====================================================================
 *  schedule.js —— 时间表附属页渲染逻辑
 *  ---------------------------------------------------------------
 *  1) 全天时间表（北京时间联动：当前时段高亮 + 已流逝进度）
 *  2) 理论 vs 实际对比卡（理论=当前时段；实际=主站 Store.getActiveTimer()）
 *  3) 规则速查 + 心态工具（收起式面板）
 *  每 30 秒本地刷新一次（纯 DOM，无网络流量）。
 *  数据：schedule-data.js（window.SCHEDULE_DATA）；依赖 config/blocks/store
 * ===================================================================== */
(function () {
  const D = window.SCHEDULE_DATA;

  // 颜色统一取 schedule-data.js 的 kindColors（单一事实源，v1.16.0）
  const KIND_COLORS = (window.SCHEDULE_DATA && window.SCHEDULE_DATA.kindColors) || {};
  const KIND_META = {
    study:    { label: "自习",   color: KIND_COLORS.study    || "#0d9488" },
    meal:     { label: "用餐",   color: KIND_COLORS.meal     || "#ea580c" },
    rest:     { label: "休息",   color: KIND_COLORS.rest     || "#16a34a" },
    sleep:    { label: "睡眠",   color: KIND_COLORS.sleep    || "#1e40af" },
    prep:     { label: "预备",   color: KIND_COLORS.prep     || "#64748b" },
    winddown: { label: "收尾",   color: KIND_COLORS.winddown || "#64748b" }
  };
  const kindMeta = (k) => KIND_META[k] || { label: k || "—", color: "#64748b" };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function toMin(t) { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  function nowSecBJ() {
    // 北京时间当日秒数（与全站时间基准一致）
    if (window.Blocks && window.Blocks.secOfDay) return window.Blocks.secOfDay(new Date());
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function currentSlot() {
    const s = nowSecBJ();
    return D.slots.find(x => toMin(x.start) * 60 <= s && s < toMin(x.end) * 60) || null;
  }
  function slotProgress(slot) {
    const s = nowSecBJ();
    const a = toMin(slot.start) * 60, b = toMin(slot.end) * 60;
    if (b <= a) return 0;
    return Math.max(0, Math.min(100, Math.round(((s - a) / (b - a)) * 100)));
  }

  /* ---------- 理论 vs 实际 对比 ---------- */
  function compareWithActual(slot) {
    const at = window.Store ? window.Store.getActiveTimer() : null;
    const theo = slot
      ? `理论上：${slot.name}（${slot.start}~${slot.end}）`
      : "当前不在任何计划时段内";
    const km = kindMeta(slot ? slot.kind : "");
    const running = at && at.status === "running";
    const paused = at && at.status === "paused";
    const isStudy = at && (at.kind === "study" || at.sub_category === "enter_state");

    let state, cls;
    if (!at) {
      if (slot && slot.kind === "study") { state = "❌ 未在计时——" + theo + "，现在就该开始"; cls = "bad"; }
      else { state = "✅ " + theo + "（当前无计时）"; cls = "ok"; }
    } else if (slot && slot.kind === "study") {
      if (running && isStudy) { state = "✅ " + theo + "——正在学习，保持！"; cls = "ok"; }
      else if (running) { state = "⚠️ " + theo + "，但当前计时为「" + (at.label || at.kind) + "」（非学习类）"; cls = "warn"; }
      else if (paused) { state = "⚠️ " + theo + "——计时处于暂停中，尽快继续"; cls = "warn"; }
      else { state = "❌ " + theo + "，但未在计时——立即开始，不等待整点"; cls = "bad"; }
    } else {
      // 非学习时段（用餐/休息/睡眠/收尾/预备）
      if (running) { state = "ℹ️ " + theo + "——你在自觉加练（" + (at.label || at.kind) + "），注意休息 ≤20min"; cls = "info"; }
      else { state = "✅ " + theo + "（当前无计时，符合安排）"; cls = "ok"; }
    }
    return { theo, km, state, cls };
  }

  function renderCompare() {
    const slot = currentSlot();
    const c = compareWithActual(slot);
    const km = kindMeta(slot ? slot.kind : "");
    const timeEl = document.getElementById("scNowTime");
    if (timeEl) timeEl.textContent = fmtHM(new Date());
    const badge = document.getElementById("scSlotBadge");
    if (badge) {
      badge.textContent = slot ? ("当前：" + slot.name) : "自由时段";
      badge.style.background = km.color;
    }
    const box = document.getElementById("scCompare");
    if (box) {
      box.className = "sc-compare " + c.cls;
      box.innerHTML = '<div class="sc-cmp-theo">' + escapeHtml(c.state) + '</div>';
    }
  }

  function fmtHM(d) {
    const p = n => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /* ---------- 全天时间表 ---------- */
  // 一天从「起床」开始：起床(kind=prep)之前的时段（夜间收尾/睡眠）是前一天的尾巴，
  // 白天它们属于「今晚尚未到来」，不能按已流逝处理（标 100%/淡化）
  function tailMaxMin() {
    const prep = D.slots.find(x => x.kind === "prep");
    return toMin(prep ? prep.start : "07:30");
  }
  function renderTable() {
    const now = currentSlot();
    const s = nowSecBJ();
    const tailMax = tailMaxMin();
    const rows = D.slots.map(slot => {
      const km = kindMeta(slot.kind);
      const isNow = now && slot.start === now.start && slot.end === now.end;
      const isTail = toMin(slot.end) <= tailMax;
      const prog = isNow ? slotProgress(slot) : (!isTail && toMin(slot.end) * 60 <= s ? 100 : 0);
      return `
        <div class="sc-row ${isNow ? "now" : ""}" style="--kc:${km.color}">
          <div class="sc-row-time">${slot.start}~${slot.end}
            ${isNow ? '<span class="sc-now-badge">现在</span>' : ""}
          </div>
          <div class="sc-row-main">
            <div class="sc-row-name"><span class="sc-kind-dot" style="background:${km.color}"></span>${escapeHtml(slot.name)}</div>
            ${slot.note ? `<div class="sc-row-note">${escapeHtml(slot.note)}</div>` : ""}
            ${isNow ? `<div class="sc-prog"><i style="width:${prog}%"></i></div>` : ""}
          </div>
          <div class="sc-row-dur">${slotDurText(slot)}</div>
        </div>`;
    }).join("");
    const el = document.getElementById("scTable");
    if (el) el.innerHTML = rows;
  }
  function slotDurText(slot) {
    const mins = toMin(slot.end) - toMin(slot.start);
    const h = Math.floor(mins / 60), m = mins % 60;
    return (h > 0 ? h + "小时" : "") + (m > 0 ? m + "分钟" : (h > 0 ? "" : ""));
  }

  // 规则速查：与主站一致——按原表 1-6 分点逐字原装，不加来源破折号
  function renderRules() {
    const el = document.getElementById("scRules");
    if (!el) return;
    el.innerHTML = D.rules.map(r => `
      <li class="sc-rule"><span class="sc-rule-text">${escapeHtml(r.text)}</span></li>`).join("");
  }
  function renderMindTools() {
    const el = document.getElementById("scMind");
    if (!el) return;
    el.innerHTML = D.mindTools.map(t => `
      <div class="sc-mind">
        <div class="sc-mind-title">${escapeHtml(t.title)}</div>
        <div class="sc-mind-quote">${escapeHtml(t.quote)}</div>
        <div class="sc-mind-action">▸ ${escapeHtml(t.action)}</div>
        <div class="sc-mind-src">—— ${escapeHtml(t.source)}</div>
      </div>`).join("");
  }

  function renderAll() {
    renderTable();
    renderRules();
    renderMindTools();
    renderCompare();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if (!D) return;
    renderAll();
    renderCompare();
    setInterval(() => { renderCompare(); }, 30000);          // 对比卡 30s 刷新
    setInterval(() => { renderTable(); renderRules(); renderMindTools(); renderCompare(); }, 60000); // 每分钟全量走针
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

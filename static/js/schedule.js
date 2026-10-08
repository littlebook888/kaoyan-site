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

  /* ---------- 版本切换（用户 2026-10-08：两版都保留，可随时切换查看）----------
   * ⚠️ 作用范围**仅限本页的表格与对照卡**。
   * 首页时段列表/时钟芯片/通话判定/休息页读的是 SCHEDULE_DATA.slots（恒=当前版），
   * 不受这里的切换影响—— 否则会出现「在时间表页切到存档版，
   * 通话页的判定也跟着按旧作息算」这类跨模块分叉。 */
  const VER_KEY = "kaoyan:schedule_version";
  const VERSIONS = (D && Array.isArray(D.versions) && D.versions.length)
    ? D.versions
    : [{ id: "current", label: "当前版本", shortLabel: "当前版本", isCurrent: true, slots: (D && D.slots) || [] }];
  let viewIdx = 0;   // 本页正在查看的版本下标（默认当前版）

  function versionById(id) {
    for (let i = 0; i < VERSIONS.length; i++) if (VERSIONS[i].id === id) return i;
    return -1;
  }
  function curSlots() { return (VERSIONS[viewIdx] && VERSIONS[viewIdx].slots) || [] || (D.slots || []); }
  function isViewingCurrent() { return VERSIONS[viewIdx] && VERSIONS[viewIdx].isCurrent; }

  // 颜色统一取 schedule-data.js 的 kindColors（单一事实源，v1.16.0）
  const KIND_COLORS = (window.SCHEDULE_DATA && window.SCHEDULE_DATA.kindColors) || {};
  const KIND_META = {
    study:    { label: "自习",   color: KIND_COLORS.study    || "#0d9488" },
    meal:     { label: "用餐",   color: KIND_COLORS.meal     || "#ea580c" },
    rest:     { label: "休息",   color: KIND_COLORS.rest     || "#7c3aed" },
    sleep:    { label: "睡眠",   color: KIND_COLORS.sleep    || "#1e40af" },
    prep:     { label: "预备",   color: KIND_COLORS.prep     || "#64748b" },
    winddown: { label: "收尾",   color: KIND_COLORS.winddown || "#64748b" },
    commute:  { label: "通勤",   color: KIND_COLORS.commute  || "#6b7280" }   // v2-intern 新增
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
    return curSlots().find(x => toMin(x.start) * 60 <= s && s < toMin(x.end) * 60) || null;
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
      let html = '<div class="sc-cmp-theo">' + escapeHtml(c.state) + "</div>";
      // 切到存档版时必须提醒：这条"理论"不是今天要执行的那版
      if (!isViewingCurrent()) {
        const v = VERSIONS[viewIdx];
        html += '<div class="sc-cmp-arch">（当前查看的是存档版「'
          + escapeHtml(v.shortLabel || v.label) + '」，实际执行请看「'
          + escapeHtml(VERSIONS[0].shortLabel || VERSIONS[0].label) + '」）</div>';
      }
      box.innerHTML = html;
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
    const prep = curSlots().find(x => x.kind === "prep");
    return toMin(prep ? prep.start : "07:30");
  }
  function renderTable() {
    const now = currentSlot();
    const s = nowSecBJ();
    const tailMax = tailMaxMin();
    const rows = curSlots().map(slot => {
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

  /* ---------- 版本切换器 ---------- */
  function renderVersionToggle() {
    const box = document.getElementById("scVerToggle");
    const curEl = document.getElementById("scVerCurrent");
    const hintEl = document.getElementById("scVerHint");
    const tagEl = document.getElementById("scTableTag");
    const cur = VERSIONS[0];

    if (curEl) {
      curEl.textContent = "当前生效：" + (cur.shortLabel || cur.label || cur.id);
    }
    if (box) {
      box.innerHTML = VERSIONS.map((v, i) => {
        const active = i === viewIdx;
        return '<button type="button" role="tab" data-vi="' + i + '"'
          + ' aria-selected="' + (active ? "true" : "false") + '"'
          + (active ? ' class="active"' : "") + ">"
          + escapeHtml(v.shortLabel || v.label || v.id)
          + (v.isCurrent ? " ·现行" : "") + "</button>";
      }).join("");
      box.querySelectorAll("button[data-vi]").forEach(b => {
        b.addEventListener("click", function () {
          const i = Number(b.getAttribute("data-vi"));
          if (!isFinite(i) || i === viewIdx) return;
          viewIdx = i;
          try { localStorage.setItem(VER_KEY, VERSIONS[i].id); } catch (e) {}
          renderVersionToggle();
          renderTable();
          renderDiff();
          renderCompare();
        });
      });
    }
    // 表格标题旁标出正在查看的版本；切到存档版时对比卡给出醒目提示
    if (tagEl) {
      const v = VERSIONS[viewIdx];
      tagEl.textContent = v ? ("· " + (v.shortLabel || v.label)) : "";
      tagEl.className = "sc-ver-tag" + (v && !v.isCurrent ? " archive" : "");
    }
    if (hintEl) {
      hintEl.innerHTML = isViewingCurrent()
        ? "当前查看的版本 <b>就是首页与各页实际执行的那一版</b>。切换仅改变本页显示。"
        : "⚠️ 你正在查看<b>存档版</b>，仅供对照，<b>不会被执行</b>。首页时段、时钟芯片、通话判定仍按「"
          + escapeHtml(cur.shortLabel || cur.label) + "」走。";
    }
  }

  /* ---------- 两版并列对照 ---------- */
  function slotKey(s) { return s.start + "~" + s.end + "|" + s.name; }
  function durMin(s) {
    let d = toMin(s.end) - toMin(s.start);
    if (s.end === "24:00") d = 1440 - toMin(s.start);
    return d;
  }
  function renderDiff() {
    const box = document.getElementById("scDiff");
    if (!box) return;
    const cur = VERSIONS[0];
    const others = VERSIONS.slice(1);
    if (!others.length) {
      box.innerHTML = '<div class="sc-diff-empty">目前只有一个版本，无需对照。</div>';
      return;
    }
    const curSlots_ = cur.slots || [];
    const curKeys = new Set(curSlots_.map(slotKey));
    const curTotal = curSlots_.reduce((a, s) => a + durMin(s), 0);
    const curStudy = curSlots_.filter(s => s.kind === "study").reduce((a, s) => a + durMin(s), 0);

    let html = "";
    for (const ov of others) {
      const ovSlots = ov.slots || [];
      const ovKeys = new Set(ovSlots.map(slotKey));
      const ovTotal = ovSlots.reduce((a, s) => a + durMin(s), 0);
      const ovStudy = ovSlots.filter(s => s.kind === "study").reduce((a, s) => a + durMin(s), 0);

      const changed = [];
      for (const s of curSlots_) {
        if (!ovKeys.has(slotKey(s))) changed.push({ type: "add", s });
      }
      for (const s of ovSlots) {
        if (!curKeys.has(slotKey(s))) changed.push({ type: "del", s });
      }
      // 同名同 kind 但时段长度变了（如「午餐 30min→60min」）也要列出来
      const byKey = new Map(ovSlots.map(s => [slotKey(s), s]));
      for (const s of curSlots_) {
        const o = byKey.get(slotKey(s));
        if (o && durMin(o) !== durMin(s)) changed.push({ type: "len", s, o });
      }

      const metric = (label, a, b, unit) => {
        const same = a === b;
        return '<div class="sc-diff-metric"><span class="sc-diff-ml">' + label + "</span>"
          + '<span class="sc-diff-mv">' + a + unit + "</span>"
          + '<span class="sc-diff-arrow">' + (same ? "＝" : " ≠ ") + "</span>"
          + '<span class="sc-diff-mv dim">' + b + unit + "</span></div>";
      };

      html += '<div class="sc-diff-ver">'
        + '<div class="sc-diff-vhead"><span class="sc-diff-vtag now">' + escapeHtml(cur.shortLabel || cur.label) + "</span>"
        + '<span class="sc-diff-vs">当前生效版</span></div>'
        + '<div class="sc-diff-vhead"><span class="sc-diff-vtag archive">' + escapeHtml(ov.shortLabel || ov.label) + "</span>"
        + '<span class="sc-diff-vs">存档版（不执行）</span></div>'
        + "</div>"
        + '<div class="sc-diff-metrics">'
        + metric("全天合计", curTotal / 60, ovTotal / 60, "h")
        + metric("自习合计", curStudy / 60, ovStudy / 60, "h")
        + metric("时段数", curSlots_.length, ovSlots.length, "")
        + "</div>";
      if (changed.length) {
        html += '<div class="sc-diff-list-title">差异时段</div><ul class="sc-diff-list">';
        for (const c of changed) {
          const km = kindMeta(c.s.kind);
          const t = c.type === "add" ? "新增" : (c.type === "del" ? "取消" : "时长调整");
          const oldTxt = c.type === "len"
            ? '（存档版为 ' + c.s.start + "~" + c.s.end + "，" + (durMin(c.o) / 60) + "h）" : "";
          html += '<li class="sc-diff-item ' + c.type + '">'
            + '<span class="sc-diff-badge">' + t + "</span>"
            + '<span class="sc-kind-dot" style="background:' + km.color + '"></span>'
            + "<b>" + c.s.start + "~" + c.s.end + "</b> " + escapeHtml(c.s.name)
            + (oldTxt ? '<span class="sc-diff-old">' + escapeHtml(oldTxt) + "</span>" : "")
            + "</li>";
        }
        html += "</ul>";
      } else {
        html += '<div class="sc-diff-same">两版时段完全一致。</div>';
      }
    }
    box.innerHTML = html;
  }

  function renderAll() {
    renderVersionToggle();
    renderTable();
    renderDiff();
    renderRules();
    renderMindTools();
    renderCompare();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if (!D) return;
    // 恢复上次查看的版本（读不到或非法则回当前版）
    try {
      const saved = localStorage.getItem(VER_KEY);
      const i = versionById(saved);
      if (i >= 0) viewIdx = i;
    } catch (e) {}
    renderAll();
    renderCompare();
    setInterval(() => { renderCompare(); }, 30000);          // 对比卡 30s 刷新
    setInterval(() => { renderTable(); renderCompare(); }, 60000); // 每分钟走针
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

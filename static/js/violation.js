/* =====================================================================
 *  violation.js —— 违规记录模块（v1.32.0 · 完全独立，用户 2026.10.05 指定）
 *  ---------------------------------------------------------------------
 *  · 以【自然日】人工判定违规：登记 = 记录判定日期+时间，违规内容可选填
 *  · 惩罚：当日和次日不得「娱乐 / 通话 / 聚餐」；一日多次违规或违规期内再犯，
 *    一次违规 +1 日惩罚；违规日晚于当前惩罚期末 → 新一轮（当日+次日）
 *  · 惩罚期间 → 任务页顶部震撼横幅（页面内布局推挤，不发系统通知）
 *  · 完全独立：不与通话边界/任务/计时/统计联动（不写 tasks/time_records/active_timer）
 *  · 多端轻量同步：events 表行 { id: "viol-<时间戳ms>", date, title: "violation", note }
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const EV_PREFIX = "viol-";
  const FORBIDDEN = ["娱乐", "通话", "聚餐"];

  function bjNow() {
    return window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
  }
  function dateKey(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function todayKey() { return dateKey(bjNow()); }

  function violations() {
    return (Store.getEvents() || [])
      .filter(e => e && e.id && String(e.id).startsWith(EV_PREFIX))
      .map(e => ({ id: e.id, date: e.date || "", note: e.note || "", ts: Number(String(e.id).slice(EV_PREFIX.length)) || 0 }))
      .sort((a, b) => a.ts - b.ts);
  }

  /* 惩罚算法（v1.32.0）：按登记时间排序逐条结算——
   *  首条/晚于当前期末的条目 = 新一轮（当日+次日，即期末 = 违规日+1）；
   *  当日多次或违规期内再犯 = 期末 +1 日。返回惩罚期末的日期 key（无违规 → null）。 */
  function penaltyEndKey() {
    const vs = violations();
    if (!vs.length) return null;
    let end = null;   // "YYYY-MM-DD"
    const plusDays = (k, n) => {
      const d = new Date(k + "T00:00:00");
      d.setDate(d.getDate() + n);
      return dateKey(d);
    };
    for (const v of vs) {
      if (!v.date) continue;
      if (end === null || v.date > end) end = plusDays(v.date, 1);   // 新一轮：当日+次日
      else end = plusDays(end, 1);                                   // 期内/同日再犯：+1 日
    }
    return end;
  }
  /* 当前是否处于违规惩罚期：今日 ≤ 惩罚期末 */
  function inPenalty() {
    const end = penaltyEndKey();
    return !!end && todayKey() <= end;
  }
  /* 剩余惩罚天数（含今天） */
  function remainDays() {
    const end = penaltyEndKey();
    if (!end) return 0;
    const t = new Date(todayKey() + "T00:00:00"), e = new Date(end + "T00:00:00");
    return Math.max(0, Math.round((e - t) / 86400000) + 1);
  }

  /* 登记：判定时刻 = 现在；内容可选填 */
  function register(note) {
    const d = bjNow();
    const p = (n) => String(n).padStart(2, "0");
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    const id = EV_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    events.push({
      id, user_id: C.USER_ID,
      date: todayKey(),
      title: "violation",
      note: (note || "").trim(),
      time: `${p(d.getHours())}:${p(d.getMinutes())}`
    });
    Store.setEvents(events);
    return id;
  }
  /* 删除（误登记兜底）：显式推删云端行 */
  function remove(id) {
    if (!String(id || "").startsWith(EV_PREFIX)) return false;
    Store.deleteEventRow(id);
    return true;
  }

  function alertMsg(msg) {
    if (window.UI && window.UI.showAlert) window.UI.showAlert(msg, 2200);
  }

  /* 日期 key → 中文短格式（2026-10-07 → 10月7日） */
  function fmtCn(k) {
    const parts = String(k || "").split("-");
    return `${Number(parts[1])}月${Number(parts[2])}日`;
  }

  function render() {
    const penal = inPenalty();
    const end = penaltyEndKey();
    // 震撼横幅（违规中才显示；页面内布局推挤，不发系统通知）
    const banner = document.getElementById("violationBanner");
    if (banner) {
      banner.style.display = penal ? "" : "none";
      if (penal) {
        const range = document.getElementById("violationBannerRange");
        if (range) range.textContent = `人工判定违规 · 自动累计（再犯 +1 日/次）`;
        const endEl = document.getElementById("violationBannerEnd");
        if (endEl) endEl.textContent = fmtCn(end);
        const leftEl = document.getElementById("violationBannerLeft");
        if (leftEl) leftEl.textContent = `剩 ${remainDays()} 天`;
        if (window.Icon) window.Icon.inject(banner);
      }
    }
    // 底部独立卡
    const card = document.getElementById("violationCard");
    if (card) card.classList.toggle("penal", penal);
    const st = document.getElementById("violationState");
    if (st) {
      st.textContent = penal ? `违规中 · 剩 ${remainDays()} 天` : "正常";
      st.className = "ck-state " + (penal ? "bad" : "ok");
    }
    // 记录列表（最近在前）
    const list = document.getElementById("violationList");
    if (list) {
      const vs = violations().slice().reverse();
      list.innerHTML = vs.length ? vs.map(v => `
        <div class="viol-row">
          <span class="viol-dot"></span>
          <span class="viol-main"><b>${fmtCn(v.date)}${v.time ? " " + v.time : ""}</b>${v.note ? `<i>${escapeHtml(v.note)}</i>` : ""}</span>
          <button type="button" class="viol-del" data-viol-del="${v.id}">删除</button>
        </div>`).join("") : '<div class="viol-empty">暂无违规记录</div>';
      list.querySelectorAll("[data-viol-del]").forEach(b => b.addEventListener("click", () => {
        if (remove(b.dataset.violDel)) { render(); alertMsg("已删除该条违规记录"); }
      }));
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function bind() {
    const btn = document.getElementById("violationAddBtn");
    const noteEl = document.getElementById("violationNote");
    if (btn) btn.addEventListener("click", () => {
      register(noteEl ? noteEl.value : "");
      if (noteEl) noteEl.value = "";
      render();
      alertMsg("⛔ 已登记违规（惩罚期自动计算）");
    });
    // 其他设备登记/删除 → events 同步落地 → 本页即时跟随
    if (Store.subscribeEvents) Store.subscribeEvents(() => render());
    setInterval(render, 60000);
  }

  function init() { bind(); render(); }

  window.VIOLATION = { init, render, bind, violations, penaltyEndKey, inPenalty, remainDays, register, remove, FORBIDDEN };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

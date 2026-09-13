/* =====================================================================
 *  home-schedule.js —— 首页「规则部时间表 · 现在该做什么」卡片
 *  ---------------------------------------------------------------
 *  1) 当前时段 hero：时段名/区间 + 实时进度条 + 剩余时间 + 状态判定
 *  2) 今日 9 时段列表：已过淡化 / 当前高亮「现在」/ 自习时段一键正计时
 *  3) 自习室规则速查：SCHEDULE_DATA.rules 按 1-6 编号逐字原装（不加来源破折号）
 *  数据：schedule-data.js（window.SCHEDULE_DATA，与副站 schedule.html 同源同改）
 *  一键正计时：跳 timer.html?up=1&cat=study&label=时段名（timer.js 负责自动开跑；
 *              正计时不自动停止，手动停止走计时器页统一流程，本模块不碰计时生命周期）
 *  刷新：1 秒走针（与首页实时时钟对齐）；时段切换/计时状态变化才整体重渲
 *  依赖：config.js / blocks.js / store.js / ui.js / icon.js；加载顺序须在 store.js 之后
 * ===================================================================== */
(function () {
  const D = window.SCHEDULE_DATA;
  if (!D) return;

  const KIND_META = {
    study:    { label: "自习", color: "#059669", icon: "book-open" },
    meal:     { label: "用餐", color: "#ea580c", icon: "utensils" },
    rest:     { label: "休息", color: "#0ea5e9", icon: "coffee" },
    sleep:    { label: "睡眠", color: "#4f46e5", icon: "moon" },
    prep:     { label: "预备", color: "#64748b", icon: "sunrise" },
    winddown: { label: "收尾", color: "#64748b", icon: "wind" }
  };
  // 自习时段专属图标（上午日出 / 下午烈日 / 晚上月亮），其余时段按性质取 KIND_META
  const STUDY_ICONS = ["sunrise", "sun", "moon"];

  // 预处理：每个时段挂上颜色 / 图标 / 开始按钮链接（启动时算一次，渲染不再重复拼）
  let studyIdx = 0;
  const SLOTS = D.slots.map(s => Object.assign({}, s, {
    color: (KIND_META[s.kind] || {}).color || "#64748b",
    icon: s.kind === "study"
      ? STUDY_ICONS[Math.min(studyIdx++, STUDY_ICONS.length - 1)]
      : (KIND_META[s.kind] || {}).icon || "clock-3",
    startUrl: s.kind === "study"
      ? "timer.html?up=1&cat=study&label=" + encodeURIComponent(s.name)
      : ""
  }));

  // 一天从「起床」开始：起床前的时段（夜间收尾/睡眠）是前一天的尾巴——白天属于
  // 「今晚尚未到来」，不按已流逝淡化（与副站 schedule.js 同口径）
  const TAIL_MAX_MIN = toMin((D.slots.find(x => x.kind === "prep") || { start: "07:30" }).start);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function toMin(t) { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  // 全站统一北京时间当日秒数（与 blocks.js / 副站 schedule.js 同口径）
  function nowSec() {
    if (window.Blocks && window.Blocks.secOfDay) return window.Blocks.secOfDay(new Date());
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function currentSlot() {
    const s = nowSec();
    return SLOTS.find(x => toMin(x.start) * 60 <= s && s < toMin(x.end) * 60) || null;
  }
  function slotKey(slot) { return slot ? slot.start + "-" + slot.end : "none"; }
  function p2(n) { return String(n).padStart(2, "0"); }
  function fmtClock(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
  }
  function fmtDur(sec) {
    if (sec <= 0) return "0 分钟";
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0 && m > 0) return `${h}小时${m}分`;
    if (h > 0) return `${h}小时`;
    return `${Math.max(1, m)}分钟`;
  }
  function slotDurText(slot) {
    return fmtDur((toMin(slot.end) - toMin(slot.start)) * 60);
  }

  /* ---------- 计时状态（对照 schedule.js 的判定口径） ---------- */
  function activeState() {
    const at = window.Store ? window.Store.getActiveTimer() : null;
    const running = !!(at && at.status === "running");
    const paused = !!(at && at.status === "paused");
    const isStudy = !!(at && (at.kind === "study" || at.sub_category === "enter_state"));
    let elapsed = 0;
    if (at) {
      elapsed = running
        ? Math.round((at.elapsed_sec || 0) + (Date.now() - (at.started_at || Date.now())) / 1000)
        : Math.round(at.elapsed_sec || 0);
      elapsed = Math.max(0, elapsed);
    }
    return { at, running, paused, isStudy, elapsed };
  }

  function statusInfo(slot, st) {
    const isStudySlot = slot && slot.kind === "study";
    const theo = slot ? `${slot.name}（${slot.start}~${slot.end}）` : "自由时段";
    if (isStudySlot) {
      if (st.at && st.running && st.isStudy) {
        return { cls: "ok", html: `✅ 正在计时 <b>${fmtClock(st.elapsed)}</b>（${escapeHtml(st.at.label || "学习")}）· 保持！` };
      }
      if (st.at && st.running) {
        return { cls: "warn", html: `⚠️ ${escapeHtml(theo)}，但当前计时为「${escapeHtml(st.at.label || st.at.kind)}」（非学习类）` };
      }
      if (st.at && st.paused) {
        return { cls: "warn", html: `⏸ ${escapeHtml(theo)}——计时处于暂停中，尽快继续` };
      }
      return { cls: "bad", html: `❌ ${escapeHtml(theo)}，还没开始计时——迟到不等待整点，立即开始` };
    }
    // 非学习时段（用餐 / 休息 / 睡眠 / 预备 / 收尾）
    if (st.at && st.running) {
      return { cls: "info", html: `ℹ️ ${escapeHtml(theo)}——你在自觉加练（${escapeHtml(st.at.label || st.at.kind)}），单次休息不超过 20min` };
    }
    if (st.at && st.paused) {
      return { cls: "info", html: `ℹ️ ${escapeHtml(theo)}——计时暂停中（${escapeHtml(st.at.label || st.at.kind)}）` };
    }
    return { cls: "ok", html: `✅ ${escapeHtml(theo)}（当前无计时，符合安排）` };
  }

  function actionHtml(slot, st) {
    if (slot.kind !== "study") return "";
    if (st.at) {
      // 已有会话（含其他设备开启的）：不再提供第二个开始入口，防止覆盖原会话
      return `<div class="sch-actions"><a class="btn ghost sch-btn" href="timer.html">已有会话 → 去计时页</a></div>`;
    }
    return `<div class="sch-actions"><a class="btn sch-btn" href="${slot.startUrl}">开始「${escapeHtml(slot.name)}」正计时</a></div>`;
  }

  /* ---------- 渲染 ---------- */
  function renderFull() {
    const box = document.getElementById("homeSchedule");
    if (!box) return;
    const slot = currentSlot();
    const st = activeState();
    const s = nowSec();

    let hero;
    if (slot) {
      const a = toMin(slot.start) * 60, b = toMin(slot.end) * 60;
      const prog = b > a ? Math.max(0, Math.min(100, Math.round(((s - a) / (b - a)) * 100))) : 0;
      const si = statusInfo(slot, st);
      hero = `
      <div class="sch-hero" style="--kc:${slot.color}">
        <div class="sch-hero-top">
          <span class="sch-hero-ico" data-icon="${slot.icon}"></span>
          <div class="sch-hero-name">${escapeHtml(slot.name)}<span class="sch-now-badge">现在</span></div>
          <div class="sch-hero-range">${slot.start}~${slot.end} · 共${slotDurText(slot)}</div>
        </div>
        <div class="sch-prog"><i id="schProgFill" style="width:${prog}%"></i></div>
        <div class="sch-hero-meta" id="schHeroMeta">已进行 ${fmtDur(Math.max(0, s - a))} · 距结束还剩 <b>${fmtDur(Math.max(0, b - s))}</b></div>
        <div class="sch-status ${si.cls}" id="schStatus">${si.html}</div>
        ${actionHtml(slot, st)}
      </div>`;
    } else {
      hero = `
      <div class="sch-hero" style="--kc:#64748b">
        <div class="sch-hero-top">
          <span class="sch-hero-ico" data-icon="clock-3"></span>
          <div class="sch-hero-name">当前不在任何计划时段<span class="sch-now-badge">自由</span></div>
        </div>
        <div class="sch-status info">ℹ️ 此刻不在《规则部计划表》内，自行安排</div>
      </div>`;
    }

    const rows = SLOTS.map(x => {
      const isNow = slot && x.start === slot.start && x.end === slot.end;
      const past = !isNow && toMin(x.end) > TAIL_MAX_MIN && toMin(x.end) * 60 <= s;
      const cls = isNow ? "now" : (past ? "past" : "future");
      const btn = x.startUrl
        ? `<a class="sch-row-btn" style="background:${x.color}" href="${x.startUrl}" title="开始「${escapeHtml(x.name)}」正计时" aria-label="开始 ${escapeHtml(x.name)} 正计时"><span data-icon="play"></span></a>`
        : "";
      return `
      <div class="sch-row ${cls}" style="--kc:${x.color}">
        <div class="sch-row-time">${x.start}~${x.end}</div>
        <div class="sch-row-main">
          <div class="sch-row-name"><span class="sch-dot" style="background:${x.color}"></span>${escapeHtml(x.name)}${isNow ? '<span class="sch-now-badge">现在</span>' : ""}</div>
          ${x.note ? `<div class="sch-row-note">${escapeHtml(x.note)}</div>` : ""}
        </div>
        <div class="sch-row-dur">${slotDurText(x)}</div>
        ${btn}
      </div>`;
    }).join("");

    // 自习室规则速查：按原表 1-6 分点逐字原装，不加来源破折号
    const rules = `
    <details class="sch-rules">
      <summary>自习室规则速查（${D.rules.length} 条）</summary>
      <ol class="sch-rules-ol">${D.rules.map(r => `<li>${escapeHtml(r.text)}</li>`).join("")}</ol>
    </details>`;

    const more = `<div class="sch-more"><a href="schedule.html">查看完整时间表（理论 vs 实际对比 · 心态工具）→</a></div>`;

    box.innerHTML = hero + `<div class="sch-list">${rows}</div>` + rules + more;
    if (window.Icon) window.Icon.inject(box);
  }

  /* ---------- 1 秒走针：只更新文本 / 进度，时段切换才整体重渲 ---------- */
  let _lastSlotKey = null;
  function tick() {
    const box = document.getElementById("homeSchedule");
    if (!box) return;
    const slot = currentSlot();
    const key = slotKey(slot);
    if (key !== _lastSlotKey) {
      _lastSlotKey = key;
      renderFull();
      return;
    }
    if (slot) {
      const a = toMin(slot.start) * 60, b = toMin(slot.end) * 60;
      const s = nowSec();
      const prog = b > a ? Math.max(0, Math.min(100, Math.round(((s - a) / (b - a)) * 100))) : 0;
      const fill = document.getElementById("schProgFill");
      if (fill) fill.style.width = prog + "%";
      const meta = document.getElementById("schHeroMeta");
      if (meta) meta.innerHTML = `已进行 ${fmtDur(Math.max(0, s - a))} · 距结束还剩 <b>${fmtDur(Math.max(0, b - s))}</b>`;
      // 状态行每秒重建（含正计时秒表数字）；类名随判定即时切换
      const statusEl = document.getElementById("schStatus");
      if (statusEl) {
        const si = statusInfo(slot, activeState());
        if (statusEl.getAttribute("data-cls") !== si.cls) {
          statusEl.className = "sch-status " + si.cls;
          statusEl.setAttribute("data-cls", si.cls);
        }
        statusEl.innerHTML = si.html;
      }
    }
  }

  function init() {
    if (!document.getElementById("homeSchedule")) return;
    _lastSlotKey = slotKey(currentSlot());
    renderFull();
    setInterval(tick, 1000);
    // 三端同步：任意一端开始/暂停/停止 → 立即整体重渲（按钮与状态行联动）
    if (window.Store && window.Store.subscribeActiveTimer) {
      window.Store.subscribeActiveTimer(() => {
        _lastSlotKey = slotKey(currentSlot());
        renderFull();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

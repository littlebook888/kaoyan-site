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

  // 颜色统一取 schedule-data.js 的 kindColors（单一事实源，v1.16.0）
  const KIND_COLORS = (D && D.kindColors) || {};
  const KIND_META = {
    study:    { label: "自习", color: KIND_COLORS.study    || "#0d9488", icon: "book-open" },
    meal:     { label: "用餐", color: KIND_COLORS.meal     || "#ea580c", icon: "utensils" },
    rest:     { label: "休息", color: KIND_COLORS.rest     || "#7c3aed", icon: "coffee" },
    sleep:    { label: "睡眠", color: KIND_COLORS.sleep    || "#1e40af", icon: "moon" },
    prep:     { label: "预备", color: KIND_COLORS.prep     || "#64748b", icon: "sunrise" },
    winddown: { label: "收尾", color: KIND_COLORS.winddown || "#64748b", icon: "wind" }
  };
  // 自习时段专属图标（上午日出 / 下午烈日 / 晚上月亮），其余时段按性质取 KIND_META
  const STUDY_ICONS = ["sunrise", "sun", "moon"];

  /* ---------- 每时段预设计时映射（全部正计时打点，手动停止）----------
   * 用户拍板（v1.6.3 / v1.6.7）：一键吃饭/一键睡觉——按下即进入对应标签的正计时；
   * 午休用专属二级「午休」noon_rest；睡眠仍用「长睡觉」；
   * 自习时段二级保持空（进页后或停止时自行选西综/英语等）；
   * 起床（prep）不设按钮。label 去掉括号备注（「睡眠（预计 7 小时）」→「睡眠」）。 */
  const PRESET_BY_KIND = {
    study:    { cat: "study", sub: "" },
    meal:     { cat: "meal",  sub: "regular" },
    rest:     { cat: "sleep", sub: "noon_rest" },
    sleep:    { cat: "sleep", sub: "long_sleep" },
    winddown: { cat: "other", sub: "other" }
  };
  /* 一键开始时预置的标签（tags）：让记录自带可检索维度，且停止时不再弹标签抽屉。
   * 自习→专注、吃饭→用餐、睡觉→休息（用户指定）；夜间收尾→收尾。 */
  const PRESET_TAGS = {
    study: "专注", meal: "用餐", sleep: "休息", other: "收尾"
  };
  function cleanLabel(name) {
    return String(name || "").replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim();
  }

  // 预处理：每个时段挂上颜色 / 图标 / 预设计时链接（启动时算一次，渲染不再重复拼）
  let studyIdx = 0;
  const SLOTS = D.slots.map(s => {
    const p = PRESET_BY_KIND[s.kind];
    const label = cleanLabel(s.name);
    const tag = (p && PRESET_TAGS[p.cat]) || "";
    return Object.assign({}, s, {
      color: (KIND_META[s.kind] || {}).color || "#64748b",
      icon: s.kind === "study"
        ? STUDY_ICONS[Math.min(studyIdx++, STUDY_ICONS.length - 1)]
        : (KIND_META[s.kind] || {}).icon || "clock-3",
      btnLabel: label,
      startUrl: p
        ? "timer.html?up=1&cat=" + p.cat + "&sub=" + p.sub +
          (tag ? "&tags=" + encodeURIComponent(tag) : "") +
          "&label=" + encodeURIComponent(label)
        : ""
    });
  });

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
    /* v1.21.3：统一走 UI.fmtDur。
     * 旧实现把 30 秒"凑整"成 1 分钟（Math.max(1, m)），剩 30 秒时显示"1分钟"是错的；
     * 现在 <1 分钟如实显示"30秒"。<=0 仍给"0 分钟"，避免时段已结束时显示成"0秒"太突兀。 */
    if (!(sec > 0)) return "0 分钟";
    return window.UI && window.UI.fmtDur ? window.UI.fmtDur(sec) : `${Math.max(1, Math.round(sec / 60))}分钟`;
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

  /* 计时中的随类别提醒（按一级分类给话术，可自行增改）
   * kind 取计时器当前会话的 category：study/work/meal/rest/sleep/commute/... */
  const HINT_BY_CAT = {
    study:     "保持！",
    work:      "请抓紧利用碎片时间学习！",          // 实习 / 副业
    internship:"请抓紧利用碎片时间学习！",          // 实习（独立分类）
    meal:      "吃饭就专心吃，恢复好再上",
    rest:      "休息是为了下一段更专注",
    sports:    "好好锻炼，回来效率更高",
    commute:   "路上可以听音频、背单词",
    housework: "快点收尾，回到书桌",
    sleep:     "早睡——明天的状态靠今晚",
    call:      "注意边界，别被聊久了",
    entertain: "这是娱乐时间，及时收手",
    other:     "记一下这段，别让时间悄悄溜走"
  };
  // 需要"提醒语气"（黄底警示）的分类
  const HINT_WARN_CATS = { entertain: 1, call: 1 };
  function catHint(kind) { return HINT_BY_CAT[kind] || HINT_BY_CAT.study; }

  function statusInfo(slot, st) {
    const isStudySlot = slot && slot.kind === "study";
    const theo = slot ? `${slot.name}（${slot.start}~${slot.end}）` : "自由时段";
    // 1) 计时进行中：以"当前在计什么"+类别提醒为主（用户看的就是自己的计时）
    if (st.at && st.running) {
      const label = escapeHtml(st.at.label || st.at.kind || "计时");
      const hint = catHint(st.at.kind);
      const head = `正在计时 <b>${fmtClock(st.elapsed)}</b>（${label}）`;
      if (isStudySlot && !st.isStudy) return { cls: "warn", html: `⚠️ ${head} · ${hint}` };  // 学习时段却在做别的
      if (HINT_WARN_CATS[st.at.kind]) return { cls: "warn", html: `⚠️ ${head} · ${hint}` };
      if (st.isStudy) return { cls: "ok", html: `✅ ${head} · ${hint}` };
      return { cls: "info", html: `ℹ️ ${head} · ${hint}` };
    }
    // 2) 暂停中
    if (st.at && st.paused) {
      const label = escapeHtml(st.at.label || st.at.kind || "计时");
      return {
        cls: isStudySlot && !st.isStudy ? "warn" : "info",
        html: `⏸ 计时暂停中（${label}）——尽快继续，别让状态断掉`
      };
    }
    // 3) 无计时
    if (isStudySlot) {
      return { cls: "bad", html: `❌ ${escapeHtml(theo)}，还没开始计时——迟到不等待整点，立即开始` };
    }
    if (slot && slot.startUrl) {
      return { cls: "info", html: `ℹ️ ${escapeHtml(theo)}——当前无计时，需要就一键开始` };
    }
    return { cls: "ok", html: `✅ ${escapeHtml(theo)}（当前无计时，符合安排）` };
  }

  function actionHtml(slot, st) {
    if (!slot.startUrl) return "";
    if (st.at) {
      // 已有会话（含其他设备开启的）：不再提供第二个开始入口，防止覆盖原会话
      //   （放音乐入口在计时器页，不放在首页）
      return `<div class="sch-actions"><a class="btn ghost sch-btn" href="timer.html">已有会话 → 去计时页</a></div>`;
    }
    let verb = "";
    if (slot.kind === "meal") verb = "一键吃饭 · ";
    else if (slot.kind === "rest" || slot.kind === "sleep") verb = "一键睡觉 · ";
    return `<div class="sch-actions"><a class="btn sch-btn" href="${slot.startUrl}">${verb}开始「${escapeHtml(slot.btnLabel)}」正计时</a></div>`;
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

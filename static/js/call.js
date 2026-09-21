/* =====================================================================
 *  call.js —— 通话边界管控分站核心逻辑
 *  功能：今日判定 · 话术速查 · 随机借口 · 双闹钟 · 周频率 · 联动计时
 *  依赖：config.js / blocks.js / clock.js / store.js / ui.js / call-data.js / icon.js
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;
  const D = window.CALL_DATA;

  // ---- 状态 ----
  let callStartAt = null;      // 通话开始时间戳
  let warnTimerId = null;      // 15min 预警定时器
  let finalTimerId = null;     // 25min 终极定时器
  let callTickId = null;       // 通话时长刷新
  let weeklyCallCount = 0;    // 本周已用次数（从时间记录推算）

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function p(n) { return String(Math.max(0, Math.floor(n))).padStart(2, "0"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- 当前时段（对齐规则部 9.13 计划表） ----------
   * 学习区间（kind=study）= 计划表的正经学习时间 → 按规则「正经时间一律禁止聊天」
   * 依赖 schedule-data.js（window.SCHEDULE_DATA）；未加载时本功能静默降级 */
  function toMin(t) { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  function nowSecBJ() {
    if (window.Blocks && window.Blocks.secOfDay) return window.Blocks.secOfDay(new Date());
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function currentSlotInfo() {
    const D = window.SCHEDULE_DATA;
    if (!D || !D.slots) return null;
    const s = nowSecBJ();
    const slot = D.slots.find(x => toMin(x.start) * 60 <= s && s < toMin(x.end) * 60);
    if (!slot) return { slot: null, remainMin: 0, isStudy: false };
    const endSec = toMin(slot.end) * 60;
    return {
      slot,
      remainMin: Math.max(0, Math.round((endSec - s) / 60)),
      isStudy: slot.kind === "study",
      // 放松时间是否 ≥30min（接听前提之一：非专注 AND 放松 >30min）
      relaxOk: slot.kind !== "study" && (endSec - s) >= 30 * 60
    };
  }
  function fmtRemain(min) {
    return min >= 60 ? `${Math.floor(min / 60)}小时${min % 60}分` : `${min}分钟`;
  }
  // 秒 → 时长文案（此刻快照用；与 day-review.js 同款格式）
  function fmtDuration(sec) {
    // v1.21.3：统一走 UI.fmtDur（<1 分钟显示"29秒"，不再显示"0分"）
    return window.UI && window.UI.fmtDur ? window.UI.fmtDur(sec) : Math.max(0, Math.round(Number(sec) || 0)) + "秒";
  }
  // 展示名去掉括号备注（「睡眠（预计 7 小时）」→「睡眠」）
  function cleanName(n) { return String(n || "").replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim(); }

  /* ---------- 规则部特殊处理（豁免窗口）----------
   * 设计：学习区间不是"一刀切死"——大块时间内的短暂放松/垃圾时间可报规则部，
   * 人工判断后给一段临时豁免（默认 30 分钟），到期自动恢复限制；全程留痕便于复盘。
   * 存储：kaoyan:call_overrides = { quota_extra, necessary }；日报备次数 kaoyan:call_override_log。
   * 两类豁免只放行各自对应的限制，允许同时存在；旧 call_override 会幂等迁移。 */
  const OV_KEY = "kaoyan:call_overrides";
  const OV_LEGACY_KEY = "kaoyan:call_override";
  const OV_LOG_KEY = "kaoyan:call_override_log";
  function getOverrides() {
    try {
      let map = JSON.parse(localStorage.getItem(OV_KEY) || "null") || {};
      const legacy = JSON.parse(localStorage.getItem(OV_LEGACY_KEY) || "null");
      if (legacy && legacy.until > Date.now()) {
        const type = legacy.type === "necessary" ? "necessary" : "quota_extra";
        if (!map[type]) map[type] = { ...legacy, type };
      }
      if (legacy) localStorage.removeItem(OV_LEGACY_KEY);
      let changed = false;
      ["quota_extra", "necessary"].forEach(type => {
        if (map[type] && (!map[type].until || map[type].until <= Date.now())) {
          delete map[type]; changed = true;
        }
      });
      if (changed || legacy) localStorage.setItem(OV_KEY, JSON.stringify(map));
      return map;
    } catch (e) { return {}; }
  }
  function getOverride(type) { return getOverrides()[type] || null; }
  function overrideActive(type) {
    const map = getOverrides();
    return type ? !!map[type] : !!(map.quota_extra || map.necessary);
  }
  function overrideStateKey() {
    const map = getOverrides();
    return ["quota_extra", "necessary"].map(t => map[t] ? `${t}:${map[t].until}` : "-").join("|");
  }
  /* 两类真正的豁免：quota_extra = 本周第 5 次及以后；necessary = 正经时间内确实不得不。 */
  function setOverride(reason, minutes, type) {
    const o = { until: Date.now() + minutes * 60000, reason: reason || "特殊处理",
                type: type === "necessary" ? "necessary" : "quota_extra", at: Date.now() };
    try {
      const map = getOverrides();
      map[o.type] = o;
      localStorage.setItem(OV_KEY, JSON.stringify(map));
    } catch (e) {}
    // 日报备计数（用于复盘自律情况）
    try {
      const today = window.Blocks ? window.Blocks.dateStr(new Date()) : new Date().toDateString();
      const log = JSON.parse(localStorage.getItem(OV_LOG_KEY) || "null");
      const n = (log && log.d === today) ? (log.n || 0) + 1 : 1;
      localStorage.setItem(OV_LOG_KEY, JSON.stringify({ d: today, n }));
    } catch (e) {}
    return o;
  }
  function overrideTypeLabel(o) {
    return o && o.type === "necessary" ? "正经时间·确实不得不通话" : "增加 1 次周额度";
  }
  function clearOverride(type) {
    try {
      const map = getOverrides();
      if (type) delete map[type];
      else Object.keys(map).forEach(k => delete map[k]);
      localStorage.setItem(OV_KEY, JSON.stringify(map));
    } catch (e) {}
  }
  function overrideCountToday() {
    try {
      const today = window.Blocks ? window.Blocks.dateStr(new Date()) : new Date().toDateString();
      const log = JSON.parse(localStorage.getItem(OV_LOG_KEY) || "null");
      return (log && log.d === today) ? (log.n || 0) : 0;
    } catch (e) { return 0; }
  }
  /* 理由历史（最近 3 次，本机）：快速复用，不跨端同步 */
  const REASON_HIST_KEY = "kaoyan:call_reason_history";
  function getReasonHistory(type) {
    try { return (JSON.parse(localStorage.getItem(REASON_HIST_KEY) || "{}")[type]) || []; }
    catch (e) { return []; }
  }
  function pushReasonHistory(type, reason) {
    try {
      const map = JSON.parse(localStorage.getItem(REASON_HIST_KEY) || "{}") || {};
      const arr = (map[type] || []).filter(r => r !== reason);
      arr.unshift(reason);
      map[type] = arr.slice(0, 3);
      localStorage.setItem(REASON_HIST_KEY, JSON.stringify(map));
    } catch (e) {}
  }
  function overrideMinutes() {
    const r = (D && D.rules) || {};
    return typeof r.overrideMinutes === "number" ? r.overrideMinutes : 30;
  }

  /* ---------- 通话记录的统一识别（v1.22.11）----------
   * call_boundary = 双闹钟记下的真实通话；call_manual = 「补记通话」的条目。
   * 两者都算"这次通话"（今日通话分钟 / 上次通话 / 周额度都计），
   * 区别只在主站是否显示：call_manual 被 today-records.js 排除在主站视图之外
   * （用户指示：补记暂不与主站时间记录联动）。 */
  function isCallRec(r) {
    return !!r && (r.source === "call_boundary" || r.source === "call_manual");
  }

  /* ---------- 今日通话分钟（#12）：从时间账本统计 + 手动补记 ---------- */
  function todayCallMin() {
    const recs = Store.getTimeRecords() || [];
    const today = window.Blocks ? window.Blocks.dateStr(new Date()) : new Date().toDateString();
    let sec = 0;
    recs.forEach(r => {
      if (!isCallRec(r) || !r.started_at) return;
      if (window.Blocks.dateStr(new Date(r.started_at)) === today) sec += r.duration_sec || 0;
    });
    return Math.round(sec / 60);
  }
  function renderTodayCall() {
    const el = document.getElementById("todayCallMin");
    if (el) el.textContent = String(todayCallMin());
  }

  /* 非学习时段的性质提示（不轻易断言"可接听"——接听还受周频率/邀约/主聊日约束）
   * rest 才是规则里说的"放松时间"，睡眠/收尾/预备属作息时段，不该当聊天窗口 */
  const NONSTUDY_HINT = {
    rest:     "休息时段（非专注）——按规则还须「放松时间 >30min」且非邀约，才可考虑接听",
    meal:     "用餐时段——一般用 17:30 话术池推脱，或餐后文字回复",
    sleep:    "睡眠时段（规则部建议，非强制）——以主站计时标签为准；无计时且确属垃圾时间可正常判断",
    winddown: "收尾时段——该准备上床了，建议文字回复",
    prep:     "起床/预备时段——建议文字回复，别打乱开局"
  };

  function renderNowSlot() {
    const el = document.getElementById("nowSlot");
    if (!el) return;
    const info = currentSlotInfo();
    if (!info) { el.innerHTML = `<div class="ns-free">（未加载计划表数据，仅按奇偶日判定）</div>`; return; }
    if (!info.slot) {
      el.innerHTML = `<div class="ns-free">🕊 当前不在计划时段内（自由时段）</div>`;
      return;
    }
    const sl = info.slot;
    const nm = cleanName(sl.name);
    if (info.isStudy) {
      el.innerHTML = `
        <div class="ns-badge ns-study">⚠️ 现在是学习区间</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">本时段还剩 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip">按规则部计划表：<b>正经时间（学习）一律禁止聊天</b>。<br>此刻来电 → 直接拒接 / 只回文字 / 说「回家后我回你」。</div>`;
    } else if (sl.kind === "sleep") {
      el.innerHTML = `
        <div class="ns-badge ns-sleep">🌙 睡眠时段（规则部建议）</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">距离 ${sl.end} 还有 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip ns-advise">此为规则部<b>建议</b>的睡眠时间——是否在睡，以主站计时标签为准。<br>主站正在计时「睡觉」→ 强制禁止接通；无睡眠计时且确属垃圾时间 → 可按正常流程判断。</div>`;
    } else {
      const base = NONSTUDY_HINT[sl.kind] || "非学习时段——按规则仍需非专注、非邀约且时限内";
      const extra = (sl.kind === "rest" && info.relaxOk)
        ? `（本时段剩余 ≥30min，已具备「放松 >30min」这一条）` : "";
      el.innerHTML = `
        <div class="ns-badge ns-ok ns-${esc(sl.kind || "free")}">✅ 当前非学习区间</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">本时段还剩 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip">${esc(base)}${esc(extra)}</div>`;
    }
    renderOverride();
  }

  /* 豁免状态显示（卡片内）+ 两个独立申请入口；两种状态可同时生效、分别结束。 */
  function renderOverride() {
    const box = document.getElementById("nsOverride");
    const quotaLabel = document.getElementById("btnQuotaOverrideText");
    const quotaBtn = document.getElementById("btnQuotaOverride");
    const necessaryLabel = document.getElementById("btnNecessaryOverrideText");
    const necessaryBtn = document.getElementById("btnNecessaryOverride");
    if (!box) return;
    const map = getOverrides();
    const active = [map.quota_extra, map.necessary].filter(Boolean);
    if (active.length) {
      box.style.display = "";
      box.innerHTML = `
        <div class="ns-badge ns-override-on">🔓 已报规则部 · 特殊处理中</div>
        ${active.map(ov => `<div class="ns-ov-row"><b>${esc(overrideTypeLabel(ov))}</b>：${esc(ov.reason)} · 剩余 ${Math.max(0, Math.round((ov.until - Date.now()) / 60000))} 分钟</div>`).join("")}
        <div class="ns-ov-row">今日累计申报 ${overrideCountToday()} 次</div>
        <div class="ns-ov-row ns-ov-note">豁免期内通话仍会开双闹钟并记入账本（含豁免标记），便于事后复盘。</div>`;
    } else {
      box.style.display = "none";
    }
    if (quotaLabel) quotaLabel.textContent = map.quota_extra ? "结束 · 周额度豁免" : "申请 · 增加 1 次周额度";
    if (necessaryLabel) necessaryLabel.textContent = map.necessary ? "结束 · 正经时间豁免" : "申请 · 正经时间不得不通话";
    if (quotaBtn) quotaBtn.classList.toggle("is-ending", !!map.quota_extra);
    if (necessaryBtn) necessaryBtn.classList.toggle("is-ending", !!map.necessary);
  }

  /* ---------- 两类独立豁免窗口 ---------- */
  /* 人工复选框只保留"系统无法知道"的项；系统已知事实（专注/周额度/邀约/影响进度/
   * 垃圾时间确认/时段合法性）全部由 getOverrideAudit 自动核验并以徽章呈现，
   * 不满足即整窗拦截——减少决策成本与"顺手全勾"的决策失误（用户 2026-09-16 指示）。 */
  const QUOTA_OVERRIDE_CHECKS = [
    "quotaCheckProgress", "quotaCheckSleep", "quotaCheckAlternative", "quotaCheckAlarm"
  ];
  const NECESSARY_OVERRIDE_CHECKS = [
    "necessaryCheckLoss", "necessaryCheckDelay", "necessaryCheckText",
    "necessaryCheckEscape", "necessaryCheckAlarm", "necessaryCheckReview"
  ];

  function overrideCheckIds(type) {
    return type === "necessary" ? NECESSARY_OVERRIDE_CHECKS : QUOTA_OVERRIDE_CHECKS;
  }

  function overrideChecksPassed(type) {
    return overrideCheckIds(type).every(id => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    });
  }

  function taskDateKey(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    const b = window.Blocks ? window.Blocks.beijing(d) : d;
    return `${b.getFullYear()}-${p(b.getMonth() + 1)}-${p(b.getDate())}`;
  }

  /* ---------- 任务门禁的统计范围（用户 2026-09-20 指示）----------
   * 「今日/昨日未完成」**暂时只统计「单词突围」任务**：
   *   天天师兄（xizong_live 的听课/做题/滚动复习等）与人可研梦（physio_rolling，
   *   本来就无日期）都不参与阻断——它们的量太大，会让门禁永远通不过。
   * 识别口径与任务页 tasks.js 的 isWordTask 保持一致（source **或**标题特征：
   * 云端 tasks.source 曾被 null 传染过，光看 source 认不出）。
   * ⚠️ 以后要恢复"所有今日任务"或换别的系列，只改 isWordGateTask 这一个函数即可。 */
  const WORD_TITLE_RE = /每日单词任务|^背单词\s*[·:：]/;
  function isWordGateTask(t) {
    return !!t && (t.source === "english_words" || WORD_TITLE_RE.test(t.title || ""));
  }
  /* 未完成清单文案（用户要求：阻断时必须指出到底哪几项没完成） */
  function taskListText(list, cap) {
    const n = cap || 4;
    const names = list.slice(0, n).map(t => String(t.title || "(无标题)"));
    return names.join("；") + (list.length > n ? `…等共 ${list.length} 项` : "");
  }
  /* 门禁结论的统一文案：计数 + 具体哪几项（徽标提示、结论卡、弹窗提示共用同一份） */
  function gateText(gate) {
    return [
      `今日未完成 ${gate.dueToday} 项` + (gate.dueToday ? `：${taskListText(gate.todayList)}` : ""),
      `昨日未完成 ${gate.yesterday} 项` + (gate.yesterday ? `：${taskListText(gate.yestList)}` : ""),
      `惩罚任务 ${gate.penalty} 项` + (gate.penalty ? `：${taskListText(gate.penaltyList)}` : "")
    ].join("；");
  }

  function getTaskGate(todayKey) {
    const tasks = (Store.getTasks && Store.getTasks()) || [];
    const parts = todayKey.split("-").map(Number);
    const yesterdayKey = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) - 86400000).toISOString().slice(0, 10);
    let dueToday = 0, yesterday = 0, penalty = 0, olderIgnored = 0;
    const todayList = [], yestList = [], penaltyList = [];
    tasks.forEach(t => {
      if (t.done === true || t.status === "done") return;
      const key = taskDateKey(t.date);
      const tags = Array.isArray(t.tags) ? t.tags : [];
      const isPenalty = t.enforcement_level === "penalty" || t.category === "penalty" ||
        t.task_type === "penalty" || tags.includes("惩罚任务") || tags.includes("penalty");
      const inScope = isWordGateTask(t);   // ★ 只有单词突围参与今日/昨日判定
      if (inScope && key === todayKey) { dueToday++; todayList.push(t); return; }
      if (inScope && key === yesterdayKey) { yesterday++; yestList.push(t); return; }
      if (isPenalty) { penalty++; penaltyList.push(t); return; }
      if (key && key < yesterdayKey) olderIgnored++;
    });
    return { ok: dueToday === 0 && yesterday === 0 && penalty === 0, dueToday, yesterday, penalty, olderIgnored, todayList, yestList, penaltyList };
  }

  function getOverrideAudit(type) {
    const isNecessary = type === "necessary";
    const j = judgeToday();
    const at = Store.getActiveTimer();
    const taskGate = getTaskGate(j.dateStr);
    const focused = activeStudyTimer() || checked("currentlyFocused");
    const activeCall = !!(at && at.kind === "call");
    const affairs = checked("affairsDone");
    const deferred = checked("followDeferRule");
    const affects = checked("impactStudy");
    const invitation = checked("isInvitation");
    const quotaCovered = j.weeklyCallCount < D.weeklyRule.maxPerWeek || overrideActive("quota_extra");
    const necessaryCovered = overrideActive("necessary");
    const items = [
      { ok: !activeCall, label: "主站通话状态", detail: activeCall ? "已经在通话，不允许重复申请" : "当前没有进行中的通话" },
      { ok: !focused, label: "专注状态", detail: focused ? "主站学习计时或人工专注已触发硬阻断" : "未检测到正在专注" },
      { ok: !j.timerSleeping, label: "作息边界", detail: j.timerSleeping ? "主站正在计时睡眠——任何豁免均不可覆盖" : (j.isSleep ? "当前为睡眠时段（规则部建议，非强制）；无睡眠计时即可正常申请" : "当前不在睡眠时段") },
      { ok: taskGate.ok, label: "任务完成状态", detail: taskGate.ok
        ? `今日、昨日及明确标记的惩罚任务均已完成${taskGate.olderIgnored ? `（更早普通计划 ${taskGate.olderIgnored} 项不作为本规则阻断）` : ""}｜口径：只统计「单词突围」，天天师兄/人可研梦不参与`
        : `${gateText(taskGate)}；先完成这些再谈通话，豁免也不能绕过` },
      { ok: affairs, label: "自身事务", detail: affairs ? "已沿用日常判定：自身事务处理完毕" : "请先在本次来电结论中确认自身事务已完成" },
      { ok: deferred, label: "置后定则", detail: deferred ? "已确认无法继续置后" : "请先执行并确认置后定则" },
      { ok: !affects, label: "进度影响", detail: affects ? "已标记会影响正常进度，禁止豁免" : "未标记影响正常进度" },
      { ok: !invitation, label: "邀约识别", detail: invitation ? "邀约类来电只能文字回复" : "未标记为邀约类来电" }
    ];
    if (isNecessary) {
      items.push(
        { ok: j.inStudy && !checked("garbageTime"), label: "申请场景", detail: j.inStudy && !checked("garbageTime") ? "正处于正经时间，且未冒充垃圾时间" : "仅正经时间、非垃圾时间才需要此豁免" },
        { ok: quotaCovered, label: "周次数限制", detail: quotaCovered ? "周额度可用或已另行获得周额度豁免" : "周额度已用尽；本窗口不豁免次数，请另走周额度申请" }
      );
    } else {
      items.push(
        { ok: j.weeklyCallCount >= D.weeklyRule.maxPerWeek, label: "周额度触发", detail: `本周 ${j.weeklyCallCount}/${D.weeklyRule.maxPerWeek} 次；仅额度用尽后才能申请增加` },
        { ok: checked("garbageTime") || necessaryCovered, label: "时间合法性", detail: checked("garbageTime") ? "主页面已确认垃圾时间" : (necessaryCovered ? "已另行获得正经时间必要豁免" : "须确认垃圾时间；正经时间须先单独申请必要豁免") }
      );
    }
    return { ok: items.every(x => x.ok), items, taskGate };
  }

  function renderOverrideAudit(type) {
    const isNecessary = type === "necessary";
    const box = document.getElementById(isNecessary ? "necessaryAutoAudit" : "quotaAutoAudit");
    if (!box) return;
    const audit = getOverrideAudit(type);
    const passCount = audit.items.filter(x => x.ok).length;
    const failing = audit.items.filter(x => !x.ok);
    box.innerHTML = `<div class="cm-auto-title">系统核验 · ${passCount}/${audit.items.length}${audit.ok ? " · 全部通过" : " · 存在阻断"}</div>` +
      `<div class="cm-badge-grid">` + audit.items.map(x =>
        `<span class="cm-badge ${x.ok ? "ok" : "block"}" title="${esc(x.detail)}">${x.ok ? "✓" : "✕"} ${esc(x.label)}</span>`).join("") + `</div>` +
      (failing.length ? `<div class="cm-auto-block">` + failing.map(x => `· ${esc(x.detail)}`).join("<br>") + `</div>` : "");
  }

  /* ---------- 此刻快照：把系统知道的数据摆到台面上，供充分判断 ---------- */
  function renderOverrideSnapshot(type) {
    const box = document.getElementById(type === "necessary" ? "necessarySnapshot" : "quotaSnapshot");
    if (!box) return;
    const j = judgeToday();
    const gate = getTaskGate(j.dateStr);
    const goalTargetSec = (parseFloat(C.DAILY_GOAL_HOURS) || 8) * 3600;
    const cats = (C.TIME_CATEGORIES || []);
    const countsGoal = (r) => { const c = cats.find(x => x.key === r.category); return !!(c && c.countTowardGoal); };
    const today = window.TodayRecords ? window.TodayRecords.getTodayRecords() : [];
    const studySec = today.filter(countsGoal).reduce((a, r) => a + (Number(r.duration_sec) || 0), 0);
    const studyPct = goalTargetSec ? Math.min(100, Math.round(studySec / goalTargetSec * 100)) : 0;
    let lastCallTxt = "本周暂无";
    let lastMs = 0;
    (Store.getTimeRecords() || []).forEach(r => {
      if (!isCallRec(r) || !r.ended_at) return;
      const t = Date.parse(r.ended_at);
      if (isFinite(t) && t > lastMs) lastMs = t;
    });
    if (lastMs) {
      const agoMin = Math.max(0, Math.round((Date.now() - lastMs) / 60000));
      lastCallTxt = agoMin >= 60 ? `${Math.floor(agoMin / 60)}小时${agoMin % 60}分前` : `${agoMin} 分钟前`;
    }
    const si = currentSlotInfo();
    const slotTxt = si && si.slot ? `${cleanName(si.slot.name)} · 剩 ${fmtRemain(si.remainMin)}` : "自由时段";
    box.innerHTML =
      `<div class="cm-snap-title">此刻快照（系统自动统计）</div>` +
      `<div class="cm-snap-grid">` +
      `<div class="cm-snap-row"><span>今日有效学习</span><b>${fmtDuration(studySec)} / ${fmtDuration(goalTargetSec)}（${studyPct}%）</b></div>` +
      `<div class="cm-snap-row"><span>任务门禁</span><b>${gate.ok ? "今日昨日任务均已完成" : `今日剩 ${gate.dueToday} 项 · 昨日剩 ${gate.yesterday} 项`}</b></div>` +
      (!gate.ok ? `<div class="cm-snap-row"><span>待完成</span><b>${esc(taskListText((gate.todayList || []).concat(gate.yestList || []), 3))}</b></div>` : "") +
      `<div class="cm-snap-row"><span>本周长通话</span><b>${j.weeklyCallCount}/${D.weeklyRule.maxPerWeek} 次 · 上次 ${esc(lastCallTxt)}</b></div>` +
      `<div class="cm-snap-row"><span>当前时段</span><b>${esc(slotTxt)}</b></div>` +
      `</div>` +
      `<div class="cm-snap-stance">上面的数字才是你的尺子 ——<b>我今天的进度，对得起 12 月吗？</b></div>`;
  }
  /* 半自动项的数据提示：数据系统给，判断由人做 */
  function fillOverrideHints(type) {
    const si = currentSlotInfo();
    const gate = getTaskGate(judgeToday().dateStr);
    const q1 = document.getElementById("quotaHintProgress");
    if (q1) q1.textContent = `系统快照：今日剩余任务 ${gate.dueToday} 项${gate.yesterday ? `，昨日剩余 ${gate.yesterday} 项` : ""}` +
      ((gate.dueToday || gate.yesterday) ? `（${taskListText((gate.todayList || []).concat(gate.yestList || []), 3)}）` : "") +
      `｜口径：只统计「单词突围」`;
    const q2 = document.getElementById("quotaHintSleep");
    if (q2) {
      const b = window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
      const minsNow = b.getHours() * 60 + b.getMinutes();
      let toBed = (24 * 60 + 30) - minsNow;                    // 上床 00:30
      if (toBed <= 0) toBed += 24 * 60;
      q2.textContent = `现在 ${String(b.getHours()).padStart(2, "0")}:${String(b.getMinutes()).padStart(2, "0")} · 距 00:30 上床还有 ${Math.floor(toBed / 60)}小时${toBed % 60}分`;
    }
    const n1 = document.getElementById("necessaryHintDelay");
    if (n1) n1.textContent = si && si.slot ? `本时段剩余 ${fmtRemain(si.remainMin)}——延后意味着占用下一个时段` : "";
  }

  function overrideSystemEligible(type) {
    return getOverrideAudit(type).ok;
  }

  function syncOverrideGrantState(type) {
    const isNecessary = type === "necessary";
    const button = document.getElementById(isNecessary ? "necessaryGrant" : "quotaGrant");
    const hint = document.getElementById(isNecessary ? "necessaryStrictHint" : "quotaStrictHint");
    const ids = overrideCheckIds(type);
    const checkedCount = ids.filter(id => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    }).length;
    const checksOk = checkedCount === ids.length;
    const systemOk = overrideSystemEligible(type);
    renderOverrideAudit(type);
    renderOverrideSnapshot(type);
    fillOverrideHints(type);
    if (button) button.disabled = !(checksOk && systemOk);
    if (!hint) return;
    hint.classList.toggle("ready", checksOk && systemOk);
    if (!checksOk) {
      hint.textContent = `人工核验尚未完成：已勾选 ${checkedCount}/${ids.length} 项（系统核验项无需勾选，自动判定）。`;
    } else if (!systemOk) {
      hint.textContent = isNecessary
        ? "人工核验已完成，但系统检测到硬阻断：专注、睡眠、影响进度或邀约时不能豁免。"
        : "人工核验已完成，但系统条件仍不满足：须达到每周 4 次上限，且主页面已确认当前是垃圾时间。";
    } else {
      hint.textContent = "全部核验通过。仍可选择取消；确认后将留痕并强制执行双闹钟。";
    }
  }

  function fillOverrideReasons(type) {
    const isNecessary = type === "necessary";
    const chips = document.getElementById(isNecessary ? "necessaryReasons" : "quotaReasons");
    const input = document.getElementById(isNecessary ? "necessaryReasonInput" : "quotaReasonInput");
    const rules = (D && D.rules) || {};
    const configured = isNecessary
      ? (rules.necessaryOverrideReasons || ["紧急事务，延后会造成实际损失"])
      : (rules.quotaOverrideReasons || ["本周额度已用尽，当前确属垃圾时间"]);
    const history = getReasonHistory(type).filter(r => !configured.includes(r));
    const reasons = [...history, ...configured];
    if (chips && !chips.childElementCount) {
      chips.innerHTML = reasons.map((r, i) =>
        `<button type="button" class="cm-chip ${i < history.length ? "is-history" : ""}" data-reason="${esc(r)}">${esc(r)}</button>`).join("");
      chips.addEventListener("click", (e) => {
        const b = e.target.closest("[data-reason]");
        if (b && input) {
          input.value = b.dataset.reason;
          syncOverrideGrantState(type);
        }
      });
    }
    if (input && !input.value) input.value = reasons[0] || "";
    if (input && !input.dataset.strictBound) {
      input.dataset.strictBound = "1";
      input.addEventListener("input", () => syncOverrideGrantState(type));
    }
  }

  function openOverrideDialog(type) {
    const isNecessary = type === "necessary";
    const mask = document.getElementById(isNecessary ? "necessaryMask" : "quotaMask");
    const modal = document.getElementById(isNecessary ? "necessaryModal" : "quotaModal");
    if (!mask || !modal) return;
    const si = currentSlotInfo();
    const inStudy = !!(si && si.isStudy);
    const ctx = document.getElementById(isNecessary ? "necessaryContext" : "quotaContext");
    if (ctx) {
      if (si && si.slot) {
        const endSec = toMin(si.slot.end) * 60;
        const leftMin = Math.max(0, Math.round((endSec - nowSecBJ()) / 60));
        const timeSense = `距离 ${si.slot.end} 还有 ${fmtRemain(leftMin)}`;
        if (isNecessary) {
          ctx.className = "cm-context is-study";
          ctx.innerHTML = `当前：<b>${esc(cleanName(si.slot.name))}</b>（${si.slot.start}~${si.slot.end}） · ${timeSense}` +
            (inStudy ? "——现在接听会直接占用正经学习时间" : "——虽非学习区间，仍需证明必须此刻处理");
        } else {
          const j = judgeToday();
          ctx.className = inStudy ? "cm-context is-study" : "cm-context";
          ctx.innerHTML = `本周已通话：<b>${j.weeklyCallCount}/${D.weeklyRule.maxPerWeek} 次</b>；当前：` +
            `<b>${esc(cleanName(si.slot.name))}</b>（${si.slot.start}~${si.slot.end}） · ${timeSense}` +
            (inStudy ? "——当前不是垃圾时间，不符合本申请条件" : "");
        }
      } else {
        ctx.className = "cm-context";
        ctx.innerHTML = "此刻不在计划时段内";
      }
    }
    fillOverrideReasons(type);
    overrideCheckIds(type).forEach(id => {
      const checkbox = document.getElementById(id);
      if (!checkbox) return;
      checkbox.checked = false;
      if (!checkbox.dataset.strictBound) {
        checkbox.dataset.strictBound = "1";
        checkbox.addEventListener("change", () => syncOverrideGrantState(type));
      }
    });
    syncOverrideGrantState(type);
    mask.classList.add("show");
    modal.classList.add("show");
    if (window.Icon) window.Icon.inject(modal);
  }
  function closeOverrideDialog(type) {
    const isNecessary = type === "necessary";
    const mask = document.getElementById(isNecessary ? "necessaryMask" : "quotaMask");
    const modal = document.getElementById(isNecessary ? "necessaryModal" : "quotaModal");
    if (mask) mask.classList.remove("show");
    if (modal) modal.classList.remove("show");
  }

  /* ---------- 今日判定 ---------- */
  function judgeToday() {
    const now = new Date();
    const beijing = window.Blocks ? window.Blocks.beijing(now) : now;
    const day = beijing.getDate();
    const isOdd = day % 2 === 1;
    const dayName = ["周日","周一","周二","周三","周四","周五","周六"][beijing.getDay()];
    const dateStr = `${beijing.getFullYear()}-${p(beijing.getMonth()+1)}-${p(day)}`;

    // 计算本周已用次数
    weeklyCallCount = calcWeeklyCallCount(beijing);
    const slotInfo = currentSlotInfo();
    const inStudy = !!(slotInfo && slotInfo.isStudy);
    /* 睡眠判定改源（用户 2026-09-16 指示）：
     * 硬限制以「主计时器正在计时的标签」为准（计时睡觉/长睡觉/小憩）；
     * 规划表的睡眠时段仅作建议提示——大块时间段内仍可能有垃圾时间。 */
    const atNow = Store.getActiveTimer();
    const timerSleeping = !!(atNow && atNow.status === "running" &&
      (atNow.kind === "sleep" || atNow.sub_category === "long_sleep" || atNow.sub_category === "nap"));
    const isSleep = !!(slotInfo && slotInfo.slot && slotInfo.slot.kind === "sleep"); // 仅建议
    const quota = D.weeklyRule.maxPerWeek;

    /* 基础环境判定。最终结论还要叠加「通话对象 · 联系规则」人工自检。 */
    let verdict, color, advice;
    if (timerSleeping) {
      verdict = "睡眠计时中 · 禁止接听";
      color = "#1e40af";
      advice = "主站正在计时睡眠（以计时标签为准）——规则部规定：请直接挂断或只回文字，任何豁免不可覆盖";
    } else if (inStudy && overrideActive("necessary")) {
      const ov = getOverride("necessary");
      verdict = "已报规则部 · 特殊处理中";
      color = "#d97706";
      advice = `豁免理由「${ov.reason}」· 到期自动恢复限制；通话仍须双闹钟并及时挂断`;
    } else if (inStudy) {
      verdict = "需人工判断";
      color = "#d97706";
      advice = "大自习板块理论不允许接听：若正在专注，必须挂断；若此刻确属垃圾时间，需人工确认后再判断";
    } else if (weeklyCallCount >= quota) {
      verdict = "额度已用尽 · 建议拒绝";
      color = "#ef4444";
      advice = `本周长通话已用 ${weeklyCallCount}/${quota} 次——建议只回文字`;
    } else {
      verdict = "等待本次自检";
      color = "#d97706";
      advice = `先确认这是垃圾时间且不影响进度 · 本周 ${weeklyCallCount}/${quota} 次` +
        (!isOdd ? "｜规则部建议：单数日再接（仅建议）" : "");
    }
    if (isSleep && !timerSleeping) advice += "｜🌙 规则部建议：此刻为睡眠时段（仅建议，以计时标签为准）";
    if (isOdd && !isSleep && !inStudy) advice += "｜今日单数日 ✅";

    return { dateStr, dayName, day, isOdd, verdict, color, advice, weeklyCallCount, slotInfo, isSleep, timerSleeping, inStudy };
  }

  function activeStudyTimer() {
    const at = Store.getActiveTimer();
    return !!(at && at.status === "running" && at.kind === "study");
  }

  function checked(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  }

  /* 把静态规则真正变成可执行判定。顺序即优先级，命中第一条就停止。 */
  function evaluateCallDecision() {
    const j = judgeToday();
    const quotaOv = getOverride("quota_extra");
    const necessaryOv = getOverride("necessary");
    const at = Store.getActiveTimer();
    const taskGate = getTaskGate(j.dateStr);
    const focused = activeStudyTimer() || checked("currentlyFocused");
    const isInvitation = checked("isInvitation");
    const affects = checked("impactStudy");
    const garbage = checked("garbageTime");
    const affairs = checked("affairsDone");
    const deferred = checked("followDeferRule");

    if (at && at.kind === "call") return { ...j, allowed: false, hard: true, verdict: "正在通话", color: "#2563eb", advice: "主站已存在通话计时：不要重复开始，按当前时长执行双闹钟与强硬收尾。" };
    if (j.timerSleeping) return { ...j, allowed: false, hard: true, verdict: "睡眠计时中 · 禁止接听", color: "#1e40af", advice: "主站正在计时睡眠（以计时标签为准）——规则部规定：请直接挂断或只回文字，任何豁免不可覆盖。" };
    if (focused) return { ...j, allowed: false, hard: true, verdict: "禁止接听", color: "#dc2626", advice: "人工判断为正在专注学习（或主站正在学习计时）：一定不允许接通。" };
    if (!taskGate.ok) return { ...j, allowed: false, hard: true, verdict: "任务未完成 · 禁止接听", color: "#dc2626", advice: `系统发现 ${gateText(taskGate)}（口径：只统计「单词突围」，天天师兄/人可研梦不参与）；先完成任务，豁免也不能绕过。` };
    if (isInvitation) return { ...j, allowed: false, hard: true, verdict: "禁止接听", color: "#dc2626", advice: "通话对象规则：邀约类来电不得接听，只能文字回复。" };
    if (affects) return { ...j, allowed: false, hard: true, verdict: "禁止接听", color: "#dc2626", advice: "本次通话会影响正常进度：请直接挂断或改期。" };
    if (j.weeklyCallCount >= D.weeklyRule.maxPerWeek && !quotaOv) {
      return { ...j, allowed: false, verdict: "周额度已用尽", color: "#dc2626", advice: "本周 4 次长通话已用尽；只有确认是垃圾时间后，才可申请“增加 1 次周额度”豁免。" };
    }
    if (!affairs) return { ...j, allowed: false, verdict: "暂不可接", color: "#d97706", advice: "先处理完自身事务；对方来电排在所有正经任务之后。" };
    if (!deferred) return { ...j, allowed: false, verdict: "先置后", color: "#d97706", advice: "先问：能否稍后回拨或用文字解决？确认已执行置后定则。" };
    if (!garbage && !necessaryOv) {
      return { ...j, allowed: false, verdict: j.inStudy ? "正经时间 · 不可接" : "尚未确认垃圾时间", color: "#d97706", advice: "所有通话只能发生在垃圾时间或完全不影响进度的时间。确实不得不，才申请正经时间豁免。" };
    }
    const oddTip = j.isOdd ? "规则部建议的单数日" : "今日虽为偶数日，但单双日仅是建议";
    const sleepTip = j.isSleep ? "｜🌙 规则部建议：此刻为睡眠时段（仅建议，以计时标签为准）——尽快收尾休息。" : "";
    return { ...j, allowed: true, verdict: "允许接听 · 必开双闹钟", color: "#15803d", advice: `人工自检通过：垃圾时间、不影响进度、非邀约；${oddTip}${sleepTip}` };
  }

  function calcWeeklyCallCount(beijing) {
    // 从 time_records 统计本周通话次数
    const records = Store.getTimeRecords() || [];
    const rule = D.weeklyRule;
    let count = 0;
    records.forEach(r => {
      if (!isCallRec(r)) return;
      if (!r.started_at) return;
      const d = new Date(r.started_at);
      const b = window.Blocks.beijing(d);
      // 计算该记录所在周的周一
      const dow = b.getDay() || 7; // 周日=7
      const diffToMon = dow === 1 ? 0 : dow - 1;
      const mon = new Date(b);
      mon.setDate(mon.getDate() - diffToMon);
      mon.setHours(0, 0, 0, 0);
      // 当前周的周一
      const today = new Date(beijing);
      const todayDow = today.getDay() || 7;
      const todayMon = new Date(today);
      todayMon.setDate(todayMon.getDate() - (todayDow === 1 ? 0 : todayDow - 1));
      todayMon.setHours(0, 0, 0, 0);
      if (mon.getTime() === todayMon.getTime()) count++;
    });
    return count;
  }

  /* ---------- 渲染 ---------- */
  function renderJudge() {
    const el = document.getElementById("todayJudge");
    if (!el) return;
    const j = judgeToday();
    const timerFocused = activeStudyTimer();
    el.innerHTML = `
      <div class="j-row" id="judgeDecision">
        <div class="j-date">${j.dateStr} · ${j.dayName} · 第${j.day}日</div>
        <div class="j-verdict" style="color:${j.color}">${j.verdict}</div>
      </div>
      <div class="j-advice" id="judgeAdvice">${j.advice}</div>
      <div class="j-stance">每次想接之前，先回答这一句：<b>我今天的进度，对得起 12 月吗？</b></div>
      <label class="j-check j-check-critical">
        <input type="checkbox" id="currentlyFocused" ${timerFocused ? "checked disabled" : ""} />
        我此刻正在专注学习${timerFocused ? "（主站学习计时已确认）" : "（人工判断）"}
      </label>
      <label class="j-check">
        <input type="checkbox" id="garbageTime" />
        当前确属垃圾时间，且不会挤占计划进度
      </label>
      <label class="j-check">
        <input type="checkbox" id="affairsDone" />
        自身事务已处理完毕
      </label>
      <label class="j-check">
        <input type="checkbox" id="followDeferRule" />
        是否遵循「置后定则」？<small style="margin-left:6px;color:var(--ink-3);font-weight:500">（通话前先问：我能否 XX 分钟后再处理？/ 回你电话？）</small>
      </label>
      <label class="j-check">
        <input type="checkbox" id="impactStudy" />
        本次通话会影响正常学习进度<small style="margin-left:6px;color:#b91c1c;font-weight:600">（勾选即拒接）</small>
      </label>
      <label class="j-check">
        <input type="checkbox" id="isInvitation" />
        这是邀约类来电<small style="margin-left:6px;color:#b91c1c;font-weight:600">（只能文字回复）</small>
      </label>
    `;
    ["currentlyFocused", "garbageTime", "affairsDone", "followDeferRule", "impactStudy", "isInvitation"].forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.addEventListener("change", refreshCallDecision);
    });
    refreshCallDecision();
  }

  function refreshCallDecision() {
    const d = evaluateCallDecision();
    const verdict = document.querySelector("#judgeDecision .j-verdict");
    const advice = document.getElementById("judgeAdvice");
    const timerAction = document.getElementById("allowedTimerAction");
    if (verdict) { verdict.textContent = d.verdict; verdict.style.color = d.color; }
    if (advice) advice.textContent = d.advice;
    if (timerAction) timerAction.hidden = !d.allowed;
    updateJudgeHint();
    renderScenarios();
    renderWeeklyInfo();
    if (document.getElementById("quotaModal")?.classList.contains("show")) syncOverrideGrantState("quota_extra");
    if (document.getElementById("necessaryModal")?.classList.contains("show")) syncOverrideGrantState("necessary");
  }

  function updateJudgeHint() {
    // 复选框提示摘要：3 项未勾选 → 顶部强调
    const a = document.getElementById("affairsDone");
    const d = document.getElementById("followDeferRule");
    const i = document.getElementById("impactStudy");
    const g = document.getElementById("garbageTime");
    const f = document.getElementById("currentlyFocused");
    const invite = document.getElementById("isInvitation");
    if (!a || !d || !i || !g || !f || !invite) return;
    const items = [];
    if (f.checked) items.push("【正在专注→必须拒接】");
    if (!g.checked) items.push("【未确认垃圾时间】");
    if (!a.checked) items.push("【自身事务处理】");
    if (!d.checked) items.push("【置后定则】");
    if (i.checked) items.push("【将打断学习→拒接】");
    if (invite.checked) items.push("【邀约→仅文字回复】");
    const box = document.getElementById("checklistHint");
    if (!box) return;
    if (items.length === 0) {
      box.innerHTML = `<div class="judge-hint ok">✅ 联系规则自检通过，可进入限时通话流程</div>`;
      box.style.display = "";
    } else {
      box.innerHTML = `<div class="judge-hint bad">⚠️ 当前阻断项：${items.join(" · ")}</div>`;
      box.style.display = "";
    }
  }

  function renderScenarios() {
    const box = document.getElementById("callScenarios");
    if (!box) return;
    const j = evaluateCallDecision();
    let items;
    if (!j.allowed) {
      items = [
        { label: "当前结论 · 直接挂断", text: "我现在不方便接电话，有事请先文字留言，晚点我回复。" },
        { label: "置后回复", text: "我正在处理自己的安排，现在不能聊。确有急事请文字说，其他事情改天再联系。" }
      ];
    } else {
      items = [
        { label: "允许接听 · 开场", text: "我现在有一点时间，可以聊一会儿；我已经设好闹钟，到点就要结束。" },
        { label: "限时收尾", text: "闹钟到了，我要继续自己的安排了。有事你发文字，我们下次再聊。" }
      ];
    }

    box.innerHTML = items.map((s, i) => `
      <div class="scenario-item" data-idx="${i}">
        <div class="s-label">${s.label}</div>
        <div class="s-text">${s.text}</div>
        <button class="s-copy" data-copy="${s.text}">复制</button>
      </div>
    `).join("");

    box.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        copyText(text);
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    });
  }

  function renderWindowScenarios() {
    const box = document.getElementById("windowScenarios");
    if (!box) return;
    const openItems = D.poolOpen.map((t, i) => ({ label: `开场 #${i+1}`, text: t }));
    const closeItems = D.poolClose.map((t, i) => ({ label: `收尾 #${i+1}`, text: t }));
    const all = [...openItems, ...closeItems];
    box.innerHTML = all.map((s, i) => `
      <div class="scenario-item" data-idx="${i}">
        <div class="s-label">${s.label}</div>
        <div class="s-text">${s.text}</div>
        <button class="s-copy" data-copy="${s.text}">复制</button>
      </div>
    `).join("");
    box.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        copyText(text);
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    });
  }

  function renderHostStatus() {
    const at = Store.getActiveTimer();
    const card = document.getElementById("hostCard");
    const status = document.getElementById("hostStatus");
    const hint = document.getElementById("hostHint");
    if (!card || !status) return;

    if (at) {
      // v2：按 at.kind 显示分类（不硬编码为"正在学习"），paused 也显示状态
      const cats = window.APP_CONFIG.TIME_CATEGORIES || [];
      const cm = cats.find(c => c.key === at.kind) || { label: at.kind || "活动", color: "#94a3b8" };
      let elapsed = at.status === "running" ? Math.round(
          (at.elapsed_sec || 0) + (Date.now() - (at.started_at || Date.now())) / 1000
        ) : Math.round(at.elapsed_sec || 0);
      elapsed = Math.max(0, elapsed);
      const label = at.label || cm.label || "学习";
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const statusTxt = at.status === "paused" ? "（已暂停）" : "";
      const isHostCall = at.kind === "call";
      const tagClass = isHostCall ? "host-call" :
        (at.kind === "study" && at.status === "running" ? "host-study" : "host-other");
      card.style.display = "";
      status.innerHTML = `<span class="host-tag ${tagClass}">正在${cm.label} ${mins}分${secs}秒${statusTxt}</span> <span class="host-label">${label}</span>`;
      if (isHostCall) {
        let stage;
        if (at.status === "paused") {
          stage = "主站通话计时已暂停；如果电话仍未结束，请立即恢复计时或直接挂断，不能让通话脱离记录。";
        } else if (elapsed < 15 * 60) {
          stage = `距离 15 分钟预警还有 ${fmtRemain(Math.ceil((15 * 60 - elapsed) / 60))}；现在就控制话题，只处理必要事项。`;
        } else if (elapsed < 25 * 60) {
          stage = `已进入强硬收尾阶段，距离 25 分钟终极时限还有 ${fmtRemain(Math.ceil((25 * 60 - elapsed) / 60))}。`;
        } else {
          stage = `已超过 25 分钟终极时限 ${fmtRemain(Math.ceil((elapsed - 25 * 60) / 60))}：不要继续解释，立即挂断。`;
        }
        hint.innerHTML = `<div class="host-call-guidance"><b>📞 主站确认：正在通话</b><span>${stage}</span>` +
          `<span>规则提醒：宁可少打，不拖延；感到消耗或时间到，执行“过渡 3 分钟定则”收尾。</span>` +
          `<span>除 3 小时以上完整时间块外不得挂机；与对方要求冲突时，3 分钟内解释完并回到自己的事。</span></div>`;
      } else if (at.kind === "study") {
        hint.textContent = at.status === "running"
          ? "通话将计入今日占用，强化边界意识"
          : "当前学习计时已暂停";
      } else {
        hint.textContent = "当前正处于「" + cm.label + "」状态";
      }
    } else {
      card.style.display = "";
      status.innerHTML = `<span class="host-tag host-idle">主站空闲</span>`;
      hint.textContent = "当前无进行中的计时";
    }
  }

  function renderWeeklyInfo() {
    const el = document.getElementById("weeklyInfo");
    if (!el) return;
    const j = evaluateCallDecision();
    const rule = D.weeklyRule;
    el.innerHTML = `
      <div class="wf-row"><span>本周长通话额度</span><span class="wf-count ${j.weeklyCallCount >= rule.maxPerWeek ? 'over' : ''}">${j.weeklyCallCount} / ${rule.maxPerWeek}</span></div>
      <div class="wf-row"><span>规则部建议</span><span>单数日接听（仅建议，非硬规则）</span></div>
      <div class="wf-row"><span>时间前提</span><span>仅限垃圾时间 / 不影响正常进度</span></div>
      <div class="wf-row"><span>当前判定</span><span style="color:${j.color}">${j.verdict}</span></div>
    `;
  }

  /* ---------- 操作 ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
    }
    if (window.UI) window.UI.showAlert("已复制到剪贴板", 1500);
  }

  function randomExcuse() {
    const arr = D.excuses;
    const idx = Math.floor(Math.random() * arr.length);
    const e = arr[idx];
    const typeEl = document.getElementById("excuseType");
    const textEl = document.getElementById("excuseText");
    if (typeEl) typeEl.textContent = `${e.label}（${idx+1}/${arr.length}）`;
    if (textEl) textEl.textContent = e.text;
  }

  function randomPool1730() {
    const arr = D.pool1730;
    const idx = Math.floor(Math.random() * arr.length);
    const el = document.getElementById("poolText");
    if (el) el.textContent = arr[idx];
  }

  function copyExcuse() {
    const t = document.getElementById("excuseText");
    if (t && t.textContent && t.textContent !== "点下方按钮抽一条随机借口") {
      copyText(t.textContent);
    }
  }

  function copyPool() {
    const t = document.getElementById("poolText");
    if (t && t.textContent && !t.textContent.startsWith("点")) {
      copyText(t.textContent);
    }
  }

  /* ---------- 双闹钟 ---------- */
  function startDualAlarm() {
    if (callStartAt) return;
    callStartAt = Date.now();
    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "";

    // 15min 预警
    warnTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(1);
        window.UI.showAlert("⏰ 还有 10 分钟，准备收尾", 5000);
        window.UI.notify("⏰ 预警", "通话 15 分钟了，还有 10 分钟到终极");
      }
    }, 15 * 60 * 1000);

    // 25min 终极
    finalTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(3);
        window.UI.buzz();
        window.UI.showAlert("到点了，刚性挂断！", 5000);
        window.UI.notify("⏰ 通话结束", "25 分钟到了，请挂断");
      }
      endCall(true);
    }, 25 * 60 * 1000);

    // 通话时长刷新
    callTickId = setInterval(updateCallDisplay, 1000);
    updateCallDisplay();

    if (window.UI) window.UI.showAlert("通话开始，双闹钟已启动（15min预警 / 25min终极）", 3000);
  }

  function updateCallDisplay() {
    if (!callStartAt) return;
    const elapsed = Math.floor((Date.now() - callStartAt) / 1000);
    const em = Math.floor(elapsed / 60), es = elapsed % 60;
    const el = document.getElementById("callElapsed");
    if (el) el.textContent = `${p(em)}:${p(es)}`;

    const warnRemain = Math.max(0, 15 * 60 - elapsed);
    const wr = document.getElementById("warnRemain");
    if (wr) wr.textContent = `${p(Math.floor(warnRemain/60))}:${p(warnRemain%60)}`;

    const finalRemain = Math.max(0, 25 * 60 - elapsed);
    const fr = document.getElementById("finalRemain");
    if (fr) fr.textContent = `${p(Math.floor(finalRemain/60))}:${p(finalRemain%60)}`;
  }

  function endCall(forced) {
    if (!callStartAt) return;
    const dur = Math.floor((Date.now() - callStartAt) / 1000);
    const startedAt = callStartAt;
    const endedAt = Date.now();

    // 清除定时器
    if (warnTimerId) clearTimeout(warnTimerId);
    if (finalTimerId) clearTimeout(finalTimerId);
    if (callTickId) clearInterval(callTickId);
    callStartAt = null;

    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "none";

    // 写入时间记录（上行联动）
    const si = currentSlotInfo();
    const inStudySlot = !!(si && si.isStudy);
    const ovs = getOverrides();
    const activeOvs = [ovs.quota_extra, ovs.necessary].filter(Boolean);
    const tags = ["边界管控", "通话"];
    if (inStudySlot) tags.push("学习区间通话");
    if (ovs.quota_extra) tags.push("周次数额外豁免");
    if (ovs.necessary) tags.push("正经时间必要豁免");
    const rec = {
      id: uid(),
      user_id: C.USER_ID,
      category: "call",
      sub_category: "linyuchen",
      label: "通话",
      tags: tags,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_sec: dur,
      source: "call_boundary",
      note: (forced ? "双闹钟超时·刚性挂断" : "正常挂断") +
            (inStudySlot ? `｜⚠️ 发生在学习区间「${si.slot.name}」` : "") +
            activeOvs.map(ov => `｜🔓 ${overrideTypeLabel(ov)}（已报规则部）：${ov.reason}`).join(""),
      created_at: new Date().toISOString()
    };
    Store.addTimeRecord(rec);
    renderTodayCall();

    if (window.UI) {
      window.UI.showAlert(
        `通话结束，时长 ${Math.floor(dur/60)}分${dur%60}秒，已记入时间账本` +
        (inStudySlot ? (ovs.necessary ? "（学习区间·已报规则部）" : "（学习区间通话，已标记）") : ""), 3000);
    }

    // 刷新周频率
    renderWeeklyInfo();
  }

  /* ---------- 周频率检查 ---------- */
  function checkWeekly() {
    const j = judgeToday();
    const rule = D.weeklyRule;
    if (j.weeklyCallCount >= rule.maxPerWeek) {
      if (window.UI) {
        window.UI.showAlert(`本周通话已达 ${rule.maxPerWeek} 次上限，建议返回学习`, 5000);
        setTimeout(() => {
          const ok = confirm("本周已超额，继续畅聊将违反边界管控。\n\n选择：\n确定 = 继续畅聊（违规）\n取消 = 返回学习");
          if (ok) {
            if (window.UI) window.UI.showAlert("已标记为违规，请自觉遵守边界", 3000);
          }
        }, 100);
      }
    } else {
      if (window.UI) {
        window.UI.showAlert(`本周已用 ${j.weeklyCallCount}/${rule.maxPerWeek} 次，剩余 ${rule.maxPerWeek - j.weeklyCallCount} 次`, 3000);
      }
    }
  }

  /* ---------- 初始化 ---------- */
  // M1: call 页秒级 tick —— 计时器运行中时每秒刷新"正在学习 X分X秒"
  let _hostTickTimer = null;
  function _ensureHostTick() {
    const at = Store.getActiveTimer();
    const isRunning = at && at.status === "running";
    if (isRunning && !_hostTickTimer) {
      _hostTickTimer = setInterval(() => renderHostStatus(), 1000);
    } else if (!isRunning && _hostTickTimer) {
      clearInterval(_hostTickTimer);
      _hostTickTimer = null;
    }
  }

  function init() {
    renderNowSlot();
    renderTodayCall();
    renderJudge();
    updateJudgeHint();       // 初始化复选框摘要提示
    renderScenarios();
    renderWindowScenarios();
    renderHostStatus();
    renderWeeklyInfo();

    // 每 30 秒刷新时段卡与豁免倒计时；跨过时段边界/豁免到期时同步刷新判定
    let lastSlotKey = (currentSlotInfo() && currentSlotInfo().slot) ? currentSlotInfo().slot.start : "none";
    let lastOvState = overrideStateKey();
    setInterval(() => {
      renderNowSlot();
      const si = currentSlotInfo();
      const key = (si && si.slot) ? si.slot.start : "none";
      const ovState = overrideStateKey();
      if (key !== lastSlotKey || ovState !== lastOvState) {
        lastSlotKey = key;
        lastOvState = ovState;
        renderJudge();       // 时段切换 / 豁免到期 → 判定结论可能变化
        updateJudgeHint();
      }
    }, 30000);

    // 随机借口
    const btnExcuse = document.getElementById("btnExcuse");
    if (btnExcuse) btnExcuse.addEventListener("click", randomExcuse);
    const btnCopyExcuse = document.getElementById("btnCopyExcuse");
    if (btnCopyExcuse) btnCopyExcuse.addEventListener("click", copyExcuse);

    // 17:30 话术
    const btnPool = document.getElementById("btnPool1730");
    if (btnPool) btnPool.addEventListener("click", randomPool1730);
    const btnCopyPool = document.getElementById("btnCopyPool");
    if (btnCopyPool) btnCopyPool.addEventListener("click", copyPool);

    // 双闹钟
    const btnCall = document.getElementById("btnCall");
    if (btnCall) btnCall.addEventListener("click", () => {
      const decision = evaluateCallDecision();
      if (!decision.allowed) {
        if (window.UI) window.UI.showAlert(`规则部规定：请你直接挂断。${decision.advice}`, 5000);
        return;
      }
      // 主站计时联动：明确显示“旧状态将结束 → 进入通话双闹钟”，由用户确认或取消。
      const at = Store.getActiveTimer();
      if (at && (at.status === "running" || at.status === "paused")) {
        const label = at.label || at.kind || "计时";
        const elapsedMin = Math.max(0, Math.round(
          ((at.elapsed_sec || 0) + (at.status === "running" ? (Date.now() - (at.started_at || Date.now())) / 1000 : 0)) / 60));
        if (!confirm(`「${label}」将结束（已 ${elapsedMin} 分钟），进入「通话 · 双闹钟」。\n\n` +
                     `原计时会自动写入时间账本。\n\n确认 = 结束并进入通话\n取消 = 保持原计时、不接通`)) return;
        if (window.Timer && window.Timer.stopSilent) window.Timer.stopSilent();
      }
      startDualAlarm();
    });

    const btnEnd = document.getElementById("btnEnd");
    if (btnEnd) btnEnd.addEventListener("click", () => endCall(false));

    // 底部按钮 → 打开"选择窗口"；窗口内二选一（不豁免 / 申报豁免）
    const btnQuota = document.getElementById("btnQuotaOverride");
    if (btnQuota) btnQuota.addEventListener("click", () => {
      if (getOverride("quota_extra")) {
        clearOverride("quota_extra");
        renderOverride();
        refreshCallDecision();
        if (window.UI) window.UI.showAlert("已结束周额度豁免，恢复每周次数限制", 2200);
        return;
      }
      openOverrideDialog("quota_extra");
    });
    const btnNecessary = document.getElementById("btnNecessaryOverride");
    if (btnNecessary) btnNecessary.addEventListener("click", () => {
      if (getOverride("necessary")) {
        clearOverride("necessary");
        renderOverride();
        refreshCallDecision();
        if (window.UI) window.UI.showAlert("已结束正经时间豁免，恢复垃圾时间限制", 2200);
        return;
      }
      openOverrideDialog("necessary");
    });

    [
      ["quotaClose", "quota_extra"], ["quotaCancel", "quota_extra"],
      ["necessaryClose", "necessary"], ["necessaryCancel", "necessary"]
    ].forEach(([id, type]) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => closeOverrideDialog(type));
    });
    const quotaMask = document.getElementById("quotaMask");
    if (quotaMask) quotaMask.addEventListener("click", () => closeOverrideDialog("quota_extra"));
    const necessaryMask = document.getElementById("necessaryMask");
    if (necessaryMask) necessaryMask.addEventListener("click", () => closeOverrideDialog("necessary"));

    // 窗口 A：只为“周次数已用尽但此刻确属垃圾时间”增加 1 次额度。
    const quotaGrant = document.getElementById("quotaGrant");
    if (quotaGrant) quotaGrant.addEventListener("click", () => {
      if (!overrideChecksPassed("quota_extra")) {
        if (window.UI) window.UI.showAlert("4 项人工承诺必须全部勾选（系统核验项已自动判定）", 3500);
        return;
      }
      const input = document.getElementById("quotaReasonInput");
      const reason = String((input && input.value) || "").trim();
      if (!reason) {
        if (window.UI) window.UI.showAlert("请写明为什么需要增加本周额度", 3000);
        return;
      }
      const j = judgeToday();
      if (j.weeklyCallCount < D.weeklyRule.maxPerWeek) {
        if (window.UI) window.UI.showAlert(`本周仅使用 ${j.weeklyCallCount}/${D.weeklyRule.maxPerWeek} 次，无需增加额度`, 3500);
        return;
      }
      if (!overrideSystemEligible("quota_extra")) {
        if (window.UI) window.UI.showAlert("增加周次数只适用于已确认的垃圾时间；专注、睡眠、影响进度或邀约时不可使用", 4200);
        return;
      }
      pushReasonHistory("quota_extra", reason);
      const mins = overrideMinutes();
      setOverride(reason, mins, "quota_extra");
      closeOverrideDialog("quota_extra");
      renderOverride();
      refreshCallDecision();
      if (window.UI) window.UI.showAlert(`🔓 已增加 1 次周额度｜仅在当前垃圾时间内有效 ${mins} 分钟｜${reason}`, 4200);
    });

    // 窗口 B：正经时间特殊豁免；“正在专注”仍绝对禁止，并须说明现实损失。
    const necessaryGrant = document.getElementById("necessaryGrant");
    if (necessaryGrant) necessaryGrant.addEventListener("click", () => {
      if (!overrideChecksPassed("necessary")) {
        if (window.UI) window.UI.showAlert("6 项人工核验必须全部勾选（系统核验项已自动判定）", 3500);
        return;
      }
      const input = document.getElementById("necessaryReasonInput");
      const reason = String((input && input.value) || "").trim();
      if (reason.length < 6) {
        if (window.UI) window.UI.showAlert("请具体写明：为什么确实不得不现在通话（至少 6 个字）", 3500);
        return;
      }
      if (!overrideSystemEligible("necessary")) {
        if (window.UI) window.UI.showAlert("系统仍检测到专注、睡眠、影响进度或邀约等硬阻断，本入口不能覆盖", 5000);
        return;
      }
      if (!confirm("⚠️ 正经时间特殊豁免\n\n请再次确认：\n· 文字、延后回拨、10 分钟短答等替代方案均不可行\n· 这件事确实不得不现在处理\n· 通话仍须双闹钟并进入每日复盘\n\n确认 = 申报特殊豁免\n取消 = 收手，继续原计划")) return;
      pushReasonHistory("necessary", reason);
      const mins = overrideMinutes();
      setOverride(reason, mins, "necessary");
      closeOverrideDialog("necessary");
      renderOverride();
      refreshCallDecision();
      if (window.UI) window.UI.showAlert(`🟠 已申报“确实不得不”特殊豁免 ${mins} 分钟｜${reason}（已留痕）`, 4200);
    });

    // 今日通话分钟 + 补记
    const btnManual = document.getElementById("btnManualCall");
    if (btnManual) btnManual.addEventListener("click", () => {
      const v = prompt("补记通话（分钟数）：\n例如刚才接了电话没开双闹钟。\n（只记进通话页自己的账本：今日通话 / 周额度；不进主站时间记录，也不影响主计时器）", "10");
      if (v === null) return;
      const mins = Math.round(parseFloat(v));
      if (!isFinite(mins) || mins <= 0) {
        if (window.UI) window.UI.showAlert("请输入有效的分钟数", 2500);
        return;
      }
      const now = Date.now();
      Store.addTimeRecord({
        id: uid(), user_id: C.USER_ID,
        category: "call", sub_category: "linyuchen",
        label: "通话（补记）", tags: ["边界管控", "通话", "手动补记"],
        started_at: new Date(now - mins * 60000).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_sec: mins * 60,
        source: "call_manual",   // ★ 主站不联动：见 today-records.js 的 source 白名单说明
        note: "手动补记（未开双闹钟）｜只进通话页账本，不进主站时间记录",
        created_at: new Date(now).toISOString()
      });
      renderTodayCall();
      renderWeeklyInfo();
      if (window.UI) window.UI.showAlert(`✅ 已补记 ${mins} 分钟通话（计入本周额度；按你的要求不进主站时间记录）`, 3000);
    });

    // 周频率检查
    const btnWeekly = document.getElementById("btnWeeklyCheck");
    if (btnWeekly) btnWeekly.addEventListener("click", checkWeekly);

    // 订阅主站状态变化
    Store.subscribeActiveTimer(() => { renderHostStatus(); renderJudge(); _ensureHostTick(); });
    // 任务同步到达后重新执行自动门禁，但不重建复选框，保留用户当前人工判断。
    if (Store.subscribeTasks) Store.subscribeTasks(() => refreshCallDecision());

    // M1 修复：运行中秒级自刷新（Store 不会每秒 emit，call 页自己 tick）
    _ensureHostTick();

    // 图标注入
    if (window.Icon) {
      window.Icon.inject(document.getElementById("callScenarios"));
      window.Icon.inject(document.getElementById("windowScenarios"));
      window.Icon.inject(document.querySelector(".call-actions"));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (window.Blocks && window.Clock) {
      init();
    } else {
      setTimeout(() => { if (window.Blocks) init(); }, 300);
    }
  });
})();

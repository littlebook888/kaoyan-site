/* =====================================================================
 *  call-verdict.js —— 规则部裁定 · 通话申请判定（v1.77.0）
 *
 *  ── 它做什么 ──────────────────────────────────────────────────
 *  点管控闪卡 → 选入口（来电 / 想打）→ 只问必要的问题 → 给出带条例依据的裁定，
 *  旁边用**真实数据**展示这次通话的机会成本。
 *
 *  ── 它绝不做什么（每次改这个文件前重读一遍）──────────────────────
 *  ① 不修改任何原有阈值（15min 预警 / 25min 终极 / 日 40 / 周 120 / 睡眠段 /
 *     晚自习两段 / 奇偶日）—— 这些只从 CALL_DATA 读取。
 *  ② 不写任何原有记录：不 addTimeRecord、不 updateTimeRecord、不 setActiveTimer、
 *     不碰 active_timer、不碰豁免、不碰双闹钟。裁定纯展示。
 *  ③ 不自动接听 / 拨打 / 挂断真实电话。
 *  ④ 不把「计划被占用的时间」说成「实际损失的学习时间」——两者在界面上分开写。
 *  ⑤ 数据拿不到就写「暂不可用」，绝不编造学习时长、任务数、考试日期。
 *  ⑥ 任务门禁当前是关闭的（taskGateEnabled=false）→「剩余任务」只能当参考事实，
 *     不能当成系统自动阻断的理由；置后定则的结论标注「人工判断」。
 *
 *  条例依据全部来自 window.CALL_RULEBASE（那份库的唯一来源是 call.html 静态文案）。
 *  依赖：config.js / blocks.js / store.js / call-data.js / call-rulebase.js（均只读）
 * ===================================================================== */
window.CallVerdict = (function () {
  "use strict";

  var C = null, D = null, Store = null;
  var RB = null;

  /* ---------- 基础工具 ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function toMin(t) { var p = String(t).split(":"); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function bj(d) {
    return (window.Blocks && window.Blocks.beijing) ? window.Blocks.beijing(d || new Date()) : new Date();
  }
  function nowMin() { var b = bj(); return b.getHours() * 60 + b.getMinutes(); }
  function bizDay(ts) {
    if (window.Blocks && window.Blocks.bizDateStr) return window.Blocks.bizDateStr(ts);
    var d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function fmtMin(min) {
    min = Math.max(0, Math.round(min));
    return min >= 60 ? Math.floor(min / 60) + " 小时 " + (min % 60) + " 分" : min + " 分钟";
  }

  function hhmm(t) {
    var m = toMin(t);
    return pad(Math.floor((m % 1440) / 60)) + ":" + pad(m % 60);
  }

  /* ---------- 时段（只读 CALL_DATA.nightStudy，与判定同源） ----------
   * ★ 与 call.js 的 nightStudyBlocking / nightStudySoftBlocking / sleepWindowBlocking
   *   三个函数逐条对齐：同一组字段、同一个「起点 > 终点 = 跨午夜」写法、同一个 since 生效日。
   *   抽成 phaseAt(分钟) 是因为下面判断「下一个收尾窗口」时，要按**那个时段的起始时刻**
   *   反推它是否被硬禁窗覆盖——只会算「现在」是不够用的。 */
  function phaseAt(m) {
    var ns = (D && D.nightStudy) || {};
    var today = bizDay();
    if (!ns.enabled || (ns.since && String(today) < String(ns.since))) {
      return { key: "other", label: "非夜间管控时段" };
    }
    m = ((Number(m) || 0) % 1440 + 1440) % 1440;
    function hit(from, to) {
      if (!from || !to) return false;
      var a = toMin(from), b = toMin(to);
      return a <= b ? (m >= a && m < b) : (m >= a || m < b);
    }
    if (hit(ns.sleepFrom, ns.sleepTo)) {
      return { key: "sleep", label: "强制睡眠段（" + hhmm(ns.sleepFrom) + "–" + hhmm(ns.sleepTo) + "）" };
    }
    if (hit(ns.offFrom, ns.offTo)) {
      return { key: "core", label: "晚自习核心段（" + hhmm(ns.offFrom) + "–" + hhmm(ns.offTo) + "）" };
    }
    if (hit(ns.softFrom, ns.softTo)) {
      return { key: "extend", label: "晚自习延展段（" + hhmm(ns.softFrom) + "–" + hhmm(ns.softTo) + "）" };
    }
    return { key: "other", label: "非夜间管控时段" };
  }
  function phaseNow() { return phaseAt(nowMin()); }

  /* ---------- 与「当前状态与来电判定」同源的事实读取 ----------
   * ★ 用户 2026.10.20 明确：闪卡裁定必须与下方那张判定卡**同一套底层逻辑**。
   *   下面这张表就是那 6 个复选框的实时状态（id 由 call.js 渲染，此处**只读**：
   *   不勾选、不改 DOM、不写存储）。读不到就按未勾选算 —— 与判定卡刚打开时的初始态一致。 */
  function checked(id) {
    var el = document.getElementById(id);
    return !!(el && el.checked);
  }
  function readChecks() {
    return {
      currentlyFocused: checked("currentlyFocused"),
      garbageTime: checked("garbageTime"),
      affairsDone: checked("affairsDone"),
      followDeferRule: checked("followDeferRule"),
      impactStudy: checked("impactStudy"),
      isInvitation: checked("isInvitation")
    };
  }

  /* ---------- 通话统计（只读 time_records，口径与原判定一致） ---------- */
  function isCallRec(r) {
    return !!r && (r.source === "call_boundary" || r.source === "call_manual");
  }
  /* 自然周口径 = 周一 → 今日，与 call.js 的 calcWeeklyCallMinSec / calcWeeklyCallCount 一致。
   * ⚠️ 这里必须用 key 反推周一（而不是 new Date().getDay()），否则跨零点后会算错周。 */
  function weekMonday(key) {
    var p = String(key).split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var dow = d.getDay() || 7;              // 周日 = 7
    d.setDate(d.getDate() - (dow - 1));
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  /* 按业务日汇总通话秒→分（双闹钟 + 补记都算，只认 call_boundary / call_manual） */
  function callMinByDay() {
    var map = {};
    var recs = (Store && Store.getTimeRecords) ? (Store.getTimeRecords() || []) : [];
    recs.forEach(function (r) {
      if (!isCallRec(r) || !r.started_at) return;
      var k = bizDay(r.started_at);
      map[k] = (map[k] || 0) + (Number(r.duration_sec) || 0) / 60;
    });
    return map;
  }
  function callStats() {
    var today = bizDay();
    var mon = weekMonday(today);
    var map = callMinByDay();
    var todayMin = 0, weekMin = 0, weekDays = 0;
    Object.keys(map).forEach(function (k) {
      if (k === today) todayMin += map[k];
      if (k >= mon && k <= today) { weekMin += map[k]; weekDays += 1; }
    });
    /* 次数：与 calcWeeklyCallCount 同口径（数**记录条数**，不是天数）。
     * 只作展示——weeklyRule.maxPerWeek 已为 null（次数闸取消），不参与阻断。 */
    var weekRecs = 0;
    var recs = (Store && Store.getTimeRecords) ? (Store.getTimeRecords() || []) : [];
    recs.forEach(function (r) {
      if (!isCallRec(r) || !r.started_at) return;
      var k = bizDay(r.started_at);
      if (k >= mon && k <= today) weekRecs += 1;
    });
    var wr = (D && D.weeklyRule) || {};
    var dayCap = (typeof wr.maxMinPerDay === "number" && wr.maxMinPerDay > 0) ? wr.maxMinPerDay : 0;
    return {
      todayMin: todayMin, weekMin: weekMin,
      weekDays: weekDays, weekRecs: weekRecs,
      dayCap: dayCap,
      weekCap: Number(wr.maxMinPerWeek) || 120,
      countCap: (typeof wr.maxPerWeek === "number" && wr.maxPerWeek > 0) ? wr.maxPerWeek : 0
    };
  }

  /* 奇偶日：与 call.js 的 oddEvenActive + evenCallDaysThisWeek 逐行对齐。
   * 奇偶按「几号」判（10 月 12 日 = 偶数日），与星期几无关；
   * 本周已用掉的偶数日 = 周一→今日之间、凡是产生过通话分钟的偶数日。 */
  function evenDaysUsed(today) {
    var mon = weekMonday(today);
    var p = mon.split("-").map(Number);
    var map = callMinByDay();
    var out = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(p[0], p[1] - 1, p[2] + i);
      var k = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      if (k > today) break;
      if (d.getDate() % 2 === 0 && (map[k] || 0) > 0) out.push(k);
    }
    return out;
  }
  function oddState() {
    var cfg = (D && D.weeklyRule && D.weeklyRule.oddEven) || {};
    var today = bizDay();
    return {
      on: !!(cfg.enabled && String(today) >= String(cfg.since || "")),
      isOdd: Number(String(today).slice(8)) % 2 === 1,
      today: today,
      quota: Number(cfg.evenDaysPerWeek) || 1,
      used: evenDaysUsed(today)
    };
  }

  /* ---------- 学习数据（只读；拿不到就标不可用） ---------- */
  function countsGoalRec() {
    var cats = (C && C.TIME_CATEGORIES) || [];
    return function (r) {
      var c = cats.filter(function (x) { return x.key === r.category; })[0];
      return !!(c && c.countTowardGoal);
    };
  }
  function studyStats() {
    var out = { ok: false };
    var goalH = parseFloat(C && C.DAILY_GOAL_HOURS) || 0;
    if (!goalH) return out;
    var recs = [];
    if (window.TodayRecords && window.TodayRecords.getTodayRecords) {
      recs = window.TodayRecords.getTodayRecords() || [];
    } else if (Store && Store.getTimeRecords) {
      var today = bizDay();
      recs = (Store.getTimeRecords() || []).filter(function (r) { return bizDay(r.started_at) === today; });
    }
    var counts = countsGoalRec();
    var studySec = recs.filter(counts).reduce(function (a, r) { return a + (Number(r.duration_sec) || 0); }, 0);
    out.ok = true;
    out.goalMin = goalH * 60;
    out.studyMin = studySec / 60;
    out.pct = out.goalMin ? Math.min(100, Math.round(out.studyMin / out.goalMin * 100)) : 0;
    out.remainMin = Math.max(0, out.goalMin - out.studyMin);
    return out;
  }
  function taskStats() {
    var out = { ok: false, pending: [], count: 0 };
    if (!(Store && Store.getTasks)) return out;
    var list = Store.getTasks() || [];
    var today = bizDay();
    /* 口径：未完成、且日期是今天或更早（欠着的）——只作参考，不参与阻断判定 */
    var pend = list.filter(function (t) {
      if (!t || t.done) return false;
      var d = t.date ? String(t.date) : "";
      return !d || d.slice(0, 10) <= today;
    });
    out.ok = true;
    out.count = pend.length;
    out.pending = pend.slice(0, 3).map(function (t) { return t.title || "(无标题)"; });
    return out;
  }
  function slotNow() {
    var SD = window.SCHEDULE_DATA;
    if (!SD || !SD.slots) return null;
    var m = nowMin();
    var hit = SD.slots.filter(function (s) {
      var a = toMin(s.start), b = toMin(s.end), e = (s.end === "24:00") ? 1440 : b;
      if (e < a) return (m >= a || m < e);        // 跨午夜
      return m >= a && m < e;
    })[0];
    if (!hit) return null;
    var endM = (hit.end === "24:00") ? 1440 : toMin(hit.end);
    return {
      name: String(hit.name || "").replace(/（.*?）/g, ""),
      start: hit.start, end: hit.end,
      remainMin: Math.max(0, endM - m),
      kind: hit.kind
    };
  }
  function examDays() {
    var d = C && C.EXAM_DATE;
    if (!d) return null;
    var t = Date.parse(String(d) + "T00:00:00+08:00");
    if (!isFinite(t)) return null;
    var n = Math.ceil((t - Date.now()) / 86400000);
    return n >= 0 ? n : null;
  }
  function cleanName(n) {
    return String(n || "").replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim();
  }

  /* ---------- 建议项的三类来源（逐条对齐 call.js 的 advItems 收集段） ----------
   * ① 计划表此刻就是学习区间；② 本大块后面还排着学习；③ 主站正在计时工作/实习。
   * 三类都是「推断」而非事实行为，所以只能**建议**，不能硬拦
   * （用户 2026.10.18 定：只有主站正在计时**学习**才硬拦，那条在上面的 focused 分支里）。 */
  function blockHasStudyAfter(slot) {
    var SD = window.SCHEDULE_DATA;
    var tb = (C && C.TIME_BLOCKS) || {};
    if (!SD || !SD.slots || !slot || !tb.wake) return false;
    var sMin = toMin(slot.start), eMin = toMin(slot.end);
    var bounds = [
      { s: toMin(tb.wake), e: toMin(tb.lunch) },
      { s: toMin(tb.lunch), e: toMin(tb.dinner) },
      { s: toMin(tb.dinner), e: toMin(tb.sleep === "24:00" ? "24:00" : tb.sleep) }
    ];
    var blk = null;
    for (var i = 0; i < bounds.length; i++) {
      if (sMin >= bounds[i].s && sMin < bounds[i].e) { blk = bounds[i]; break; }
    }
    if (!blk) return false;                       // 不在任何大块内（如洗漱）→ 并行规则可用
    return SD.slots.some(function (x) {
      return x.kind === "study" &&
        toMin(x.start) >= blk.s && toMin(x.end) <= blk.e &&
        toMin(x.start) >= eMin;
    });
  }
  /* 置后定则的**出口**：下一个「之后无正经安排」的收尾段。
   * 口径：非学习时段 AND 本大块内其后无学习 AND 未被睡眠/核心段/延展段覆盖。 */
  function nextDeferWindow() {
    var SD = window.SCHEDULE_DATA;
    if (!SD || !SD.slots) return null;
    var m = nowMin();
    var list = SD.slots.filter(function (s) {
      if (s.kind === "study") return false;
      if (toMin(s.end) <= m) return false;
      if (blockHasStudyAfter(s)) return false;
      var k = phaseAt(toMin(s.start)).key;
      if (k === "sleep" || k === "core" || k === "extend") return false;
      return true;
    });
    list.sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
    return list[0] || null;
  }
  function deferWindowText() {
    var s = nextDeferWindow();
    return s ? cleanName(s.name) + " " + s.start + "~" + s.end : "";
  }
  function advItemsNow(at) {
    var out = [];
    var sl = slotNow();
    if (sl && sl.kind === "study") {
      out.push("现在是学习区间：〈" + cleanName(sl.name) + " " + sl.start + "~" + sl.end + "〉还剩 " +
        fmtMin(sl.remainMin) + "——计划表口径：正经时间一律不建议聊天。");
    }
    if (sl && sl.kind !== "study" && blockHasStudyAfter(sl)) {
      var win = deferWindowText();
      out.push("本大块后面还排着学习 → 置后定则优先于垃圾/休息并行利用" +
        (win ? "；可改约「" + win + "」" : "；今日已无合格收尾段"));
    }
    if (at && at.status === "running" && (at.kind === "work" || at.kind === "internship")) {
      var cats = (C && C.TIME_CATEGORIES) || [];
      var cm = cats.filter(function (x) { return x.key === at.kind; })[0] || { label: at.kind };
      var elSec = Math.max(0, Math.round((Number(at.elapsed_sec) || 0) +
        (Date.now() - (at.started_at || Date.now())) / 1000));
      out.push("主站正在计时〈" + cm.label + "〉已 " + fmtMin(Math.floor(elSec / 60)) +
        "——正经事进行中，建议这边结束后再回电。");
    }
    return out;
  }

  /* ---------- 条例引用 ---------- */
  function rule(no) {
    if (!RB) return null;
    return (RB.items || []).filter(function (x) { return x.no === no; })[0] || null;
  }
  function ref(no) {
    var r = rule(no);
    return r ? { no: r.no, title: r.title, quote: r.summary } : null;
  }
  function supplementsByTag(tag) {
    return ((RB && RB.supplements) || []).filter(function (s) {
      return (s.tags || []).indexOf(tag) >= 0;
    });
  }

  /* =====================================================================
   *  判定
   *  entry: "incoming"（他打来） | "outgoing"（我想打）
   *  ans:   { defer:"yes|no|unsure", necessity:"real|chat", garbage:"yes|no|unsure" }
   * ===================================================================== */
  function judge(entry, ans) {
    ans = ans || {};
    var ph = phaseNow();
    var cs = callStats();
    var v = {
      level: "consider",
      entry: entry,
      phase: ph.key,
      matter: (entry === "outgoing" ? "主动拨打" : "来电接听") + " · " + ph.label,
      rules: [],
      facts: [],
      costs: [],
      notes: [],
      action: ""
    };
    function addRule(no) { var r = ref(no); if (r) v.rules.push(r); }
    function deny(title, action) { v.level = "forbid"; v.title = title; v.action = action; return v; }
    function ask(k) { v.level = "ask"; v.ask = k; return v; }

    /* ★ 事实来源（用户 2026.10.20 要求：与「当前状态与来电判定」同源）：
     *   优先用问答答案；没答过的，直接取下方判定卡那 6 个复选框的当前状态。
     *   下面整条链的顺序、条件、结论，逐条对齐 call.js 的 evaluateCallDecision()。 */
    var chk = readChecks();
    var at = (Store && Store.getActiveTimer) ? Store.getActiveTimer() : null;
    var od = oddState();
    function pick(k, fallback) {
      return (ans[k] !== undefined && ans[k] !== "") ? ans[k] : (fallback ? "yes" : "");
    }
    var garbage = pick("garbage", chk.garbageTime);
    var affairs = pick("affairs", chk.affairsDone);
    var deferred = pick("deferred", chk.followDeferRule);
    var invitation = pick("invitation", chk.isInvitation);
    var affects = pick("affects", chk.impactStudy);

    /* ── 1. 已经有一通在计时：不要重复开表 ── */
    if (at && at.kind === "call") {
      addRule("⑬");
      v.facts.push("主站已存在通话计时——不要重复开始，按当前时长执行双闹钟与收尾。");
      return deny("已有一通在计", "按现有这通继续走；不要在页面上重复开表。");
    }

    /* ── 2. 睡眠计时中（以计时标签为准，与钟点睡眠是两条独立口径）── */
    var timerSleeping = !!(at && at.status === "running" &&
      (at.kind === "sleep" || at.sub_category === "long_sleep" || at.sub_category === "nap"));
    if (timerSleeping) {
      addRule("⑦");
      v.facts.push("主站正在计时睡眠（以计时标签为准）—— 与钟点睡眠是两条独立口径，任一成立即不接。");
      return deny("不予通过", "直接挂断或只回文字，任何豁免都不覆盖这条。");
    }

    /* ── 3. 睡眠段（按钟点，23:40–07:00）── */
    if (ph.key === "sleep") {
      var nsS = (D && D.nightStudy) || {};
      addRule("⑦"); addRule("⑫"); addRule("⑧");
      v.facts.push("当前处于" + ph.label + "（含准备睡觉时间），按 ⑦ / ⑫ 不得通话。");
      v.facts.push("已在通话中的须在 " + (nsS.sleepEndBy || "23:45") + " 前结束；未安排睡觉的同样适用。");
      v.notes.push("此时的「置后」不等于「稍后再接」——只能改约次日 " +
        (nsS.sleepTo || "07:00") + " 之后，或改用文字解决。");
      var ex = examDays();
      v.costs.push({ label: "现在该做的", value: "休息", note: ex != null ? "距考研还有 " + ex + " 天" : "" });
      return deny("不予通过", "休息，必要事项改到明天处理；回复建议文字解释，或不解释。");
    }

    /* ── 4. 晚自习核心段（18:30–23:00，硬禁、不受垃圾时间调剂）── */
    if (ph.key === "core") {
      addRule("⑫"); addRule("⑩"); addRule("⑮");
      v.facts.push("当前处于" + ph.label + "，按 ⑫ 不接受任何理由的接打电话，也不接受垃圾时间调剂。");
      var sl0 = slotNow();
      if (sl0) v.facts.push("原定安排：" + sl0.name + "（至 " + sl0.end + "），还剩 " + fmtMin(sl0.remainMin) + "。");
      var st0 = studyStats();
      if (st0.ok) v.costs.push({
        label: "今日学习", value: Math.round(st0.studyMin) + " / " + Math.round(st0.goalMin) + " 分钟（" + st0.pct + "%）",
        note: "仅作参考，不构成处罚"
      });
      return deny("不予通过", "继续原定学习安排；来电直接拒接或只回文字，不必解释。");
    }

    /* ── 5. 晚自习延展段（23:00–23:40）：仅确认垃圾时间后可接 ── */
    if (ph.key === "extend" && garbage !== "yes") {
      if (!garbage) return ask("garbage");
      v.level = "hold";
      v.title = "暂不通话，先核实";
      addRule("⑫"); addRule("②");
      v.facts.push(garbage === "no"
        ? "你判断现在不属于垃圾时间。延展段仍是晚自习，只有垃圾时间才可接听。"
        : "垃圾时间资格尚未确认，未确认时按不可接处理。");
      v.action = "先把当前事情做完；确认确属垃圾时间后，再回来重新判定。";
      return v;
    }

    /* ── 6. 专注中（主站正在计时学习，或你勾了「正在专注」）── */
    var focused = !!(at && at.status === "running" && at.kind === "study") ||
      pick("focused", chk.currentlyFocused) === "yes";
    if (focused) {
      addRule("②"); addRule("④");
      v.facts.push("主站正在计时学习，或你标记为正在专注——正经时间一律禁止聊天，不得影响正常进度。");
      return deny("不予通过", "直接挂断；学习计时结束后再判断。");
    }

    /* ── 7. 任务门禁：rules.taskGateEnabled = false（已停用）→ 与下方判定一致，跳过 ── */

    /* ── 8. 邀约类来电：只能文字回复 ── */
    if (invitation === "yes") {
      addRule("②");
      v.facts.push("你标记本次是邀约类来电——邀约不得接听，只能文字回复。");
      return deny("不予通过", "不接，改文字回复。");
    }

    /* ── 9. 会影响正常进度 ── */
    if (affects === "yes") {
      addRule("⑮");
      v.facts.push("你判断这次通话会影响正常进度——「不得影响进度」是硬条件。");
      return deny("不予通过", "直接挂断或改期。");
    }

    /* ── 10. 周时长闸（与判定卡同口径：> 上限才算超，不是 >=）── */
    if (cs.weekMin > cs.weekCap) {
      v.rules.push({ no: "规则部 · 周频率规则", title: "每周 ≤ " + cs.weekCap + " 分钟",
        quote: "每周接通总时长不超过 " + cs.weekCap + " 分钟（自然周，周一→今日；与下方判定同一口径）。" });
      v.facts.push("本周已通 " + Math.round(cs.weekMin) + " 分钟，已超过周上限 " + cs.weekCap + " 分钟。");
      v.notes.push("判定卡只在「本周通话超过上限」时触发此条；次数闸（每周 N 次）已于 v1.37.0 取消，只留时长。");
      return deny("不予通过", "本周额度已用尽；确有需要只能走原有的「周额度豁免」流程。");
    }

    /* ── 11. 日闸（单日 ≤ 40 分钟，硬阻断）──
     * ⚠️ 与判定卡一致：这条要 oddEvenOn 与 dayCapMin>0 同时成立才生效
     *   （call.js: j.oddEvenOn && j.dayCapMin > 0 && j.curDayMin >= j.dayCapMin）。 */
    if (od.on && cs.dayCap > 0 && cs.todayMin >= cs.dayCap) {
      v.rules.push({ no: "规则部 · 周频率规则", title: "单日 ≤ " + cs.dayCap + " 分钟",
        quote: "每日接通总时长不超过 " + cs.dayCap + " 分钟（目的是避免一天把全周额度占完；与下方判定同一口径）。" });
      v.facts.push("今日已通 " + Math.round(cs.todayMin) + " 分钟，已达单日上限 " + cs.dayCap + " 分钟。");
      v.facts.push("本周还剩 " + Math.max(0, Math.round(cs.weekCap - cs.weekMin)) + " 分钟额度，但今天不能再用了。");
      return deny("不予通过", "今天不再接通；明天再聊。");
    }

    /* ── 12. 奇偶日（偶数日每周限 1 天，硬阻断，先到先得）── */
    if (od.on && !od.isOdd) {
      if (od.used.length >= od.quota && od.used.indexOf(od.today) < 0) {
        v.rules.push({
          no: "规则部 · 奇偶日规则", title: "偶数日每周限 " + od.quota + " 天",
          quote: "奇数日可接听；偶数日每个自然周只有 " + od.quota + " 天能通话（与下方判定同一口径）。"
        });
        v.facts.push("今天是偶数日，本周的偶数日名额已经用在 " + od.used.map(function (k) {
          return Number(k.slice(5, 7)) + "月" + Number(k.slice(8, 10)) + "日";
        }).join("、") + "。");
        return deny("不予通过", "等下一个奇数日；今天来电只回文字。");
      }
    }

    /* ── 13. 自身事务是否处理完（对应下方「自身事务已处理」勾选）── */
    if (affairs !== "yes") {
      if (!affairs) return ask("affairs");
      v.level = "hold";
      v.title = "请判断 · 先处理完自身事务";
      addRule("②");
      v.facts.push("自身事务还没处理完——对方来电排在所有正经任务之后。");
      v.notes.push("判定卡在这一步写的是「请判断」（琥珀色，不是硬禁）——你随时可以先处理完再回来。");
      v.action = "先把自己的事情做完，勾上「自身事务已处理」，再回来重新判定。";
      return v;
    }

    /* ── 14. 置后定则（对应下方「置后定则已执行」勾选）── */
    if (deferred !== "yes") {
      if (!deferred) return ask("deferred");
      v.level = "hold";
      v.title = "请判断 · 先置后";
      addRule("①");
      v.facts.push("置后定则还没确认——能不能稍后回拨、或用文字解决？");
      v.notes.push("置后定则永远是**人工判断**：判定卡的「一键绕过」也不覆盖它（用户 2026.10.18 定）。");
      var winTxt = deferWindowText();
      v.action = winTxt
        ? "先问能否改约「" + winTxt + "」或改文字；确认确实无法置后，再回来重新判定。"
        : "今日已无合格的收尾段——置后的唯一出口是改文字，或改约明天。";
      return v;
    }

    /* ── 15. 建议项（与下方判定的三类建议同口径）──
     * ★ 与判定卡一致：勾了「当前是垃圾时间」就跳过这一段（合法路径，不消耗绕过次数）。 */
    var adv = advItemsNow(at);
    if (adv.length && garbage !== "yes") {
      v.level = "hold";
      v.title = "建议不接（可自行判断）";
      addRule("①");
      adv.forEach(function (a) { v.facts.push(a); });
      v.action = "这是建议、不是硬性禁止：在判定卡勾上「当前是垃圾时间」即可直接接，不消耗绕过次数；" +
        "不勾则要占今日的绕过额度。";
      return v;
    }

    /* ── 16. 垃圾时间（非延展段也要确认）── */
    if (garbage !== "yes") {
      if (!garbage) return ask("garbage");
      v.level = "hold";
      v.title = "暂不通话，先核实";
      addRule("②");
      v.facts.push("垃圾时间尚未确认——所有通话只能发生在垃圾时间或完全不影响进度的时间。");
      v.action = "确认当前确属垃圾时间后，再回来重新判定。";
      return v;
    }

    /* 问答答案与判定卡勾选不一致时提醒一句：本模块只读，不会替你勾。
     * 不一致时**以判定卡为准**（用户 2026.10.20：三方冲突时听判定卡的）。 */
    var mm = [];
    if (ans.garbage === "yes" && !chk.garbageTime) mm.push("当前是垃圾时间");
    if (ans.affairs === "yes" && !chk.affairsDone) mm.push("自身事务已处理");
    if (ans.deferred === "yes" && !chk.followDeferRule) mm.push("置后定则已执行");
    if (mm.length) {
      v.notes.push("你在上面的回答与判定卡的勾选不一致（" + mm.join("、") +
        "）——本模块只读、不会替你打勾；想让它长期生效就把判定卡对应的框也勾上。两边不一致时以判定卡为准。");
    }

    /* ── 17. 主动拨打独有的前置自问（△ 唯一一条判定卡没有的）──
     * 为什么允许它存在：判定卡的标题就是「当前状态与**来电**判定」，它只覆盖接听侧；
     * 「我现在要不要拨出去」是另一种动作，靠 ⑯/⑰ 单独约束。
     * 它只会让你**更少**打电话，永远不会放行任何被卡住的情形，所以不与判定卡冲突。 */
    if (entry === "outgoing" && !ans.necessity) return ask("necessity");
    if (entry === "outgoing" && ans.necessity === "chat") {
      v.level = "hold";
      v.title = "请判断 · 没有具体事项";
      addRule("⑰"); addRule("⑮");
      v.facts.push("你选的不是「有具体事情」——⑰ 的目标关系边界是普通高中同学，减少无关陪伴和无意义社交。");
      v.notes.push("这一条只针对主动拨打；来电侧由上面整条链判定。");
      v.action = "没有正事就先不拨；想说话可以发文字，不占任何通话额度。";
      return v;
    }

    /* ── 18. 全部通过：可以考虑 ── */
    return finish(v, entry, cs);
  }

  function finish(v, entry, cs) {
    /* 走到这里说明周时长 / 日闸 / 奇偶日 / 专注 / 邀约 / 事务 / 置后 全部已过。
     * 原来这里又重复拦了一遍日闸与周闸（且周闸用的是 >=，与上游的 > 不一致）——
     * 已删除：同一条规则只在一个地方判，避免「两处写法不同步」把结论判拧。 */

    v.level = "consider";
    v.title = "可以考虑通话";
    v.rules.push({ no: "⑮", title: "最推荐的动作仍然是不接听", quote: "所有收尾规矩都不改变结论：最推荐仍是不接听。" });
    if (entry === "outgoing") v.rules.push(ref("⑯") || { no: "⑯", title: "主动拨打", quote: "" });

    /* 事实与代价 */
    v.facts.push("当前不在硬性禁止时段，额度也有余量。");
    v.costs.push({
      label: "今日通话额度", value: Math.round(cs.todayMin) + " / " + cs.dayCap + " 分钟",
      note: "剩余 " + Math.max(0, Math.round(cs.dayCap - cs.todayMin)) + " 分钟"
    });
    v.costs.push({
      label: "本周通话额度", value: Math.round(cs.weekMin) + " / " + cs.weekCap + " 分钟",
      note: "已通话 " + cs.weekDays + " 天"
    });
    /* 关系频率：只提示，不拦截（页面 ⑰ 已写明按自控执行） */
    v.costs.push({
      label: "本周通话天数", value: cs.weekDays + " 天 · " + cs.weekRecs + " 通",
      note: "自控目标 ≤ 2 次/周 · 次数闸已于 v1.37.0 取消，系统不会拦第 3 通"
    });
    var st = studyStats();
    if (st.ok) {
      v.costs.push({ label: "今日学习", value: Math.round(st.studyMin) + " / " + Math.round(st.goalMin) + " 分钟（" + st.pct + "%）", note: "还差 " + Math.round(st.remainMin) + " 分钟" });
    }
    var tk = taskStats();
    if (tk.ok && tk.count) {
      v.costs.push({ label: "未完成任务", value: tk.count + " 项", note: tk.pending.join("、") + " · 仅供参考，不参与阻断" });
    }
    v.action = entry === "outgoing"
      ? "确有事项再拨；拨出后 3 分钟内打 2 次无回应即收手（⑯）。"
      : "可以接，但请开双闹钟，到点 3 分钟内挂断（⑬）；不想接也完全可以不接（⑮）。";
    v.notes.push("任务门禁当前处于关闭状态——上面的「未完成任务」只是参考，不是系统在拦你。");
    v.notes.push("本模块不读「豁免」状态（周额度豁免 / 正经时间必要豁免）：若你今天已申请豁免，以通话页判定卡的结论为准。");
    return v;
  }

  /* =====================================================================
   *  渲染
   * ===================================================================== */
  var STATE = { entry: null, ans: {}, step: null };

  /* 徽标用「判定等级」的短标签，与下方判定卡的语义色一一对应：
   *   红 = 硬禁不可绕 / 琥珀 = 请判断可自行决定 / 绿 = 可以考虑 / 灰 = 待核验 */
  function levelMeta(lv) {
    if (lv === "forbid") return { text: "不予通过", cls: "is-forbid" };
    if (lv === "hold") return { text: "请判断", cls: "is-hold" };
    if (lv === "ask") return { text: "待核验", cls: "is-ask" };
    return { text: "可以考虑", cls: "is-ok" };
  }

  /* 问句：**只问判定链真正需要的三件事**。
   * ★ 与下方判定卡的对应关系（用户 2026.10.20 要求同源）：
   *   garbage   ↔ 复选框「当前是垃圾时间」
   *   affairs   ↔ 复选框「自身事务已处理」
   *   deferred  ↔ 复选框「置后定则已执行」
   *   其余三项（专注 / 会影响进度 / 邀约）不主动问——它们通常是「否」，
   *   直接取判定卡的实时勾选状态；只有真勾上了才在裁定里体现。 */
  function askHtml(ask) {
    if (ask === "deferred") {
      return {
        q: "置后定则执行了吗？",
        sub: "先问过「能不能稍后回拨 / 用文字解决」吗？这一步永远是人工判断，一键绕过也不覆盖它。",
        opts: [
          { k: "yes", t: "已确认无法置后，只能现在通话" },
          { k: "no", t: "还没问，现在去问" },
          { k: "unsure", t: "不确定，需要核实" }
        ]
      };
    }
    if (ask === "affairs") {
      return {
        q: "自己的事情处理完了吗？",
        sub: "对方来电排在所有正经任务之后。这是「请判断」，不是硬禁——没做完就先去做。",
        opts: [
          { k: "yes", t: "已处理完" },
          { k: "no", t: "还没处理完" },
          { k: "unsure", t: "不确定，需要核实" }
        ]
      };
    }
    if (ask === "garbage") {
      return {
        q: "现在属于「垃圾时间」吗？",
        sub: "垃圾时间 = 做完该做的事之后、不影响进度的零碎时间。勾上判定卡的同一个框即可直接接。",
        opts: [
          { k: "yes", t: "是，确实是垃圾时间" },
          { k: "no", t: "不是，正处在正经时间" },
          { k: "unsure", t: "不确定" }
        ]
      };
    }
    return {
      q: "这次有明确、必要的事情需要沟通吗？",
      sub: "不是「聊几分钟」——是有没有具体需要说的事。",
      opts: [
        { k: "real", t: "有具体事情需要沟通" },
        { k: "chat", t: "只是想聊天，没有明确内容" }
      ]
    };
  }

  /* 面板 HTML 是**纯函数**：给一份裁定对象 + 时段，返回字符串。
   * 拆出来的原因：原来它和 renderPanel 揉在一起，只能靠手点浏览器验；
   * 现在断言脚本可以脱离 DOM 直接检查渲染产物（标题有没有丢、徽标对不对）。 */
  function panelHtml(v, ph) {
    ph = ph || phaseNow();
    /* 问句态 */
    if (v.level === "ask") {
      var a = askHtml(v.ask);
      return '<div class="cv-phase">' + esc(ph.label) + '</div>' +
        '<div class="cv-q">' + esc(a.q) + '</div>' +
        '<div class="cv-qsub">' + esc(a.sub) + '</div>' +
        '<div class="cv-opts">' + a.opts.map(function (o) {
          return '<button type="button" class="cv-opt" data-cv-ans="' + esc(v.ask) + ':' + esc(o.k) + '">' + esc(o.t) + '</button>';
        }).join("") + '</div>' +
        '<button type="button" class="cv-back" data-cv-back="1">← 换个入口</button>';
    }

    /* 裁定态 */
    var lm = levelMeta(v.level);
    var h = '';
    h += '<div class="cv-verdict ' + lm.cls + '">' +
      '<div class="cv-v-head"><span class="cv-v-title">' + esc(v.title || "规则部裁定") + '</span>' +
      '<span class="cv-v-badge">' + esc(lm.text) + '</span></div>' +
      '<div class="cv-v-matter">裁定事项：' + esc(v.matter) + '</div>' +
      '</div>';

    if (v.rules.length) {
      h += '<div class="cv-sec"><div class="cv-sec-t">条例依据</div>';
      v.rules.forEach(function (r) {
        h += '<div class="cv-rule">' +
          '<div class="cv-rule-h"><span class="cv-rule-no">' + esc(r.no) + '</span>' +
          '<span class="cv-rule-t">' + esc(r.title) + '</span></div>' +
          (r.quote ? '<div class="cv-rule-q">' + esc(r.quote) + '</div>' : '') +
          '</div>';
      });
      h += '</div>';
    }

    if (v.facts.length) {
      h += '<div class="cv-sec"><div class="cv-sec-t">事实认定</div><ul class="cv-ul">' +
        v.facts.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join("") + '</ul></div>';
    }

    if (v.costs.length) {
      h += '<div class="cv-sec"><div class="cv-sec-t">学习机会成本</div><div class="cv-costs">';
      v.costs.forEach(function (c) {
        h += '<div class="cv-cost"><span class="cv-cost-l">' + esc(c.label) + '</span>' +
          '<b class="cv-cost-v">' + esc(c.value) + '</b>' +
          (c.note ? '<span class="cv-cost-n">' + esc(c.note) + '</span>' : '') + '</div>';
      });
      h += '</div></div>';
    }

    if (v.notes.length) {
      h += '<div class="cv-sec"><div class="cv-notes">' +
        v.notes.map(function (n) { return '<div class="cv-note">' + esc(n) + '</div>'; }).join("") +
        '</div></div>';
    }

    h += '<div class="cv-action"><span class="cv-action-t">执行建议</span>' + esc(v.action) + '</div>';
    h += '<div class="cv-foot">' +
      '<button type="button" class="cv-btn ghost" data-cv-back="1">重新判定</button>' +
      (v.level === "consider" ? '<a class="cv-btn" href="timer.html">去主站计时</a>' : '') +
      '</div>';
    return h;
  }

  function renderPanel() {
    var box = document.getElementById("cvBody");
    if (!box) return;
    box.innerHTML = panelHtml(judge(STATE.entry, STATE.ans), phaseNow());
  }

  /* ---------- 面板骨架 ---------- */
  function ensureDom() {
    if (document.getElementById("cvMask")) return;
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="cv-mask" id="cvMask"></div>' +
      '<div class="cv-modal" id="cvModal" role="dialog" aria-modal="true">' +
        '<div class="cv-head">' +
          '<div class="cv-title">规则部裁定</div>' +
          '<button type="button" class="cv-close" id="cvClose" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="cv-intro" id="cvIntro">' +
          '<div class="cv-intro-t">这次是哪种情况？</div>' +
          '<div class="cv-opts">' +
            '<button type="button" class="cv-opt" data-cv-entry="incoming">A · 他打来了</button>' +
            '<button type="button" class="cv-opt" data-cv-entry="outgoing">B · 我想打给他</button>' +
          '</div>' +
          '<div class="cv-intro-n">问答只问必要的事实；学习数据全部来自网站现有统计，拿不到就写「暂不可用」。</div>' +
        '</div>' +
        '<div class="cv-body" id="cvBody" style="display:none"></div>' +
      '</div>';
    while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);

    document.getElementById("cvClose").addEventListener("click", close);
    document.getElementById("cvMask").addEventListener("click", close);
    document.getElementById("cvModal").addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-cv-entry],[data-cv-ans],[data-cv-back]") : null;
      if (!t) return;
      if (t.dataset.cvEntry) { startEntry(t.dataset.cvEntry); return; }
      if (t.dataset.cvBack) { backToEntry(); return; }
      if (t.dataset.cvAns) {
        var p = t.dataset.cvAns.split(":");
        STATE.ans[p[0]] = p[1];
        renderPanel();
      }
    });
  }

  function showBody(show) {
    var intro = document.getElementById("cvIntro");
    var body = document.getElementById("cvBody");
    if (intro) intro.style.display = show ? "none" : "";
    if (body) body.style.display = show ? "" : "none";
  }

  function startEntry(entry) {
    STATE.entry = entry;
    STATE.ans = {};
    showBody(true);
    renderPanel();
  }
  function backToEntry() {
    STATE.entry = null;
    STATE.ans = {};
    showBody(false);
  }

  function open(entry) {
    ensureDom();
    var m = document.getElementById("cvModal"), mask = document.getElementById("cvMask");
    backToEntry();
    if (entry) startEntry(entry);
    m.style.display = "block"; mask.style.display = "block";
    document.body.classList.add("cv-open");   // 锁背景滚动（面板内部自己滚）
    requestAnimationFrame(function () { m.classList.add("show"); mask.classList.add("show"); });
  }
  function close() {
    var m = document.getElementById("cvModal"), mask = document.getElementById("cvMask");
    if (!m) return;
    m.classList.remove("show"); mask.classList.remove("show");
    document.body.classList.remove("cv-open");
    setTimeout(function () { m.style.display = "none"; mask.style.display = "none"; }, 220);
  }

  /* ---------- 入口：点管控闪卡 ---------- */
  function init() {
    C = window.APP_CONFIG || {};
    D = window.CALL_DATA || {};
    Store = window.Store;
    RB = window.CALL_RULEBASE;

    var flash = document.getElementById("controlFlash");
    if (flash) {
      /* 闪卡是 call.js 渲染的，这里用事件委托，不重写它的渲染逻辑。
       * ★ 判定永远按「现在几点」算，不按点的是哪张卡——
       *   否则点睡眠卡在下午就会得出荒谬结论。 */
      if (!flash.__cvBound) {
        flash.__cvBound = true;
        flash.addEventListener("click", function (e) {
          var card = e.target.closest ? e.target.closest(".cflash") : null;
          if (!card) return;
          /* 翻页按钮不拦截 */
          if (e.target.closest("[data-flash-nav]")) return;
          open(null);
        });
      }
      /* 入口提示：只在闪卡下方加一行，不动卡片本身 */
      if (!document.getElementById("cvEntryHint")) {
        var hint = document.createElement("div");
        hint.id = "cvEntryHint";
        hint.className = "cv-entry-hint";
        hint.textContent = "点上方任一管控卡 → 规则部裁定（问几个问题，给条例依据）";
        flash.parentNode.insertBefore(hint, flash.nextSibling);
      }
    }
  }

  return {
    init: init, open: open, close: close,
    /* 只读出口，供断言用 */
    _api: {
      judge: judge, phaseNow: phaseNow, phaseAt: phaseAt, callStats: callStats,
      studyStats: studyStats, taskStats: taskStats, slotNow: slotNow, examDays: examDays,
      readChecks: readChecks, oddState: oddState, evenDaysUsed: evenDaysUsed,
      weekMonday: weekMonday, advItemsNow: advItemsNow, nextDeferWindow: nextDeferWindow,
      askHtml: askHtml, panelHtml: panelHtml, levelMeta: levelMeta,
      ref: ref, rulebase: function () { return RB; }
    }
  };
})();

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

  /* ---------- 时段（只读 CALL_DATA.nightStudy，与判定同源） ---------- */
  function phaseNow() {
    var ns = (D && D.nightStudy) || {};
    var m = nowMin();
    var offFrom = toMin(ns.offFrom || "18:30");
    var offTo = toMin(ns.offTo || "23:00");
    var softFrom = toMin(ns.softFrom || "23:00");
    var softTo = toMin(ns.softTo || "23:40");
    var sleepFrom = toMin(ns.sleepFrom || "23:40");
    var sleepTo = toMin(ns.sleepTo || "07:00");

    /* 睡眠段跨午夜（23:40 → 07:00） */
    if (m >= sleepFrom || m < sleepTo) return { key: "sleep", label: "强制睡眠段（23:40–07:00）" };
    if (m >= offFrom && m < offTo) return { key: "core", label: "晚自习核心段（18:30–23:00）" };
    if (m >= softFrom && m < softTo) return { key: "extend", label: "晚自习延展段（23:00–23:40）" };
    return { key: "other", label: "非夜间管控时段" };
  }

  /* ---------- 通话统计（只读 time_records，口径与原判定一致） ---------- */
  function isCallRec(r) {
    return !!r && (r.source === "call_boundary" || r.source === "call_manual");
  }
  function mondayKey() {
    var b = bj();
    var dow = b.getDay();                 // 0=周日
    var diff = (dow + 6) % 7;             // 距本周一
    var d = new Date(b.getFullYear(), b.getMonth(), b.getDate() - diff);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function callStats() {
    var recs = (Store && Store.getTimeRecords) ? (Store.getTimeRecords() || []) : [];
    var today = bizDay();
    var mon = mondayKey();
    var todaySec = 0, weekSec = 0, weekCount = 0;
    var seenDay = {};
    recs.forEach(function (r) {
      if (!isCallRec(r)) return;
      var sec = Number(r.duration_sec) || 0;
      var dk = bizDay(r.started_at || r.ended_at);
      if (dk === today) todaySec += sec;
      if (dk >= mon && dk <= today) {
        weekSec += sec;
        if (!seenDay[dk]) { seenDay[dk] = 1; weekCount++; }
      }
    });
    var cap = (D && D.weeklyRule) || {};
    return {
      todayMin: todaySec / 60,
      weekMin: weekSec / 60,
      weekDays: weekCount,
      dayCap: Number(cap.maxMinPerDay) || 40,
      weekCap: Number(cap.maxMinPerWeek) || 120
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
    function forbid(first) { v.level = "forbid"; return first; }

    /* ── 1. 核心段：硬禁，立即结束，不问 ── */
    if (ph.key === "core") {
      v.level = "forbid";
      v.title = "本次不予通过";
      addRule("⑫"); addRule("⑩"); addRule("⑮");
      v.facts.push("当前处于晚自习核心段 18:30–23:00，按 ⑫ 不接受任何理由的接打电话，也不接受垃圾时间调剂。");
      var sl0 = slotNow();
      if (sl0) v.facts.push("原定安排：" + sl0.name + "（至 " + sl0.end + "），还剩 " + fmtMin(sl0.remainMin) + "。");
      var st0 = studyStats();
      if (st0.ok) v.costs.push({ label: "今日学习", value: Math.round(st0.studyMin) + " / " + Math.round(st0.goalMin) + " 分钟（" + st0.pct + "%）", note: "仅作参考，不构成处罚" });
      v.action = "继续原定学习安排；来电直接拒接或只回文字，不必解释。";
      return v;
    }

    /* ── 2. 睡眠段：硬禁，立即结束 ── */
    if (ph.key === "sleep") {
      v.level = "forbid";
      v.title = "本次不予通过";
      addRule("⑦"); addRule("⑫"); addRule("⑧");
      v.facts.push("当前处于强制睡眠段 23:40–07:00（含准备睡觉时间），按 ⑦ / ⑫ 不得通话。");
      v.facts.push("已在通话中的须在 23:45 前结束；未安排睡觉的同样适用。");
      v.notes.push("此时的「置后」不等于「稍后再接」——只能改约次日 07:00 之后，或改用文字解决。");
      var ex = examDays();
      v.costs.push({ label: "现在该做的", value: "休息", note: ex != null ? "距考研还有 " + ex + " 天" : "" });
      v.action = "休息，必要事项改到明天处理；回复建议文字解释，或不解释。";
      return v;
    }

    /* ── 3. 延展段：先问「后面还有没有任务」（置后定则） ── */
    if (ph.key === "extend") {
      if (!ans || !ans.defer) { v.level = "ask"; v.ask = "defer"; return v; }
      if (ans.defer === "yes") {
        v.level = "forbid";
        v.title = "本次不予通过";
        addRule("①"); addRule("⑫");
        v.facts.push("你确认后续仍有学习任务或正经事情，接听会打乱原定学习安排。");
        v.facts.push("置后定则：娱乐类事件（含通话）要放到后面不再安排正经事的时段——后面还排着学习，就不算置后到位。");
        var sl1 = slotNow();
        var tk1 = taskStats();
        if (sl1) v.costs.push({ label: "当前时段", value: sl1.name + "（至 " + sl1.end + "）", note: "本段还剩 " + fmtMin(sl1.remainMin) });
        if (tk1.ok && tk1.count) v.costs.push({ label: "未完成任务", value: tk1.count + " 项", note: tk1.pending.join("、") });
        var st1 = studyStats();
        if (st1.ok) v.costs.push({ label: "今日学习", value: Math.round(st1.studyMin) + " / " + Math.round(st1.goalMin) + " 分钟（" + st1.pct + "%）", note: "还差 " + Math.round(st1.remainMin) + " 分钟到目标" });
        supplementsByTag("effect").forEach(function (s) {
          v.notes.push(s.tag + "：" + s.summary);
        });
        v.action = "继续原定任务；本次不接听，也不主动拨打。若要回，改约明天白天或改用文字。";
        return v;
      }
      if (ans.defer === "unsure") {
        v.level = "hold";
        v.title = "暂不通话，先核实";
        addRule("①");
        v.facts.push("你还不确定后面是否还有任务。在核实之前，先不要接通。");
        v.action = "先确认今晚剩下的安排（任务清单 / 时间表），确认「后面没有正经事」再回来重新判定。";
        return v;
      }
      /* defer === "no" → 继续核验垃圾时间 */
      if (!ans.garbage) { v.level = "ask"; v.ask = "garbage"; return v; }
      if (ans.garbage !== "yes") {
        v.level = "hold";
        v.title = "暂不通话，先核实";
        addRule("⑫"); addRule("②");
        v.facts.push(ans.garbage === "no"
          ? "你判断现在不属于垃圾时间。延展段仍是晚自习，只有垃圾时间才可接听。"
          : "垃圾时间资格尚未确认。未确认时按不可接处理。");
        v.action = "先把当前事情做完；确实确认是垃圾时间后，再回来重新判定。";
        return v;
      }
      /* 垃圾时间 + 后续无任务 → 继续查额度与次数 */
      return finish(v, entry, cs);
    }

    /* ── 4. 非夜间时段：白天 → 主动拨打要问必要性；来电问垃圾时间 ── */
    if (entry === "outgoing") {
      if (!ans || !ans.necessity) { v.level = "ask"; v.ask = "necessity"; return v; }
      if (ans.necessity === "chat") {
        v.level = "hold";
        v.title = "建议不主动拨打";
        addRule("⑰"); addRule("⑲"); addRule("⑮");
        v.facts.push("你确认这次只是想聊天，没有明确需要沟通的事情。");
        v.facts.push("关系边界目标：电话每周最多 2 次，减少无关陪伴和无意义社交。");
        v.action = "不主动拨打；确有内容可用简短文字，把话题留到以后。";
        return v;
      }
    } else {
      if (!ans || !ans.garbage) { v.level = "ask"; v.ask = "garbage"; return v; }
      if (ans.garbage !== "yes") {
        v.level = "hold";
        v.title = "暂不通话，先核实";
        addRule("②");
        v.facts.push(ans.garbage === "no" ? "你判断现在不属于垃圾时间，或正处在正经时间里。" : "垃圾时间资格尚未确认。");
        v.action = "先确认当前是否确属垃圾时间，未确认前暂不接听。";
        return v;
      }
    }
    return finish(v, entry, cs);
  }

  /* 收尾核验：额度 / 次数 / 缺口 */
  function finish(v, entry, cs) {
    /* 额度：原有硬闸，只读展示 */
    if (cs.todayMin >= cs.dayCap) {
      v.level = "forbid"; v.title = "本次不予通过";
      v.rules.push({ no: "规则部 · 周频率规则", title: "单日 ≤ 40 分钟", quote: "每日接通总时长不超过 40 分钟（原判定同口径）。" });
      v.facts.push("今日已通 " + Math.round(cs.todayMin) + " 分钟，已达单日上限 " + cs.dayCap + " 分钟。");
      v.action = "今天不再接通；明天再聊。";
      return v;
    }
    if (cs.weekMin >= cs.weekCap) {
      v.level = "forbid"; v.title = "本次不予通过";
      v.rules.push({ no: "规则部 · 周频率规则", title: "每周 ≤ 120 分钟", quote: "每周接通总时长不超过 120 分钟（原判定同口径）。" });
      v.facts.push("本周已通 " + Math.round(cs.weekMin) + " 分钟，已达周上限 " + cs.weekCap + " 分钟。");
      v.action = "本周额度已用尽；确有需要只能走原有的「周额度豁免」流程。";
      return v;
    }

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
      label: "本周通话次数", value: cs.weekDays + " 天",
      note: "目标 ≤ 2 次/周 · 按自控执行，系统不会拦截第 3 通"
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
    return v;
  }

  /* =====================================================================
   *  渲染
   * ===================================================================== */
  var STATE = { entry: null, ans: {}, step: null };

  function levelMeta(lv) {
    if (lv === "forbid") return { text: "不予通过", cls: "is-forbid" };
    if (lv === "hold") return { text: "暂不通话 · 先核实", cls: "is-hold" };
    if (lv === "ask") return { text: "待核验", cls: "is-ask" };
    return { text: "可以考虑", cls: "is-ok" };
  }

  function askHtml(ask) {
    if (ask === "defer") {
      return {
        q: "之后是否还有其他学习内容或正经任务？",
        sub: "如果现在接听，后面的原定学习计划可能就会被打乱。请如实判断。",
        opts: [
          { k: "yes", t: "有，后面还有任务" },
          { k: "no", t: "没有，后续任务已完成" },
          { k: "unsure", t: "不确定，需要核实" }
        ]
      };
    }
    if (ask === "garbage") {
      return {
        q: "现在属于「垃圾时间」吗？",
        sub: "垃圾时间 = 做完该做的事之后、不影响进度的零碎时间。",
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

  function renderPanel() {
    var box = document.getElementById("cvBody");
    if (!box) return;
    var ph = phaseNow();
    var v = judge(STATE.entry, STATE.ans);

    /* 问句态 */
    if (v.level === "ask") {
      var a = askHtml(v.ask);
      box.innerHTML =
        '<div class="cv-phase">' + esc(ph.label) + '</div>' +
        '<div class="cv-q">' + esc(a.q) + '</div>' +
        '<div class="cv-qsub">' + esc(a.sub) + '</div>' +
        '<div class="cv-opts">' + a.opts.map(function (o) {
          return '<button type="button" class="cv-opt" data-cv-ans="' + v.ask + ':' + o.k + '">' + esc(o.t) + '</button>';
        }).join("") + '</div>' +
        '<button type="button" class="cv-back" data-cv-back="1">← 换个入口</button>';
      return;
    }

    /* 裁定态 */
    var lm = levelMeta(v.level);
    var h = '';
    h += '<div class="cv-verdict ' + lm.cls + '">' +
      '<div class="cv-v-head"><span class="cv-v-title">规则部裁定</span>' +
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

    box.innerHTML = h;
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
    _api: { judge: judge, phaseNow: phaseNow, callStats: callStats, studyStats: studyStats,
            taskStats: taskStats, slotNow: slotNow, examDays: examDays, ref: ref, rulebase: function () { return RB; } }
  };
})();

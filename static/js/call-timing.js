/* =====================================================================
 *  call-timing.js —— 他通常在什么时候打来（通话到达时间分析 · v1.80.0）
 *
 *  ── 需求（用户 2026.10.20 原话）───────────────────────────────────
 *  「对方什么时候打电话来，可以根据过去的相关补录记录和计时器记录来判断对方
 *    打电话来的时间，你可以进行一些测试、模拟测试。对于针对高峰的情况和
 *    高峰时间点进行对应的攻略。」
 *
 *  ── 它做什么 ──────────────────────────────────────────────────
 *  只读 time_records 里 source = call_boundary（双闹钟真实计时）/ call_manual（补录）
 *  两类记录，统计「通话**开始**时刻」的分布，最后给出：高峰时段 + 该时段的攻略。
 *
 *  ── 它绝不做什么（改这个文件前重读一遍）────────────────────────────
 *  ① 不写任何记录、不改计时器、不改额度、不碰豁免。
 *  ② 不编造数据：样本不足就明说「数据不足」，绝不用 0 或平均值糊过去。
 *  ③ 不用「通话开始时刻」冒充「对方拨打时刻」——补录时人可能已经聊了一会儿才想起来记，
 *     所以补录占比高时必须降级置信度并在界面上写清楚。
 *  ④ 攻略的口径全部来自 CALL_DATA.nightStudy（与判定同源），不在这里另写一套时间。
 *
 *  依赖：config.js / blocks.js / store.js / call-data.js（均只读）
 * ===================================================================== */
window.CallTiming = (function () {
  "use strict";

  var C = null, D = null, Store = null;
  var WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

  /* 惰性取依赖：analyze() 可能在被别的模块直接调用时先于 init() 执行，
   * 拿不到 D 就会把每一通都判成「非夜间管控」——那种错很安静，必须在源头堵死。 */
  function ensure() {
    if (!C) C = window.APP_CONFIG || {};
    if (!D) D = window.CALL_DATA || {};
    if (!Store) Store = window.Store;
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function bj(d) {
    return (window.Blocks && window.Blocks.beijing) ? window.Blocks.beijing(d || new Date()) : new Date();
  }
  function toMin(t) {
    var p = String(t).split(":");
    return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
  }
  /* ★ v1.101.0 业务日（04:00 换天）：与主站 Blocks.bizDateStr 同源，不另写一套 */
  function bizKeyOf(ts) {
    var B = window.Blocks;
    if (B && typeof B.bizDateStr === "function") return B.bizDateStr(ts);
    var b = bj(new Date(ts));
    if (b.getHours() < 4) b.setDate(b.getDate() - 1);
    return b.getFullYear() + "-" + pad(b.getMonth() + 1) + "-" + pad(b.getDate());
  }
  function hhmm(min) { return pad(Math.floor(min / 60) % 24) + ":" + pad(min % 60); }
  function isCallRec(r) {
    return !!r && (r.source === "call_boundary" || r.source === "call_manual");
  }
  function fmtMin(min) {
    min = Math.round(min);
    if (min < 60) return min + " 分钟";
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + " 小时 " + m + " 分" : h + " 小时";
  }

  /* ---------- 时段归类（与 call.js 的睡眠/核心/延展三段同源） ---------- */
  function phaseOf(min) {
    ensure();
    var ns = (D && D.nightStudy) || {};
    min = ((Number(min) || 0) % 1440 + 1440) % 1440;
    function hit(from, to) {
      if (!from || !to) return false;
      var a = toMin(from), b = toMin(to);
      return a <= b ? (min >= a && min < b) : (min >= a || min < b);
    }
    if (hit(ns.sleepFrom, ns.sleepTo)) return "sleep";
    if (hit(ns.offFrom, ns.offTo)) return "core";
    if (hit(ns.softFrom, ns.softTo)) return "extend";
    return "free";
  }
  var WIN_NAME = { sleep: "睡眠段（硬禁）", core: "核心段（硬禁）", extend: "延展段（可调剂）", free: "非夜间管控" };

  /* ---------- 统计 ---------- */
  function analyze(records) {
    ensure();
    var out = {
      ok: false, n: 0, totalMin: 0,
      bins: [], weekday: [], windows: {}, peaks: [],
      src: { timer: 0, manual: 0 }, manualPct: 0,
      hardMin: 0, hardPct: 0,
      firstDay: "", lastDay: "", spanDays: 0,
      confidence: { level: "低", note: "" }
    };
    var list = (records || []).filter(function (r) {
      return isCallRec(r) && r.started_at;
    });
    out.n = list.length;
    if (!list.length) {
      out.confidence = { level: "低", note: "还没有任何通话记录，等有 3 通以上再看这张表才有意义。" };
      return out;
    }

    var bins = [];
    for (var h = 0; h < 24; h++) bins.push({ h: h, count: 0, min: 0 });
    var wd = [];
    for (var w = 0; w < 7; w++) wd.push({ d: w, name: WD[w], count: 0, min: 0 });
    var wins = { sleep: { n: 0, min: 0 }, core: { n: 0, min: 0 }, extend: { n: 0, min: 0 }, free: { n: 0, min: 0 } };
    var days = {}, totalSec = 0;

    list.forEach(function (r) {
      var b = bj(new Date(r.started_at));
      var m = b.getHours() * 60 + b.getMinutes();
      var sec = Number(r.duration_sec) || 0;
      var min = sec / 60;
      totalSec += sec;
      bins[b.getHours()].count += 1;
      bins[b.getHours()].min += min;
      var dow = (b.getDay() + 6) % 7;                  // 0 = 周一
      wd[dow].count += 1; wd[dow].min += min;
      var pk = phaseOf(m);
      wins[pk].n += 1; wins[pk].min += min;
      if (pk === "sleep" || pk === "core") out.hardMin += min;
      /* ★ v1.101.0：「覆盖多少个日子」同改业务日（04:00 换天）——
       *   凌晨 0–4 点打的电话算在前一天，跟通话账本、周额度是同一把尺。 */
      days[bizKeyOf(r.started_at)] = 1;
      if (r.source === "call_manual") out.src.manual += 1; else out.src.timer += 1;
    });

    var dayKeys = Object.keys(days).sort();
    out.bins = bins;
    out.weekday = wd;
    out.windows = wins;
    out.totalMin = totalSec / 60;
    out.hardPct = out.totalMin ? Math.round(out.hardMin / out.totalMin * 100) : 0;
    out.manualPct = out.n ? Math.round(out.src.manual / out.n * 100) : 0;
    out.firstDay = dayKeys[0] || "";
    out.lastDay = dayKeys[dayKeys.length - 1] || "";
    out.spanDays = dayKeys.length;
    out.peaks = findPeaks(bins);
    out.ok = true;
    out.confidence = confOf(out);
    return out;
  }

  /* 高峰检测：
   *   · 先把「次数 ≥ 门槛」的小时标为热，再**环形**合并相邻热小时（23→0→1 算一段）；
   *   · 门槛 = max(2, ceil(最大小时次数 / 3))——「达到最高频次的 1/3」就算热，
   *     这样主高峰之外还能捞出一两个次热档；只有出现过 2 次以上才配叫高峰（1 次叫偶发）；
   *   · 按**分钟数**排序取前三（次数相同看谁的时长更重）。 */
  function findPeaks(bins) {
    var maxCount = 0;
    bins.forEach(function (b) { if (b.count > maxCount) maxCount = b.count; });
    if (maxCount < 2) return [];
    var cut = Math.max(2, Math.ceil(maxCount / 3));
    var hot = bins.map(function (b) { return b.count >= cut; });
    if (hot.every(function (x) { return x; })) hot = hot.map(function () { return false; });  // 全热 = 无显著高峰

    /* 环形合并的正确姿势：先找「run 起点」= 自己热、但前一个小时不热。
     * ⚠️ 不能从 0 点开始顺着走——23→0 是相邻的，从 0 起走会把这一圈切成两段，
     *    「22:00–02:00」就会被拆成「00:00–02:00」和「22:00–24:00」两个假高峰。 */
    var groups = [];
    var starts = [];
    for (var s = 0; s < 24; s++) {
      if (hot[s] && !hot[(s + 23) % 24]) starts.push(s);
    }
    if (!starts.length && hot.some(function (x) { return x; })) starts = [0];   // 24 小时全热
    starts.forEach(function (st) {
      var end = st, cur = st, len = 1;
      while (len < 24 && hot[(cur + 1) % 24]) { cur = (cur + 1) % 24; end = cur; len++; }
      groups.push({ from: st, to: end });
    });

    var res = groups.map(function (g) {
      var count = 0, min = 0, i = g.from;
      var guard = 0;
      while (true) {
        count += bins[i].count; min += bins[i].min;
        if (i === g.to || guard++ > 24) break;
        i = (i + 1) % 24;
      }
      var fromMin = g.from * 60, toMin_ = (g.to + 1) * 60;
      /* 窗口归类：取这段里分钟数最多的那种时段 */
      var wsum = { sleep: 0, core: 0, extend: 0, free: 0 };
      var j = g.from;
      var guard2 = 0;
      while (true) {
        wsum[phaseOf(j * 60)] += bins[j].min;
        if (j === g.to || guard2++ > 24) break;
        j = (j + 1) % 24;
      }
      var win = "free", best = -1;
      ["sleep", "core", "extend", "free"].forEach(function (k) {
        if (wsum[k] > best) { best = wsum[k]; win = k; }
      });
      return {
        from: g.from, to: g.to, fromMin: fromMin, toMin: toMin_,
        label: hhmm(fromMin) + "–" + (g.to === 23 ? "24:00" : hhmm(toMin_)),
        count: count, min: min, win: win, winName: WIN_NAME[win]
      };
    }).filter(function (p) { return p.count > 0; });

    res.sort(function (a, b) { return (b.min - a.min) || (b.count - a.count); });
    return res.slice(0, 3);
  }

  function confOf(a) {
    var lv = a.n >= 20 ? "高" : (a.n >= 8 ? "中" : "低");
    var notes = [];
    if (a.manualPct >= 60) {
      notes.push("其中 " + a.manualPct + "% 是补录（事后凭记忆补的），时间点只能算到「那阵子」，不是精确到分钟。");
      lv = (lv === "高") ? "中" : "低";
    }
    if (a.spanDays < 14) notes.push("只覆盖 " + a.spanDays + " 个不同日期，样本偏薄，多看两周再下结论。");
    if (a.n >= 20 && !notes.length) notes.push("样本量够，可以直接按下面的时段布防。");
    return { level: lv, note: notes.join(" ") };
  }

  /* ---------- 攻略：按高峰所属时段出对应打法 ---------- */
  function adviceFor(peak, a) {
    ensure();
    var ns = (D && D.nightStudy) || {};
    var sleepTxt = (ns.sleepFrom || "00:00") + "–" + (ns.sleepTo || "07:00");   // ★ v1.94.0 兜底随配置改 00:00
    var coreTxt = (ns.offFrom || "18:30") + "–" + (ns.offTo || "23:00");
    if (peak.win === "sleep") {
      return {
        head: "硬禁 · 不需要任何解释",
        body: "这一段（" + sleepTxt + "）是强制睡眠段，豁免也覆盖不了。他到点打来，不要接、也不要在那次通话里解释——" +
          "接起来就变成了「已经在聊」，后面还得再找一次机会挂断。",
        acts: ["睡前把手机调静音 / 勿扰，别放在枕边", "第二天早上再统一回一条文字", "对外口径只说「要睡了」，不说「还有安排」"],
        scene: "lateStudy", sceneWhy: "对外一律说「要睡了」"
      };
    }
    if (peak.win === "core") {
      return {
        head: "硬禁 · 拒接 + 一句文字",
        body: "这一段（" + coreTxt + "）是晚自习核心时间，不接受任何理由接听。高峰落在这里，说明他的作息和你完全错位——" +
          "这不是偶发，是常态，所以值得设成固定动作，而不是每次都临场决定。",
        acts: ["静音别管它，学完再看", "下自习后回一条固定文字（不用解释在学什么）", "不要约「明天几点」——给模糊的「明天再说」"],
        scene: "notNextDay", sceneWhy: "只说此刻不行，不约明天"
      };
    }
    if (peak.win === "extend") {
      return {
        head: "可调剂 · 只有确认是垃圾时间才接",
        body: "这一段（延展段）仍是晚自习，只有你确认此刻确属垃圾时间才可以接。高峰落在这里，意味着" +
          "「差一点点就能接」——最容易破防的一段，所以要么明确不接，要么明确就接 10 分钟并开双闹钟。",
        acts: ["先问自己一句：现在真的是垃圾时间吗", "接就开双闹钟，到点 3 分钟内挂断", "不接就回一句「现在不行」"],
        scene: "notNextDay", sceneWhy: "先按「现在不行」回"
      };
    }
    return {
      head: "非管控时段 · 可接，但要开双闹钟",
      body: "这一段不在夜间管控里，是你真正能接的时段。高峰落在这里是好消息：说明大部分来电本来就撞不上硬禁。" +
        "但能接 ≠ 随便聊，日闸 40 / 周 120 分钟照样管着。",
      acts: ["接之前开双闹钟（到点 3 分钟内挂断）", "接通先说清只能聊几分钟", "留意当天的日闸余量"],
      scene: "winOpen", sceneWhy: "先开口把时长框住"
    };
  }

  /* ---------- 渲染 ---------- */
  function barsHtml(a) {
    var maxC = 1;
    a.bins.forEach(function (b) { if (b.count > maxC) maxC = b.count; });
    var hot = {};
    a.peaks.forEach(function (p) {
      var i = p.from, guard = 0;
      while (true) { hot[i] = 1; if (i === p.to || guard++ > 24) break; i = (i + 1) % 24; }
    });
    var cells = a.bins.map(function (b) {
      var pk = phaseOf(b.h * 60);
      var cls = "ct-bar is-" + pk + (hot[b.h] ? " is-hot" : "");
      var pct = b.count ? Math.max(8, Math.round(b.count / maxC * 100)) : 0;
      var title = pad(b.h) + ":00–" + pad(b.h) + ":59  " + b.count + " 通 · " + Math.round(b.min) + " 分钟";
      return '<div class="' + cls + '" title="' + esc(title) + '">' +
        '<i style="height:' + pct + '%"></i>' +
        '<span>' + (b.h % 3 === 0 ? b.h : "") + '</span>' +
        '</div>';
    }).join("");
    return '<div class="ct-chart">' + cells + '</div>' +
      '<div class="ct-legend">' +
        '<span class="lg is-sleep"></span>睡眠段硬禁' +
        '<span class="lg is-core"></span>核心段硬禁' +
        '<span class="lg is-extend"></span>延展段可调剂' +
        '<span class="lg is-free"></span>非管控' +
        '<span class="lg-rt">柱高 = 通话次数 · 亮边 = 高峰</span>' +
      '</div>';
  }

  function peaksHtml(a) {
    if (!a.peaks.length) {
      return '<div class="ct-empty">样本里没有出现「同一个小时重复 2 次以上」的情况，' +
        '还看不出高峰。再多记几次通话，这张表才会说话。</div>';
    }
    return a.peaks.map(function (p, i) {
      var ad = adviceFor(p, a);
      var pct = a.totalMin ? Math.round(p.min / a.totalMin * 100) : 0;
      return '<div class="ct-peak is-' + esc(p.win) + '">' +
        '<div class="ct-pk-head">' +
          '<span class="ct-pk-rank">高峰 ' + (i + 1) + '</span>' +
          '<span class="ct-pk-time">' + esc(p.label) + '</span>' +
          '<span class="ct-pk-num">' + p.count + ' 通 · ' + Math.round(p.min) + ' 分钟（时长 ' + pct + '%）</span>' +
        '</div>' +
        '<div class="ct-pk-win">' + esc(p.winName) + ' · ' + esc(ad.head) + '</div>' +
        '<div class="ct-pk-body">' + esc(ad.body) + '</div>' +
        '<ul class="ct-pk-acts">' + ad.acts.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul>' +
        '<button type="button" class="ct-pk-btn" data-ct-scene="' + esc(ad.scene) + '">' +
          '去挑一句 · ' + esc(ad.sceneWhy) + '</button>' +
        '</div>';
    }).join("");
  }

  function cardHtml(a) {
    if (!a.ok) {
      return '<h2><span class="hico" data-icon="clock"></span>他通常在什么时候打来</h2>' +
        '<div class="ct-empty">' + esc(a.confidence.note) + '</div>';
    }
    var over = a.hardPct;
    var overTxt = over >= 60
      ? '有 <b>' + over + '%</b> 的通话时长落在<b>硬禁时段</b>——他的作息和你几乎不重叠，「不接」才应该是默认动作。'
      : (over >= 30
        ? '有 <b>' + over + '%</b> 的通话时长落在<b>硬禁时段</b>——不算极端，但已经值得设固定动作。'
        : '硬禁时段只占 <b>' + over + '%</b> 的通话时长——大部分来电本身是可接的。');
    return '<h2><span class="hico" data-icon="clock"></span>他通常在什么时候打来</h2>' +
      '<div class="ct-sub">只看通话<b>开始</b>时刻，数据来自你自己的记录（计时器 + 补录），不联网、不估算。</div>' +
      '<div class="ct-kpis">' +
        '<div class="ct-kpi"><b>' + a.n + '</b><span>通</span></div>' +
        '<div class="ct-kpi"><b>' + Math.round(a.totalMin) + '</b><span>分钟</span></div>' +
        '<div class="ct-kpi"><b>' + a.src.timer + '</b><span>计时器</span></div>' +
        '<div class="ct-kpi"><b>' + a.src.manual + '</b><span>补录</span></div>' +
        '<div class="ct-kpi"><b>' + a.spanDays + '</b><span>个日子</span></div>' +
      '</div>' +
      barsHtml(a) +
      '<div class="ct-over">' + overTxt + '</div>' +
      '<div class="ct-sec-t">高峰与对应打法</div>' +
      peaksHtml(a) +
      '<div class="ct-conf">置信度：<b>' + esc(a.confidence.level) + '</b>' +
        '（' + esc(a.firstDay || "—") + ' → ' + esc(a.lastDay || "—") + '，共 ' + a.n + ' 通）' +
        (a.confidence.note ? '<br>' + esc(a.confidence.note) : "") +
      '</div>';
  }

  /* ---------- 入口 ---------- */
  function render() {
    ensure();
    var box = document.getElementById("callTimingCard");
    if (!box) return null;
    var records = (Store && Store.getTimeRecords) ? (Store.getTimeRecords() || []) : [];
    var a = analyze(records);
    box.innerHTML = cardHtml(a);
    if (window.Icon) window.Icon.inject(box);
    bindButtons(box);
    return a;
  }

  function bindButtons(box) {
    box.querySelectorAll("[data-ct-scene]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.ctScene;
        if (window.CallVerdict && window.CallVerdict.openScene) window.CallVerdict.openScene(key);
      });
    });
  }

  function init() {
    C = window.APP_CONFIG || {};
    D = window.CALL_DATA || {};
    Store = window.Store;
    render();
  }

  return {
    init: init, render: render,
    _api: {
      analyze: analyze, findPeaks: findPeaks, phaseOf: phaseOf, adviceFor: adviceFor,
      cardHtml: cardHtml, confOf: confOf, fmtMin: fmtMin
    }
  };
})();

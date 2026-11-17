/* task-picker.js —— 通用「选择关联任务」弹窗（v1.44.0 → v1.140.0）
 * ------------------------------------------------------------------
 * 为什么要抽出来：
 *   原先只有 timer.html 里写死了一个 #taskLinkModal，逻辑长在 timer.js
 *   （renderTaskLinkList / openTaskLinkPicker / applyTaskLink）。于是——
 *   ① 别的页面（首页列表、每日复盘）想改关联，拿不到这个弹窗；
 *   ② 编辑抽屉 rec-edit.js 根本没有「关联任务」这一行（用户 2026-10-12 报的）；
 *   ③ 两处各写一份 = 迟早长得不一样。
 *   现在：本模块自建 DOM，**任何页面引入即可用**，计时器与编辑抽屉共用同一份
 *   候选与分组逻辑（用户原话「该功能请与计时器相关功能同步」）。
 *
 * 相比旧版的三处改进（都是用户提的）：
 *   ① **分类**：旧版是「未完成任务按创建时间倒序取 50 条」一锅平铺 → 杂乱。
 *      现按 subject（西医综合 / 英语 / 政治 / 其他）分组，组内按日期排。
 *   ② **可选内容变多**：旧版把已完成任务一律过滤掉（「感觉可选的内容不是很多」）。
 *      现给「显示已完成」开关，默认关、选择后记住。
 *   ③ **能搜**：标题 / DAY 标记 / 备注 模糊匹配，条数多时靠搜不靠翻。
 *
 * ★ v1.119.0（用户 2026-11-10：「对单词突围每日任务的关联便携性不够」）
 *   实测云端 477 条任务 / 448 条未完成，截图里满屏「生理学滚动复习 DAY1~9」，
 *   单词突围 17 条一个都看不到。四个叠加的根因：
 *     ① 排序键错：任务 date 存的是 `toDateString()`（"Tue Nov 10 2026"），
 *        旧代码 `String(da).localeCompare(String(db))` 按**字符串**比 → 按星期首字母
 *        乱排；且 87 条无 date 的滚动复习用 "9999-99-99" 反而冲到最前面。
 *     ② 截断位置错：`list.slice(0, MAX_ITEMS)` 在**分组之前**，448 条只留 300 条，
 *        17 条单词任务只剩 9 条，今天的 DAY 42 恰好被截掉。现改为**每组**限额。
 *     ③ 日期显示错：`metaText` 用 `date.slice(5)`（按 "2026-11-10" 写的），
 *        实际输出 "ov 10 2026"，所以列表副标题只剩光秃秃的 "DAY 1"。
 *     ④ 排序位置错：431 条西医综合排在英语组前面，单词任务要滚很久。
 *   对策：把「英语单词突围」抽成**独立置顶分组**（组内按真实日期升序，17 条全在），
 *   顶部加「一键关联今天/下一项」快捷条 + 筛选 chip，标题精简为 `DAY 42 · 新词 300 词`
 *   并附一行真实范围小字。
 *   ⚠️ 范围小字只从任务 note / 标题里读（timer.html / index.html / stats.html
 *      **没有**引入 word-plan.js，不能依赖 window.WORD_PLAN）；note 为空就留空，
 *      绝不编造范围（与 v1.118.0 vocabRangeHint 同一条自律）。
 *   ⚠️「今天」口径跟 tasks.js `vocabTodayIdx` 保持一致：`new Date().toDateString()`
 *      （自然日），不套学习日 04:00——否则凌晨 0~4 点单词卡指向昨天的 DAY，
 *      快捷条却指向今天，同一页面出现两把尺子。快捷条一律标出具体日期，
 *      即使口径有边界也不会误导。
 *
 * ⚠️ 只负责「选」，不负责「存」：onPick(taskId) 回调交给调用方落盘。
 *    计时器侧要写 active_timer.task_id；记录侧要写 time_records.task_id，
 *    且必须走 Store.updateTimeRecord（它内部会重算**新旧两个**任务的累计专注）。
 *
 * ★ v1.140.0（用户 2026-11-18）：手机上「底部外科冲刺那块滑不动」+ 机制系统优化
 *   ① 滑不动的真因在 CSS 不在 JS：.tp-list 是 flex item，默认 min-height:auto，
 *      被 300 条内容撑到全高 → 它自己不溢出、modal 也不滚动 → 整块溢出到弹窗外面。
 *      已改为 modal 裁切 + list flex:1/min-height:0 + 触摸惯性（见 theme.css）。
 *      ⚠️ 别用「给 modal 加 overflow:auto」糊过去：那样头部搜索框会跟着滚走。
 *   ② 外科冲刺成了近期主任务（一天 4~6 节 × 7 天 = 28 条），平铺一坨要翻很久：
 *      组内**按冲刺日分小节**（DAY1/7 · 4 节 · 已完成 4），小节内未完成在前。
 *      小节标题的天键取标题里的 `DAY1/7`（config 里的 sprintIndex 会随改期整体移位，
 *      但标题是渲染时按 plan 重算的、和卡片完全同源，比 day_label 的 D134-1 好读）。
 *   ③ 快捷条升级成两张卡：🩺 外科（近期主任务，排第一）+ 📕 单词（v1.119.0 原逻辑一字未改）。
 *      外科优先给「今天没听完的那一节」，没有今天就给「最早没听完的那一节」。
 *   ④ 已完成一律沉底（byDate 里加 done 比较）：一旦勾了「显示已完成」，
 *      11-15 那批早听完的节原本全堆在最上面，今天要用的反而要往下翻。
 *   ⑤ 手机不自动聚焦搜索框（软键盘一弹就把列表挤没了，看着就像"滑不动"）。
 * ------------------------------------------------------------------ */
window.TaskPicker = (function () {
  "use strict";

  var SUBJECT_LABEL = { xizong: "西医综合", english: "英语", politics: "政治", other: "其他" };
  var SUBJECT_ORDER = ["xizong", "english", "politics", "other"];
  var WORD_KEY = "word";                                   // ★ v1.119.0 独立分组键
  var WORD_GROUP_LABEL = "📕 英语单词突围 · 每日任务";
  /* ★ v1.133.0：外科冲刺改成「一节课一条任务」后，一天就有 4 条候选，
   *   再混进「西医综合」组会和听力/真题等任务搅在一起 —— 单列一组、置顶在单词之后。 */
  var SURGERY_KEY = "surgery";
  var SURGERY_GROUP_LABEL = "🩺 外科学冲刺 · 每节一条";
  /* ★ v1.140.0：外科冲刺升为近期主任务 → 排到单词之前（单词仍稳在西医综合之前，
   *   这是 v1.119.0 的硬要求：17 条单词任务不能被 431 条西综挤到看不见的地方）。 */
  var GROUP_ORDER = [SURGERY_KEY, WORD_KEY].concat(SUBJECT_ORDER);
  var SHOW_DONE_KEY = "kaoyan:taskpicker_show_done";
  var MAX_ITEMS = 300;          // ★ v1.119.0：语义改为「每组」上限，不再分组前整体截断
  /* 与 tasks.js isWordTask 同口径：云端历史上把 source/day_label/note 整列置过 null，
   * 只认 source 会漏；标题是唯一从未丢失的字段，必须双认。 */
  var WORD_TITLE_RE = /每日单词任务|^背单词\s*[·:：]/;
  var SURGERY_TITLE_RE = /^【外科冲刺】/;
  /* 退役行：旧 DAY 级历史行（v1.133.0 粒度改「节」后降级的）与 v1.129.0 的配套行。
   * 它们留着是为了不断掉历史记录的 task_id，但绝不该出现在「选任务关联」里。 */
  var DEAD_SURGERY_RE = /^【外科冲刺·历史】|^【外科配套】/;
  /* ★ v1.140.0 外科冲刺的「天」键：标题形如
   *   【外科冲刺】DAY1/7 · 7.12 第2节 腹部损伤 → 天键 "DAY1/7"，候选里只留课程名。
   *   为什么不用 day_label（外科冲刺 D134-1）：用户认的是"第几个冲刺日"，
   *   D134 是原表 DAY 号，28 条里根本分不清先后。 */
  var SURGERY_DAY_RE = /^【外科冲刺】\s*(DAY\d+\/\d+)/;
  var SURGERY_PREFIX_RE = /^【外科冲刺】\s*/;
  var SURGERY_DAY_HEAD_RE = /^DAY\d+\/\d+\s*·\s*/;

  var cb = null;                // 当前回调
  var curId = null;             // 当前已关联的任务 id
  var kw = "";                  // 搜索词
  var showDone = false;
  var quickFilter = "all";      // all | word | today（★ v1.119.0，每次 open 重置）

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function readShowDone() {
    try { return localStorage.getItem(SHOW_DONE_KEY) === "1"; } catch (e) { return false; }
  }
  function writeShowDone(v) {
    try { localStorage.setItem(SHOW_DONE_KEY, v ? "1" : "0"); } catch (e) { }
  }
  function q(id) { return document.getElementById(id); }
  function allTasks() {
    return (window.Store && window.Store.getTasks ? window.Store.getTasks() : []) || [];
  }

  /* ---------- ★ v1.119.0 日期 / 单词任务的公共判据 ---------- */
  /* date 可能是 "Tue Nov 10 2026"（tasks 表全量都是这个）或 "2026-11-10"。
   * 后者按 UTC 解析会偏一天，故显式用本地构造。无日期 → Infinity（沉底）。 */
  function dateMs(t) {
    var raw = String((t && t.date) || "").trim();
    if (!raw) return Infinity;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    var ms = m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : new Date(raw).getTime();
    return isNaN(ms) ? Infinity : ms;
  }
  function fmtDate(t) {
    var ms = dateMs(t);
    if (ms === Infinity) return "";
    var d = new Date(ms);
    return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function isToday(t) {
    var ms = dateMs(t);
    return ms !== Infinity && new Date(ms).toDateString() === new Date().toDateString();
  }
  /* Infinity - Infinity = NaN 会让 sort 变成不确定顺序（无日期任务互相乱窜），
   * 故统一走这里：有日期按毫秒升序，无日期一律沉底且保持 created_at 顺序。
   * ★ v1.140.0：已完成的先沉底 —— 勾了「显示已完成」之后，11-15 那批早听完的节
   *   原本按日期排在今天要用的那节前面，用户得往下翻很久才找得到。 */
  function byDate(a, b) {
    var da = !!a.done, db = !!b.done;
    if (da !== db) return da ? 1 : -1;
    var va = dateMs(a), vb = dateMs(b);
    if (va !== Infinity && vb !== Infinity && va !== vb) return va - vb;
    if (va !== Infinity && vb === Infinity) return -1;
    if (va === Infinity && vb !== Infinity) return 1;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  }
  /* 桶内排序（外科组按天分小节后用）：同一天里未完成在前、已完成沉底，
   * 其余保持原顺序 —— 稳定排序，不会把同一天内节的先后打乱。 */
  function undoneFirst(a, b) {
    var da = !!a.done, db = !!b.done;
    if (da !== db) return da ? 1 : -1;
    return 0;
  }
  function isWordTask(t) {
    return !!t && (t.source === "english_words" || WORD_TITLE_RE.test(String(t.title || "")));
  }
  function isSurgeryTask(t) {
    return !!t && (t.source === "surgery_sprint" || SURGERY_TITLE_RE.test(String(t.title || "")));
  }
  function isDeadSurgery(t) {
    return !!t && (t.source === "surgery_legacy" || t.source === "surgery_support" ||
      DEAD_SURGERY_RE.test(String(t.title || "")));
  }
  /* 外科冲刺的天键 / 精简标题（★ v1.140.0）
   *   标题 "【外科冲刺】DAY1/7 · 7.12 第2节 腹部损伤" → 天键 "DAY1/7"、短名 "7.12 第2节 腹部损伤"
   *   天键取不到就归到 "其他"（历史脏数据不静默消失，仍能在组里选到） */
  function surgeryDayKey(t) {
    var m = SURGERY_DAY_RE.exec(String((t && t.title) || ""));
    return m ? m[1] : "";
  }
  function surgeryBrief(t) {
    return String((t && t.title) || "").replace(SURGERY_PREFIX_RE, "").replace(SURGERY_DAY_HEAD_RE, "");
  }
  /* 精简标题：DAY 42 · 新词 300 词 / 复习 DAY 4 · 复习 648 词
   * （原标题 "11-10 DAY 42 每日单词任务：背单词·新词 300" 在手机上会被截成半截） */
  function wordTitle(t) {
    var lab = String(t.day_label || "").trim() || "单词 DAY";
    var m = /(新词|复习)\s*(\d+)/.exec(String(t.title || ""));
    return lab + (m ? " · " + m[1] + " " + m[2] + " 词" : "");
  }
  /* 范围小字：只取 note 里「阶段构成 / 首末词 / 补复习覆盖」这些真实内容，
   * 去掉词书前缀、轮次、词量、点开路径、系统无词提示；note 为空就退回标题词量。 */
  function wordHint(t) {
    var parts = String((t && t.note) || "").split("｜").map(function (s) { return s.trim(); }).filter(Boolean);
    var keep = parts.filter(function (s) {
      return !/^词书[:：]/.test(s) && !/^第\s*\d+\s*轮/.test(s) &&
        !/^第二轮补复习/.test(s) && !/^\d+\s*词$/.test(s) &&
        !/^点开[:：]/.test(s) && !/^系统无/.test(s);
    });
    if (keep.length) return keep.slice(0, 3).join(" · ");
    var m = /(新词|复习)\s*(\d+)/.exec(String((t && t.title) || ""));   // 兜底：标题里就有词量
    return m ? m[1] + " " + m[2] + " 词" : "";
  }
  /* 快捷条目标：永远给一个可见结论，绝不因为「今天没排期 / 已完成」就静默空白。 */
  function quickTarget() {
    var words = allTasks().filter(function (t) { return t && t.id && isWordTask(t); });
    words.sort(byDate);
    if (!words.length) return { mode: "none", task: null, count: 0 };
    var today = new Date().toDateString();
    var t0 = new Date(today).getTime();
    var todayTask = words.filter(function (t) { return String(t.date || "") === today; })[0] || null;
    var undone = words.filter(function (t) { return !t.done; });
    var future = undone.filter(function (t) { var ms = dateMs(t); return ms !== Infinity && ms > t0; });
    var firstUndone = undone[0] || null;
    if (todayTask && !todayTask.done) {
      return { mode: "today", task: todayTask, count: words.length };
    }
    if (todayTask && todayTask.done) {
      return { mode: "todayDone", task: future[0] || firstUndone || todayTask,
        doneTask: todayTask, count: words.length };
    }
    if (future.length) {
      return { mode: "gap", task: future[0], count: words.length };   // 今天无排期（如 11-17 空档）
    }
    return { mode: "allDone", task: firstUndone || words[words.length - 1], count: words.length };
  }

  /* ---------- DOM：本模块自建（不依赖任何页面的 HTML）---------- */
  var HTML =
    '<div class="tp-mask" id="tpMask"></div>' +
    '<div class="tp-modal" id="tpModal" role="dialog" aria-modal="true">' +
      '<div class="tp-head">' +
        '<div class="tp-title" id="tpTitle">选择关联任务</div>' +
        '<button type="button" class="tp-close" id="tpClose" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="tp-tools">' +
        '<input type="search" class="tp-search" id="tpSearch" placeholder="搜标题 / DAY / 日期 / 范围…" />' +
        '<label class="tp-toggle"><input type="checkbox" id="tpShowDone" /> 显示已完成</label>' +
      '</div>' +
      '<div class="tp-quick" id="tpQuick"></div>' +
      '<div class="tp-chips" id="tpChips"></div>' +
      '<div class="tp-list" id="tpList"></div>' +
      '<div class="tp-foot">' +
        '<button type="button" class="tp-btn ghost" id="tpClear">解除关联</button>' +
        '<span class="tp-count" id="tpCount"></span>' +
      '</div>' +
    '</div>';

  function ensureDom() {
    if (q("tpModal")) return;
    var wrap = document.createElement("div");
    wrap.innerHTML = HTML;
    while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);
    q("tpClose").addEventListener("click", close);
    q("tpMask").addEventListener("click", close);
    q("tpClear").addEventListener("click", function () { pick(null); });
    q("tpSearch").addEventListener("input", function (e) { kw = String(e.target.value || "").trim(); render(); });
    q("tpShowDone").addEventListener("change", function (e) {
      showDone = !!e.target.checked;
      writeShowDone(showDone);
      render();
    });
  }

  /* ---------- ★ v1.119.0 顶部快捷条 → ★ v1.140.0 升级成两张卡 ---------- */
  /* 一张快捷卡：head + main + hint + reason + acts，没传的字段自动省略。
   * sx=true 走青蓝配色（外科），与单词的 66ccff 区分开。 */
  function quickCard(o) {
    return '<div class="tpq-card' + (o.sx ? " is-sx" : "") + '">' +
      '<div class="tpq-head">' + esc(o.head) + '</div>' +
      (o.main ? '<div class="tpq-main">' + esc(o.main) + '</div>' : "") +
      (o.hint ? '<div class="tpq-hint">' + esc(o.hint) + '</div>' : "") +
      (o.reason ? '<div class="tpq-reason">' + esc(o.reason) + '</div>' : "") +
      '<div class="tpq-acts">' + (o.acts || "") + '</div>' +
    '</div>';
  }
  /* 「只看 X ▾」/「↩ 显示全部」：已经筛到这一类时按钮改成退回去，
   * 否则点第二下毫无反应（用户会以为按钮坏了）。 */
  function filterBtn(key, label) {
    var on = quickFilter === key;
    return '<button type="button" class="tpq-more' + (on ? " is-on" : "") + '"' +
      ' data-tp-quick-filter="' + (on ? "all" : key) + '">' +
      esc(on ? "↩ 显示全部" : label) + '</button>';
  }
  /* 单词快捷卡（v1.119.0 原逻辑与文案一字未改，只换成 quickCard 拼装） */
  function wordQuickHtml() {
    var hit = quickTarget();
    var head = "📕 单词突围 · 快捷关联";
    if (hit.mode === "none") {
      return quickCard({
        head: head,
        reason: "还没有单词突围每日任务，去「任务」页导入计划后即可一键关联。",
        acts: filterBtn("word", "查看单词任务 ▾")
      });
    }
    var t = hit.task;
    var label = wordTitle(t) + (fmtDate(t) ? " · " + fmtDate(t) : "");
    var reason;
    if (hit.mode === "today") reason = "今天该做这一条，点一下直接关联当前会话。";
    else if (hit.mode === "todayDone")
      reason = "今天的 " + wordTitle(hit.doneTask) + " 已完成，改为关联下一项。";
    else if (hit.mode === "gap") reason = "今天没有单词排期（计划有空档），指向下一项。";
    else reason = "计划里的 DAY 都已完成，仍可关联这条补记时长。";
    var btn = '<button type="button" class="tpq-go" data-tp-quick="' + esc(t.id) + '">' +
      (hit.mode === "today" ? "⚡ 一键关联 " + esc(t.day_label || "这个 DAY")
        : "⚡ 关联下一项 " + esc(t.day_label || "这个 DAY")) + ' →</button>';
    return quickCard({
      head: head, main: label, hint: wordHint(t), reason: reason,
      acts: btn + filterBtn("word", "只看单词 " + hit.count + " 天 ▾")
    });
  }
  /* 外科快捷卡（★ v1.140.0）：近期主任务，排在最前面。
   * 目标顺序：今天没听完的第一节 → 最早没听完的 → （全完成）最后一节补记。
   * 没有外科计划时整块不显示 —— 单词那条必须给可见结论，外科是附加系列。 */
  function surgeryQuickHtml() {
    var all = allTasks().filter(function (t) {
      return t && t.id && isSurgeryTask(t) && !isDeadSurgery(t);
    });
    if (!all.length) return "";
    all.sort(byDate);
    var undone = all.filter(function (t) { return !t.done; });
    var todayHit = undone.filter(isToday)[0] || null;
    var t = todayHit || undone[0] || all[all.length - 1];
    if (!t) return "";
    var mode = !undone.length ? "allDone" : (todayHit ? "today" : "next");
    var reason = mode === "today" ? "今天要听这一节，点一下直接关联当前会话。"
      : mode === "next" ? "从最早没听完的那一节接着听，别从中间挑。"
      : "课节都标完成了，仍可关联最后一节补记时长。";
    return quickCard({
      sx: true,
      head: "🩺 外科冲刺 · 快捷关联",
      main: surgeryBrief(t) + (fmtDate(t) ? " · " + fmtDate(t) : ""),
      hint: t.day_label || "",
      reason: reason,
      acts: '<button type="button" class="tpq-go tpq-go-sx" data-tp-quick="' + esc(t.id) + '">⚡ 关联这一节 →</button>' +
        /* 不带数字：默认视图只列未完成，写「28 节」会和列表里的 23 条对不上 */
        filterBtn("surgery", "只看外科 ▾")
    });
  }
  function renderQuick() {
    var box = q("tpQuick");
    if (!box) return;
    box.innerHTML = surgeryQuickHtml() + wordQuickHtml();
    box.querySelectorAll("[data-tp-quick]").forEach(function (b) {
      b.addEventListener("click", function () { pick(b.getAttribute("data-tp-quick")); });
    });
    box.querySelectorAll("[data-tp-quick-filter]").forEach(function (b) {
      b.addEventListener("click", function () { quickFilter = b.getAttribute("data-tp-quick-filter"); render(); });
    });
  }

  /* ---------- ★ v1.119.0 筛选 chip ---------- */
  function renderChips() {
    var box = q("tpChips");
    if (!box) return;
    var defs = [["all", "全部"], ["word", "📕 单词突围"], ["surgery", "🩺 外科冲刺"], ["today", "今天"]];
    box.innerHTML = defs.map(function (d) {
      return '<button type="button" class="tp-chip' + (quickFilter === d[0] ? " is-on" : "") +
        '" data-tp-filter="' + d[0] + '">' + esc(d[1]) + '</button>';
    }).join("");
    box.querySelectorAll("[data-tp-filter]").forEach(function (b) {
      b.addEventListener("click", function () { quickFilter = b.getAttribute("data-tp-filter"); render(); });
    });
  }

  /* ---------- 候选与分组 ---------- */
  function buildGroups() {
    var list = allTasks().filter(function (t) {
      return t && t.id && !isDeadSurgery(t) && (showDone || !t.done);
    });
    if (quickFilter === "word") list = list.filter(isWordTask);
    else if (quickFilter === "surgery") list = list.filter(isSurgeryTask);
    else if (quickFilter === "today") list = list.filter(isToday);
    if (kw) {
      var k = kw.toLowerCase(), flat = k.replace(/\s+/g, "");
      list = list.filter(function (t) {
        var hay = [t.title, t.day_label, t.note, t.ref_id, fmtDate(t), wordHint(t)]
          .map(function (v) { return String(v || ""); }).join(" ").toLowerCase();
        return hay.indexOf(k) >= 0 || hay.replace(/\s+/g, "").indexOf(flat) >= 0;  // 支持 "DAY42"
      });
    }
    /* ★ v1.119.0：按真实时间升序（原来按字符串比，等于按星期首字母排），
     *   无日期的沉底（原来 "9999-99-99" 反而霸占榜首 → 满屏生理滚动复习）。 */
    list.sort(byDate);
    var groups = {};
    list.forEach(function (t) {
      var k = isWordTask(t) ? WORD_KEY
        : (isSurgeryTask(t) ? SURGERY_KEY : (SUBJECT_LABEL[t.subject] ? t.subject : "other"));
      (groups[k] = groups[k] || []).push(t);
    });
    /* ★ v1.119.0：限额改到**每组**。旧版在分组前 slice(0,300)，448 条里
     *   431 条西医综合把 17 条单词任务挤掉 8 条（今天的 DAY 42 正好没了）。 */
    return GROUP_ORDER.filter(function (k) { return groups[k] && groups[k].length; })
      .map(function (k) {
        return {
          key: k,
          label: k === WORD_KEY ? WORD_GROUP_LABEL
            : (k === SURGERY_KEY ? SURGERY_GROUP_LABEL : SUBJECT_LABEL[k]),
          word: k === WORD_KEY,
          surgery: k === SURGERY_KEY,     // ★ v1.140.0：组内按冲刺日分小节
          items: groups[k].slice(0, MAX_ITEMS)
        };
      });
  }

  /* isWord=true 时标题已经是「DAY 42 · 新词 300 词」，meta 就不再重复 day_label。 */
  function metaText(t, isWord) {
    var bits = [];
    var d = fmtDate(t);                              // ★ v1.119.0：11-10（原来 slice(5) 出 "ov 10 2026"）
    if (d) bits.push(d);
    if (isToday(t)) bits.push("今天");
    if (t.day_label && !isWord) bits.push(t.day_label);   // DAY 17
    if (t.estimated_min) bits.push("预估 " + t.estimated_min + "分");
    if (t.done) bits.push("已完成");
    else if (t.status === "running") bits.push("进行中");
    return bits.join(" · ");
  }

  /* 单条候选（★ v1.140.0 抽出：外科组按天分小节后要复用同一套行渲染） */
  function itemHtml(g, t) {
    var title = g.word ? wordTitle(t)
      : (g.surgery ? surgeryBrief(t) : (t.title || "(无标题任务)"));
    var hint = g.word ? wordHint(t) : "";
    var cls = "tp-item" + (g.word ? " tp-item-word" : "") + (g.surgery ? " tp-item-sx" : "") +
      (t.id === curId ? " is-current" : "") + (isToday(t) ? " is-today" : "") +
      (t.done ? " is-muted" : "");
    return '<button type="button" class="' + cls + '" data-tp-id="' + esc(t.id) + '">' +
      '<span class="tpi-title">' + esc(title) + (isToday(t) ? ' <span class="tp-today">今天</span>' : "") + '</span>' +
      '<span class="tpi-meta">' + esc(metaText(t, g.word)) + (t.id === curId ? " · 当前" : "") + '</span>' +
      (hint ? '<span class="tpi-hint">' + esc(hint) + '</span>' : "") +
    '</button>';
  }
  /* 组内条目：外科按冲刺日分小节（DAY1/7 · 4 节 · 已完成 4），其余平铺。
   * ⚠️ 不能直接靠 byDate 之后的顺序切段：byDate 现在把已完成的挪到全局末尾，
   *   同一天的「未完成半截」和「已完成半截」会被别的天隔开 → 出现两个 DAY1/7 小节。
   *   所以这里自己聚桶；天的先后按**桶内首条的日期**排（不是首次出现）——
   *   否则某天全听完后整天被 byDate 推到末尾，DAY1 会跑到 DAY7 后面去。
   *   桶内未完成在前（undoneFirst，稳定排序，同一天内节的先后不变）。 */
  function groupItemsHtml(g) {
    if (!g.surgery) return g.items.map(function (t) { return itemHtml(g, t); }).join("");
    var order = [], buckets = {};
    g.items.forEach(function (t) {
      var k = surgeryDayKey(t) || "其他";
      if (!buckets[k]) { buckets[k] = []; order.push(k); }
      buckets[k].push(t);
    });
    order.sort(function (ka, kb) {
      var va = dateMs(buckets[ka][0]), vb = dateMs(buckets[kb][0]);
      if (va !== Infinity && vb !== Infinity) return va - vb;
      if (va !== Infinity) return -1;
      if (vb !== Infinity) return 1;
      return 0;
    });
    return order.map(function (k) {
      var arr = buckets[k].slice().sort(undoneFirst);
      var dn = arr.filter(function (t) { return t.done; }).length;
      return '<div class="tp-sub' + (dn === arr.length ? " is-done" : "") + '">' + esc(k) +
        '<span class="tp-sub-num">' + arr.length + " 节" + (dn ? " · 已完成 " + dn : "") + '</span></div>' +
        arr.map(function (t) { return itemHtml(g, t); }).join("");
    }).join("");
  }

  function render() {
    var box = q("tpList");
    if (!box) return;
    renderQuick();
    renderChips();
    var groups = buildGroups();
    if (!groups.length) {
      var why = kw ? "没有匹配「" + esc(kw) + "」的任务"
        : quickFilter === "word" ? "没有符合条件的单词突围任务（可勾选「显示已完成」或切回「全部」）"
        : quickFilter === "today" ? "今天没有排期的任务（可切回「全部」）"
        : (showDone ? "还没有任何任务" : "没有未完成的任务（可勾选「显示已完成」）");
      box.innerHTML = '<div class="tp-empty">' + why + "</div>";
      q("tpCount").textContent = "";
      return;
    }
    var n = 0;
    box.innerHTML = groups.map(function (g) {
      n += g.items.length;
      /* ★ v1.140.0：组标题带上未完成数 —— 「28 条」看不出还剩多少要干。 */
      var left = g.items.filter(function (t) { return !t.done; }).length;
      var cls = "tp-group" + (g.word ? " tp-group-word" : "") + (g.surgery ? " tp-group-surgery" : "");
      return '<div class="' + cls + '">' +
        '<div class="tp-g-title">' + esc(g.label) +
          '<span class="tp-g-num">' + g.items.length +
            (left && left !== g.items.length ? " 条 · 未完成 " + left : " 条") + '</span></div>' +
        groupItemsHtml(g) +
      '</div>';
    }).join("");
    q("tpCount").textContent = n + " 条";
    box.querySelectorAll("[data-tp-id]").forEach(function (b) {
      b.addEventListener("click", function () { pick(b.getAttribute("data-tp-id")); });
    });
  }

  function pick(id) {
    var fn = cb;
    close();
    if (fn) fn(id || null);
  }

  function open(opts) {
    opts = opts || {};
    ensureDom();
    cb = typeof opts.onPick === "function" ? opts.onPick : null;
    curId = opts.currentId || null;
    kw = "";
    quickFilter = "all";        // ★ v1.119.0：不记住上次筛选，避免下次打开只剩一类任务
    showDone = readShowDone();
    q("tpTitle").textContent = opts.title || "选择关联任务";
    q("tpSearch").value = "";
    q("tpShowDone").checked = showDone;
    q("tpClear").style.display = curId ? "" : "none";
    render();
    var m = q("tpModal"), mask = q("tpMask");
    /* ★ v1.140.0：这里必须是 flex，不能是 block。
     *   .tp-modal 的布局全靠 flex 列（头部固定 + 列表吃掉剩余高度 + 底栏常驻），
     *   旧代码写 style.display = "block" 把整条 flex 规则架空了：
     *   .tp-list 变成普通块 → 高度等于内容高 → overflow-y 永远不触发
     *   → 300 条内容直接溢出到弹窗外，手指怎么划都没反应（用户截图的形态）。
     *   `display: flex` 照样覆盖 class 里的 `display: none`，不用改 .show 逻辑。 */
    m.style.display = "flex"; mask.style.display = "block";
    requestAnimationFrame(function () { m.classList.add("show"); mask.classList.add("show"); });
    var s = q("tpSearch");
    /* ★ v1.140.0：手机上不自动聚焦 —— 软键盘一弹就把列表挤成一条缝，
     *   再叠上「列表不能滚」的 bug，看起来就是"这弹窗彻底滑不动"。
     *   桌面上仍自动聚焦（键盘输入检索是主用法）。 */
    if (s && !isTouchOnly()) setTimeout(function () { s.focus(); }, 260);
  }
  /* 触屏设备判定：老浏览器 / 沙箱没有 matchMedia 时按「非触屏」处理（宁可聚焦） */
  function isTouchOnly() {
    try {
      if (window.matchMedia && window.matchMedia("(hover: none)").matches &&
        window.matchMedia("(pointer: coarse)").matches) return true;
    } catch (e) { }
    return false;
  }

  function close() {
    var m = q("tpModal"), mask = q("tpMask");
    if (!m) return;
    m.classList.remove("show"); mask.classList.remove("show");
    setTimeout(function () { m.style.display = "none"; mask.style.display = "none"; }, 240);
    cb = null;
  }

  /* 任务 id → 标题（供列表 / 每日复盘显示「这条记录挂在哪件事上」）。
   * ★ 抽在这里而不是各处各写一份：三处显示必须同一个口径，
   *   否则会出现「计时页显示已关联、复盘页显示未关联」的对不上。
   *   任务已被删除时返回空串——调用方应回退显示「已关联任务」，而不是空白。 */
  function titleOf(id) {
    if (!id) return "";
    var list = allTasks();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i].title || "(无标题任务)";
    }
    return "";
  }

  return { open: open, close: close, titleOf: titleOf };
})();

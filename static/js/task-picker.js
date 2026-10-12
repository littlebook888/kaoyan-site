/* task-picker.js —— 通用「选择关联任务」弹窗（v1.44.0）
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
 * ⚠️ 只负责「选」，不负责「存」：onPick(taskId) 回调交给调用方落盘。
 *    计时器侧要写 active_timer.task_id；记录侧要写 time_records.task_id，
 *    且必须走 Store.updateTimeRecord（它内部会重算**新旧两个**任务的累计专注）。
 * ------------------------------------------------------------------ */
window.TaskPicker = (function () {
  "use strict";

  var SUBJECT_LABEL = { xizong: "西医综合", english: "英语", politics: "政治", other: "其他" };
  var SUBJECT_ORDER = ["xizong", "english", "politics", "other"];
  var SHOW_DONE_KEY = "kaoyan:taskpicker_show_done";
  var MAX_ITEMS = 300;          // 上限从 50 提到 300（分组 + 搜索后，翻不到底也不怕）

  var cb = null;                // 当前回调
  var curId = null;             // 当前已关联的任务 id
  var kw = "";                  // 搜索词
  var showDone = false;

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

  /* ---------- DOM：本模块自建（不依赖任何页面的 HTML）---------- */
  var HTML =
    '<div class="tp-mask" id="tpMask"></div>' +
    '<div class="tp-modal" id="tpModal" role="dialog" aria-modal="true">' +
      '<div class="tp-head">' +
        '<div class="tp-title" id="tpTitle">选择关联任务</div>' +
        '<button type="button" class="tp-close" id="tpClose" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="tp-tools">' +
        '<input type="search" class="tp-search" id="tpSearch" placeholder="搜标题 / DAY / 备注…" />' +
        '<label class="tp-toggle"><input type="checkbox" id="tpShowDone" /> 显示已完成</label>' +
      '</div>' +
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

  /* ---------- 候选与分组 ---------- */
  function buildGroups() {
    var all = (window.Store && window.Store.getTasks ? window.Store.getTasks() : []) || [];
    var list = all.filter(function (t) { return t && t.id && (showDone || !t.done); });
    if (kw) {
      var k = kw.toLowerCase();
      list = list.filter(function (t) {
        return [t.title, t.day_label, t.note, t.ref_id]
          .some(function (v) { return String(v || "").toLowerCase().indexOf(k) >= 0; });
      });
    }
    // 组内排序：有日期的按日期升序（先做先做），无日期的沉到后面
    list.sort(function (a, b) {
      var da = a.date || "9999-99-99", db = b.date || "9999-99-99";
      if (da !== db) return String(da).localeCompare(String(db));
      return String(a.created_at || "").localeCompare(String(b.created_at || ""));
    });
    var groups = {};
    list.slice(0, MAX_ITEMS).forEach(function (t) {
      var k = SUBJECT_LABEL[t.subject] ? t.subject : "other";
      (groups[k] = groups[k] || []).push(t);
    });
    return SUBJECT_ORDER
      .filter(function (k) { return groups[k] && groups[k].length; })
      .map(function (k) { return { key: k, label: SUBJECT_LABEL[k], items: groups[k] }; });
  }

  function metaText(t) {
    var bits = [];
    if (t.date) bits.push(String(t.date).slice(5));            // 10-05
    if (t.day_label) bits.push(t.day_label);                    // DAY 17
    if (t.estimated_min) bits.push("预估 " + t.estimated_min + "分");
    if (t.done) bits.push("已完成");
    else if (t.status === "running") bits.push("进行中");
    return bits.join(" · ");
  }

  function render() {
    var box = q("tpList");
    if (!box) return;
    var groups = buildGroups();
    if (!groups.length) {
      box.innerHTML = '<div class="tp-empty">' +
        (kw ? "没有匹配「" + esc(kw) + "」的任务" : (showDone ? "还没有任何任务" : "没有未完成的任务（可勾选「显示已完成」）")) +
        "</div>";
      q("tpCount").textContent = "";
      return;
    }
    var n = 0;
    box.innerHTML = groups.map(function (g) {
      n += g.items.length;
      return '<div class="tp-group">' +
        '<div class="tp-g-title">' + esc(g.label) + '<span class="tp-g-num">' + g.items.length + '</span></div>' +
        g.items.map(function (t) {
          return '<button type="button" class="tp-item' + (t.id === curId ? " is-current" : "") + '" data-tp-id="' + esc(t.id) + '">' +
            '<span class="tpi-title">' + esc(t.title || "(无标题任务)") + '</span>' +
            '<span class="tpi-meta">' + esc(metaText(t)) + (t.id === curId ? " · 当前" : "") + '</span>' +
          '</button>';
        }).join("") +
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
    showDone = readShowDone();
    q("tpTitle").textContent = opts.title || "选择关联任务";
    q("tpSearch").value = "";
    q("tpShowDone").checked = showDone;
    q("tpClear").style.display = curId ? "" : "none";
    render();
    var m = q("tpModal"), mask = q("tpMask");
    m.style.display = "block"; mask.style.display = "block";
    requestAnimationFrame(function () { m.classList.add("show"); mask.classList.add("show"); });
    var s = q("tpSearch");
    if (s) setTimeout(function () { s.focus(); }, 260);
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
    var list = (window.Store && window.Store.getTasks ? window.Store.getTasks() : []) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i].title || "(无标题任务)";
    }
    return "";
  }

  return { open: open, close: close, titleOf: titleOf };
})();

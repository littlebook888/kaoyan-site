/* =====================================================================
 *  checkin.js —— 每日签到提醒（v1.32.0 · 完全独立，分项切日版）
 *  ---------------------------------------------------------------------
 *  · 三项签到的 APP 刷新时间不同（用户 2026.10.05 指定）：
 *      ima 知识库双账号 / workbuddy、trae → 每日凌晨 0 点刷新（自然日）
 *      不背单词 App                       → 每日凌晨 4 点刷新
 *    → 0:00~3:59 期间给不背单词签到，签的是【前一天】的到。
 *  · 数据：events 表每项独立一行 { id: "ck-ima-<D>" / "ck-wb-<D>" / "ck-bb-<D>" }
 *      （D = 各项锚点日 = dateOf(now − 锚点小时)，ima/wb −0h、bb −4h）
 *    旧版合并行 ck-<D> 兼容读取 = 三项在该自然日均已完成（best-effort）。
 *  · 「已完成今日签到任务」一键完成所有当前锚点日未完成的项；撤销只删
 *    最近一次按下所创建的行（LS 记 last-press 行 id 集）。
 *  · 18 点后存在未完成项 → 单词卡上方页面内气泡列出未完成项；无系统通知。
 *  · 完全独立：不写 tasks/time_records/active_timer，不引用 Timer。
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const ITEMS = [
    { key: "ima", label: "ima 知识库 · 双账号签到", anchorHours: 0, group: "zero" },
    { key: "wb", label: "workbuddy、trae 签到", anchorHours: 0, group: "zero" },
    { key: "bb", label: "不背单词 App 签到", anchorHours: 4, group: "four" }
  ];
  /* ★ v1.32.1 两个按钮分开管两组切日逻辑（用户指定）：
   *   zero 组（凌晨 0 点刷新）= ima + workbuddy、trae；four 组（凌晨 4 点刷新）= 不背单词。 */
  const GROUPS = [
    { key: "zero", items: ITEMS.filter(i => i.group === "zero") },
    { key: "four", items: ITEMS.filter(i => i.group === "four") }
  ];

  function bjNow() {
    return window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
  }
  function dateKey(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  /* 某项的锚点日：now − anchorHours 后的自然日（bb 在 0~4 点 = 前一天） */
  function anchorKey(item) {
    const d = new Date(bjNow().getTime() - item.anchorHours * 3600 * 1000);
    return dateKey(d);
  }
  function rowId(item) { return "ck-" + item.key + "-" + anchorKey(item); }
  /* 旧行兼容：ck-<D> = 三项在自然日 D 均已完成 */
  function legacyDone(dateKeyStr) {
    return (Store.getEvents() || []).some(e => e && e.id === "ck-" + dateKeyStr);
  }
  function isItemDone(item) {
    const events = Store.getEvents() || [];
    return events.some(e => e && e.id === rowId(item)) || legacyDone(anchorKey(item));
  }
  function pendingItems() { return ITEMS.filter(it => !isItemDone(it)); }
  function allDone() { return pendingItems().length === 0; }
  function doneCount() { return ITEMS.length - pendingItems().length; }
  /* 是否已过今日 18 点（北京时间） */
  function after1800() { return bjNow().getHours() >= 18; }
  function bubbleVisible() { return !allDone() && after1800(); }

  /* 组内完成：为该组当前锚点日未完成的项建行；记录本次创建的行 id 集（供撤销） */
  function completeGroup(items) {
    const created = [];
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    for (const item of items) {
      if (isItemDone(item)) continue;
      const id = rowId(item);
      if (!events.some(e => e.id === id)) { events.push({ id, user_id: C.USER_ID, date: anchorKey(item), title: "daily-checkin", note: item.key }); created.push(id); }
    }
    if (created.length) Store.setEvents(events);
    return created;
  }
  function todayKey() { return dateKey(bjNow()); }
  /* ★ v1.32.2 撤销今日签到（误触兜底，可反复按）：删除三项目前锚点日的行 + 今日旧合并行，
   *   全部走 deleteEventRow 显式推删云端（防拉回复活）。撤销后卡片回到未完成、按钮回场；
   *   若已过 18 点且仍有未完成项，气泡按条件重现。 */
  function undoToday() {
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    const targets = ITEMS.map(item => rowId(item));
    targets.push("ck-" + todayKey());   // 旧版合并行（如有）
    const hit = targets.filter(id => events.some(e => e.id === id));
    if (!hit.length) return false;
    hit.forEach(id => Store.deleteEventRow(id));
    return true;
  }
  /* 旧行迁移：读到旧合并行 ck-<今日> 时，一键完成视为全项完成（无需迁移写入） */

  function alertMsg(msg) {
    if (window.UI && window.UI.showAlert) window.UI.showAlert(msg, 2200);
  }

  function render() {
    // 分项勾圈：各自锚点日完成态
    const card = document.getElementById("checkinCard");
    if (card) card.classList.toggle("done", allDone());
    ITEMS.forEach(item => {
      const el = document.querySelector(`[data-ck-item="${item.key}"]`);
      if (el) el.classList.toggle("ok", isItemDone(item));
    });
    // 日期副行
    const dateEl = document.getElementById("checkinDate");
    if (dateEl) {
      const d = bjNow();
      dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 · 周${"日一二三四五六"[d.getDay()]}`;
    }
    // 状态胶囊：已完成 N/3
    const doneN = doneCount();
    const st = document.getElementById("checkinState");
    if (st) {
      st.textContent = allDone() ? "今日已完成 ✓" : `已完成 ${doneN}/${ITEMS.length}`;
      st.className = "ck-state " + (allDone() ? "ok" : "todo");
    }
    // 两个组按钮：各自组内全部完成才隐藏（0 点组 / 4 点组逻辑分开）
    GROUPS.forEach(g => {
      const b = document.getElementById(g.key === "zero" ? "checkinDoneBtn0" : "checkinDoneBtn4");
      if (b) b.style.display = g.items.every(it => isItemDone(it)) ? "none" : "";
    });
    const doneRow = document.getElementById("checkinDoneRow");
    if (doneRow) doneRow.style.display = allDone() ? "flex" : "none";
    // 18 点后未完成项 → 气泡（列出具体未完成项）
    const bubble = document.getElementById("checkinBubble");
    if (bubble) {
      const show = bubbleVisible();
      bubble.style.display = show ? "" : "none";
      if (show) {
        const pend = pendingItems().map(it => it.label);
        const list = document.getElementById("checkinBubbleItems");
        if (list) list.textContent = pend.join("；");
        const bb = document.getElementById("checkinBubbleDone");
        if (bb) bb.disabled = false;
        if (window.Icon) window.Icon.inject(bubble);
      }
    }
  }

  function bind() {
    const press = (items) => {
      const created = completeGroup(items);
      render();
      if (created.length) alertMsg(`✅ 已记录 ${created.length} 项签到（三端同步）`);
    };
    const undo = () => {
      if (undoToday()) { render(); alertMsg("↩ 已撤销今日全部签到，可重新记录"); }
      else alertMsg("今天还没有可撤销的签到记录", 1800);
    };
    const b0 = document.getElementById("checkinDoneBtn0");
    if (b0) b0.addEventListener("click", () => press(GROUPS[0].items));
    const b4 = document.getElementById("checkinDoneBtn4");
    if (b4) b4.addEventListener("click", () => press(GROUPS[1].items));
    const bb = document.getElementById("checkinBubbleDone");
    if (bb) bb.addEventListener("click", () => press(pendingItems()));
    const undoBtn = document.getElementById("checkinUndo");
    if (undoBtn) undoBtn.addEventListener("click", undo);
    if (Store.subscribeEvents) Store.subscribeEvents(() => render());
    setInterval(render, 60000);
  }

  function init() { bind(); render(); }

  window.CHECKIN = { init, render, bind, ITEMS, GROUPS, isItemDone, pendingItems, allDone, doneCount, completeGroup, undoToday, bubbleVisible, anchorKey, todayKey };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

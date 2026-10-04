/* =====================================================================
 *  checkin.js —— 每日签到提醒（v1.30.0 · 完全独立新功能）
 *  ---------------------------------------------------------------------
 *  用户 2026.10.04 指定：
 *   · 以【自然日】（北京时间 0 点切换）进行每日签到提醒
 *   · 签到内容三项：① ima 知识库双账号签到 ② workbuddy、trae ③ 不背单词 App
 *   · 入口在任务页最底下，平时折叠隐藏；【完全独立】：与任务/计时/统计零联动
 *     （不写 tasks、不写 time_records、不碰 active_timer、不弹系统通知）
 *   · 当日完成后按「已完成今日签到任务」记录；当日 18 点后仍未完成 →
 *     在「英语单词突围」卡上方弹页面内气泡提醒（只推挤布局，不发系统通知），
 *     确认完成后气泡消失
 *   · 多端轻量同步：借 events 表存 { id: "ck-<YYYY-MM-DD>" }（1 行/天，稳定 id
 *     天然去重；只增不删 → 无「整表推送不删除」复活问题；复用既有 6 表同步）
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const EV_PREFIX = "ck-";          // events 行 id 前缀：ck-YYYY-MM-DD
  const ITEMS = [
    "ima 知识库 · 双账号签到",
    "workbuddy、trae 签到",
    "不背单词 App 签到"
  ];

  /* 北京时间自然日（与全站口径一致：Blocks.beijing + 补零） */
  function bjNow() {
    return window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
  }
  function todayKey() {
    const d = bjNow();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  /* 今天是否已签到：events 表存在 ck-<今日> 行 */
  function isDoneToday() {
    const k = todayKey();
    return (Store.getEvents() || []).some(e => e && e.id === EV_PREFIX + k);
  }
  /* 是否已过今日 18:00（北京时间） */
  function after1800() {
    return bjNow().getHours() >= 18;
  }
  /* 气泡可见条件：今日未签到 且 已过 18 点 */
  function bubbleVisible() {
    return !isDoneToday() && after1800();
  }
  /* 记录今日签到（幂等）：读改写保留全部既有 events 行（通讯录指派等），只追加当日一行 */
  function recordToday() {
    const k = todayKey();
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    if (events.some(e => e.id === EV_PREFIX + k)) return false;
    events.push({ id: EV_PREFIX + k, user_id: C.USER_ID, date: k, title: "daily-checkin", note: "" });
    Store.setEvents(events);
    return true;
  }

  function alertDone() {
    if (window.UI && window.UI.showAlert) window.UI.showAlert("✅ 今日签到已记录（三端同步）", 2200);
  }

  /* 撤销今日签到（误触兜底，v1.30.2）：只删今天自己的 ck 行——
   * deleteEventRow = setLocal 过滤 + pushDeleteRow 显式删云端行（防整表拉取复活） */
  function undoToday() {
    if (!isDoneToday()) return false;
    Store.deleteEventRow(EV_PREFIX + todayKey());
    return true;
  }

  function render() {
    const done = isDoneToday();
    // 底部独立卡：徽章/日期副行/状态胶囊/清单勾/按钮与完成行切换
    const card = document.getElementById("checkinCard");
    if (card) card.classList.toggle("done", done);
    const dateEl = document.getElementById("checkinDate");
    if (dateEl) {
      const d = bjNow();
      dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 · 周${"日一二三四五六"[d.getDay()]}`;
    }
    const st = document.getElementById("checkinState");
    if (st) {
      st.textContent = done ? "今日已完成 ✓" : "今日未完成";
      st.className = "ck-state " + (done ? "ok" : "todo");
    }
    const btn = document.getElementById("checkinDoneBtn");
    if (btn) btn.style.display = done ? "none" : "";
    const doneRow = document.getElementById("checkinDoneRow");
    if (doneRow) doneRow.style.display = done ? "flex" : "none";
    // 18 点后未完成 → 单词卡上方的页面内气泡（显示/隐藏只推挤布局，不发系统通知）
    const bubble = document.getElementById("checkinBubble");
    if (bubble) {
      const show = bubbleVisible();
      bubble.style.display = show ? "" : "none";
      if (show) {
        const list = document.getElementById("checkinBubbleItems");
        if (list) list.textContent = ITEMS.join("；");
        const bb = document.getElementById("checkinBubbleDone");
        if (bb) bb.disabled = done;
        if (window.Icon) window.Icon.inject(bubble);
      }
    }
  }

  function bind() {
    const done = () => { if (recordToday()) { render(); alertDone(); } else { render(); } };
    const btn = document.getElementById("checkinDoneBtn");
    if (btn) btn.addEventListener("click", done);
    const bb = document.getElementById("checkinBubbleDone");
    if (bb) bb.addEventListener("click", done);
    // 撤销（误触兜底）：删回今天的 ck 行，状态复原；若已过 18 点气泡会重新出现
    const undoBtn = document.getElementById("checkinUndo");
    if (undoBtn) undoBtn.addEventListener("click", () => {
      if (undoToday()) {
        render();
        if (window.UI && window.UI.showAlert) window.UI.showAlert("↩ 已撤销今日签到", 1800);
      }
    });
    // 其他设备签到/撤销 → events 同步落地 → 本页状态/气泡即时跟随
    if (Store.subscribeEvents) Store.subscribeEvents(() => render());
    // 每分钟自检一次：跨过 18:00 时气泡自动出现（无轮询推送，纯本地时钟判断）
    setInterval(render, 60000);
  }

  function init() {
    bind();
    render();
  }

  window.CHECKIN = { init, render, bind, isDoneToday, recordToday, undoToday, bubbleVisible, todayKey, ITEMS };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

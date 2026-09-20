/* =====================================================================
 *  clock.js —— 实时北京时间 + 日期 + 当日进度 + 当前计时状态
 *  每秒刷新；每个设备都读取实时北京时间，多端互通时间基准一致。
 *  依赖 blocks.js（window.Blocks.beijing / secOfDay / currentKey）。
 * ===================================================================== */
window.Clock = (function () {
  function p(n) { return String(n).padStart(2, "0"); }

  function catMeta(key) {
    if (!window.APP_CONFIG) return { label: key || "计时", color: "#66ccff" };
    const list = window.APP_CONFIG.TIME_CATEGORIES || [];
    // 先查二级
    for (const c of list) {
      if (c.subs && c.subs.length) {
        const s = c.subs.find(x => x.key === key);
        if (s) return { label: s.label, color: s.color || c.color };
      }
      if (c.key === key) return { label: c.label, color: c.color };
    }
    return { label: key || "计时", color: "#66ccff" };
  }

  function statusBubbleHtml() {
    const at = window.Store ? window.Store.getActiveTimer() : null;
    if (!at) return `<div class="lc-status idle"><span class="lc-sb">当前无计时</span></div>`;
    const cm = catMeta(at.sub_category || at.kind);
    const modeTxt = at.mode === "countdown" ? "倒计时" : "正计时";
    const statusTxt = at.status === "paused" ? "（暂停中）" : "";
    return `<div class="lc-status"><span class="lc-sb" style="--sb-c:${cm.color}">${cm.label} · ${modeTxt}${statusTxt}</span></div>`;
  }

  /* ---------- 「现在该做什么」提示（状态气泡右侧，随计划时段联动） ----------
   * 依赖 schedule-data.js（window.SCHEDULE_DATA）；未加载该数据的页面静默不渲染。
   * 判定口径与首页「现在该做什么」卡片一致：
   *   自习时段 + 无计时     → ❌ 该开始了（红）
   *   自习时段 + 非学习计时 → ⚠️ 偏离计划（黄）
   *   自习时段 + 学习计时   → ✅ 吻合（学习青绿）
   *   非自习时段            → ✅ 符合安排（按时段性质配色：睡眠深蓝/用餐橙/休息紫）
   *                           此时还在学习 → ℹ️ 自觉加练（同样按时段性质配色）
   * 点击：有卡片就滚到卡片，否则跳时间表页。 */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toMin(t) { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  /* 时段性质 → 项目分类色：单一事实源 = schedule-data.js 的 kindColors */
  const KIND_COLORS = Object.assign(
    { study: "#0d9488", meal: "#ea580c", rest: "#7c3aed", sleep: "#1e40af", prep: "#64748b", winddown: "#64748b" },
    (window.SCHEDULE_DATA && window.SCHEDULE_DATA.kindColors) || {});

  function planHintHtml() {
    const D = window.SCHEDULE_DATA;
    if (!D || !D.slots || !window.Blocks) return "";
    const sod = window.Blocks.secOfDay(new Date());
    const slot = D.slots.find(x => toMin(x.start) * 60 <= sod && sod < toMin(x.end) * 60);
    if (!slot) return `<span class="lc-plan free" title="点击查看完整时间表">🕊 现在该做什么：自由时段</span>`;

    const at = window.Store ? window.Store.getActiveTimer() : null;
    const running = !!(at && at.status === "running");
    const isStudyTimer = !!(at && (at.kind === "study" || at.sub_category === "enter_state"));
    const isStudySlot = slot.kind === "study";

    let cls = "kind", mark = "✅", tail = "符合安排";
    if (isStudySlot) {
      if (!running) { cls = "bad"; mark = "❌"; tail = "该开始了"; }
      else if (!isStudyTimer) { cls = "warn"; mark = "⚠️"; tail = "偏离计划"; }
      else { tail = "保持"; }
    } else if (running && isStudyTimer) {
      cls = "kind"; mark = "ℹ️"; tail = "自觉加练";
    }
    // 常态芯片按时段性质配色（睡眠=深蓝/用餐=橙/休息=绿/自习=青绿），
    // 紧急（红）与偏离（黄）两种警示态保留固定色
    const kindStyle = cls === "kind" ? ` style="--pc:${KIND_COLORS[slot.kind] || "#64748b"}"` : "";

    const endSec = toMin(slot.end) * 60;
    const rm = Math.max(0, Math.round((endSec - sod) / 60));
    const remain = rm >= 60 ? `${Math.floor(rm / 60)}小时${rm % 60}分` : `${rm}分`;
    // 状态词只在"需要提醒"时显示（吻合时保持简洁，芯片不至于过长）
    const tailHtml = (cls === "kind" && mark === "✅") ? "" : `（${tail}）`;
    const tip = `现在是「${slot.name}」（${slot.start}~${slot.end}）· ${tail}｜点击查看完整时间表`;
    return `<span class="lc-plan ${cls}"${kindStyle} title="${esc(tip)}">${mark} 现在该做什么：${esc(slot.name)}${tailHtml} · 剩 ${remain}</span>`;
  }

  // 点击提示 → 滚到首页卡片；其他页面 → 跳时间表页
  function bindPlanHint() {
    const el = document.getElementById("liveClock");
    if (!el) return;
    el.addEventListener("click", (e) => {
      if (!e.target.closest(".lc-plan")) return;
      const card = document.getElementById("homeSchedule");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      else location.href = "schedule.html";
    });
  }

  function render() {
    const el = document.getElementById("liveClock");
    if (!el || !window.Blocks) return;
    const b = window.Blocks.beijing(new Date());
    const wd = ["日", "一", "二", "三", "四", "五", "六"][b.getDay()];
    const dateStr = `${b.getFullYear()}年${b.getMonth() + 1}月${b.getDate()}日 · 周${wd}`;
    const timeStr = `${p(b.getHours())}:${p(b.getMinutes())}:${p(b.getSeconds())}`;
    const sod = window.Blocks.secOfDay(new Date());
    const pct = Math.min(100, (sod / 86400) * 100);
    const key = window.Blocks.currentKey(b);
    const bn = window.Blocks.NAMES[key];
    const bc = window.Blocks.COLORS[key];

    // 距睡觉边界还剩多少秒（北京时；边界取 config TIME_BLOCKS.sleep，曾硬编码 23:40 导致改配置不同步）
    const sleepStr = (window.APP_CONFIG && window.APP_CONFIG.TIME_BLOCKS && window.APP_CONFIG.TIME_BLOCKS.sleep) || "23:40";
    const sp = sleepStr.split(":").map(Number);
    const endSec = (sp[0] || 0) * 3600 + (sp[1] || 0) * 60;
    const remainSec = Math.max(0, endSec - sod);
    const rh = Math.floor(remainSec / 3600);
    const rm = Math.floor((remainSec % 3600) / 60);
    const rs = remainSec % 60;
    let remainStr;
    if (remainSec <= 0) remainStr = "已过";
    else if (rh > 0) remainStr = `${rh}小时${rm}分${rs}秒`;
    else if (rm > 0) remainStr = `${rm}分${rs}秒`;
    else remainStr = `${rs}秒`;

    el.innerHTML =
      `<div class="lc-time">${timeStr}</div>
       <div class="lc-date-row">
         <div class="lc-date-wrap">
           <div class="lc-date">${dateStr} · 北京时间</div>
           <div class="lc-block" style="--bc:${bc}">${bn}</div>
         </div>
       </div>
       <div class="lc-bar"><div class="lc-bar-fill" style="width:${pct}%"></div></div>
       <div class="lc-meta">今日已过去 ${pct.toFixed(1)}%<span class="lc-remain"> · 距离${sleepStr}还剩：${remainStr}</span></div>
       <div class="lc-status-row">当前状态为：${statusBubbleHtml()}${planHintHtml()}</div>`;
  }

  function init() {
    if (!document.getElementById("liveClock")) return;
    render();
    bindPlanHint();
    setInterval(render, 1000);
  }

  return { init, render };
})();
document.addEventListener("DOMContentLoaded", () => window.Clock && window.Clock.init());

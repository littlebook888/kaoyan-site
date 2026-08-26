/* =====================================================================
 *  clock.js —— 实时北京时间 + 日期 + 当日进度
 *  每秒刷新；每个设备都读取实时北京时间，多端互通时间基准一致。
 *  依赖 blocks.js（window.Blocks.beijing / secOfDay / currentKey）。
 * ===================================================================== */
window.Clock = (function () {
  function p(n) { return String(n).padStart(2, "0"); }

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

    // 距离23:40还剩多少秒（北京时）
    const endSec = 23 * 3600 + 40 * 60;
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
       <div class="lc-meta">今日已过去 ${pct.toFixed(1)}%<span class="lc-remain"> · 距离23:40还剩：${remainStr}</span></div>`;
  }

  function init() {
    if (!document.getElementById("liveClock")) return;
    render();
    setInterval(render, 1000);
  }

  return { init, render };
})();
document.addEventListener("DOMContentLoaded", () => window.Clock && window.Clock.init());

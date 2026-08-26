/* =====================================================================
 *  xizong-physio.js —— 生理学·人可研梦滚动复习（独立系列，不同步天天师兄每日计划）
 *  任务名：生理学人可研梦滚动复习
 *  卡片：【复习】《生理学》人可研梦滚动复习 DAY n 【第二期…；第三期…】
 *  节奏：DAY1 起
 *    - 第二期 = 2026-06-20 + (day-1) 天
 *    - 第三期 = 2026-07-25 + (day-1) 天
 *  独立进度：DAY1 → DAY43，每次给一张卡片，逐日推进
 * ===================================================================== */
(function () {
  const pad = n => String(n).padStart(2, "0");
  const list = [];

  const start2 = new Date(2026, 5, 20); // 第二期起始 6.20
  const start3 = new Date(2026, 6, 25); // 第三期起始 7.25

  for (let n = 1; n <= 43; n++) {
    const t2 = new Date(start2);
    t2.setDate(t2.getDate() + (n - 1));
    const t3 = new Date(start3);
    t3.setDate(t3.getDate() + (n - 1));

    const m2 = t2.getMonth() + 1, d2 = t2.getDate();
    const m3 = t3.getMonth() + 1, d3 = t3.getDate();

    list.push({
      day: n,
      term2: `${m2}.${d2}`,
      term3: `${m3}.${d3}`,
      dateStr: `${t2.getFullYear()}-${pad(m2)}-${pad(d2)}`,
      title: `【复习】《生理学》人可研梦滚动复习DAY${n}【第二期${m2}.${d2}；第三期${m3}.${d3}】`
    });
  }

  window.PHYSIO_PLAN = list;
})();
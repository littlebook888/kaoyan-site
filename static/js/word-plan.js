/* =====================================================================
 *  word-plan.js —— 「英语单词突围」每日背单词计划数据源（可编辑）
 *  ---------------------------------------------------------------
 *  ★ v1.103.0（用户 2026-10-28 指定）：**第二轮计划**，旧第一轮（DAY 1–41）已归档。
 *
 *  为什么整份换掉：第一轮 41 天（2026-09-23 ~ 10-26）已背完，覆盖 6682 词；
 *  旧任务行从云端 tasks 表移除（time_records 里的学习时长**保留**，统计页历史不断）。
 *  归档动作由 tasks.js 的 purgeLegacyWordTasks() 幂等执行，不靠手工删库。
 *
 *  【第二轮 · 新词 7 天】2026-10-30 起，编号接着往下：DAY 42 – DAY 48
 *  ┌────┬──────┬────────────────────────┬──────────────────────────┐
 *  │第n天│ 词数 │ 阶段构成                │ 首词 / 末词               │
 *  ├────┼──────┼────────────────────────┼──────────────────────────┤
 *  │ 1  │ 300  │ 四级 250 + 六级 50      │ biochemistry / enhancement│
 *  │ 2  │ 300  │ 六级 300                │ vulnerability / commuter  │
 *  │ 3  │ 300  │ 六级 300                │ annoyance / benevolence   │
 *  │ 4  │ 300  │ 六级 300                │ consolation / volatility  │
 *  │ 5  │ 300  │ 六级 300                │ uranium / bravery         │
 *  │ 6  │ 300  │ 考研其他 297 + 六级 3    │ warning / procreation     │
 *  │ 7  │ 107  │ 考研其他 107            │ proxy / wrongdoing        │
 *  └────┴──────┴────────────────────────┴──────────────────────────┘
 *  合计 1907 词。**不含「当日回看一遍」**（用户 2026-10-28 明确取消该制度）。
 *
 *  【第二轮 · 补复习 10 天】新词收官（11-05）隔一天，2026-11-07 起，
 *  每天补一个第一轮遗留的复习日，顺序就是 4 的倍数：DAY 4/8/12/…/40。
 *  词量沿用第一轮原定口径（648/647/645），因为这些复习覆盖的正是那批旧词。
 *
 *  ⚠️ 编号说明：新词用 DAY 42–48，复习仍叫「复习 DAY 4」这种（day 字段 = 4）。
 *     两者靠 **date 排序**（tasks.js 的 vocabList 已改为按日期排），不靠 DAY 号大小，
 *     否则复习 DAY 4 会排到 DAY 42 前面去。
 *  ⚠️ day 号在 plan 内必须唯一：42–48 与 4/8/12/…/40 互不重叠。
 *     dayNumOf() 从 day_label 取第一个数字 → "DAY 42"→42、"复习 DAY 4"→4，均正确。
 * ===================================================================== */
(function () {
  const DAY_BASE = 41;              // 新词接着第一轮往下编号 → DAY 42 起
  const NEW_START = "2026-10-30";   // 第二轮第 1 天
  const REVIEW_START = "2026-11-07";// 补复习第 1 天（新词 11-05 收官，隔一天）
  const REVIEW_KIND = "review";

  /* 新词 7 天：words=词数，phase=阶段构成，range=首词/末词（写进任务备注，便于和 APP 对账） */
  const NEW_DAYS = [
    { n: 1, words: 300, phase: "四级 250 + 六级 50",   range: "biochemistry → enhancement" },
    { n: 2, words: 300, phase: "六级 300",             range: "vulnerability → commuter" },
    { n: 3, words: 300, phase: "六级 300",             range: "annoyance → benevolence" },
    { n: 4, words: 300, phase: "六级 300",             range: "consolation → volatility" },
    { n: 5, words: 300, phase: "六级 300",             range: "uranium → bravery" },
    { n: 6, words: 300, phase: "考研其他 297 + 六级 3", range: "warning → procreation" },
    { n: 7, words: 107, phase: "考研其他 107",         range: "proxy → wrongdoing" }
  ];

  /* 补复习 10 天：day = 第一轮那个复习日的编号（4 的倍数），words = 第一轮原定词量 */
  const REVIEW_DAYS = [
    { day: 4,  words: 648 },
    { day: 8,  words: 648 },
    { day: 12, words: 648 },
    { day: 16, words: 648 },
    { day: 20, words: 648 },
    { day: 24, words: 647 },
    { day: 28, words: 645 },
    { day: 32, words: 645 },
    { day: 36, words: 645 },
    { day: 40, words: 645 }
  ];

  function ymd(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const newMs = new Date(NEW_START + "T00:00:00").getTime();
  const revMs = new Date(REVIEW_START + "T00:00:00").getTime();
  const DAY_MS = 86400000;

  const plan = [];

  /* 1) 新词日：seq 1..7，day 42..48 */
  NEW_DAYS.forEach(d => {
    plan.push({
      day: DAY_BASE + d.n,                 // 42..48
      seq: d.n,                            // 显示顺序（第 n 天）
      round: 2,
      label: `DAY ${DAY_BASE + d.n}`,      // "DAY 42"
      dateStr: ymd(newMs + (d.n - 1) * DAY_MS),
      kind: "new",
      words: d.words,
      phase: d.phase,
      range: d.range
    });
  });

  /* 2) 补复习日：seq 接着 8..17，day 仍是 4/8/…/40，日期 11-07 起每天一个 */
  REVIEW_DAYS.forEach((r, i) => {
    plan.push({
      day: r.day,                          // 4/8/12/…/40（第一轮复习日编号）
      seq: NEW_DAYS.length + 1 + i,        // 8..17
      round: 2,
      label: `复习 DAY ${r.day}`,           // "复习 DAY 4"
      dateStr: ymd(revMs + i * DAY_MS),
      kind: REVIEW_KIND,
      words: r.words,
      phase: "第一轮遗留复习",
      range: ""
    });
  });

  /* 按日期排好（新词在前、复习在后），下游 everywhere 都靠这个顺序 */
  plan.sort((a, b) => (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : a.day - b.day));

  window.WORD_PLAN = plan;

  /* 给 UI 用的元信息（renderWordPlan 读它算收官日、文案） */
  window.WORD_PLAN_META = {
    round: 2,
    newStart: NEW_START,
    newEnd: ymd(newMs + (NEW_DAYS.length - 1) * DAY_MS),                 // 2026-11-05
    reviewStart: REVIEW_START,
    reviewEnd: ymd(revMs + (REVIEW_DAYS.length - 1) * DAY_MS),           // 2026-11-16
    newWords: NEW_DAYS.reduce((s, d) => s + d.words, 0),                 // 1907
    reviewWords: REVIEW_DAYS.reduce((s, d) => s + d.words, 0),           // 6467
    totalDays: plan.length                                               // 17
  };
})();

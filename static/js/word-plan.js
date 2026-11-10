/* =====================================================================
 *  word-plan.js —— 「英语单词突围」每日背单词计划数据源（可编辑）
 *  ---------------------------------------------------------------
 *  ★ v1.103.0（用户 2026-10-28 指定）：**第二轮计划**，旧第一轮（DAY 1–41）已归档。
 *
 *  为什么整份换掉：第一轮 41 天（2026-09-23 ~ 10-26）已背完，覆盖 6682 词；
 *  旧任务行从云端 tasks 表移除（time_records 里的学习时长**保留**，统计页历史不断）。
 *  归档动作由 tasks.js 的 purgeLegacyWordTasks() 幂等执行，不靠手工删库。
 *
 *  【第二轮 · 新词 7 天】2026-11-10 起，编号接着往下：DAY 42 – DAY 48
 *  （用户 2026-11-10 指定：DAY 42 就是今天 → 整份计划从 11-05 顺延 5 天）
 *  ┌────┬──────┬────────────────────────┬──────────────────────────┐
 *  │第n天│ 词数 │ 阶段构成                │ 首词 / 末词               │
 *  ├────┼──────┼────────────────────────┼──────────────────────────┤
 *  │ 1  │ 300  │ 四级 250 + 六级 50      │ biochemistry / enhancement│
 *  │ 2  │ 300  │ 六级 300                │ vulnerability / commuter  │
 *  │ 3  │ 300  │ 六级 300                │ annoyance / benevolence   │
 *  │ 4  │ 300  │ 六级 300                │ consolation / volatility  │
 *  │ 5  │ 300  │ 六级 300                │ uranium / bravery         │
 *  │ 6  │ 300  │ 考研其他 297 + 六级 3    │ warning / ethos           │
 *  │ 7  │ 107  │ 考研其他 107            │ ex-soldier / wrongdoing   │
 *  └────┴──────┴────────────────────────┴──────────────────────────┘
 *  合计 1907 词。**不含「当日回看一遍」**（用户 2026-10-28 明确取消该制度）。
 *
 *  ★ v1.118.0 权威数据源：用户 2026-11-10 提供 `cet46_ky_300plan.xlsx`（sheet「排期总览」+
 *    「每日点击路径」+「词汇总清单」+「说明与口径」）。**表内「第 n 天」= 本计划 DAY (41+n)**，
 *    即第 1 天 = DAY 42 … 第 7 天 = DAY 48；这份表**只覆盖新词 7 天，不含补复习 10 天**。
 *  ┌─────┬──────┬────────┬───────────┬──────┬──────┐
 *  │第n天│ 词数 │ 点开DAY │ ≥3词值得点│ 累计 │ 系统无│
 *  ├─────┼──────┼────────┼───────────┼──────┼──────┤
 *  │  1  │ 300  │   27   │    27     │  300 │   0  │
 *  │  2  │ 300  │    9   │     9     │  600 │   0  │
 *  │  3  │ 300  │    8   │     8     │  900 │   0  │
 *  │  4  │ 300  │    6   │     6     │ 1200 │   0  │
 *  │  5  │ 300  │    5   │     5     │ 1500 │   0  │
 *  │  6  │ 300  │   88   │    45     │ 1800 │  59  │
 *  │  7  │ 107  │    0   │     0     │ 1907 │ 107  │
 *  └─────┴──────┴────────┴───────────┴──────┴──────┘
 *  ⚠️ 三条口径决策（「适当理解」，不是照抄 Excel）：
 *    ① Excel「当天任务」列写「新学 300 词（约 66 分钟）+ **当日回看 1 遍**」——
 *       回看是**旧制度**，用户 2026-10-28 已明确取消，护栏锁死「数据层零回看」，**不采纳**；
 *       只取「约 66/24 分钟」作为预计耗时。
 *    ② Excel「系统无 59 / 107 词（用红宝书/大纲表）」必须单独提示：这些词在 APP 里搜不到，
 *       照着点会白找；第 7 天全部 107 词都要改用红宝书/大纲表。
 *    ③ 首末词按「词汇总清单」按天分组校正：第 6 天 warning→ethos、第 7 天 ex-soldier→wrongdoing
 *       （旧值 warning→procreation / proxy→wrongdoing 把隔壁天的词串进来了）。
 *    clickPath 逐字抄自 Excel「系统需点击的DAY（按此顺序）」列，含其 en-dash 与括号写法。
 *
 *  【第二轮 · 补复习 10 天】新词收官（11-16）隔一天，2026-11-18 起，
 *  每天补一个第一轮遗留的复习日，顺序就是 4 的倍数：DAY 4/8/12/…/40。
 *  词量沿用第一轮原定口径（648/647/645），因为这些复习覆盖的正是那批旧词。
 *  ⚠️ 复习范围（cover）不是猜的：第一轮 word-plan.js 里 `words = 前 3 个新词日之和`，
 *     即复习 DAY N 覆盖第一轮 DAY (N-3) ~ (N-1) 的新词（DAY 4 → DAY 1–3，DAY 40 → DAY 37–39）。
 *     卡片小字直接读这个字段；没有确切范围的条目宁可留空，也不编造。
 *
 *  ⚠️ 编号说明：新词用 DAY 42–48，复习仍叫「复习 DAY 4」这种（day 字段 = 4）。
 *     两者靠 **date 排序**（tasks.js 的 vocabList 已改为按日期排），不靠 DAY 号大小，
 *     否则复习 DAY 4 会排到 DAY 42 前面去。
 *  ⚠️ day 号在 plan 内必须唯一：42–48 与 4/8/12/…/40 互不重叠。
 *     dayNumOf() 从 day_label 取第一个数字 → "DAY 42"→42、"复习 DAY 4"→4，均正确。
 * ===================================================================== */
(function () {
  const DAY_BASE = 41;              // 新词接着第一轮往下编号 → DAY 42 起
  const NEW_START = "2026-11-10";   // 第二轮第 1 天（用户 2026-11-10 指定：DAY 42 = 今天）
  const REVIEW_START = "2026-11-18";// 补复习第 1 天（新词 11-16 收官，隔一天 11-17）
  const REVIEW_KIND = "review";

  /* 新词 7 天（★ v1.118.0 全部字段来自用户 Excel「排期总览」，逐字对账）：
   *   words 词数 / phase 阶段构成 / range 首词→末词（按「词汇总清单」按天分组校正）
   *   clickDays 需点开 DAY 数 / worthDays 其中 ≥3 词值得点开 / clickPath 系统需点击的 DAY（按此顺序）
   *   cum 累计词数 / offline 系统库无、须用红宝书/大纲表的词数 / minutes 预计耗时
   * ⚠️ Excel「当天任务」列另写「+ 当日回看 1 遍」——旧制度已取消，本表**故意不设该字段**（护栏锁着）。 */
  const NEW_DAYS = [
    {
      n: 1, words: 300, phase: "四级 250 + 六级 50", range: "biochemistry → enhancement",
      clickDays: 27, worthDays: 27, cum: 300, offline: 0, minutes: 66,
      clickPath: "四级 D1–D31 共24个DAY(250词) + 六级 D1–D3 共3个DAY(50词)"
    },
    {
      n: 2, words: 300, phase: "六级 300", range: "vulnerability → commuter",
      clickDays: 9, worthDays: 9, cum: 600, offline: 0, minutes: 66,
      clickPath: "六级 D3–D14 共9个DAY(300词)"
    },
    {
      n: 3, words: 300, phase: "六级 300", range: "annoyance → benevolence",
      clickDays: 8, worthDays: 8, cum: 900, offline: 0, minutes: 66,
      clickPath: "六级 D14–D23 共8个DAY(300词)"
    },
    {
      n: 4, words: 300, phase: "六级 300", range: "consolation → volatility",
      clickDays: 6, worthDays: 6, cum: 1200, offline: 0, minutes: 66,
      clickPath: "六级 D23–D30 共6个DAY(300词)"
    },
    {
      n: 5, words: 300, phase: "六级 300", range: "uranium → bravery",
      clickDays: 5, worthDays: 5, cum: 1500, offline: 0, minutes: 66,
      clickPath: "六级 D30–D35 共5个DAY(300词)"
    },
    {
      n: 6, words: 300, phase: "考研其他 297 + 六级 3", range: "warning → ethos",
      clickDays: 88, worthDays: 45, cum: 1800, offline: 59, minutes: 66,
      clickPath: "六级 D35(3词) + 雅思 D1–D54 共38个DAY(129词) + 托福 D1–D77 共49个DAY(109词) + 系统无 59 词（用红宝书/大纲表）"
    },
    {
      n: 7, words: 107, phase: "考研其他 107", range: "ex-soldier → wrongdoing",
      clickDays: 0, worthDays: 0, cum: 1907, offline: 107, minutes: 24,
      clickPath: "系统无 107 词（用红宝书/大纲表）"
    }
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
      range: d.range,
      /* ★ v1.118.0：Excel「排期总览」的操作列，卡片小字据此逐条展示 */
      clickDays: d.clickDays,
      worthDays: d.worthDays,
      clickPath: d.clickPath,
      cum: d.cum,
      offline: d.offline,
      minutes: d.minutes
    });
  });

  /* 2) 补复习日：seq 接着 8..17，day 仍是 4/8/…/40，日期 11-18 起每天一个 */
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
      range: "",
      /* ★ v1.118.0：复习覆盖范围（见文件头说明）。只在有确切依据时给值，
       *   卡片小字据此显示「补的是哪一批旧词」，不做猜测。 */
      cover: `第一轮 DAY ${r.day - 3}–${r.day - 1} 的新词`
    });
  });

  /* 按日期排好（新词在前、复习在后），下游 everywhere 都靠这个顺序 */
  plan.sort((a, b) => (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : a.day - b.day));

  window.WORD_PLAN = plan;

  /* 给 UI 用的元信息（renderWordPlan 读它算收官日、文案） */
  window.WORD_PLAN_META = {
    round: 2,
    newStart: NEW_START,
    newEnd: ymd(newMs + (NEW_DAYS.length - 1) * DAY_MS),                 // 2026-11-16
    reviewStart: REVIEW_START,
    reviewEnd: ymd(revMs + (REVIEW_DAYS.length - 1) * DAY_MS),           // 2026-11-27
    newWords: NEW_DAYS.reduce((s, d) => s + d.words, 0),                 // 1907
    reviewWords: REVIEW_DAYS.reduce((s, d) => s + d.words, 0),           // 6467
    totalDays: plan.length                                               // 17
  };
})();

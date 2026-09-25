/* =====================================================================
 *  word-plan.js —— 「英语单词突围」每日背单词计划数据源（可编辑）
 *  ---------------------------------------------------------------
 *  词书：考研英语 6700（APP：单词突围）
 *  起点：**2026-09-23 = DAY 1**（用户 2026-09-22 指定：**DAY 3 = 9 月 25 日**）
 *        → DAY N 对应日期 = 2026-09-23 + (N−1) 天
 *  排布（与 APP 进度页逐条核对一致）：
 *    · 新词日：DAY 1–22 每天 216 词；DAY 23–41 每天 215 词
 *    · 复习日：每 4 天一次（DAY 4/8/12/…/40），词量 = 前 3 个新词日之和
 *      实测吻合：DAY4=648、DAY8=648、DAY24=647(216+216+215)、
 *                DAY28/32/36/40=645(215×3)
 *  长度：41 天 → 2026-11-02 收官
 *  改这里即可调整：想换起点改 START_DATE；想加长改 TOTAL_DAYS；
 *  想微调某天词量在 MANUAL_WORDS 里加一行（按 DAY 号覆盖）。
 *  ⚠️ 改 START_DATE 后无需手工迁移：已导入的任务由 tasks.js 的
 *     alignVocabTasksToPlan() 按 DAY 号自动对齐（标题里的日期、date 字段、
 *     day_label、备注一起改），完成状态与累计专注时长存在任务本身上，不受影响。
 * ===================================================================== */
(function () {
  const START_DATE = "2026-09-23";   // DAY 1（→ DAY 3 = 9 月 25 日）
  const TOTAL_DAYS = 41;             // 计划总天数
  const NEW_BIG = 216;               // DAY ≤ NEW_BIG_UNTIL 的新词量
  const NEW_BIG_UNTIL = 22;
  const NEW_SMALL = 215;             // 之后的新词量
  const REVIEW_EVERY = 4;            // 每 4 天一次复习
  const MANUAL_WORDS = {};           // 例：{ 17: 210 } 覆盖指定 DAY 的词量

  function ymd(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const startMs = new Date(START_DATE + "T00:00:00").getTime();

  const plan = [];
  for (let n = 1; n <= TOTAL_DAYS; n++) {
    const isReview = n % REVIEW_EVERY === 0;
    let words;
    if (isReview) {
      // 复习量 = 前 3 个新词日之和（即上一个复习日之后的 3 天）
      words = 0;
      for (let k = n - 3; k < n; k++) {
        if (k < 1) continue;
        words += plan[k - 1].words;
      }
    } else {
      words = n <= NEW_BIG_UNTIL ? NEW_BIG : NEW_SMALL;
    }
    if (MANUAL_WORDS[n]) words = MANUAL_WORDS[n];
    plan.push({
      day: n,
      label: `DAY ${n}`,
      dateStr: ymd(startMs + (n - 1) * 86400000),
      kind: isReview ? "review" : "new",
      words: words
    });
  }

  window.WORD_PLAN = plan;
})();

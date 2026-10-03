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
 *  长度：41 天 → 2026-11-02 收官（原始节奏）；
 *        叠加加速规则后实际收官见下方 DOUBLE_SPEED（v1.28.8：DAY 41 = 2026-10-13）。
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

  /* ★ v1.27.0 双倍速区间（用户 2026.09.30 指定：国庆 10/1~10/7 每天完成 2 个 DAY）。
   * ★ v1.28.8 修订（用户 2026.10.02 指定）：**10-03 及以前的任务一律不动**（仍为老节奏 2 个/天）；
   *   10-04 起，当天装入的 DAY 含复习 → 当天容量提到 3 个（2 新词 + 1 复习）；
   *   不含复习 → 2 个新词 DAY。规则持续到收官（收官日随之提前）。
   *   ⚠️ from 必须留在 10-01、不能直接改成 10-04：否则 10-01~10-03 会掉回 1 个/天，
   *      DAY 10~14 跟着移位，违背「10-03 前不动」。用 tripleFrom 单独控制扩容起点。 */
  const DOUBLE_SPEED = { from: "2026-10-01", to: "2099-12-31", perDay: 2, tripleFrom: "2026-10-04" };
  const REVIEW_EVERY_PLAN = REVIEW_EVERY;   // 复习日判定（n % 4 === 0）

  // DAY n → 日期：游标法。双倍速区间内每天消耗 2 个 DAY；
  // tripleFrom 之后，若当天已装入的 DAY 里含复习，则当天再多消耗 1 个（凑成 2 新词 + 1 复习）。
  function dateOf(n) {
    let cursor = startMs;
    let used = 0;             // 当前游标日已消耗的 DAY 数
    let hasReview = false;    // 当天已装入的 DAY 是否含复习
    for (let k = 1; k <= n; k++) {
      const cs = ymd(cursor);
      const inWindow = DOUBLE_SPEED && cs >= DOUBLE_SPEED.from && cs <= DOUBLE_SPEED.to;
      let per = inWindow ? DOUBLE_SPEED.perDay : 1;
      const canTriple = inWindow && DOUBLE_SPEED.tripleFrom && cs >= DOUBLE_SPEED.tripleFrom;
      // 当天已装入 2 个且其中含复习 → 该天容量提升为 3（上限，2 新词 + 1 复习）
      if (canTriple && hasReview && used >= per) per = 3;
      if (used >= per) { cursor += 86400000; used = 0; hasReview = false; k--; continue; }
      if (k === n) return ymd(cursor);
      if (isReviewDay(k)) hasReview = true;
      used++;
    }
    return ymd(cursor);
  }
  function isReviewDay(n) { return n % REVIEW_EVERY_PLAN === 0; }

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
      dateStr: dateOf(n),
      kind: isReview ? "review" : "new",
      words: words
    });
  }

  window.WORD_PLAN = plan;
})();

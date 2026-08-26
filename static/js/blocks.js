/* =====================================================================
 *  blocks.js —— 学习大块（按三餐切分）计算 helper
 *  早块 = 起床→午餐；午块 = 午餐→晚餐；晚块 = 晚餐→睡觉
 *  供首页「今日三块」与计时器「大块预设」共用。
 *
 *  ⭐ 统一用「北京时间(UTC+8)」判定，保证任意设备/任意时区下
 *     块的切分一致，多端互通才不会出现「同一段学习被归到不同块」。
 * ===================================================================== */
window.Blocks = (function () {
  const C = window.APP_CONFIG;
  const KEYS = ["morning", "afternoon", "evening"];
  const NAMES = { morning: "早块", afternoon: "午块", evening: "晚块" };
  const ICONS = { morning: "sunrise", afternoon: "sun", evening: "moon" };
  const COLORS = { morning: "#ffb347", afternoon: "#66ccff", evening: "#7c8cff" };

  function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

  // 把任意本地时间转成「北京时间(UTC+8)」的 Date（getHours 等返回北京时刻）
  function beijing(d) {
    d = d ? new Date(d) : new Date();
    return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  }
  // 北京时间当天已过秒数（0..86399），时区无关
  function secOfDay(d) {
    const b = beijing(d);
    return b.getHours() * 3600 + b.getMinutes() * 60 + b.getSeconds();
  }
  // 北京时间当天日期串（YYYY-M-D），用于「今天」的跨设备一致判定
  function dateStr(d) {
    const b = beijing(d);
    return `${b.getFullYear()}-${b.getMonth() + 1}-${b.getDate()}`;
  }

  function defs() {
    const b = C.TIME_BLOCKS || { wake: "06:30", lunch: "12:00", dinner: "17:30", sleep: "23:30" };
    return [
      { key: "morning",   name: NAMES.morning,   start: b.wake,  end: b.lunch  },
      { key: "afternoon", name: NAMES.afternoon, start: b.lunch, end: b.dinner },
      { key: "evening",   name: NAMES.evening,   start: b.dinner, end: b.sleep }
    ];
  }

  // 判断某个时刻（Date）属于哪个大块（统一按北京时间）
  function blockOf(date) {
    const b = C.TIME_BLOCKS || { wake: "06:30", lunch: "12:00", dinner: "17:30" };
    const mins = secOfDay(date) / 60;
    if (mins < toMin(b.wake)) return "evening";   // 凌晨 0:00–起床 计入昨夜的晚块
    if (mins < toMin(b.lunch)) return "morning";
    if (mins < toMin(b.dinner)) return "afternoon";
    return "evening";
  }
  function currentKey(now) { return blockOf(now || new Date()); }

  function windowText(key) {
    const d = defs().find(x => x.key === key);
    return d ? `${d.start}–${d.end}` : "";
  }

  // 该块还剩多少秒（仅对「当前块」有意义，返回到块结束边界的秒数；非当前块返回 null）
  function remainingSeconds(key, now) {
    now = now || new Date();
    if (key !== currentKey(now)) return null;
    const d = defs().find(x => x.key === key);
    const endSec = toMin(d.end) * 60;   // 该块结束时刻（北京时间当天秒数）
    return Math.max(0, endSec - secOfDay(now));
  }

  // 该块整块时长（秒）
  function blockDurationSec(key) {
    const d = defs().find(x => x.key === key);
    return (toMin(d.end) - toMin(d.start)) * 60;
  }

  /* ---- 吃饭相关 ----
   * 早块 → 午饭 → 午块；午块 → 晚饭 → 晚块
   * 「开始吃饭」记录一段 meal 类时间记录，不改变块的时间边界判定
   */
  function mealOfBlock(key) {
    // morning → lunch（午饭），afternoon → dinner（晚饭），evening → null
    const map = (C.MEAL_OF_BLOCK) || { morning: "lunch", afternoon: "dinner" };
    return map[key] || null;
  }
  function mealLabel(mealKey) {
    return mealKey === "lunch" ? "午饭" : mealKey === "dinner" ? "晚饭" : "吃饭";
  }
  // 当前块是否可以「开始吃饭」（早块/午块才有饭点）
  function canStartMeal(now) {
    const key = currentKey(now);
    return key === "morning" || key === "afternoon";
  }

  return {
    KEYS, NAMES, ICONS, COLORS, defs, beijing, secOfDay, dateStr,
    blockOf, currentKey, windowText, remainingSeconds, blockDurationSec,
    mealOfBlock, mealLabel, canStartMeal
  };
})();

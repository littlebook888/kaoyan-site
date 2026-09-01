/* =====================================================================
 *  config.js —— 全局配置（你以后只改这里）
 *  考研个人网站 · 免费三端同步
 * ===================================================================== */

window.APP_CONFIG = {
  /* ⭐ 应用版本号（每次代码改动必须升级，前端会自动检测版本变化并清空旧缓存）
   *    命名规则：v主版本.次版本.补丁（如 v1.0.5）
   *    主版本=大改版 / 次版本=新功能 / 补丁=bug修复 */
  APP_VERSION: "v1.3.9",

  /* ---------------------------------------------------------------
   *  Supabase 三端同步配置
   *  ---------------------------------------------------------------
   *  ⚠️ 默认用「本地存储 + 同浏览器多标签同步」即可立即使用。
   *  要手机/电脑/平板「跨设备」实时同步，需：
   *    1) 去 https://supabase.com 免费注册，新建一个 project；
   *    2) 在 Project Settings → API 找到 URL 和 anon public key；
   *    3) 把下面的 SUPABASE_URL / SUPABASE_ANON_KEY 填上；
   *    4) 在 Supabase SQL Editor 执行本仓库 sql/schema.sql 建表。
   *  不填也能用（数据存在本机浏览器），只是不能跨设备。
   * ------------------------------------------------------------- */
  SUPABASE_URL: "https://nkwwtlgpfvhzetjsssvj.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rd3d0bGdwZnZoemV0anNzc3ZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDI2MDUsImV4cCI6MjEwMzMxODYwNX0.UCXhEKqe08d4h74w9hExZe9XGKjIzZVQXQFHLYcddS8",

  /* 单用户标识：跨设备用同一个 user_id 即可共享同一份数据。
   * 你可以三端都填同一个固定字符串（如 "chenbenzhen"）。 */
  USER_ID: "kaoyan_user_default",
  SYNC_CHANNEL: "kaoyan-sync",     // BroadcastChannel 同浏览器多标签同步频道名

  /* 考研初试日期（默认占位，改成你的真实日期） */
  EXAM_DATE: "2026-12-19",

  /* 每日目标学习时长（小时），用于首页进度与学霸指数 */
  DAILY_GOAL_HOURS: 8,

  /* ⭐ 学习大块（按三餐切分，符合你的「大块学习」心智模型）
   * 早块 = 起床 → 午餐；午块 = 午餐 → 晚餐；晚块 = 晚餐 → 睡觉
   * 改这里即可调整你的作息边界（24 小时制 HH:MM）。 */
  TIME_BLOCKS: {
    wake:   "08:00",   // 起床（早块起点）
    lunch:  "12:00",   // 午餐（早块结束 / 午块起点）
    dinner: "17:30",   // 晚餐（午块结束 / 晚块起点）
    sleep:  "23:40"    // 睡觉（晚块结束）
  },
  /* 每块每日目标学习时长（小时）。三块合计≈每日目标，可按你节奏改。 */
  BLOCK_GOAL_HOURS: { morning: 3, afternoon: 2.5, evening: 2.5 },

  /* 主题色（洛天依蓝） */
  THEME_COLOR: "#66ccff",
  THEME_COLOR_DARK: "#3399ee",

  /* ⭐ 时间记录系统 · 分类体系（对标爱时间/时间日志）
   * category = 一级分类（大类），sub_category / tag = 二级标签（细项）
   * 颜色用于时间轴、饼图等可视化。 */
  TIME_CATEGORIES: [
    { key: "study",    label: "学习", color: "#0d9488", icon: "book-open",  countTowardGoal: true,
      subs: [
        { key: "xizong",  label: "学西医综合", color: "#0d9488" },
        { key: "english", label: "学英语",     color: "#14b8a6" },
        { key: "politics",label: "学政治",     color: "#2dd4bf" },
        { key: "study_other", label: "学习其他", color: "#99f6e4" },
        { key: "enter_state", label: "进入学习状态", color: "#0d6b4d" }
      ]
    },
    { key: "work",     label: "工作", color: "#1e40af", icon: "briefcase",  countTowardGoal: false,
      subs: [
        { key: "intern",  label: "实习",     color: "#3b82f6" },
        { key: "sidejob", label: "副业",     color: "#60a5fa" }
      ]
    },
    { key: "meal",     label: "吃饭", color: "#ea580c", icon: "utensils",   countTowardGoal: false,
      subs: [
        { key: "regular", label: "正餐",     color: "#ea580c" },
        { key: "snack",   label: "吃零食",   color: "#f97316" }
      ]
    },
    { key: "housework",label: "家务", color: "#78350f", icon: "home",       countTowardGoal: false, subs: [] },
    { key: "sports",   label: "运动", color: "#ca8a04", icon: "dumbbell",   countTowardGoal: false, subs: [] },
    { key: "commute",  label: "通勤", color: "#6b7280", icon: "bus",        countTowardGoal: false, subs: [] },
    { key: "rest",     label: "休息", color: "#16a34a", icon: "coffee",     countTowardGoal: false, subs: [] },
    { key: "entertain",label: "娱乐", color: "#db2777", icon: "gamepad-2",  countTowardGoal: false,
      subs: [
        { key: "game",       label: "游戏",         color: "#f472b6" },
        { key: "video",      label: "刷视频",       color: "#e879f9" }
      ]
    },
    { key: "call",     label: "通话边界", color: "#66ccff", icon: "phone",      countTowardGoal: false,
      subs: [
        { key: "linyuchen", label: "与林宇晨通话", color: "#3399ee" },
        { key: "rule_break", label: "违规",         color: "#ef4444" }
      ]
    },
    { key: "other",    label: "其他", color: "#a16207", icon: "layers",     countTowardGoal: false,
      subs: [
        { key: "other",         label: "其他",             color: "#a16207" },
        { key: "rule_analyze",  label: "规则部分析事件",   color: "#ca8a04" },
        { key: "rule_break",    label: "违反规则部的事件", color: "#1c1917" },
        { key: "study_materials", label: "整理学习资料等", color: "#ea580c" }
      ]
    },
    { key: "sleep",    label: "睡觉", color: "#1e40af", icon: "moon",       countTowardGoal: false,
      subs: [
        { key: "long_sleep", label: "长睡觉", color: "#2563eb" },
        { key: "nap",        label: "小憩",   color: "#3b82f6" }
      ]
    }
  ],
  /* 常用标签（打标签用，对标时间日志） */
  COMMON_TAGS: ["高效", "低效", "专注", "摸鱼", "西综", "英语", "政治", "刷题", "背书", "听课"],

  /* 「开始吃饭」默认时长（分钟，分度值 5） */
  MEAL_DEFAULT_MINUTES: 30,
  MEAL_STEP_MINUTES: 5,
  /* 三餐对应的块切换：早块→午饭→午块，午块→晚饭→晚块 */
  MEAL_OF_BLOCK: { morning: "lunch", afternoon: "dinner" },

  /* 任务与时间记录联动（任务计时→专注时长累计/完成状态更新）。
   * 必须保持 true：设为 false 时任务页「开始/完成」只改一半状态（曾导致任务永远卡在
   * 计时中、专注时长恒为 0）。不要随意关闭。 */
  TASKS_LINK_TO_TIME_RECORDS: true
};

/* =====================================================================
 *  call-sop.js —— 柔性收尾 · 7 天练习（v1.76.0 新增，独立模块）
 *
 *  ── 定位 ────────────────────────────────────────────────────────
 *  这是一个**指导工具**：帮你在不伤害朋友感受的前提下，逐渐学会温和地
 *  结束通话。它不监督你、不给你打分、不把超时叫失败。
 *
 *  ── 与原有系统的边界（务必遵守，改代码前先读这一段）────────────
 *  ① 不修改原有任何规则、阈值、额度（日 40 / 周 120 / 15min 预警 /
 *     25min 终极 / 3 分钟收尾宽限 / 睡眠段 23:40–07:00 / 晚自习 18:30–23:00
 *     与 23:00–23:40 延展段）。本模块**只读**这些配置，不改一个字。
 *  ② 不建第二套计时器：通话时长一律从 Store.getActiveTimer() 只读获取，
 *     绝不自己累加、绝不重复计算额度。
 *  ③ 不结束/暂停/重置原有计时器，不生成任何通话记录，不自动挂断电话。
 *     「我准备结束通话了」只给话术与流程提示 —— 挂断这个动作永远是你做的。
 *  ④ 柔性 ≠ 加额度：触及硬性时限（25min）或睡眠段时，本模块只显示
 *     「三级 · 必要结束」，不提供任何延长出口。
 *  ⑤ 数据独立存储：localStorage 键 kaoyan:call_sop_v1 + 云端独立 scope
 *     call_sop，绝不写原通话记录/额度/豁免的任何字段。
 *
 *  ── 文案红线 ────────────────────────────────────────────────────
 *  不出现：失败 / 违规 / 惩罚 / 你必须立刻挂断 / 不许再听 / 绝对不能心软 /
 *  对方在操控你 / 只有强硬才能建立边界。断言在 verify-call-sop.js 里锁死。
 *
 *  依赖：config.js / blocks.js / store.js / call-data.js（均只读）
 * ===================================================================== */
window.CallSop = (function () {
  "use strict";

  /* ---------- 存储：独立键 + 独立云端 scope ---------- */
  var LS_KEY = "kaoyan:call_sop_v1";
  var CLOUD_SCOPE = "call_sop";   // 与 call_bypass 同表不同 scope，互不干扰

  /* =====================================================================
   *  数据：7 天计划 / 三级策略 / 挽留应对 / 特殊场景 / 日常模式 / 复盘
   * ===================================================================== */

  /* 7 天练习。第 2/4/6 天与相邻天同一阶段，只是角度略有推进。 */
  var DAYS = [
    {
      d: 1, phase: "练习温柔收尾",
      focus: "先降低结束通话时的心理压力，不追求今天就很准点。",
      points: [
        "允许对方把当前一句话、或当前一个意思说完。",
        "用自然的告别语就好，不用解释太多。",
        "不要求每次都严格按时结束。",
        "合理延长了几分钟也没关系 —— 这里不记失败、不显示违规。"
      ],
      scripts: [
        "我差不多要睡了，你把刚才这句说完吧，我们等下就先休息。",
        "嗯，我听到了。那我们今天先聊到这儿，明天再说。"
      ]
    },
    {
      d: 2, phase: "练习温柔收尾",
      focus: "再练一次：把「听完这一句」当成自然的收尾，而不是延长通话。",
      points: [
        "对方讲到一半时，可以先说「你把这句说完吧」再告别。",
        "说完那句之后如果他开了新话题，可以自然道别，不必继续听完。",
        "不用刻意打断对方，也不用勉强自己一直沉默等他说完。",
        "今天只要有一次自然的收尾，就是练习到了。"
      ],
      scripts: [
        "你把这句说完，我先听着，说完我们就先休息啦。",
        "好，我知道啦。那今天先这样，明天再聊。"
      ]
    },
    {
      d: 3, phase: "提前告知结束时间",
      focus: "让双方提前有预期，而不是等到最后一刻才突然说要挂。",
      points: [
        "通话进行到一半时，可以提前说一句「我今天只能聊到这个时候」。",
        "对方正在讲一个完整的意思，可以听完这一段。",
        "他讲完后又开了新话题，可以把新话题留到下次。",
        "提前告知比突然挂断更自然，也更容易被接受。"
      ],
      scripts: [
        "我今天只能聊到这个时候，等下得准备睡觉了。",
        "我还有一点时间，你想说的先说吧，等下我就得去休息了。"
      ]
    },
    {
      d: 4, phase: "提前告知结束时间",
      focus: "再练一次提前说，试着在还剩几分钟时就讲出来。",
      points: [
        "试试在还剩几分钟的时候就说，不要等到完全撑不住了才提。",
        "说完之后不必再反复解释为什么要结束。",
        "他如果还想再说一点，可以听完当前这一段。",
        "提前说过一次之后，最后那句告别会轻松很多。"
      ],
      scripts: [
        "我等下就得休息了，你把想说的先说完吧。",
        "今天只能聊到这儿啦，剩下的我们改天接着说。"
      ]
    },
    {
      d: 5, phase: "减少反复协商",
      focus: "继续温和，但不因每次挽留都重新开一轮完整的聊天。",
      points: [
        "他恳切地请求再聊一分钟，你可以按当时的精神状态决定。",
        "可以选择听完当前一句，或者只延长一次 —— 就一次。",
        "不要因为他每挽留一次，就重新开放一段时间。",
        "温柔和坚定可以同时存在，不需要二选一。"
      ],
      scripts: [
        "我知道你还想聊，不过我今天真的要休息了，咱们下次接着说。",
        "这个话题挺有意思的，我们改天再聊吧，我先睡了。"
      ]
    },
    {
      d: 6, phase: "减少反复协商",
      focus: "试着把「重申」说得更轻松一点，甚至带点玩笑。",
      points: [
        "重申一次就够了，不必每次都重新说明理由。",
        "可以带点笑意，像朋友之间日常挂电话那样。",
        "如果他还在挽留，说句晚安就可以结束了，不用等他同意。",
        "一次正常的挂断，不是什么关系危机。"
      ],
      scripts: [
        "哈哈，知道你还想聊，今天就先到这儿吧，咱们下次接着说。",
        "真的要睡啦，晚安，明天再聊。"
      ]
    },
    {
      d: 7, phase: "简单复盘",
      focus: "看看哪些方式更自然、更容易长期坚持。不是考试，只是回顾。",
      points: [
        "回顾这 7 天里，哪一次收尾你自己觉得最自然。",
        "有没有哪次是明明不想继续、却因为不好意思而拖着。",
        "想想哪种说法，你和对方都更容易接受。",
        "下周挑一种最舒服的方法继续用就好。"
      ],
      scripts: [],
      review: true
    }
  ];

  /* 三级收尾策略。
   * ⚠️ 二级「温和限时」只在预警（15min）之前可用 —— 用户 2026.10.19 选定最保守口径：
   *    预警一响就不再提供延长出口，避免柔性被当成加额度。 */
  var LEVELS = [
    {
      key: "soft", name: "温柔收尾", tag: "优先选择",
      when: ["对方正在讲一个故事", "对方正在表达一个完整的想法", "对话自然进入尾声", "你愿意听完当前一句或当前一个意思"],
      scripts: [
        "我差不多要睡了，你把这句说完吧。",
        "好，我听着，你把刚才这段说完，我们今天就先到这儿。",
        "嗯，知道了。那咱们明天再聊，我先睡啦。"
      ],
      note: "「听完最后一句」是自然收尾的方法，不是无限延长通话的承诺。" +
            "对方说完这句之后又开了新话题，你可以自然告别，不必继续听完新话题。"
    },
    {
      key: "limit", name: "温和限时", tag: "允许一次合理延长",
      when: ["对方确实还有一点内容要说", "你还有精力继续听一小会儿", "你希望用更柔和的方式逐步结束"],
      scripts: [
        "好，那我再听你说一小会儿，不过我今天真的得睡了。",
        "你把这段说完吧，我等下就准备休息了。",
        "好，再听你说一会儿，之后咱们就先挂了。"
      ],
      note: "给自己一个清楚、可执行的结束点（比如再听两分钟，也可以更短，或者现在就结束）。" +
            "只做**一次**明确的延长决定，之后不再重新协商 —— 这不代表每次挽留都能重新获得一段时间。"
    },
    {
      key: "end", name: "必要结束", tag: "自然告别并结束",
      when: ["你已经明显困倦", "你已经不想继续说话", "第二天有早起、实习、工作或其他必须完成的安排", "已触及原有硬性时间限制", "继续会明显影响睡眠或正常生活"],
      scripts: [
        "我今天真的有点困了，先睡了啊，咱们改天再聊。",
        "我得去休息了，不然明天起不来啦。今天先这样，晚安。",
        "我知道你还想聊，不过我今天得结束了，咱们下次再接着说。"
      ],
      note: "这一级不是惩罚，只是确实需要结束时，给你一个简单、自然的退出方式。"
    }
  ];

  /* 对方挽留时的递进应对。不把挽留判定为恶意，不猜对方动机。 */
  var URGE = [
    { step: "第一次挽留", hint: "可以给一点空间。",
      scripts: ["好，你把这句说完吧，我等下真的得睡了。"],
      extra: "如果你当时确实愿意多听一会儿，也可以选择短暂延长一次 —— 这是你自己的选择，不是必须。" },
    { step: "再次挽留", hint: "温柔重申，不用重新解释一遍。",
      scripts: ["哈哈，我知道你还想聊，今天就先到这儿吧，咱们下次接着说。"],
      extra: "重申一次就够了。语气可以轻松一点，像平时挂电话那样。" },
    { step: "仍然继续挽留", hint: "不必争论，也不必不断解释。",
      scripts: ["真的要睡啦，晚安，明天再聊。"],
      extra: "说完这句就可以正常结束通话了。你不需要等到对方同意，也不需要证明自己有多困。" }
  ];
  var URGE_RULES = [
    "不要求每次必须重复两次或三次，也不要求机械地完成固定次数。",
    "不必为了显得礼貌而一直等对方点头。",
    "不用反复说明自己为什么需要休息。",
    "允许轻松、带一点玩笑的语气。",
    "一次正常的挂断，不是什么关系危机。"
  ];

  /* 特殊场景 A–G（可折叠）。每个场景都保留「你可以不听完」这个出口。 */
  var SCENES = [
    {
      key: "A", title: "我已经不想说话，但他还想说",
      say: "我现在有点困了，不太想说话了。你把刚才那件事说完吧，说完我们就先睡了。",
      tips: [
        "这是**可选**的收尾方式，不是必须照做。",
        "你完全可以不继续听 —— 不想说话时直接告别也很好。",
        "他如果一直讲下去，提醒一次就可以正常道别了。",
        "不要把「沉默陪听」当成必须完成的步骤；结束的意图要说清楚。"
      ]
    },
    {
      key: "B", title: "他刚开始一个新话题",
      say: "这个我还挺想听的，不过今天先不展开了，咱们下次接着说。",
      say2: "你先记着，改天再跟我讲，我今天真的要睡啦。",
      tips: [
        "新话题有趣、重要、或者突然出现，都不重新计算通话时长。",
        "把它留到下次，对双方都更舒服。",
        "不用因为话题重要就立刻重新开一轮。"
      ]
    },
    {
      key: "C", title: "他还没说完一件重要的事",
      say: "我知道这件事对你挺重要的，我现在有点撑不住了，咱们明天找时间继续说，好吗？",
      tips: [
        "内容确实重要、你还有精力 —— 可以多听一点，由你判断。",
        "你已经很疲惫 —— 说明现在无法继续，约定下次再听。",
        "不是所有情绪倾诉都必须当场完整听完。",
        "如果你判断情况真的紧急，请按现实情况寻求合适的及时支持，别只依赖这里的建议。"
      ]
    },
    {
      key: "D", title: "我担心挂断会让他失望",
      say: "他可能还想聊，但这不代表你必须继续聊。",
      tips: [
        "你可以关心他的感受，同时正常结束今天的通话。",
        "这不需要被谁批准 —— 休息是正常的安排。",
        "一次犹豫不是失败，也不代表你不够坚定。"
      ]
    },
    {
      key: "E", title: "我已经很困了",
      say: "我今天真的有点困了，先睡了啊，咱们改天再聊。",
      tips: [
        "困意已经明显影响状态时，直接结束就是合理选择。",
        "不必先听完一句、再等一轮、再重复声明 —— 那只会更累。",
        "直接说晚安就好。"
      ]
    },
    {
      key: "F", title: "对方沉默了",
      tips: [
        "不要把沉默自动理解成生气、不高兴或拒绝结束。",
        "你已经完成告别，就可以自然结束了。",
        "不需要专门等够某个秒数，也不用为了填补沉默而重新开话题。"
      ]
    },
    {
      key: "G", title: "结束后他又打来了",
      tips: [
        "这里只负责帮你结束**当前**这次通话，不接管接听判断。",
        "再次来电时，仍按原有的接听规则、时间限制和你自己的意愿决定。",
        "没有「再次来电一律拒接」这种规则 —— 按你当时的情况来。"
      ]
    }
  ];

  /* 7 天之后的日常模式。不自动切换，也不把第 8 天设成硬性分界线。 */
  var DAILY = {
    title: "日常模式",
    lead: "过渡期结束之后，你可以继续留在这里，也可以重新开始一轮练习。" +
          "日常模式不是「变严格」，只是让边界更稳定一点。",
    keeps: [
      "温柔收尾仍然优先。",
      "仍然可以听完当前一句、或当前一个意思。",
      "仍然可以有合理、有限的短暂延长。",
      "仍然用自然的告别话术。",
      "特殊情况仍然允许灵活判断。"
    ],
    diff: "与过渡期的区别只有一点：逐渐减少因反复挽留而不断延长的情况，更稳定地执行原有时间边界。",
    scripts: [
      "我今天得先休息了，你把这句说完吧。",
      "我知道你还想聊，不过今天真的到这儿啦，咱们下次接着说。",
      "我先睡了，晚安，明天再聊。"
    ]
  };

  /* 第 7 天（以及之后任何时候）的简单复盘。不排名、不打分。 */
  var REVIEW = [
    "我这几天是不是比以前更容易自然地结束通话了？",
    "我有没有减少因为不好意思拒绝而被动延长的时间？",
    "哪种收尾方式，让我和朋友都比较容易接受？",
    "哪些场景最容易让我心软？",
    "下周我最想保留哪一种方法？"
  ];

  /* 硬性时限已到 / 睡眠段时的统一提示（唯一允许「不再柔」的地方） */
  var HARD_NOTE = "已经触及原有硬性时间限制（或已经到了该睡的时间）" +
                  "—— 这一刻不用再找更柔和的说法，直接说晚安就好。";

  /* =====================================================================
   *  只读：拿原有系统的状态（绝不写回、绝不重算）
   * ===================================================================== */
  function todayKey() {
    return (window.Blocks && window.Blocks.bizDateStr)
      ? window.Blocks.bizDateStr()
      : new Date().toISOString().slice(0, 10);
  }
  function dayDiff(a, b) {
    var pa = String(a).split("-").map(Number), pb = String(b).split("-").map(Number);
    if (pa.length < 3 || pb.length < 3) return 0;
    var da = Date.UTC(pa[0], pa[1] - 1, pa[2]), db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((db - da) / 86400000);
  }
  /* 睡眠段 23:40–07:00（只读 call-data.js 的配置，绝不改） */
  function inSleepWindow() {
    var ns = (window.CALL_DATA && window.CALL_DATA.nightStudy) || {};
    var sf = ns.sleepFrom || "23:40", st = ns.sleepTo || "07:00";
    var now = window.Blocks && window.Blocks.beijing ? window.Blocks.beijing(new Date()) : new Date();
    var m = now.getHours() * 60 + now.getMinutes();
    return m >= toMin(sf) || m < toMin(st);
  }
  function toMin(t) { var p = String(t).split(":"); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); }

  /* 当前通话已进行分钟数 —— 只读 active_timer，不累加、不建第二套计时 */
  function callElapsedMin() {
    var at = (window.Store && window.Store.getActiveTimer) ? window.Store.getActiveTimer() : null;
    if (!at || at.kind !== "call") return null;
    var base = Number(at.elapsed_sec || 0);
    if (at.status === "running" && at.started_at) base += (Date.now() - Number(at.started_at)) / 1000;
    return base / 60;
  }
  function thresholds() {
    var r = (window.CALL_DATA && window.CALL_DATA.rules) || {};
    return { warn: Number(r.warnMinutes) || 15, max: Number(r.callMaxMinutes) || 25 };
  }

  /* 当前可用哪几级 —— 这是「柔性 ≠ 加额度」的落地点。
   * ★ v1.77.1（用户 2026.10.20）：同时给出**每一级被关闭的原因**（why），
   *   界面上点「当前不适用」就能展开看到，不用猜。 */
  function levelsNow() {
    var el = callElapsedMin();
    var t = thresholds();
    if (inSleepWindow()) return {
      keys: ["end"], elapsed: el, hard: true, why: {
        soft: "现在是强制睡眠段（23:40–07:00，含准备睡觉时间）。这个时间点不再做「收尾谈判」——越谈越晚，直接说晚安就好。",
        limit: "睡眠段没有「再听一会儿」这回事：延长会直接压掉睡眠时间，而且 ⑫ 明确不得通话。"
      }
    };
    if (el == null) return { keys: ["soft", "limit", "end"], elapsed: null, hard: false, why: {} };
    if (el >= t.max) return {
      keys: ["end"], elapsed: el, hard: true, why: {
        soft: "已经超过 " + t.max + " 分钟终极时限。这时候再「慢慢收尾」，实际只会把通话拖得更长——直接告别是唯一出口。",
        limit: "超过 " + t.max + " 分钟终极时限后不再提供任何延长，避免柔性被当成加额度。"
      }
    };
    if (el >= t.warn) return {
      keys: ["soft", "end"], elapsed: el, hard: false, why: {
        limit: "已经过了 " + t.warn + " 分钟预警（距 " + t.max + " 分钟终极时限只剩 " + (t.max - t.warn) + " 分钟）。" +
          "延长出口在这里关闭——柔性不等于每次挽留都重新获得一段时间。"
      }
    };
    return { keys: ["soft", "limit", "end"], elapsed: el, hard: false, why: {} };           // 15min 内三级全开
  }

  /* =====================================================================
   *  进度存储（独立键 + 云端镜像）
   * ===================================================================== */
  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { s = null; }
    if (!s || typeof s !== "object") s = { v: 1, start: "", mode: "transition", reviews: {} };
    if (!s.start) s.start = todayKey();      // 用户选定：首次打开即第 1 天
    if (!s.mode) s.mode = "transition";
    if (!s.reviews || typeof s.reviews !== "object") s.reviews = {};
    return s;
  }
  function save(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { }
    /* 云端镜像：走独立 scope，绝不碰通话记录/额度/豁免 */
    try {
      if (window.Store && window.Store.setShared) window.Store.setShared(CLOUD_SCOPE, s);
    } catch (e) { }
  }
  /* 启动时拉一次云端（三端一致）：本地没有进度而云端有 → 用云端 */
  function syncFromCloud() {
    if (!(window.Store && window.Store.getShared)) return Promise.resolve();
    return window.Store.getShared(CLOUD_SCOPE, null).then(function (cloud) {
      if (!cloud || typeof cloud !== "object" || !cloud.start) return;
      var local = load();
      var fresh = !local.start || dayDiff(local.start, todayKey()) >= 0 && cloud.start < local.start;
      if (fresh) { try { localStorage.setItem(LS_KEY, JSON.stringify(cloud)); } catch (e) { } }
    }).catch(function () { });
  }

  function dayNow(s) {
    var n = dayDiff(s.start, todayKey()) + 1;
    return n < 1 ? 1 : n;
  }

  /* =====================================================================
   *  渲染
   * ===================================================================== */
  function esc(x) {
    return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var _pick = {};        // 「换一种更自然的说法」的轮换游标
  var _lastSig = "";     // 上次渲染时的「可用级别签名」，用于心跳判断要不要整卡重绘

  /* ★ v1.77.3（用户 2026.10.20 指定）：话术一键复制。
   * ⚠️ 轮换「换一种说法」时是重建 .sop-lv-say 的 innerHTML，
   *    所以按钮必须和文本一起重建 —— 只在初始渲染拼一次的话，点一次轮换按钮就没了。 */
  function copyBtn(txt) {
    return '<button type="button" class="sop-copy" data-sop-copy="' + esc(txt) + '">复制</button>';
  }
  function legacyCopy(txt) {
    try {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) { }
  }
  function copyText(txt) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function () { legacyCopy(txt); });
        return;
      }
    } catch (e) { }
    legacyCopy(txt);   // 非 https / 老浏览器兜底
  }

  function scriptsFor(key, arr) {
    if (!arr || !arr.length) return "";
    var i = _pick[key] || 0;
    var s = arr[i % arr.length];
    return s;
  }
  function rotate(key, arr) {
    if (!arr || !arr.length) return "";
    _pick[key] = ((_pick[key] || 0) + 1) % arr.length;
    return scriptsFor(key, arr);
  }

  /* 计时器联动条：单独抽出来，好让心跳只更新这一行而不重建整张卡
   * （整卡重建会把用户展开的折叠面板收起来、把按钮输出清掉——体验很差）。 */
  function liveHtml(lv) {
    if (lv.elapsed == null) {
      return '<div class="sop-live is-idle" id="sopLive"><span class="sop-live-dot"></span>' +
        '<span>当前没有进行中的通话 · 下面是今天可以先看一眼的收尾建议</span></div>';
    }
    var t = thresholds();
    var tip = lv.hard
      ? "已到硬性时间限制 · 只提供「必要结束」"
      : (lv.elapsed >= t.warn ? "已过 " + t.warn + " 分钟预警 · 延长出口已关闭" : "还有余量 · 三级都可用");
    var h = '<div class="sop-live ' + (lv.hard ? "is-hard" : "") + '" id="sopLive">' +
      '<span class="sop-live-dot"></span>' +
      '<span>通话已进行 <b>' + Math.floor(lv.elapsed) + ' 分</b> · ' + esc(tip) + '</span></div>';
    if (lv.hard) h += '<div class="sop-note">' + esc(HARD_NOTE) + '</div>';
    return h;
  }

  function render() {
    var box = document.getElementById("sopCard");
    if (!box) return;
    var s = load();
    var d = dayNow(s);
    var lv = levelsNow();
    var day = DAYS.filter(function (x) { return x.d === d; })[0] || DAYS[0];
    var done = d > 7;

    /* ★ 重建前先记下用户的展开状态与按钮输出，重建后原样恢复。
     *   否则任何一次重绘（模式切换、心跳、点击）都会把折叠面板收起来。 */
    var openIdx = [];
    Array.prototype.forEach.call(box.querySelectorAll("details.sop-fold"), function (el, i) {
      if (el.open) openIdx.push(i);
    });
    /* v1.77.1：原因气泡（details.sop-lv-why）也要记住展开状态 */
    var openWhy = {};
    Array.prototype.forEach.call(box.querySelectorAll("details.sop-lv-why"), function (d) {
      if (d.open && d.dataset.why) openWhy[d.dataset.why] = 1;
    });
    var oldOut = document.getElementById("sopOut");
    var outHtml = oldOut ? oldOut.innerHTML : "";
    var outShown = !!(oldOut && oldOut.style.display !== "none");

    var html = "";

    /* ── 头部：模式 + 进度 ── */
    html += '<div class="sop-head">' +
      '<div class="sop-title">柔性收尾 · 7 天练习</div>' +
      '<div class="sop-sub">温柔地结束聊天，也好好照顾自己。</div>' +
      /* ★ v1.77.3（用户 2026.10.20）：一句话把分工说清 ——
       *   本卡管「已经接起来之后怎么收」，接不接由上方管控卡的裁定管。
       *   不加这句的话，想找挂电话的话术时很容易先点管控卡，结果拿到的是裁定。 */
      '<div class="sop-scope">这里管的是<b>已经接起来之后怎么收</b>；接不接，先点上方管控卡做一次裁定。</div>' +
      '<div class="sop-meta">' +
        '<span class="sop-chip ' + (s.mode === "daily" ? "is-daily" : "is-tran") + '">' +
          (s.mode === "daily" ? "日常模式" : "过渡模式") + '</span>' +
        '<span class="sop-chip is-day">' + (done ? "练习期已过" : "第 " + d + " / 7 天") + '</span>' +
      '</div>' +
      '<div class="sop-progress"><i style="width:' + Math.min(100, Math.round(d / 7 * 100)) + '%"></i></div>' +
    '</div>';

    /* ── 计时器联动（只读展示，不接管） ── */
    html += liveHtml(lv);

    /* ── 今天的练习重点 ── */
    html += '<div class="sop-today">' +
      '<div class="sop-today-h">今天：' + esc(done ? "练习期已过，可以切到日常模式" : (day.phase || "")) + '</div>' +
      '<div class="sop-today-f">' + esc(done ? DAILY.lead : (day.focus || "")) + '</div>';
    if (!done && day.points && day.points.length) {
      html += '<ul class="sop-ul">' + day.points.map(function (p) {
        return '<li>' + esc(p) + '</li>';
      }).join("") + '</ul>';
    }
    html += '</div>';

    /* ── 三级策略（按当前可用级别过滤） ── */
    html += '<div class="sop-sec-t">现在可以怎么收尾</div><div class="sop-levels">';
    LEVELS.forEach(function (L) {
      var usable = lv.keys.indexOf(L.key) >= 0;
      var sayTxt = scriptsFor(L.key, L.scripts);
      html += '<div class="sop-lv ' + (usable ? "" : "is-off") + '" data-lv="' + L.key + '">' +
        '<div class="sop-lv-h"><span class="sop-lv-n">' + esc(L.name) + '</span>' +
        '<span class="sop-lv-tag">' + esc(L.tag) + '</span></div>' +
        /* ★ v1.77.1：不可用时给一个可点的气泡，点开就是「为什么现在不适用」 */
        (usable ? "" :
          '<details class="sop-lv-why" data-why="' + L.key + '">' +
            '<summary><span class="sop-lv-off">当前不适用 · 点开看原因</span></summary>' +
            '<div class="sop-why-b">' +
              esc((lv.why && lv.why[L.key]) || "当前条件下这一级不开放。") +
            '</div>' +
          '</details>') +
        '<div class="sop-lv-when">' + L.when.map(function (w) {
          return '<span class="sop-kw">' + esc(w) + '</span>';
        }).join("") + '</div>' +
        '<div class="sop-lv-say" data-say="' + L.key + '">' + esc(sayTxt) + copyBtn(sayTxt) + '</div>' +
        '<div class="sop-lv-note">' + esc(L.note) + '</div>' +
        (usable
          ? '<button type="button" class="sop-btn ghost" data-sop-rot="' + L.key + '">换一种更自然的说法</button>'
          : '') +
      '</div>';
    });
    html += '</div>';

    /* ── 快捷按钮 ── */
    html += '<div class="sop-acts">' +
      '<button type="button" class="sop-btn" data-sop-act="listen">我想听完当前这一段</button>' +
      '<button type="button" class="sop-btn" data-sop-act="ending">我准备结束通话了</button>' +
      '<button type="button" class="sop-btn ghost" data-sop-act="plan">查看 7 天过渡计划</button>' +
      '<button type="button" class="sop-btn ghost" data-sop-act="review">完成今天的简单复盘</button>' +
    '</div>';
    html += '<div class="sop-out" id="sopOut" style="display:none"></div>';

    /* ── 对方挽留（折叠） ── */
    html += '<details class="sop-fold"><summary>对方挽留时怎么办</summary><div class="sop-fold-b">';
    URGE.forEach(function (u, i) {
      html += '<div class="sop-urge">' +
        '<div class="sop-urge-s">' + esc(u.step) + '<span class="sop-urge-h">' + esc(u.hint) + '</span></div>' +
        '<div class="sop-say">' + esc(u.scripts[0]) + copyBtn(u.scripts[0]) + '</div>' +
        '<div class="sop-urge-e">' + esc(u.extra) + '</div>' +
      '</div>';
    });
    html += '<ul class="sop-ul dim">' + URGE_RULES.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join("") + '</ul>';
    html += '</div></details>';

    /* ── 特殊情况（折叠） ── */
    html += '<details class="sop-fold"><summary>特殊情况</summary><div class="sop-fold-b">';
    SCENES.forEach(function (sc) {
      html += '<div class="sop-scene"><div class="sop-scene-t">' + esc(sc.key) + ' · ' + esc(sc.title) + '</div>';
      if (sc.say) html += '<div class="sop-say">' + esc(sc.say) + copyBtn(sc.say) + '</div>';
      if (sc.say2) html += '<div class="sop-say alt">' + esc(sc.say2) + copyBtn(sc.say2) + '</div>';
      html += '<ul class="sop-ul dim">' + sc.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join("") + '</ul></div>';
    });
    html += '</div></details>';

    /* ── 7 天计划（折叠，含日常模式） ── */
    html += '<details class="sop-fold"><summary>7 天过渡计划</summary><div class="sop-fold-b">';
    DAYS.forEach(function (x) {
      html += '<div class="sop-day' + (x.d === d ? " is-now" : "") + '">' +
        '<div class="sop-day-h">第 ' + x.d + ' 天 · ' + esc(x.phase) + (x.d === d ? ' <span class="sop-now">今天</span>' : '') + '</div>' +
        '<div class="sop-day-f">' + esc(x.focus) + '</div>' +
        (x.scripts && x.scripts.length
          ? '<div class="sop-say">' + esc(x.scripts[0]) + copyBtn(x.scripts[0]) + '</div>' +
            (x.scripts[1] ? '<div class="sop-say alt">' + esc(x.scripts[1]) + copyBtn(x.scripts[1]) + '</div>' : '')
          : '') +
      '</div>';
    });
    html += '<div class="sop-daily"><div class="sop-daily-t">' + esc(DAILY.title) + '</div>' +
      '<div class="sop-daily-l">' + esc(DAILY.lead) + '</div>' +
      '<ul class="sop-ul">' + DAILY.keeps.map(function (k) { return '<li>' + esc(k) + '</li>'; }).join("") + '</ul>' +
      '<div class="sop-daily-d">' + esc(DAILY.diff) + '</div>' +
      '<div class="sop-acts inline">' +
        (s.mode === "daily"
          ? '<button type="button" class="sop-btn ghost" data-sop-mode="transition">回到过渡模式</button>'
          : '<button type="button" class="sop-btn ghost" data-sop-mode="daily">切换到日常模式</button>') +
        '<button type="button" class="sop-btn ghost" data-sop-mode="restart">重新开始一轮练习</button>' +
      '</div></div>';
    html += '</div></details>';

    /* ── 第 7 天之后的提示（不自动切换） ── */
    if (done && s.mode !== "daily") {
      html += '<div class="sop-tip">7 天练习期已经走完了。这里不会自动把你切成严格模式 ——' +
        '你可以继续留在过渡模式，也可以自己在上面切到日常模式，或者再练一轮。</div>';
    }

    box.innerHTML = html;
    bind();
    /* 恢复展开状态与按钮输出（与上面的保存配对） */
    Array.prototype.forEach.call(box.querySelectorAll("details.sop-fold"), function (el, i) {
      if (openIdx.indexOf(i) >= 0) el.open = true;
    });
    Array.prototype.forEach.call(box.querySelectorAll("details.sop-lv-why"), function (d) {
      if (d.dataset.why && openWhy[d.dataset.why]) d.open = true;
    });
    if (outShown) {
      var o = document.getElementById("sopOut");
      if (o) { o.style.display = ""; o.innerHTML = outHtml; }
    }
    _lastSig = lv.keys.join(",");
    if (window.Icon && window.Icon.inject) { try { window.Icon.inject(box); } catch (e) { } }
  }

  /* ---------- 交互 ---------- */
  function bind() {
    var box = document.getElementById("sopCard");
    if (!box || box.__sopBound) return;
    box.__sopBound = true;

    box.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-sop-rot],[data-sop-act],[data-sop-mode],[data-sop-copy]") : null;
      if (!t) return;
      var out = document.getElementById("sopOut");

      /* 换一种更自然的说法 —— 只轮换本模块自己的文案，不碰任何系统状态 */
      if (t.dataset.sopRot) {
        var L = LEVELS.filter(function (x) { return x.key === t.dataset.sopRot; })[0];
        var say = box.querySelector('[data-say="' + t.dataset.sopRot + '"]');
        if (L && say) {
          var nx = rotate(L.key, L.scripts);
          /* ★ v1.77.3：必须连复制按钮一起重建，否则点一次轮换按钮就消失了 */
          say.innerHTML = esc(nx) + copyBtn(nx);
        }
        return;
      }

      /* ★ v1.77.3 复制话术（只写剪贴板，不碰任何系统状态） */
      if (t.dataset.sopCopy) {
        copyText(t.dataset.sopCopy);
        var oldTxt = t.textContent;
        t.textContent = "已复制";
        t.classList.add("is-done");
        setTimeout(function () {
          t.textContent = oldTxt;
          t.classList.remove("is-done");
        }, 1500);
        return;
      }

      /* 我想听完当前这一段 */
      if (t.dataset.sopAct === "listen") {
        var lvNow = levelsNow();
        /* ★ v1.77.1 修一个自埋的后门：睡眠段 / 已过 25 分钟时，一级「温柔收尾」已被锁掉，
         *   但这里如果还无条件发一级话术，等于从按钮绕过了「延长出口已关闭」——
         *   必须跟着级别走，否则「柔性≠加额度」就是句空话。 */
        if (lvNow.keys.indexOf("soft") < 0) {
          if (out) {
            out.style.display = "";
            out.innerHTML = '<div class="sop-out-h">现在不适合再「听完这一段」</div>' +
              '<div class="sop-out-n">' +
                esc((lvNow.why && lvNow.why.soft) || "当前状态已经不提供收尾谈判。") +
              '</div>' +
              '<div class="sop-say">' + esc(LEVELS[2].scripts[0]) + copyBtn(LEVELS[2].scripts[0]) + '</div>' +
              '<div class="sop-out-n">直接说这句就够，不用再找更委婉的说法。</div>';
          }
          return;
        }
        var soft = LEVELS[0];
        if (out) {
          out.style.display = "";
          out.innerHTML = '<div class="sop-out-h">先听完这一句，然后就可以告别了</div>' +
            '<div class="sop-say">' + esc(soft.scripts[0]) + copyBtn(soft.scripts[0]) + '</div>' +
            '<div class="sop-out-n">他讲完这句之后如果又开了新话题，你可以自然道别 ——' +
            '「听完最后一句」是收尾的方法，不是继续聊的承诺。</div>';
        }
        return;
      }

      /* 我准备结束通话了 —— 只给话术与流程提示，绝不声称挂断、绝不动计时器 */
      if (t.dataset.sopAct === "ending") {
        var end = LEVELS[2];
        if (out) {
          out.style.display = "";
          out.innerHTML = '<div class="sop-out-h">说这句，然后按原有流程结束</div>' +
            '<div class="sop-say">' + esc(end.scripts[0]) + copyBtn(end.scripts[0]) + '</div>' +
            '<div class="sop-out-n">挂断电话这个动作仍然是你在手机上完成 —— 这个页面不会、' +
            '也没有能力替你挂断真实电话。结束后如果开过计时，记得按原有流程停表。</div>';
        }
        return;
      }

      /* 查看 7 天过渡计划 —— 展开对应的折叠面板 */
      if (t.dataset.sopAct === "plan") {
        var f = box.querySelectorAll("details.sop-fold")[2];
        if (f) { f.open = true; f.scrollIntoView({ behavior: "smooth", block: "start" }); }
        return;
      }

      /* 完成今天的简单复盘 */
      if (t.dataset.sopAct === "review") {
        if (out) {
          out.style.display = "";
          out.innerHTML = '<div class="sop-out-h">简单复盘（只给自己看，不打分、不排名）</div>' +
            '<ul class="sop-ul">' + REVIEW.map(function (q, i) {
              return '<li><label class="sop-q"><input type="checkbox" data-sop-q="' + i + '" /> ' + esc(q) + '</label></li>';
            }).join("") + '</ul>' +
            '<div class="sop-out-n">想的时候勾一勾就好。没有哪次超时会让这里变成失败记录 ——' +
            '这只是帮你记住哪种方法更适合自己。</div>' +
            '<button type="button" class="sop-btn" data-sop-save="1">保存今天的复盘</button>';
        }
        return;
      }

      /* 保存复盘（只写本模块独立存储） */
      if (t.dataset.sopSave) {
        var s = load();
        var picked = [];
        box.querySelectorAll("[data-sop-q]").forEach(function (cb, i) { if (cb.checked) picked.push(i); });
        s.reviews[todayKey()] = { picked: picked, at: new Date().toISOString(), day: dayNow(s) };
        save(s);
        if (out) out.insertAdjacentHTML("beforeend", '<div class="sop-out-ok">已记下（存在本模块自己的存储里，不影响任何通话记录）</div>');
        return;
      }

      /* 模式切换 / 重开一轮 —— 只改本模块状态，不碰原有任何数据 */
      if (t.dataset.sopMode) {
        var st = load();
        if (t.dataset.sopMode === "daily") { st.mode = "daily"; }
        else if (t.dataset.sopMode === "transition") { st.mode = "transition"; }
        else if (t.dataset.sopMode === "restart") { st.start = todayKey(); st.mode = "transition"; }
        save(st);
        render();
        return;
      }
    });
  }

  function init() {
    /* 先尝试拉云端（三端一致），再渲染 */
    try { syncFromCloud(); } catch (e) { }
    render();
    /* 每 30 秒跟一次通话计时（只读）。
     * ★ 不整卡重绘：只有「可用级别」真的变了（跨过 15min / 25min、进出睡眠段）才重建，
     *   否则只更新那一行的分钟数 —— 否则会打断用户正在看的折叠面板与按钮输出。 */
    setInterval(function () {
      var box = document.getElementById("sopCard");
      if (!box || document.visibilityState === "hidden") return;
      var lv = levelsNow();
      var sig = lv.keys.join(",");
      if (sig !== _lastSig) { render(); return; }
      var liveEl = document.getElementById("sopLive");
      if (liveEl) liveEl.outerHTML = liveHtml(lv);
    }, 30000);
  }

  return {
    init: init, render: render,
    /* 供断言用（只读） */
    _data: { DAYS: DAYS, LEVELS: LEVELS, URGE: URGE, URGE_RULES: URGE_RULES,
             SCENES: SCENES, DAILY: DAILY, REVIEW: REVIEW },
    _keys: { LS: LS_KEY, CLOUD: CLOUD_SCOPE },
    levelsNow: levelsNow, dayNow: dayNow, load: load
  };
})();

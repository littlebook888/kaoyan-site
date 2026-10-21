/* =====================================================================
 *  call-missed.js —— 「漏接之后 · 事后怎么解释」（v1.83.0 全新独立板块）
 *
 *  为什么单独开一块（用户 2026.10.21 指定「以全新的独立板块进行」）：
 *    站内原有的一切话术都服务「此刻接不接」——
 *      拒接（今天不聊 / 非隔天 / 临睡前 / 23:40 后）
 *      通话中（到点挂断 / 没声音 / 说完理由他还拖）
 *      我方回拨（接通开场 / 我打给他没接的留言）
 *    唯独没有「**昨天没接，今天他问起**」这一类：那是**回溯性追问**，
 *    时态、语气、风险都和"当场拒接"完全不同（当场拒接他没时间核实，
 *    事后解释他有整晚时间旁敲侧击）。硬塞进话术中心会串味，所以独立成块。
 *
 *  边界（与柔性收尾同一套口径）：
 *    ① 纯文案板块：不判定、不记录、不接管任何流程、不碰计时器与额度；
 *    ② 不写任何存储（连"选过哪条理由"都不存）—— 它只是给人抄一句话；
 *    ③ 不生成通话记录、不声称替用户回复任何消息。
 *
 *  三条设计结论（来自对现有素材的核查）：
 *    ① 现有 excuses 池全是「刚忙完才看到」的即时句式，套到"昨天"上会露馅；
 *    ② excuses 是**按日期哈希每天换一句**的，同一件事被追问两三次时，
 *       昨天说值班、今天说没电 → 前后矛盾，反而更像敷衍；
 *       → 所以本板块只给**一条主干理由**，明确"别每天换剧情"。
 *    ③ 最有效的不是解释，是**趁他没问先发一条文字**（追问的真实动机多半是
 *       "不确定你还在不在意"），所以第 ③ 档放在最后，但它才是首选。
 * ===================================================================== */
window.CallMissed = (function () {
  var HOST_ID = "missedCard";

  /* ---------- 三档：按"他怎么问"分，不按"你有多愧疚"分 ---------- */
  var TIERS = [
    {
      key: "lite", no: "①", name: "他只是随口一问", tag: "一句带过",
      when: "语气平常，就是顺口问一句「昨天怎么没接」",
      rule: "**解释不超过一句**。说得越多越像心虚，也越容易被接着追问。",
      items: [
        { use: "早睡 + 静音", text: "昨天睡得早，手机没在手边。怎么了，有事？" },
        { use: "忙完已晚", text: "昨天忙完太晚，看到的时候已经不方便回了。你说，什么事？" },
        { use: "手机静音", text: "昨天手机静音了，一直没看。怎么了？" },
        { use: "最短一句", text: "昨天没注意手机。你说吧，什么事？" }
      ]
    },
    {
      key: "press", no: "②", name: "他带着情绪追问", tag: "接住 + 给出口",
      when: "「你怎么老不接」「是不是不想理我」——带指责、委屈，或者翻旧账",
      rule: "顺序是：**接住情绪 → 承认这段确实乱 → 给文字出口**。" +
            "**不要承诺「以后都接」** —— 做不到的下一次比这一次更难看。",
      items: [
        { use: "承认 + 出口", text: "这阵子确实乱，电话经常接不上。有事你发文字，我看到就回。" },
        { use: "否认故意", text: "不是故意不接，是真的顾不上。要紧的事发文字给我，我一定回。" },
        { use: "接住情绪（重）", text: "我知道连着几次没接上，你肯定不舒服。这段时间我确实接不了几个电话，有事发文字最稳。" },
        { use: "澄清动机（轻）", text: "没什么别的意思，就是太累了，一到晚上不想看手机。有事发文字哈。" }
      ]
    },
    {
      key: "pre", no: "③", name: "趁他还没问，先发一条", tag: "最省事 · 首选",
      when: "你预感到他今晚会问，或者这个月已经漏了两三次",
      rule: "追问的真实动机，多半不是「想知道你去哪了」，而是**不确定你还在不在意**。" +
            "一条主动的文字能消掉大半追问 —— 这比任何解释都省力。",
      items: [
        { use: "补一句 · 忙", text: "刚看到你打过，昨天忙完太晚就没回。有事发文字，我今天看到就回。" },
        { use: "补一句 · 静音", text: "昨天没接上，手机静音了一晚上。有事发文字给我。" },
        { use: "补一句 · 早睡", text: "昨天睡得早，没接到你电话。你方便的话发文字，我回你。" }
      ]
    }
  ];

  /* ---------- 理由只用一条：换剧情比不说更糟 ---------- */
  var REASONS = [
    {
      key: "early", label: "早睡", pick: "推荐",
      lines: ["回来就睡了", "昨晚睡得早", "忙完倒头就睡"],
      note: "和你 23:40 的睡眠线天然一致，长期复用不会前后矛盾。"
    },
    {
      key: "mute", label: "静音 / 手机不在手边",
      lines: ["手机静音了一晚上", "手机没在手边", "手机一直静音没看"],
      note: "最中性、最不容易被追问，也不涉及任何能被核实的细节。"
    },
    {
      key: "busy", label: "忙",
      lines: ["这段确实忙得乱", "昨天忙完太晚", "手头的事一直没断"],
      note: "最像医学生，但**连用三次以上**会引来「你怎么天天忙」，要配着前两条换。"
    }
  ];

  var DONT = [
    {
      t: "别说「我在按作息安排接电话」",
      d: "一旦他知道你有一套固定的接听安排，追问会立刻变成「你是不是不想跟我联系」——" +
         "那比「你昨天没接」难处理得多。"
    },
    {
      t: "别给能被核实的假细节",
      d: "跟台手术、参与抢救、具体哪个科室、几床病人——「没接电话」这件事他有整晚时间旁敲侧击，一戳就破。" +
         "模糊而真实（忙 / 早睡 / 静音）比精确而编造安全得多。"
    },
    {
      t: "别承诺「以后一定接」",
      d: "这是最容易脱口而出、也最容易失信的一句。真想说点什么，就说「有事发文字我一定回」——" +
         "这一条你做得到。"
    }
  ];

  /* ---------- 工具 ---------- */
  function esc(x) {
    var s = String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
    /* 与 call-sop 同款：先转义再转粗体，顺序不可反 */
    return s.replace(/\*\*([^*<>]+)\*\*/g, "<b>$1</b>");
  }

  function copyText(t, btn) {
    var done = function () {
      if (window.UI && window.UI.showAlert) window.UI.showAlert("已复制，直接粘过去就行", 1800);
      if (btn) {
        var old = btn.textContent;
        btn.textContent = "✓";
        setTimeout(function () { btn.textContent = old; }, 1200);
      }
    };
    var fail = function () {
      if (window.UI && window.UI.showAlert) window.UI.showAlert("复制失败，长按选中这句手动复制", 2600);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, function () { legacyCopy(t, done, fail); });
        return;
      }
    } catch (e) { /* 落到兜底 */ }
    legacyCopy(t, done, fail);
  }
  function legacyCopy(t, done, fail) {
    try {
      var ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? done() : fail();
    } catch (e) { fail(); }
  }

  function copyBtn(text) {
    return '<button type="button" class="lm-copy" data-lm-copy="1" ' +
      'data-lm-text="' + esc(text) + '" title="复制这一句">复制</button>';
  }

  /* ---------- 渲染 ---------- */
  function tierHtml(t) {
    return '<div class="lm-tier" data-tier="' + esc(t.key) + '">' +
      '<div class="lm-tier-h">' +
        '<span class="lm-tier-no">' + esc(t.no) + '</span>' +
        '<span class="lm-tier-n">' + esc(t.name) + '</span>' +
        '<span class="lm-tier-tag">' + esc(t.tag) + '</span>' +
      '</div>' +
      '<div class="lm-tier-when">什么时候用：' + esc(t.when) + '</div>' +
      '<div class="lm-tier-rule">' + esc(t.rule) + '</div>' +
      '<div class="lm-says">' +
        t.items.map(function (it) {
          return '<div class="lm-say">' +
            '<span class="lm-say-use">' + esc(it.use) + '</span>' +
            '<span class="lm-say-t">' + esc(it.text) + '</span>' +
            copyBtn(it.text) +
          '</div>';
        }).join("") +
      '</div>' +
    '</div>';
  }

  function reasonsHtml() {
    return '<div class="lm-reasons">' +
      REASONS.map(function (r) {
        return '<div class="lm-reason" data-reason="' + esc(r.key) + '">' +
          '<div class="lm-reason-h">' + esc(r.label) +
            (r.pick ? '<span class="lm-reason-pick">' + esc(r.pick) + '</span>' : '') +
          '</div>' +
          '<div class="lm-reason-l">' + r.lines.map(function (l) {
            return '<span class="lm-reason-line">' + esc(l) + '</span>';
          }).join("") + '</div>' +
          '<div class="lm-reason-n">' + esc(r.note) + '</div>' +
        '</div>';
      }).join("") +
    '</div>';
  }

  function dontHtml() {
    return '<ul class="lm-dont">' + DONT.map(function (d) {
      return '<li><b>' + esc(d.t) + '</b><span>' + esc(d.d) + '</span></li>';
    }).join("") + '</ul>';
  }

  function render() {
    var box = document.getElementById(HOST_ID);
    if (!box) return;
    var h = '';
    h += '<h2><span class="hico" data-icon="smartphone-off"></span>漏接之后 · 他问起来怎么答</h2>';
    /* ⚠️ 这两段是裸拼的 HTML，必须过 esc —— 否则 `**加粗**` 会原样印成星号
     *   （call-sop 那边就踩过这个坑：19 处文案把星号印在页面上）。 */
    h += '<div class="lm-lead">' + esc(
      '昨天没接（偶数日、特殊的日子、或者单纯没看到），他今天问起来，' +
      '这里给的是**怎么答**，不是**怎么拒**。' +
      '和上面的话术中心是两件事：那边管「此刻接不接」，这边管「事后怎么解释」。') + '</div>';

    h += '<div class="lm-tiers">' + TIERS.map(tierHtml).join("") + '</div>';

    h += '<details class="lm-fold"><summary>理由只用一条 · 别每天换剧情</summary>' +
      '<div class="lm-fold-b">' +
        '<div class="lm-fold-n">' + esc(
          '现在的随机借口是**按日期每天换一句**的 —— 单次事件很好用，但同一件事被问第二次，' +
          '昨天说在值班、今天说手机没电，他一旦记住就会觉得你在敷衍。' +
          '这一格选一条，之后一直用它，只微调措辞。') + '</div>' +
        reasonsHtml() +
      '</div></details>';

    h += '<details class="lm-fold"><summary>三件不要做</summary>' +
      '<div class="lm-fold-b">' + dontHtml() + '</div></details>';

    h += '<div class="lm-foot">这个板块只管文字：不判定来电、不记录、不接管计时器，' +
         '也不会替你发任何消息 —— 复制之后由你自己粘贴发出。</div>';

    box.innerHTML = h;

    box.querySelectorAll('[data-lm-copy]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        copyText(btn.getAttribute("data-lm-text") || "", btn);
      });
    });
    if (window.Icon) window.Icon.inject(box);
  }

  return {
    init: render,
    render: render,
    /* 只读出口：供断言核对结构与文案，不参与渲染 */
    _data: { TIERS: TIERS, REASONS: REASONS, DONT: DONT }
  };
})();

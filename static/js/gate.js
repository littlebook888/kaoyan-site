/* ★ v1.111.0 本地口令门（A 档：只挡「随手点开 / 搜索引擎」，不是安全防护）
 * ============================================================================
 * 【它能挡住什么】
 *   · 搜索引擎爬虫（配合根目录 robots.txt + 每页 meta robots noindex）
 *   · 链接被转发出去后，陌生人点开时看到的是口令页，而不是正文
 *   · 手机误触图标、别人借手机时的第一眼
 *
 * 【它挡不住什么】—— 这是设计边界，不是 bug，别误当安全措施
 *   ① F12 把 <html> 的 gate-locked 类删掉 → 立刻看到正文
 *   ② 控制台 localStorage.setItem('kaoyan:gate', PASS_HASH) → 直接放行
 *   ③ 直接访问 /static/js/call-data.js → 话术 / 铁律 / 作息全在明文里
 *   ④ 公开 GitHub 仓库里逐字可读
 *   → 想真正挡住，只有两条路：整站套 Cloudflare Access，
 *     或把私密内容搬进需要登录才能取的数据库。见 memory/MEMORY-细节.md
 *
 * 【为什么还值得做】
 *   真实风险几乎都是「无意撞见」，不是「定向攻击」。
 *   挡掉 99% 的偶然，成本 10 分钟 —— 这笔账划算。
 *
 * 【三条刻意的取舍】
 *   1. 失败即放行：localStorage 不可用（隐私模式/被禁用）时**不锁**。
 *      宁可漏挡，也不能把主人永久锁在自己站点外面。
 *   2. 通过后 reload()，不原地移除遮罩。因为锁住时 body 是 display:none，
 *      图表/滚动容器可能已按 0 宽度算过尺寸，原地解锁会错位。刷新最干净。
 *   3. 同步脚本放在 <head>、且在所有资源之前。下载期间阻塞解析 →
 *      正文不会先闪一下再被遮住。这是唯一不闪的做法。
 *
 * 【改口令】
 *   PASS_HASH 换成新口令算出的哈希。用 node 生成：
 *     node -e "function h(s){var a=5381,v='kaoyan|'+s+'|gate';for(var i=0;i<v.length;i++)a=((a<<5)+a+v.charCodeAt(i))>>>0;var b=52711;for(var j=v.length-1;j>=0;j--)b=((b<<5)+b+v.charCodeAt(j))>>>0;console.log((a.toString(16)+b.toString(16)).slice(0,16))}" 新口令
 * ============================================================================
 */
(function () {
  "use strict";

  var LS_KEY = "kaoyan:gate";
  var PASS_HASH = "4a4ff73ff43afc21"; /* ← 口令 66ccff；换口令只改这一行 */

  /* djb2 双向变体，输出 16 位 hex。
     只求「源码里看不出原始口令」，**不求抗爆破**——短口令几秒就能撞出来。
     挡的是「打开源码顺手看一眼」，不是「有人专门来破」。 */
  function hashPass(s) {
    var a = 5381;
    var v = "kaoyan|" + s + "|gate";
    for (var i = 0; i < v.length; i++) {
      a = ((a << 5) + a + v.charCodeAt(i)) >>> 0;
    }
    var b = 52711;
    for (var j = v.length - 1; j >= 0; j--) {
      b = ((b << 5) + b + v.charCodeAt(j)) >>> 0;
    }
    return (a.toString(16) + b.toString(16)).slice(0, 16);
  }

  /* ---- 判定：已通过就直接放行，什么都不做 ---- */
  var passed = false;
  try {
    passed = localStorage.getItem(LS_KEY) === PASS_HASH;
  } catch (e) {
    /* localStorage 被禁用 → 放行（取舍 1：漏挡好过锁死自己） */
    passed = true;
  }
  if (passed) return;

  var root = document.documentElement;

  /* ---- 立刻上锁：body 一旦出现就是隐藏的，不可能先闪一下正文 ---- */
  /* 用 classList 而不是 className 赋值：避免把主题脚本/chart 库后来加在 <html> 上的类冲掉 */
  if (root.classList) root.classList.add("gate-locked");
  else root.className = root.className ? root.className + " gate-locked" : "gate-locked";
  var style = document.createElement("style");
  style.id = "gateStyle";
  style.textContent =
    "html.gate-locked>body{display:none!important}" +
    "html.gate-locked{background:#0b1220}";
  (document.head || root).appendChild(style);

  function build() {
    /* 遮罩挂 <html> 上而不是 <body>：body 此刻是 display:none，挂里面会被一起藏掉 */
    var mask = document.createElement("div");
    mask.id = "gateMask";
    mask.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483000",
      "display:flex", "align-items:center", "justify-content:center",
      "padding:24px",
      "background:radial-gradient(circle at 50% 30%,#13243c 0%,#0b1220 70%)",
      "-webkit-user-select:none", "user-select:none"
    ].join(";");

    var card = document.createElement("div");
    card.style.cssText = [
      "width:100%", "max-width:344px", "box-sizing:border-box",
      "padding:26px 22px", "border-radius:16px",
      "background:#111a2b", "border:1px solid rgba(102,204,255,.22)",
      "box-shadow:0 18px 50px rgba(0,0,0,.55)",
      "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
      "text-align:center"
    ].join(";");

    var title = document.createElement("div");
    title.textContent = "小本子考研个人网站";
    title.style.cssText = "font-size:17px;font-weight:700;color:#e5eef7;letter-spacing:1px";

    var sub = document.createElement("div");
    sub.textContent = "个人自用 · 非公开";
    sub.style.cssText = "margin-top:6px;font-size:12px;color:#7b8ea6;letter-spacing:2px";

    /* ★ v1.111.1（用户 2026.11.03 指定）：路人可能撞进来，这张卡要自己解释清楚
       「这是什么站、为什么锁着、你能做什么」，而不是只甩一句「需要口令」。
       放在标题下方、输入框上方——先解释，再要求动作。 */
    var desc = document.createElement("div");
    desc.style.cssText = [
      "margin-top:16px", "padding-top:14px",
      "border-top:1px solid rgba(102,204,255,.12)",
      "font-size:12px", "line-height:1.75", "color:#8fa3bb",
      "text-align:left"
    ].join(";");
    var descLine1 = document.createElement("div");
    descLine1.textContent = "这是一个人的备考学习站点，用于记录自己的每日任务、学习计时和作息安排，不提供任何对外内容。";
    var descLine2 = document.createElement("div");
    descLine2.textContent = "如果你是通过链接误入的路人，直接关掉这个页面就好。";
    descLine2.style.cssText = "margin-top:8px;color:#6e829b";
    desc.appendChild(descLine1);
    desc.appendChild(descLine2);

    var lockHint = document.createElement("div");
    lockHint.textContent = "本站仅本人使用，需要口令";
    lockHint.style.cssText = "margin-top:16px;font-size:12px;color:#7b8ea6;letter-spacing:1px";

    var input = document.createElement("input");
    input.type = "password";
    input.id = "gateInput";
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.placeholder = "请输入口令";
    input.style.cssText = [
      "width:100%", "box-sizing:border-box", "margin-top:10px",
      "padding:12px 14px", "border-radius:10px",
      "background:#0b1220", "border:1px solid #22334a",
      "color:#e5eef7", "font-size:16px", "letter-spacing:2px",
      "outline:none", "-webkit-appearance:none"
    ].join(";");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "gateBtn";
    btn.textContent = "进入";
    btn.style.cssText = [
      "width:100%", "margin-top:12px", "padding:12px",
      "border:0", "border-radius:10px", "cursor:pointer",
      "background:#66ccff", "color:#06202e",
      "font-size:15px", "font-weight:700", "letter-spacing:2px",
      "font-family:inherit"
    ].join(";");

    var err = document.createElement("div");
    err.id = "gateErr";
    err.style.cssText = "margin-top:12px;font-size:12px;color:#f87171;min-height:16px";

    function submit() {
      var val = input.value;
      if (hashPass(val) !== PASS_HASH) {
        err.textContent = "口令不对";
        input.value = "";
        input.focus();
        return;
      }
      try {
        localStorage.setItem(LS_KEY, PASS_HASH);
      } catch (e) {
        /* 写不进去就别刷新，否则会无限重来 —— 明确告诉人怎么回事 */
        err.textContent = "浏览器拒绝写入本地存储，无法记住口令";
        return;
      }
      /* 取舍 2：整页刷新，让布局在「可见」状态下重新计算 */
      location.reload();
    }

    btn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) submit();
    });

    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(desc);
    card.appendChild(lockHint);
    card.appendChild(input);
    card.appendChild(btn);
    card.appendChild(err);
    mask.appendChild(card);
    root.appendChild(mask);

    /* 等一帧再聚焦，避免移动端键盘把布局顶乱 */
    setTimeout(function () {
      try { input.focus(); } catch (e) {}
    }, 60);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();

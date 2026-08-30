/* =====================================================================
 *  reminders.js —— 提醒栏目渲染逻辑
 *  定位：状态触发式的自我提醒系统（不是工具页）
 *  原则：
 *   - 逐字保真：quote 渲染时除 highlight 加粗外不增删改任何字符
 *     （先 HTML 转义再拼接 <b>，杜绝注入，也保证逐字）
 *   - 晨启宣言每天首次打开置顶（localStorage 按北京日期记录）
 *   - 按当前时段自动预选分组（可随时手动切换）
 *  数据：reminders-data.js（window.REMINDERS_DATA）
 * ===================================================================== */
(function () {
  const D = window.REMINDERS_DATA;

  /* ---------- 工具 ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  // 逐字渲染：highlight 命中处加粗，其余原样；未命中则整段无高亮 + 控制台警告
  function renderQuote(card) {
    const q = String(card.quote || "");
    const hl = String(card.highlight || "");
    if (!hl) return escapeHtml(q);
    const idx = q.indexOf(hl);
    if (idx === -1) {
      console.warn("[reminders] highlight 未命中（请检查数据）：", card.id);
      return escapeHtml(q);
    }
    return escapeHtml(q.slice(0, idx))
      + '<b class="rm-hl">' + escapeHtml(hl) + '</b>'
      + escapeHtml(q.slice(idx + hl.length));
  }
  function beijingDateKey() {
    // 用北京时间日期做「每天首次打开」的判定，跨设备一致
    if (window.Blocks && window.Blocks.dateStr) return window.Blocks.dateStr(new Date());
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function autoPreselectGroup() {
    // 按当前北京时间预选：5-12点→A 开始一天；12-22点→B 正在学习；其余→F 晚间复盘
    if (!window.Blocks) return "all";
    const h = window.Blocks.beijing(new Date()).getHours();
    if (h >= 5 && h < 12) return "A";
    if (h >= 12 && h < 22) return "B";
    return "F";
  }
  // 出处回查：日志本④来源给链接（首页「链接大全」同款飞书文档），其余纯文字
  const LOGBOOK_URL = "https://my.feishu.cn/docx/HOxTdb77foSnOKxZFYYcZMK4n5f?from=from_copylink";
  // 每组专属色（数据里 color 字段）：卡片粗边/徽章/执行框/引文底统一随组色
  const GC = { all: "#334155", morning: (D.morning && D.morning.color) || "#f59e0b" };
  (D.groups || []).forEach(g => { GC[g.key] = g.color || "#64748b"; });

  /* ---------- 状态 ---------- */
  let selectedGroup = "all";
  let morningPinned = false;

  /* ---------- 渲染 ---------- */
  function renderMorning() {
    const m = D.morning;
    return `
      <article class="rm-card rm-morning ${morningPinned ? "rm-pin" : ""}" style="--gc:${GC.morning}">
        ${morningPinned ? '<div class="rm-pin-badge">今日晨启 · 读毕再开始</div>' : ""}
        <div class="rm-group-tag">晨启宣言</div>
        <h2 class="rm-title">${escapeHtml(m.title)}</h2>
        <blockquote class="rm-quote">${renderQuote(m)}</blockquote>
        <div class="rm-source">—— ${escapeHtml(m.source)}</div>
        ${m.action ? `<div class="rm-action"><span class="rm-action-label">执行</span>${escapeHtml(m.action)}</div>` : ""}
        ${m.note ? `<div class="rm-note">💭 小本子提醒：${escapeHtml(m.note)}</div>` : ""}
      </article>`;
  }

  function renderCard(card) {
    return `
      <article class="rm-card" data-id="${escapeHtml(card.id)}" style="--gc:${GC[card.group] || "#64748b"}">
        <div class="rm-group-tag">${escapeHtml(card.groupName)}</div>
        <h2 class="rm-title">${escapeHtml(card.title)}</h2>
        <blockquote class="rm-quote">${renderQuote(card)}</blockquote>
        <div class="rm-source">—— ${escapeHtml(card.source)}${/日志本④/.test(card.source || "") ? ` <a class="rm-src-link" href="${LOGBOOK_URL}" target="_blank" rel="noopener">↗ 回查日志本④</a>` : ""}</div>
        ${card.action ? `<div class="rm-action"><span class="rm-action-label">执行</span>${escapeHtml(card.action)}</div>` : ""}
        ${card.note ? `<div class="rm-note">💭 小本子提醒：${escapeHtml(card.note)}</div>` : ""}
      </article>`;
  }

  function renderRules() {
    const items = D.rules.map(r => `
      <li class="rm-rule">
        <span class="rm-rule-text">“${escapeHtml(r.text)}”</span>
        <span class="rm-rule-src">—— ${escapeHtml(r.source)}</span>
      </li>`).join("");
    return `
      <details class="rm-rules">
        <summary><span data-icon="scroll"></span> 规则部速查 · 6 条硬规则 <small>（点击展开）</small></summary>
        <ul class="rm-rule-list">${items}</ul>
      </details>`;
  }

  function render() {
    const app = document.getElementById("remindersApp");
    if (!app) return;
    const group = D.groups.find(g => g.key === selectedGroup);
    const cards = group ? group.cards : D.groups.flatMap(g => g.cards);
    const groupHint = group ? group.hint : "全部卡片 · 按场景切换查看";

    app.innerHTML = `
      <div class="rm-tabs" id="rmTabs">
        <button type="button" class="rm-tab ${selectedGroup === "all" ? "active" : ""}" data-group="all" style="--tc:${GC.all}">全部</button>
        ${D.groups.map(g => `
          <button type="button" class="rm-tab ${selectedGroup === g.key ? "active" : ""}" data-group="${g.key}" style="--tc:${GC[g.key]}">${g.key} ${g.name}</button>`).join("")}
      </div>
      ${morningPinned ? `<div class="rm-first-hint">📅 今天第一次打开——先读完晨启宣言，再开始。</div>` : ""}
      ${renderMorning()}
      ${group ? `<div class="rm-group-hint" style="--gc:${GC[selectedGroup]}">${escapeHtml(groupHint)}</div>` : ""}
      <div class="rm-cards">${cards.map(renderCard).join("")}</div>
      ${renderRules()}
    `;
    if (window.Icon) window.Icon.inject(app);

    app.querySelectorAll("#rmTabs .rm-tab").forEach(b => {
      b.addEventListener("click", () => {
        selectedGroup = b.dataset.group;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if (!D) return;
    // 晨启置顶：每天（按北京日期）首次打开时置顶高亮，当日再开则普通显示
    const seenKey = "kaoyan:reminders_seen_" + beijingDateKey();
    try {
      morningPinned = !localStorage.getItem(seenKey);
      if (morningPinned) localStorage.setItem(seenKey, "1");
    } catch (e) { morningPinned = false; }
    // 按当前时段预选分组（首次打开；用户可随时手动切换）
    selectedGroup = autoPreselectGroup();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

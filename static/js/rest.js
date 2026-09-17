/* =====================================================================
 *  rest.js —— 休息副站：主站状态联动 + 预期休息结束（仅本页）+ 被动休息快速指南
 *  ---------------------------------------------------------------
 *  数据：rest-data.js（window.REST_DATA）· 时段：schedule-data.js · 主站状态：store.js
 *  边界（用户明确要求）：
 *   1) 「预期休息结束时间」只影响本页内部（localStorage kaoyan:rest_until），
 *      不写主站记录、不动活动计时会话。
 *   2) 唯一会碰主站的入口是「去计时器开这段倒计时」链接（timer.html?rest=NN），
 *      那是用户显式点击，等价于去计时页点开始。
 *   3) 本页纯渲染 + 只读 Store.getActiveTimer()，不 push 任何数据。
 * ===================================================================== */
window.Rest = (function () {
  const D = window.REST_DATA || {};
  const LS_PLAN = "kaoyan:rest_until";
  const plan = { until: 0, min: 0, src: "" };
  let initialized = false;
  let initRetries = 0;
  let fired = false;        // 到点只提醒一次
  let pickedBand = "";      // 10 秒定位选中的档

  /* ---------- 小工具 ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function bj(ms) { return window.Blocks.beijing(new Date(ms)); }
  function hhmm(ms) { const d = bj(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function mmss(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? h + ":" + pad(m) : String(m)) + ":" + pad(s);
  }
  function durText(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h && m) return h + " 小时 " + m + " 分";
    if (h) return h + " 小时";
    if (m) return m + " 分";
    return sec + " 秒";
  }
  function toMin(t) { const p = String(t).split(":").map(Number); return (p[0] || 0) * 60 + (p[1] || 0); }

  /* ---------- 预期休息结束（本页内部状态） ---------- */
  function loadPlan() {
    try {
      const raw = localStorage.getItem(LS_PLAN);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && isFinite(o.until) && o.until > Date.now() - 12 * 3600 * 1000) {
        plan.until = o.until; plan.min = o.min || 0; plan.src = o.src || "";
      }
    } catch (e) {}
  }
  function savePlan() {
    try { localStorage.setItem(LS_PLAN, JSON.stringify({ until: plan.until, min: plan.min, src: plan.src })); } catch (e) {}
  }
  function setPlan(minutes, src) {
    minutes = Math.max(1, Math.round(minutes));
    plan.min = minutes;
    plan.until = Date.now() + minutes * 60 * 1000;
    plan.src = src || (minutes + " 分钟");
    fired = false;
    savePlan();
    renderPlan();
  }
  function shiftPlan(deltaMin) {
    if (!plan.until) return;
    const left = (plan.until - Date.now()) / 60000;
    setPlan(Math.max(1, Math.round(left + deltaMin)), plan.src ? plan.src + "（手动调整）" : "手动调整");
  }
  function clearPlan() {
    plan.until = 0; plan.min = 0; plan.src = ""; fired = false;
    try { localStorage.removeItem(LS_PLAN); } catch (e) {}
    renderPlan();
  }
  function timerLink(minutes) { return minutes > 0 ? "timer.html?rest=" + minutes : "timer.html"; }

  /* ---------- 主站状态（只读） ---------- */
  function readHost() {
    const at = window.Store && window.Store.getActiveTimer ? window.Store.getActiveTimer() : null;
    if (!at) return null;
    const running = at.status === "running";
    const base = Number(at.elapsed_sec) || 0;
    const elapsed = running ? base + Math.max(0, (Date.now() - (at.started_at || Date.now())) / 1000) : base;
    const isBreak = at.mode === "countdown" && (at.kind === "break" || at.kind === "rest");
    const dur = Number(at.duration_sec) || 0;
    return {
      at, running, elapsed, isBreak, dur,
      remainSec: isBreak ? Math.max(0, dur - elapsed) : 0,
      label: at.label || at.kind || "计时"
    };
  }

  /* ---------- 渲染：现在 ---------- */
  function renderNow() {
    const now = new Date();
    const d = bj(now.getTime());
    const clock = document.getElementById("rsClock");
    if (clock) clock.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());

    // 当前时段（取计划表 slots）
    const slotEl = document.getElementById("rsSlot");
    const slots = (window.SCHEDULE_DATA && window.SCHEDULE_DATA.slots) || [];
    const sec = window.Blocks.secOfDay(now);
    const slot = slots.find(s => toMin(s.start) * 60 <= sec && sec < toMin(s.end) * 60);
    if (slotEl) {
      if (slot) {
        const left = toMin(slot.end) * 60 - sec;
        slotEl.innerHTML = `现在时段：<b>${esc(slot.name)}</b>（${esc(slot.start)}–${esc(slot.end)} · 剩 ${esc(durText(left))}）`;
      } else {
        slotEl.textContent = "现在不在计划表的任何时段内";
      }
    }

    // 主站状态
    const host = readHost();
    const badge = document.getElementById("rsHostBadge");
    const text = document.getElementById("rsHostText");
    const box = document.getElementById("rsHost");
    if (box) box.classList.remove("host-break", "host-run", "host-idle");
    if (!host) {
      if (box) box.classList.add("host-idle");
      if (badge) badge.textContent = "主站未计时";
      if (text) text.textContent = "主站没有正在跑的计时会话";
    } else if (host.isBreak) {
      if (box) box.classList.add("host-break");
      if (badge) badge.textContent = host.running ? "主站·休息中" : "主站·休息已暂停";
      if (text) {
        text.textContent = host.running
          ? `${host.label}（${durText(host.dur)}倒计时）· 剩 ${mmss(host.remainSec)}`
          : `${host.label} · 已休 ${durText(host.elapsed)}`;
      }
      // 首次进入且本页还没设预期 → 跟随主站休息倒计时
      if (!plan.until && host.running && host.remainSec > 0) {
        setPlan(Math.max(1, host.remainSec / 60), "跟随主站休息倒计时");
      }
    } else {
      if (box) box.classList.add("host-run");
      if (badge) badge.textContent = host.running ? "主站·计时中" : "主站·已暂停";
      const mode = host.at.mode === "countdown" ? "倒计时" : "正计时";
      if (text) text.textContent = `${host.label}（${mode}）· 已 ${durText(host.elapsed)}`;
    }
    return host;
  }

  /* ---------- 渲染：预期休息结束 ---------- */
  function renderPlan() {
    const endEl = document.getElementById("rsPlanEnd");
    const remEl = document.getElementById("rsPlanRemain");
    const srcEl = document.getElementById("rsPlanSrc");
    const box = document.getElementById("rsPlan");
    const link = document.getElementById("rsPlanToTimer");
    if (box) box.classList.toggle("done", !!plan.until && plan.until <= Date.now());
    if (!plan.until) {
      if (endEl) endEl.textContent = "--:--";
      if (remEl) remEl.textContent = "未设定";
      if (srcEl) srcEl.textContent = "点下面任意一档的「就用这档」即可设定";
      if (link) link.setAttribute("href", "timer.html");
      return;
    }
    const left = (plan.until - Date.now()) / 1000;
    if (endEl) endEl.textContent = hhmm(plan.until);
    if (remEl) remEl.textContent = left > 0 ? "还剩 " + mmss(left) : "已到点";
    if (srcEl) srcEl.textContent = "来源：" + (plan.src || "手动设定") + " · 共 " + plan.min + " 分钟（仅本页）";
    if (link) link.setAttribute("href", timerLink(plan.min));
  }
  function fireOnce() {
    if (fired) return;
    fired = true;
    if (window.UI) {
      window.UI.beep(2);
      window.UI.buzz();
      window.UI.showAlert("⏰ 预期休息结束：回到书桌，先写下「回来先做哪道题」", 8000);
      window.UI.notify("⏰ 休息到点", "预期休息结束，回去坐下，先写下回来要做的那道题");
    }
  }

  /* ---------- 渲染：10 秒定位 + 三档 ---------- */
  function bandByKey(k) { return (D.bands || []).find(b => b.key === k) || null; }
  function renderLocator() {
    const box = document.getElementById("rsLocator");
    if (!box || !D.locator) return;
    box.innerHTML = (D.locator.rows || []).map(r => {
      const b = bandByKey(r.band);
      const tag = r.band === "breaker" ? "熔断 · 休半天" : (b ? b.name + " · " + b.minutes + " 分" : "—");
      return `<button type="button" class="rs-loc-row" data-band="${esc(r.band)}" data-state="${esc(r.state)}">
        <span class="rs-loc-sign">${esc(r.sign)}</span>
        <span class="rs-loc-state">${esc(r.state)}</span>
        <span class="rs-loc-band">${esc(tag)}</span>
      </button>`;
    }).join("");
    box.querySelectorAll("[data-band]").forEach(btn => {
      btn.addEventListener("click", () => pickLocator(btn.dataset.band, btn.dataset.state));
    });
  }
  function pickLocator(bandKey, state) {
    pickedBand = bandKey;
    const box = document.getElementById("rsLocator");
    if (box) box.querySelectorAll("[data-band]").forEach(b => b.classList.toggle("active", b.dataset.band === bandKey));
    const hint = document.getElementById("rsLocatorHint");
    const all = document.querySelectorAll(".rs-band");
    all.forEach(el => el.classList.toggle("rec", el.dataset.band === bandKey));
    const card = document.querySelector('.rs-band[data-band="' + bandKey + '"]');
    if (bandKey === "breaker") {
      if (hint) hint.innerHTML = `你选的是「${esc(state)}」→ <b>熔断：连续 3 天情绪崩，强制休半天</b>（提前排进周计划）。这不是某一档休息，是机制修复——崩盘是机制问题，不是意志问题。`;
      return;
    }
    const b = bandByKey(bandKey);
    if (!b) return;
    setPlan(b.minutes, b.name + " · " + b.title);
    if (hint) hint.innerHTML = `你选的是「${esc(state)}」→ 建议 <b>${esc(b.name)} · ${esc(b.title)}（${b.minutes} 分钟）</b>，已把预期结束设为 <b>${esc(hhmm(plan.until))}</b>。不合适就点 ±5 分或换一档。`;
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function renderBands() {
    const box = document.getElementById("rsBands");
    if (!box) return;
    box.innerHTML = (D.bands || []).map(b => `
      <div class="rs-band" data-band="${esc(b.key)}">
        <div class="rs-band-head">
          <b class="rs-band-name">${esc(b.name)}</b>
          <span class="rs-band-min">${b.minutes} 分钟</span>
          <span class="rs-band-title">${esc(b.title)}</span>
          <span class="rs-band-fit">${(b.fit || []).map(esc).join(" / ")}</span>
        </div>
        ${b.core ? `<div class="rs-band-core">${esc(b.core)}</div>` : ""}
        <div class="rs-band-cols">
          <ul class="rs-do">${(b.dos || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          <ul class="rs-dont">${(b.donts || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        </div>
        <div class="rs-band-why"><b>原理：</b>${esc(b.why || "")}</div>
        ${b.warn ? `<div class="rs-band-warn">⚠️ ${esc(b.warn)}</div>` : ""}
        ${b.breaker ? `<div class="rs-band-breaker">🔁 ${esc(b.breaker)}</div>` : ""}
        <div class="rs-band-ops">
          <button type="button" class="btn small" data-use="${esc(b.key)}">就用这档（${b.minutes} 分钟）</button>
          <a class="btn ghost small" href="${timerLink(b.minutes)}">在主站开 ${b.minutes} 分钟倒计时</a>
          ${b.leave ? '<span class="rs-band-flag">离场档 · 本段结束</span>' : ""}
        </div>
      </div>`).join("");
    box.querySelectorAll("[data-use]").forEach(btn => {
      btn.addEventListener("click", () => {
        const b = bandByKey(btn.dataset.use);
        if (b) setPlan(b.minutes, b.name + " · " + b.title);
      });
    });
  }

  /* ---------- 渲染：主动休息 / 工具 / 理论 / 前提 ---------- */
  function quoteBlock(q, src) {
    const list = Array.isArray(q) ? q : [q];
    return `<blockquote class="rs-quote">${list.map(x => `<p>${esc(x)}</p>`).join("")}${src ? `<cite>—— ${esc(src)}</cite>` : ""}</blockquote>`;
  }
  function renderActive() {
    const box = document.getElementById("rsActive");
    if (!box || !D.activeRest) return;
    box.innerHTML = (D.activeRest.items || []).map(it => `
      <div class="rs-item ${it.star ? "star" : ""}">
        <div class="rs-item-head"><span class="rs-item-n">${esc(it.n)}</span><b>${esc(it.title)}</b>${it.star ? '<span class="rs-star">★重点</span>' : ""}${it.optional ? '<span class="rs-opt">可选</span>' : ""}</div>
        ${it.quotes ? quoteBlock(it.quotes, it.quoteSource) : ""}
        ${it.quote ? quoteBlock(it.quote, it.quoteSource) : ""}
        ${it.points ? `<ul class="rs-points">${it.points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        ${it.rule ? `<div class="rs-rule">操作规则：${esc(it.rule)}</div>` : ""}
        ${it.why ? `<div class="rs-why">${esc(it.why)}</div>` : ""}
        ${it.note ? `<div class="rs-note">${esc(it.note)}</div>` : ""}
        ${it.warn ? `<div class="rs-warn">⚠️ ${esc(it.warn)}</div>` : ""}
      </div>`).join("");
  }
  function tableHtml(t) {
    if (!t) return "";
    return `<div class="rs-table-wrap"><table class="rs-table"><thead><tr>${t.head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map(r => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="rs-td-key"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function details(title, inner, open) {
    return `<details class="rs-fold"${open ? " open" : ""}><summary>${esc(title)}</summary><div class="rs-fold-body">${inner}</div></details>`;
  }
  function renderTools() {
    const box = document.getElementById("rsTools");
    if (!box) return;
    const parts = [];
    if (D.defaultRoutine) {
      const r = D.defaultRoutine;
      parts.push(details(r.title, `
        <div class="rs-flow">${r.steps.map((s, i) => `<div class="rs-flow-step"><span>${i + 1}</span>${esc(s)}</div>`).join("")}</div>
        <div class="rs-why">${esc(r.key)}</div>
        <div class="rs-note">${esc(r.why)}</div>
        <div class="rs-band-ops"><a class="btn ghost small" href="${timerLink(10)}">休息环节：在主站开 10 分钟倒计时</a></div>`, true));
    }
    if (D.sleepTech) {
      parts.push(details(D.sleepTech.title, (D.sleepTech.items || []).map(it => `
        <div class="rs-item ${it.star ? "star" : ""}">
          <div class="rs-item-head"><span class="rs-item-n">${esc(it.n)}</span><b>${esc(it.title)}</b>${it.star ? '<span class="rs-star">★重点</span>' : ""}${it.frozen ? '<span class="rs-frozen">已冻结·背景知识</span>' : ""}</div>
          ${it.quotes ? quoteBlock(it.quotes, it.quoteSource) : ""}
          ${it.decision ? `<div class="rs-rule">决策：${esc(it.decision)}</div>` : ""}
          ${it.table ? tableHtml(it.table) : ""}
          ${it.note ? `<div class="rs-note">${esc(it.note)}</div>` : ""}
          ${it.review ? `<div class="rs-warn">${esc(it.review)}</div>` : ""}
          ${it.warns ? it.warns.map(w => `<div class="rs-warn">⚠️ ${esc(w)}</div>`).join("") : ""}
        </div>`).join("")));
    }
    if (D.emergency) {
      const e = D.emergency;
      parts.push(details(e.title, `
        <div class="hint">${esc(e.subtitle || "")}</div>
        ${tableHtml({ head: e.columns, rows: e.items })}
        <div class="rs-note">${esc(e.aids || "")}</div>
        <div class="rs-warn">${esc(e.warn || "")}</div>`));
    }
    box.innerHTML = parts.join("");
  }
  function renderTheory() {
    const box = document.getElementById("rsTheory");
    if (!box) return;
    const parts = [];
    if (D.subjects) parts.push(details(D.subjects.title, `${tableHtml({ head: D.subjects.head, rows: D.subjects.rows })}<div class="rs-warn">${esc(D.subjects.warn)}</div><div class="rs-note">${esc(D.subjects.tip)}</div>`));
    if (D.redlines) parts.push(details(D.redlines.title, tableHtml({ head: D.redlines.head, rows: D.redlines.rows })));
    if (D.triggers3) parts.push(details(D.triggers3.title, `${tableHtml({ head: D.triggers3.head, rows: D.triggers3.rows })}<div class="rs-note">${esc(D.triggers3.note)}</div>`));
    box.innerHTML = parts.join("");
  }
  function renderPremise() {
    const box = document.getElementById("rsPremise");
    if (!box) return;
    const parts = [];
    if (D.premise) {
      parts.push(details(D.premise.title, (D.premise.items || []).map(it => `
        <div class="rs-item">
          <div class="rs-item-head"><span class="rs-item-n">${esc(it.n)}</span><b>${esc(it.title)}</b></div>
          ${it.quotes ? quoteBlock(it.quotes, it.quoteSource) : ""}
          ${it.table ? tableHtml(it.table) : ""}
          ${it.note ? `<div class="rs-note">${esc(it.note)}</div>` : ""}
          ${it.tip ? `<div class="rs-warn">${esc(it.tip)}</div>` : ""}
        </div>`).join("")));
    }
    if (D.sources) parts.push(details(D.sources.title, tableHtml({ head: D.sources.head, rows: D.sources.rows })));
    box.innerHTML = parts.join("");
  }

  /* ---------- 定时刷新 ---------- */
  let tickTimer = null;
  function tick() {
    renderNow();
    renderPlan();
    if (plan.until && plan.until <= Date.now()) fireOnce();
  }

  function init() {
    if (initialized) return;
    if (!document.getElementById("rsBands")) return;
    if (!window.Blocks || !window.Store) {
      if (initRetries++ < 20) setTimeout(init, 100);
      return;
    }
    initialized = true;
    loadPlan();
    const ver = document.getElementById("rsVer");
    if (ver && D.version) ver.textContent = D.version;
    renderLocator();
    renderBands();
    renderActive();
    renderTools();
    renderTheory();
    renderPremise();
    renderNow();
    renderPlan();
    if (window.Icon && window.Icon.inject) window.Icon.inject(document);

    document.getElementById("rsMinus5").addEventListener("click", () => shiftPlan(-5));
    document.getElementById("rsPlus5").addEventListener("click", () => shiftPlan(5));
    document.getElementById("rsClearPlan").addEventListener("click", clearPlan);

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
    if (window.Store.subscribeActiveTimer) window.Store.subscribeActiveTimer(() => { renderNow(); renderPlan(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  setTimeout(init, 0);

  return { init, setPlan, clearPlan, readHost, pickLocator, render: tick, _plan: plan };
})();

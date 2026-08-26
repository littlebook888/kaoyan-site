// ==UserScript==
// @name         青云小阁·日期自动定位 + 浮动日历
// @namespace    kaoyan.xizong
// @version      2.0
// @description  ① URL 带 qd/date 参数时自动连点箭头定位到指定日期；② 注入浮动日历面板，支持点击日期 / 左右滑动 / 手动输入，随时快速跳转，无需借助外部系统。
// @author       考研个人网站管理系统
// @match        https://toashore.cn/public/apps/calendar/online/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 通用工具 ================= */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function todayStr() { return fmt(new Date()); }
  function parse(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDaysStr(dateStr, delta) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + delta);
    return fmt(d);
  }

  // 读取页面当前选中的日期（网站 let selectedDate，@grant none 下可直接访问）
  function currentSelected() {
    try { if (typeof selectedDate !== 'undefined' && selectedDate) return selectedDate; } catch (e) { /* ignore */ }
    return todayStr();
  }

  /* ================= 跳转（优先直接设页面变量，失败则连点箭头） ================= */
  function goTo(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

    // 方案A：直接写入页面内部状态并刷新（瞬时，无闪烁）
    try {
      if (typeof selectedDate !== 'undefined') selectedDate = dateStr;
      if (typeof autoTodayMode !== 'undefined') autoTodayMode = (dateStr === todayStr());
      if (typeof updateUrl === 'function') updateUrl();
      if (typeof loadData === 'function') loadData();
      return;
    } catch (e) { /* 回退到方案B */ }

    // 方案B：连点箭头
    const diffDays = Math.round((parse(dateStr) - parse(todayStr())) / 86400000);
    if (diffDays === 0) return;
    const dir = diffDays > 0 ? 'next' : 'prev';
    let i = 0;
    const count = Math.abs(diffDays);
    const step = () => {
      const sel = dir === 'next' ? '#nextDay' : '#prevDay';
      const btn = document.querySelector(sel);
      if (btn) btn.click(); else i = count; // 找不到就停止
      i++;
      if (i < count) { for (let t = 0; t < 1; t++) {} setTimeout(step, 220); }
    };
    step();
  }

  /* ================= A. URL 自动定位（兼容旧版） ================= */
  (function autoLocate() {
    const qs = new URLSearchParams(location.search);
    const target = qs.get('qd') || qs.get('date');
    if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return;
    if (target === todayStr()) return;

    let done = false;
    const wait = () => {
      if (done) return;
      // 等页面函数就绪后再跳
      if (typeof loadData === 'function' && typeof updateUrl === 'function') {
        done = true;
        setTimeout(() => goTo(target), 300);
      } else {
        setTimeout(wait, 250);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        if (typeof loadData === 'function') setTimeout(() => goTo(target), 300);
        else wait();
      });
    } else {
      wait();
    }
  })();

  /* ================= B. 浮动日历面板 ================= */
  let panelState = { viewDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1) };

  function injectStyle() {
    const css = `
#qy-cal { position: fixed; right: 12px; bottom: 12px; z-index: 999999; width: 258px;
  background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;
  box-shadow: 0 8px 30px rgba(15,23,42,.18); font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  color:#102033; font-size:13px; }
#qy-cal * { box-sizing: border-box; }
#qy-head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px;
  background:#f1f5f9; border-bottom:1px solid #e2e8f0; }
#qy-head .t { font-weight:800; }
#qy-head .btns { display:flex; align-items:center; gap:4px; }
#qy-head button { cursor:pointer; border:none; background:none; font-size:15px; color:#64748b; line-height:1; padding:0 4px; border-radius:4px; }
#qy-head button:hover { background:#e2e8f0; color:#102033; }
#qy-ball { position:fixed; right:12px; bottom:12px; z-index:999998; width:44px; height:44px;
  display:flex; align-items:center; justify-content:center;
  background:#0d9488; color:#fff; border-radius:50%; font-size:20px; cursor:pointer;
  box-shadow:0 6px 20px rgba(13,148,136,.4); user-select:none;
  transition:transform .12s ease; }
#qy-ball:hover { transform:scale(1.1); }
#qy-nav { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; }
#qy-nav .y { font-weight:700; }
#qy-nav button { border:1px solid #e2e8f0; background:#fff; border-radius:6px; cursor:pointer; padding:2px 8px; font-size:13px; }
#qy-nav button:hover { background:#e5edf5; }
#qy-today { width:100%; padding:5px 0; border:none; background:#0d9488; color:#fff; font-weight:700; cursor:pointer; border-radius:6px; }
#qy-today:hover { background:#0f766e; }
#qy-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; padding:6px 8px; }
#qy-grid .w { text-align:center; color:#94a3b8; font-size:11px; padding:2px 0; }
#qy-grid .d { text-align:center; padding:4px 0; border-radius:6px; cursor:pointer; }
#qy-grid .d:hover { background:#e5edf5; }
#qy-grid .d.is-today { box-shadow: inset 0 0 0 1px #0d9488; color:#0d9488; font-weight:700; }
#qy-grid .d.is-selected { background:#0d9488; color:#fff; font-weight:700; }
#qy-grid .d.blank { cursor:default; }
#qy-msg { padding:0 8px 8px; }
#qy-input { width:100%; padding:6px 8px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; }
        `;
    const st = document.createElement('style');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function renderGrid() {
    const grid = document.getElementById('qy-grid');
    if (!grid) return;
    const y = panelState.viewDate.getFullYear();
    const m = panelState.viewDate.getMonth();
    const first = new Date(y, m, 1);
    // 周一开头
    let lead = (first.getDay() + 6) % 7;
    const daysIn = new Date(y, m + 1, 0).getDate();
    const curSel = currentSelected();
    const tstr = todayStr();

    let html = '<div class="w">一</div><div class="w">二</div><div class="w">三</div><div class="w">四</div><div class="w">五</div><div class="w">六</div><div class="w">日</div>';
    for (let i = 0; i < lead; i++) html += '<div class="d blank"></div>';
    for (let d = 1; d <= daysIn; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
      const cls = ['d', ds === tstr ? 'is-today' : '', ds === curSel ? 'is-selected' : ''].filter(Boolean).join(' ');
      html += `<div class="${cls}" data-date="${ds}">${d}</div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.d[data-date]').forEach(cell => {
      cell.addEventListener('click', () => goTo(cell.getAttribute('data-date')));
    });
  }

  function buildPanel() {
    const wrap = document.createElement('div');
    wrap.id = 'qy-cal';
    wrap.innerHTML = `
      <div id="qy-head"><span class="t">📅 青云日期跳转</span>
        <span class="btns">
          <button class="mini" title="最小化">−</button>
          <button class="close" title="彻底关闭">×</button>
        </span>
      </div>
      <div id="qy-nav">
        <button id="qy-prevM">‹</button>
        <span class="y" id="qy-mon">--</span>
        <button id="qy-nextM">›</button>
      </div>
      <button id="qy-today">回到今天</button>
      <div id="qy-grid"></div>
      <div id="qy-msg"><input id="qy-input" type="date" aria-label="手动输入或选择日期" /></div>`;
    document.body.appendChild(wrap);

    // 最小化 → 缩成右下角悬浮球；点击小球还原
    wrap.querySelector('.mini').addEventListener('click', minimize);
    // 彻底关闭（擦除）
    wrap.querySelector('.close').addEventListener('click', () => wrap.remove());

    wrap.querySelector('#qy-prevM').addEventListener('click', () => {
      panelState.viewDate = new Date(panelState.viewDate.getFullYear(), panelState.viewDate.getMonth() - 1, 1);
      updatePanel();
    });
    wrap.querySelector('#qy-nextM').addEventListener('click', () => {
      panelState.viewDate = new Date(panelState.viewDate.getFullYear(), panelState.viewDate.getMonth() + 1, 1);
      updatePanel();
    });
    wrap.querySelector('#qy-today').addEventListener('click', () => {
      panelState.viewDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      updatePanel();
      goTo(todayStr());
    });

    const input = wrap.querySelector('#qy-input');
    input.value = currentSelected();
    input.addEventListener('change', () => {
      if (input.value) goTo(input.value);
    });
    input.addEventListener('input', () => {
      const v = input.value;
      if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m] = v.split('-').map(Number);
        panelState.viewDate = new Date(y, m - 1, 1);
        updatePanel();
        goTo(v);
      }
    });

    return wrap;
  }

  // 最小化：隐藏面板，缩成右下角悬浮球（不擦除）
  function minimize() {
    const cal = document.getElementById('qy-cal');
    if (!cal) return;
    cal.style.display = 'none';
    const ball = document.createElement('div');
    ball.id = 'qy-ball';
    ball.textContent = '📅';
    ball.title = '打开日期跳转面板';
    ball.addEventListener('click', () => {
      cal.style.display = '';
      ball.remove();
    });
    document.body.appendChild(ball);
  }

  function updatePanel() {
    const mon = document.getElementById('qy-mon');
    if (mon) mon.textContent = `${panelState.viewDate.getFullYear()} 年 ${panelState.viewDate.getMonth() + 1} 月`;
    renderGrid();
    const input = document.getElementById('qy-input');
    if (input && document.activeElement !== input) input.value = currentSelected();
  }

  // 面板常驻：每次网络数据刷新后同步高亮（监听日志或轮询）
  let lastSel = null;
  function syncLoop() {
    const s = currentSelected();
    if (s !== lastSel) { lastSel = s; renderGrid(); }
    setTimeout(syncLoop, 800);
  }

  function initPanel() {
    if (document.getElementById('qy-cal')) return;
    injectStyle();
    try {
      buildPanel();
      updatePanel();
      syncLoop();
    } catch (e) { console.warn('[青云日历] 初始化失败', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanel);
  } else {
    initPanel();
  }
})();
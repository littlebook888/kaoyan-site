/* =====================================================================
 *  tasks.js —— 每日任务（番茄ToDo 风格，关联计时+时间记录）
 *  功能：
 *   - 任务分科目：西医综合 / 英语 / 政治 / 其他
 *   - 任务类型：听课 / 复习 / 刷题 / 其他
 *   - 预估时长（可设，只做提醒不自动停止）
 *   - 一键开始正计时 → 暂停 → 标记完成
 *   - 累计专注时长（多次计时累加，支持跨天）
 *   - 数据写入 time_records，任务与时间记录双向关联
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const todayStr = () => new Date().toDateString();
  let currentView = "calendar";
  let blockFilter = "all";
  let subjectFilter = "all";   // all | xizong | english | politics | other
  let activeDayIdx = 0;        // 日历视图：当前展开的 DAY 卡片索引
  let dayTabsOpen = false;     // 日历视图：日期 Tab 条 展开/收起（跨渲染保持）

  const SUBJECT_META = {
    all:       { label: "全部",   color: "#86868b", icon: "layers" },
    xizong:    { label: "西医综合", color: "#66ccff", icon: "book-open" },
    english:   { label: "英语",    color: "#ff7eb9", icon: "languages" },
    politics:  { label: "政治",    color: "#f5a623", icon: "flag" },
    other:     { label: "其他",    color: "#b0b7c3", icon: "sparkles" }
  };

  const TYPE_META = {
    course:  { label: "听课", color: "#66ccff" },
    review:  { label: "复习", color: "#059669" },
    problem: { label: "刷题", color: "#f5a623" },
    other:   { label: "其他", color: "#b0b7c3" }
  };

  const BLOCK_META = {
    morning:   { label: "早块", color: "#ffb347" },
    afternoon: { label: "午块", color: "#66ccff" },
    evening:   { label: "晚块", color: "#7c8cff" }
  };

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function subjBadge(s) {
    const m = SUBJECT_META[s] || SUBJECT_META.other;
    return `<span class="subj-badge" style="--c:${m.color}">${m.label}</span>`;
  }

  function typeBadge(t) {
    const m = TYPE_META[t] || TYPE_META.other;
    return `<span class="type-badge" style="--c:${m.color}">${m.label}</span>`;
  }

  function todayTasks() {
    return Store.getTasks().filter(t =>
      (t.date || "") === todayStr() &&
      (blockFilter === "all" || t.block === blockFilter) &&
      (subjectFilter === "all" || t.subject === subjectFilter));
  }

  /* ---------- 渲染分发 ---------- */
  function render() {
    renderPhysio();
    const box = document.getElementById("taskContainer");
    if (!box) return;
    if (currentView === "calendar") renderCalendar(box);
    else if (currentView === "list") renderList(box);
    else if (currentView === "grid") renderGrid(box);
    else renderTimetable(box);
    updateStats();
  }

  function updateStats() {
    const all = Store.getTasks().filter(t => (t.date || "") === todayStr());
    const done = all.filter(t => t.done).length;
    const totalFocus = all.reduce((s, t) => s + (t.total_focus_sec || 0), 0);
    const el = document.getElementById("taskStats");
    if (el) el.innerHTML = `今日 ${done}/${all.length} 项 · 专注 ${fmtDuration(totalFocus)}`;
  }

  function emptyHint() {
    return `<div class="hint" style="text-align:center;padding:30px 0">
      <div style="font-size:32px;margin-bottom:8px">📝</div>
      今天还没有任务，上面加一个吧～
    </div>`;
  }

  /* ---------- 所有西综计划任务（按日期分组排序）---------- */
  function planDateStr(t) {
    // 依据任务 date（"Fri May 01 2026" 格式）还原 YYYY-MM-DD 并返回时间戳，用于排序
    const d = t.date ? new Date(t.date) : null;
    return d && !isNaN(d.getTime()) ? d : null;
  }
  function planDateLabel(t) {
    const d = planDateStr(t);
    if (!d) return "";
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }
  function planGlyph(t) {
    return t.day_label && /DAY/i.test(t.day_label) ? escapeHtml(t.day_label) : "";
  }
  // 返回所有西综计划任务分组：按日期升序（排除人可研梦生理系列——它与日期无关、独立进度）
  function collectPlanDays() {
    const all = Store.getTasks().filter(t => t.subject === "xizong" && t.source !== "physio_rolling");
    const groups = {};
    const order = [];
    all.forEach(t => {
      const key = t.date || "__nodate__";
      if (!(key in groups)) { groups[key] = []; order.push(key); }
      groups[key].push(t);
    });
    // 按真实日期升序排序
    order.sort((a, b) => {
      const da = new Date(a), db = new Date(b);
      if (isNaN(da) || isNaN(db)) return 0;
      return da - db;
    });
    return { groups, order };
  }

  /* ---------- 日历视图（DAY 大卡 + 分卡 + 导航）---------- */
  function renderCalendar(box) {
    const { groups, order } = collectPlanDays();
    if (!order.length) { box.innerHTML = emptyHint(); return; }

    // 默认定位：若存在未完成日期 → 最早的那一条（待做优先）；若全部完成 → 停在最后一天（最新的做完的日期），方便回顾
    if (activeDayIdx >= order.length) activeDayIdx = 0;
    if (activeDayIdx === 0) {
      const firstUndone = order.findIndex(k => groups[k].some(t => !t.done));
      activeDayIdx = firstUndone === -1 ? (order.length - 1) : firstUndone;
    }
    const currentDayKey = order[activeDayIdx];
    const currentArr = groups[currentDayKey] || [];
    const doneCount = currentArr.filter(t => t.done).length;
    const totalCount = currentArr.length;
    const allDone = doneCount >= totalCount;

    // 当前卡日期
    const curDateLabel = currentDayKey === "__nodate__"
      ? "未排期"
      : (planDateLabel(currentArr[0]) || currentDayKey);
    const curDayToken = planGlyph(currentArr[0]);

    // 按类型分组子任务
    const typeGroups = {};
    currentArr.forEach(t => {
      const key = t.task_type || "other";
      if (!typeGroups[key]) typeGroups[key] = [];
      typeGroups[key].push(t);
    });

    // 排序：course → review → problem → other
    const typeOrder = ["course", "review", "problem", "other"];
    const typeLabels = { course: "看课", review: "复习", problem: "刷题", other: "其他" };

    const dayLabel = curDayToken ? curDayToken : "今日任务";

    let html = `<div class="cal-wrap">`;

    // DAY 大卡头
    const webLinkOk = currentDayKey !== "__nodate__" && /^\d{4}-\d{2}-\d{2}$/.test(curDateLabel);
    const allDoneBadge = allDone ? `<div class="cal-all-done-badge" title="已完成全部任务">✅ 全部完成</div>` : '';
    const reviewHint = allDone ? `<div class="cal-review-hint">想看之前做的什么？点下方的「展开全部日期」切换日期，已完成的日期会显示绿色 ✓ 标识</div>` : '';
    html += `<div class="cal-day-card">
      <div class="cal-day-head">
        ${webLinkOk ? `<a class="cal-website-link" href="https://toashore.cn/public/apps/calendar/online/index.html?date=${curDateLabel}&qd=${curDateLabel}" target="_blank" rel="noopener"><span data-icon="globe"></span> 转到：青云小阁网站</a>` : ''}
        <div class="cal-day-title">原定于 <strong>${curDateLabel}</strong> 的任务，请你完成
          ${curDayToken ? `<span class="cal-day-token">${curDayToken}</span>` : ''}
        </div>
        <div class="cal-day-progress">
          <div class="cal-progress-bar"><div class="cal-progress-fill" style="width:${totalCount > 0 ? (doneCount/totalCount*100) : 0}%"></div></div>
          <span class="cal-progress-text">${doneCount}/${totalCount} 完成</span>
          ${allDoneBadge}
        </div>
        ${reviewHint}
      </div>`;

    // 按类型分组渲染分卡
    typeOrder.forEach(tk => {
      const arr = typeGroups[tk];
      if (!arr || arr.length === 0) return;
      const tm = TYPE_META[tk] || TYPE_META.other;
      const groupColor = tk === "course" ? "#15803d" : tm.color; // 看课组=深绿
      html += `<div class="cal-type-group">
        <div class="cal-type-label" style="--tc:${groupColor}">
          <span class="cal-type-dot" style="background:${groupColor}"></span>
          ${typeLabels[tk] || tk}（${arr.length}）
        </div>`;
      arr.forEach(t => { html += renderCalSubCard(t, allDone); });
      html += `</div>`;
    });

    // 日历导航
    html += `<div class="cal-nav">`;
    if (activeDayIdx > 0) {
      html += `<button class="cal-nav-btn" data-cal-prev><span data-icon="chevron-up"></span> 上一天</button>`;
    }
    if (allDone && activeDayIdx < order.length - 1) {
      html += `<button class="cal-nav-btn cal-nav-next" data-cal-next>下一天 <span data-icon="chevron-down"></span></button>`;
    } else if (!allDone) {
      html += `<div class="cal-tip">💡 完成当前所有任务后，可跳到下一天</div>`;
    }
    html += `</div>`;
    html += `</div>`;

    // DAY 卡导航条（日期 Tab，默认折叠收进一行；展开显示全部）
    if (order.length > 1) {
      html += `<div class="cal-day-tabs-wrap">
        <button type="button" class="cal-tabs-toggle" data-daytabs-toggle>
          <span data-icon="calendar-days"></span> <span class="tt">${dayTabsOpen ? "收起日期" : "展开全部日期"}</span> <span data-icon="${dayTabsOpen ? "chevron-up" : "chevron-down"}"></span>
        </button>
        <div class="cal-day-tabs${dayTabsOpen ? " open" : ""}" id="calDayTabs">`;
      order.forEach((k, i) => {
        const arr = groups[k];
        const dc = arr.filter(t => t.done).length;
        const allDone = dc > 0 && dc >= arr.length;
        const cls = i === activeDayIdx ? "active" : "";
        const doneCls = allDone ? "alldone" : "";
        const label = planDateLabel(arr[0]) || "未排期";
        html += `<button class="cal-day-tab ${cls} ${doneCls}" data-cal-tab="${i}">${allDone ? '<span class="ct-check">✓</span>' : ''}${label} <span class="ct-count">${dc}/${arr.length}</span></button>`;
      });
      html += `</div></div>`;
    }

    html += `</div>`;
    box.innerHTML = html;
    if (window.Icon) window.Icon.inject(box);
  }

  /* ---------- 日历视图分卡 ---------- */
  // 分类配色：网课学习=深绿，滚动复习=浅绿，其余沿用类型默认色
  function taskColor(t) {
    const title = t.title || "";
    const tt = t.task_type;
    if (tt === "course") return "#15803d";            // 网课学习 深绿
    if (/滚动复习/.test(title)) return "#22c55e";     // 滚动复习 中绿（较暗）
    return (TYPE_META[tt] || TYPE_META.other).color;
  }
  function renderCalSubCard(t, dayAllDone) {
    const subj = SUBJECT_META[t.subject] || SUBJECT_META.other;
    const focusSec = t.total_focus_sec || 0;
    const estMin = t.estimated_min || 0;
    const isRunning = window.Timer && window.Timer.getLinkedTaskId() === t.id;
    const isDone = t.done;
    const tm = TYPE_META[t.task_type] || TYPE_META.other;
    const color = taskColor(t);

    let actions = "";
    if (isDone) {
      actions = `<span class="cs-done-tag">✓ 已完成</span>
        <button class="cs-btn cs-undo" data-undo="${t.id}">撤销</button>`;
    } else if (isRunning) {
      actions = `
        <button class="cs-btn cs-pause" data-pause="${t.id}"><span data-icon="pause"></span> 暂停</button>
        <button class="cs-btn cs-finish" data-finish="${t.id}">完成</button>`;
    } else {
      actions = `
        <button class="cs-btn cs-start" data-start="${t.id}"><span data-icon="play"></span> 开始</button>
        <button class="cs-btn cs-manual" data-manual="${t.id}">手动完成</button>`;
    }

    const progress = estMin > 0 ? Math.min(100, (focusSec / (estMin * 60)) * 100) : 0;
    const progressBar = estMin > 0 ? `
      <div class="cs-prog"><div class="cs-prog-bar" style="width:${progress.toFixed(1)}%;background:${color}"></div></div>` : "";

    return `
      <div class="cs-card ${isDone ? 'cs-done' : ''} ${isRunning ? 'cs-running' : ''}" style="--ct:${color}" data-id="${t.id}">
        <div class="cs-main">
          <div class="cs-title">${escapeHtml(t.title)}</div>
          <div class="cs-meta">
            ${t.ref_id ? `<span class="cs-ref" title="人类可读任务ID">${escapeHtml(t.ref_id)}</span>` : ''}
            <span class="cs-badge" style="--cb:${color}">${tm.label}</span>
            ${estMin > 0 ? `<span class="cs-est">预估 ${estMin}分</span>` : ''}
            ${focusSec > 0 ? `<span class="cs-focus">${isDone ? '花费' : '已消耗：'}${fmtDuration(focusSec)}</span>` : '<span class="cs-focus">未开始</span>'}
          </div>
          ${progressBar}
        </div>
        <div class="cs-actions">${actions}</div>
      </div>
    `;
  }
  /* ---------- 人可研梦·生理学滚动复习（独立系列、独立进度，与天天师兄互不影响） ---------- */
  let physioIdx = 0;          // 当前定位的 DAY 下标
  let physioExpanded = false; // DAY 清单是否展开
  let physioCollapsed = false;// 整卡是否收起（只留标题行）
  function physioList() {
    return Store.getTasks().filter(t => t.source === "physio_rolling").sort((a, b) => {
      const na = dayNumOf(a), nb = dayNumOf(b); return na - nb;
    });
  }
  function dayNumOf(t) {
    const m = (t.day_label || "").match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  function physioTabBtn(i, t) {
    return `<button type="button" class="physio-tab ${i === physioIdx ? "active" : ""}" data-physio-tab="${i}" ${t.done ? 'data-done="1"' : ""}>
      DAY${dayNumOf(t)}${t.done ? ' <span class="ptick">✓</span>' : ""}</button>`;
  }
  function renderPhysio() {
    const el = document.getElementById("physioCard");
    if (!el) return;
    const phys = physioList();
    if (!phys.length) {
      // 空态：即使没任务也显示卡片占位（方便区分"没导入"和"被隐藏"）
      el.style.display = "";
      el.innerHTML = `
        <div style="text-align:center;padding:18px 0;color:var(--ink-3);font-size:13px">
          <div style="font-size:26px;margin-bottom:6px">🌱</div>
          人可研梦滚动复习：加载中…<br>
          <span style="font-size:11px;opacity:0.7">若长时间停留此状态，请刷新或检查网络</span>
        </div>`;
      return;
    }
    el.style.display = "";
    if (physioIdx >= phys.length) physioIdx = phys.length - 1;
    const cur = phys[physioIdx];
    const curDay = dayNumOf(cur);
    const total = phys.length;
    const doneTotal = phys.filter(t => t.done).length;

    // DAY 切换区
    let navHtml;
    if (physioExpanded) {
      navHtml = `<div class="physio-tabs open">${phys.map((t, i) => physioTabBtn(i, t)).join("")}
        <button type="button" class="physio-tab physio-more" data-physio-toggle>收起 ▴</button></div>`;
    } else {
      const prevOk = physioIdx > 0;
      const nextOk = physioIdx < phys.length - 1;
      navHtml = `<div class="physio-tabs">
        <button type="button" class="physio-nav" data-physio-tab="${physioIdx - 1}" ${prevOk ? "" : "disabled"}>◀</button>
        <button type="button" class="physio-cur" data-physio-done="${cur.id}">DAY ${curDay}<span class="pcur-sub">${doneTotal}/${total}</span></button>
        <button type="button" class="physio-nav" data-physio-tab="${physioIdx + 1}" ${nextOk ? "" : "disabled"}>▶</button>
        <button type="button" class="physio-more" data-physio-toggle>全部DAY ▾</button>
      </div>`;
    }

    // 当前 DAY 卡片
    let bodyHtml;
    if (cur.done) {
      const focusSec = cur.total_focus_sec || 0;
      const nextUndone = phys.findIndex((t, i) => i > physioIdx && !t.done);
      bodyHtml = `<div class="physio-done">
        <div class="physio-day-done"><span class="pd-check">✓</span> DAY ${curDay} 已完成</div>
        ${focusSec > 0 ? `<div class="physio-focus-time">花费 ${fmtDuration(focusSec)}</div>` : ''}
        ${nextUndone !== -1 ? `<div class="physio-next-hint">已自动跳到下一 DAY（DAY ${dayNumOf(phys[nextUndone])}）</div>` : `<div class="physio-next-hint">🎉 全部 ${total} 个 DAY 已完成！有空随时回来复习</div>`}
        <button class="cs-btn cs-undo" data-physio-undo="${cur.id}">撤销</button>
      </div>`;
    } else {
      const focusSec = cur.total_focus_sec || 0;
      const isRunning = window.Timer && window.Timer.getLinkedTaskId() === cur.id;
      bodyHtml = `<div class="cs-card ${isRunning ? 'cs-running' : ''}" style="--ct:#059669">
        <div class="cs-main">
          <div class="cs-title">${escapeHtml(cur.title)}</div>
          <div class="cs-meta">
            <span class="cs-badge" style="--cb:#059669">复习</span>
            ${isRunning ? '<span class="cs-badge" style="--cb:#2563eb">计时中</span>' : ''}
            ${focusSec > 0 ? `<span class="cs-focus">已消耗：${fmtDuration(focusSec)}</span>` : '<span class="cs-focus">未开始</span>'}
          </div>
        </div>
        <div class="cs-actions">
          ${isRunning
            ? `<button class="cs-btn cs-pause" data-pause="${cur.id}"><span data-icon="pause"></span> 暂停</button>
               <button class="cs-btn cs-finish" data-finish="${cur.id}">完成</button>`
            : `<button class="cs-btn cs-start" data-start="${cur.id}"><span data-icon="play"></span> 开始</button>
               <button class="cs-btn cs-physio-done" data-physio-done="${cur.id}"><span data-icon="check"></span> 完成此DAY</button>`}
        </div>
      </div>`;
    }

    el.innerHTML = `<div class="physio-wrap">
      <div class="physio-head">
        <div class="physio-htitle">
          <span class="physio-logo">📖</span>
          <span class="physio-name">生理学·人可研梦滚动复习</span>
          <span class="physio-badge">独立进度 · 有空随时参加</span>
        </div>
        <button type="button" class="physio-collapse-btn" data-physio-collapse>${physioCollapsed ? "▼ 展开" : "▲ 收起"}</button>
      </div>
      <div class="physio-body" style="${physioCollapsed ? "display:none" : ""}">
        ${navHtml}
        ${bodyHtml}
      </div>
    </div>`;
    if (window.Icon) window.Icon.inject(el);
  }

  function renderTaskCard(t) {
    const subj = SUBJECT_META[t.subject] || SUBJECT_META.other;
    const focusSec = t.total_focus_sec || 0;
    const estMin = t.estimated_min || 0;
    const estSec = estMin * 60;
    const progress = estSec > 0 ? Math.min(100, (focusSec / estSec) * 100) : 0;
    const isRunning = window.Timer && window.Timer.getLinkedTaskId() === t.id;
    const isDone = t.done;

    // 操作按钮
    let actionBtn = "";
    if (isDone) {
      actionBtn = `<button class="tac-btn done-btn" title="已完成"><span class="tac-icon">✓</span></button>`;
    } else if (isRunning) {
      actionBtn = `
        <button class="tac-btn pause-btn" data-pause="${t.id}" title="暂停">
          <span class="tac-icon" data-icon="pause"></span>
        </button>
        <button class="tac-btn finish-btn" data-finish="${t.id}" title="完成并停止">
          <span class="tac-icon" data-icon="check"></span>
        </button>`;
    } else {
      actionBtn = `
        <button class="tac-btn quickdone-btn" data-quickdone="${t.id}" title="一键完成（填备注）">
          <span class="tac-icon">✎</span>
        </button>
        <button class="tac-btn play-btn" data-start="${t.id}" title="开始">
          <span class="tac-icon" data-icon="play"></span>
        </button>`;
    }

    const progressBar = estMin > 0 ? `
      <div class="tprog">
        <div class="tprog-bar" style="width:${progress.toFixed(1)}%;background:${subj.color}"></div>
      </div>` : "";

    const estLine = estMin > 0
      ? `<span class="tmeta-est">预估 ${estMin}分钟</span>`
      : "";

    const focusLine = focusSec > 0
      ? `<span class="tmeta-focus">${isDone ? '花费' : '已消耗：'}${fmtDuration(focusSec)}</span>`
      : `<span class="tmeta-focus">未开始</span>`;

    return `
      <div class="tcard ${isDone ? "isdone" : ""} ${isRunning ? "isrunning" : ""}" style="--sc:${subj.color}" data-id="${t.id}">
        <div class="tcard-left">
          <div class="tcheck ${isDone ? "on" : ""}" data-toggle="${t.id}">${isDone ? "✓" : ""}</div>
        </div>
        <div class="tcard-body">
          <div class="ttitle">${escapeHtml(t.title)}</div>
          <div class="tmeta">
            ${t.ref_id ? `<span class="cs-ref" title="人类可读任务ID">${escapeHtml(t.ref_id)}</span>` : ''}
            ${typeBadge(t.task_type)}
            ${subjBadge(t.subject)}
            ${estLine}
            ${focusLine}
          </div>
          ${progressBar}
        </div>
        <div class="tcard-right">
          ${actionBtn}
        </div>
      </div>
    `;
  }

  /* ---------- 列表视图（番茄ToDo 风格，按 DAY 分组）---------- */
  function renderList(box) {
    const tasks = todayTasks();
    if (!tasks.length) { box.innerHTML = emptyHint(); return; }

    // 按 day_label 分组（DAY 卡片）
    const groups = {};
    const order = [];
    tasks.forEach(t => {
      const dl = t.day_label || "";
      if (!(dl in groups)) { groups[dl] = []; order.push(dl); }
      groups[dl].push(t);
    });
    const hasDay = order.some(k => k);

    let html = `<div class="tlist">`;
    order.forEach(dl => {
      const arr = groups[dl];
      const doneCnt = arr.filter(t => t.done).length;
      if (hasDay) {
        const badge = dl ? escapeHtml(dl) : "其他任务";
        const badgeCls = dl ? "day-badge" : "day-badge day-badge-other";
        html += `<div class="day-card">
          <div class="day-card-head">
            <span class="${badgeCls}">${badge}</span>
            <span class="day-summary">${doneCnt}/${arr.length} 项完成</span>
          </div>
          <div class="day-card-body">`;
      }
      arr.forEach(t => { html += renderTaskCard(t); });
      if (hasDay) html += `</div></div>`;
    });
    html += `</div>`;
    box.innerHTML = html;
    if (window.Icon) window.Icon.inject(box);
  }

  /* ---------- 网格视图（保留原有样式，兼容）---------- */
  function renderGrid(box) {
    const tasks = todayTasks();
    if (!tasks.length) { box.innerHTML = emptyHint(); return; }
    box.innerHTML = `<div class="grid">` + tasks.map(t => {
      const m = SUBJECT_META[t.subject] || SUBJECT_META.other;
      return `<div class="gcard ${t.done ? "done" : ""}" data-id="${t.id}" style="--c:${m.color}">
        <div class="gcheck" data-toggle="${t.id}">${t.done ? "✓" : ""}</div>
        <div class="gtitle">${escapeHtml(t.title)}</div>
        <div class="gmeta">${subjBadge(t.subject)} ${typeBadge(t.task_type)}</div>
        <div class="gfocus">${fmtDuration(t.total_focus_sec || 0)}</div>
      </div>`;
    }).join("") + `</div>`;
    if (window.Icon) window.Icon.inject(box);
  }

  /* ---------- 课程表视图（保留）---------- */
  function renderTimetable(box) {
    const slotted = Store.getTasks().filter(t => t.slot);
    const cells = {};
    slotted.forEach(t => { (cells[t.slot] = cells[t.slot] || []).push(t); });
    const DOW = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    let html = `<div class="tt"><div class="tt-row tt-head"><div class="tt-time">节</div>`;
    for (let d = 1; d <= 7; d++) html += `<div class="tt-cell tt-day">${DOW[d]}</div>`;
    html += `</div>`;
    PERIODS.forEach(p => {
      html += `<div class="tt-row"><div class="tt-time">${p}</div>`;
      for (let d = 1; d <= 7; d++) {
        const arr = cells[`${d}-${p}`] || [];
        const inner = arr.map(t => {
          const m = SUBJECT_META[t.subject] || SUBJECT_META.other;
          return `<div class="tt-task ${t.done ? "done" : ""}" data-toggle="${t.id}" style="--c:${m.color}">
            <span class="tt-check">${t.done ? "✓" : ""}</span>${escapeHtml(t.title)}</div>`;
        }).join("");
        html += `<div class="tt-cell">${inner}</div>`;
      }
      html += `</div>`;
    });
    html += `</div>`;

    const unslotted = todayTasks().filter(t => !t.slot);
    if (unslotted.length) {
      html += `<div class="tt-unscheduled"><h3><span data-icon="list-checks"></span> 未排课（今日）</h3><div class="list">` +
        unslotted.map(t => `<div class="item ${t.done ? "done" : ""}" data-id="${t.id}">
          <div class="check" data-toggle="${t.id}">${t.done ? "✓" : ""}</div>
          <div class="title">${escapeHtml(t.title)}</div>
          <div class="meta">${t.done ? "已打卡" : "待做"}</div></div>`).join("") + `</div></div>`;
    }
    box.innerHTML = html;
    if (window.Icon) window.Icon.inject(box);
  }

  /* ---------- 添加任务弹窗 ---------- */
  function openAddDialog() {
    const title = prompt("任务名称：");
    if (!title || !title.trim()) return;

    const subject = prompt("科目 (1=西医综合 2=英语 3=政治 4=其他)：", "1");
    const subjMap = { "1": "xizong", "2": "english", "3": "politics", "4": "other" };
    const subjectKey = subjMap[subject] || "xizong";

    const type = prompt("类型 (1=听课 2=复习 3=刷题 4=其他)：", "1");
    const typeMap = { "1": "course", "2": "review", "3": "problem", "4": "other" };
    const typeKey = typeMap[type] || "other";

    const estStr = prompt("预估时长（分钟，留空则不设）：", "");
    const estMin = estStr && estStr.trim() ? parseInt(estStr) : null;

    Store.addTask({
      id: uid(),
      user_id: C.USER_ID,
      title: title.trim(),
      done: false,
      subject: subjectKey,
      task_type: typeKey,
      estimated_min: estMin,
      remind_on_estimate: true,
      total_focus_sec: 0,
      status: "todo",
      time_record_ids: [],
      category: "general",
      slot: null,
      block: blockFilter === "all" ? null : blockFilter,
      date: todayStr(),
      created_at: new Date().toISOString()
    });
  }

  /* ---------- 手动完成（记录事件到 time_records）---------- */
  function manualCompleteTask(taskId) {
    const t = Store.getTasks().find(x => x.id === taskId);
    if (!t) return;
    const now = new Date();
    const blockKey = window.Blocks ? window.Blocks.blockOf(now) : "";
    const blockLabel = { morning: "早块", afternoon: "午块", evening: "晚块" }[blockKey] || "";

    // 1. 更新任务状态
    Store.updateTask(taskId, {
      done: true,
      status: "done",
      completed_note: `手动完成｜完成时段：${blockLabel}｜完成时间：${now.toLocaleString("zh-CN")}`,
      completed_at: now.toISOString()
    });

    // 2. 写入 time_records（记录"手动完成"事件）
    const rec = {
      id: uid(),
      user_id: C.USER_ID,
      category: "study",
      sub_category: t.subject === "xizong" ? "xizong" : (t.subject || "other"),
      label: t.title,
      tags: ["手动完成", t.task_type || ""],
      started_at: now.toISOString(),
      ended_at: now.toISOString(),
      duration_sec: 0,
      source: "task_manual_complete",
      note: `任务「${t.title}」手动完成｜时段：${blockLabel}`,
      created_at: now.toISOString()
    };
    Store.addTimeRecord(rec);

    if (window.UI && window.UI.showAlert) {
      window.UI.showAlert(`✅ 「${t.title}」已手动完成，事件已记录`, 2500);
    }
    render();
  }

  /* ---------- 一键完成弹窗 ---------- */
  function openQuickDoneDialog(taskId) {
    const t = Store.getTasks().find(x => x.id === taskId);
    if (!t) return;

    const now = new Date();
    const blockKey = window.Blocks ? window.Blocks.blockOf(now) : "";
    const blockLabel = { morning: "早块", afternoon: "午块", evening: "晚块" }[blockKey] || "";
    const defaultNote = `完成时间：${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}\n完成时段：${blockLabel}`;

    const note = prompt(`「${t.title}」完成备注：\n（可记录完成时间、完成时段、收获等）`, defaultNote);
    if (note === null) return; // 取消

    Store.updateTask(taskId, {
      done: true,
      status: "done",
      completed_note: note.trim() || "",
      completed_at: now.toISOString()
    });

    if (window.UI && window.UI.showAlert) {
      window.UI.showAlert("🎉 任务已完成！", 2000);
    }
  }

  /* ---------- 青云小阁官方计划·本地镜像导入 ---------- */
  function autoImportLivePlan() {
    const live = window.XIZONG_LIVE;
    if (!live || !live.days) return;

    const IMPORT_KEY = "xizong_live_imported_v1";
    if (localStorage.getItem(IMPORT_KEY)) return;
    // ★ 跨设备守卫：localStorage 标记只在本机有效，新设备/新浏览器打开任务页会把同一套
    //   计划重新导入一遍（新 id 推上云端 → 全端重复）。已有官方计划任务就不再自动导入。
    if (Store.getTasks().some(t => t.source === "xizong_live")) {
      localStorage.setItem(IMPORT_KEY, "1");
      return;
    }

    const mk = (dateObj, partial) => ({
      id: uid(), user_id: C.USER_ID,
      done: false, subject: "xizong",
      estimated_min: null, remind_on_estimate: true,
      total_focus_sec: 0, status: "todo", time_record_ids: [],
      category: "general", slot: null, block: null,
      date: dateObj, created_at: new Date().toISOString(),
      day_label: "",
      source: "xizong_live",
      ...partial
    });

    const typeMap = { course: "course", review: "review", problem: "problem" };
    let count = 0;

    Object.keys(live.days).forEach(dateStr => {
      const [y, m, d] = dateStr.split("-").map(Number);
      const dateObj = new Date(y, m - 1, d).toDateString();
      const items = live.days[dateStr] || [];
      items.forEach(item => {
        Store.addTask(mk(dateObj, {
          title: item.title,
          task_type: typeMap[item.type] || "other",
          completed_note: item.detail || ""
        }));
        count++;
      });
    });

    localStorage.setItem(IMPORT_KEY, "1");
    if (count && window.UI && window.UI.showAlert) {
      window.UI.showAlert(`☁️ 已导入青云小阁最新官方计划（${count} 条）`, 2500);
    }
  }

  /* ---------- 自动导入 Excel 西综计划（v2：滚动复习语义分段 + 完整内容 + 去重） ---------- */
  function autoImportXizongPlan() {
    const planData = window.XIZONG_PLAN;
    if (!planData || !planData.length) return;

    const IMPORT_KEY = "xizong_plan_imported_v2";
    if (localStorage.getItem(IMPORT_KEY)) return;
    // ★ 跨设备守卫：已有 v2 特征任务（带 completed_note 的滚动复习）则跳过
    if (Store.getTasks().some(t => t.source === "xizong_plan" &&
        /^滚动复习：/.test(t.title || "") && (t.completed_note || "").length > 10)) {
      localStorage.setItem(IMPORT_KEY, "1");
      return;
    }

    // ★ v2 清理：删除 v1 导入的滚动复习碎片任务（title 以"滚动复习："开头、无完整内容、
    //   且非 v2 导入的西综任务）——它们是把一段滚动复习按排版换行拆成的碎片
    const frags = Store.getTasks().filter(t =>
      t.subject === "xizong" && /^滚动复习：/.test(t.title || "") &&
      !(t.completed_note && t.completed_note.length > 10));
    frags.forEach(t => Store.deleteTask(t.id));

    const today = new Date();
    const todayStrVal = today.toDateString();

    // 导入所有日期的计划
    let count = 0;
    planData.forEach(dayData => {
      if (!dayData.date) return;

      // 将 Excel 日期转为 Date 对象匹配格式
      const [y, m, d] = dayData.date.split("-");
      const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      const dateStr = dateObj.toDateString();

      const dayLabel = dayData.day ? `DAY ${dayData.day}` : "";

      const mk = (partial) => ({
        id: uid(), user_id: C.USER_ID,
        done: false, subject: "xizong",
        estimated_min: null, remind_on_estimate: true,
        total_focus_sec: 0, status: "todo", time_record_ids: [],
        category: "general", slot: null, block: null,
        date: dateStr, created_at: new Date().toISOString(),
        day_label: dayLabel,
        source: "xizong_plan",   // v2：标记来源，便于未来清理/识别
        ...partial
      });
      // ★ 去重：同一日期同一标题已存在则跳过（v1 已导入的听课/复习/刷题不重复导）
      const addUnique = (title, partial) => {
        const exists = Store.getTasks().some(t =>
          t.subject === "xizong" && t.date === dateStr && t.title === title);
        if (exists) return;
        Store.addTask(mk({ title, ...partial }));
        count++;
      };

      // 课程
      if (dayData.course && dayData.course !== "/" && dayData.course !== "／") {
        const items = dayData.course.split(/[\n]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
        const durations = (dayData.duration || "").split(/[\n]+/).map(s => {
          const m = s.match(/(\d+)\s*min/);
          return m ? parseInt(m[1]) : null;
        }).filter(x => x !== null);
        items.forEach((item, idx) => {
          const estMin = durations[idx] || null;
          addUnique(`听课：${item}`, { task_type: "course", estimated_min: estMin });
        });
      }

      // 复习
      if (dayData.review && dayData.review !== "/" && dayData.review !== "／") {
        const items = dayData.review.split(/[\n;；]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
        items.forEach(item => {
          addUnique(`复习：${item.slice(0, 40)}`, { task_type: "review" });
        });
      }

      // 刷题（合并为单个小块，完整内容存入 completed_note）
      if (dayData.problem && dayData.problem !== "/" && dayData.problem !== "／") {
        const items = dayData.problem.split(/[\n;；]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
        if (items.length) {
          const full = items.join("；");
          addUnique(`刷题：${full.slice(0, 60)}${full.length > 60 ? "…" : ""}`, {
            task_type: "problem", completed_note: full
          });
        }
      }

      // 滚动复习（v2：数据文件已语义分段，一段=一条任务；完整内容存 completed_note）
      if (dayData.rolling && dayData.rolling !== "/" && dayData.rolling !== "／") {
        const items = dayData.rolling.split(/[\n]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
        items.forEach(item => {
          addUnique(`滚动复习：${item.slice(0, 40)}`, {
            task_type: "review", completed_note: item
          });
        });
      }
    });

    // 如果今天没有数据，尝试从 today-xizong-plan.js 补充
    const todayPlan = window.TODAY_XIZONG_PLAN;
    const todayTasks = Store.getTasks().filter(t => t.date === todayStrVal && t.subject === "xizong");
    if (todayPlan && todayPlan.items && todayPlan.items.length && todayTasks.length === 0) {
      const dayLabel = todayPlan.day ? `DAY ${todayPlan.day}` : "";
      const mkToday = (partial) => ({
        id: uid(), user_id: C.USER_ID,
        done: false, subject: "xizong",
        estimated_min: null, remind_on_estimate: true,
        total_focus_sec: 0, status: "todo", time_record_ids: [],
        category: "general", slot: null, block: null,
        date: todayStrVal, created_at: new Date().toISOString(),
        day_label: dayLabel,
        ...partial
      });
      todayPlan.items.forEach(item => {
        const typeMap = { course: "course", review: "review", problem: "problem" };
        Store.addTask(mkToday({
          title: item.title,
          task_type: typeMap[item.type] || "other",
          completed_note: item.detail || ""
        }));
        count++;
      });
    }

    localStorage.setItem(IMPORT_KEY, "1");
    if (window.UI && window.UI.showAlert) {
      window.UI.showAlert(`📚 已自动导入 ${count} 条西综计划（5月 + 今日）`, 3000);
    }
  }

  /* ---------- 从网站获取今日计划 ---------- */
  function importTodayFromWeb() {
    const plan = window.TODAY_XIZONG_PLAN;
    if (!plan || !plan.items || !plan.items.length) {
      if (window.UI) window.UI.showAlert("暂无今日计划数据，请先更新 today-xizong-plan.js", 3000);
      return;
    }

    // 确认导入
    const existing = todayTasks().filter(t => t.subject === "xizong");
    if (existing.length > 0) {
      const ok = confirm(`已有 ${existing.length} 条今日西综任务，是否覆盖？\n（确定=覆盖，取消=追加）`);
      if (ok) {
        // 删除已有的今日西综任务
        existing.forEach(t => Store.deleteTask(t.id));
      }
    }

    const today = new Date();
    const todayStrVal = today.toDateString();
    const dayLabel = plan.day ? `DAY ${plan.day}` : "";

    // 任务工厂
    const mk = (partial) => ({
      id: uid(), user_id: C.USER_ID,
      done: false, subject: "xizong",
      estimated_min: null, remind_on_estimate: true,
      total_focus_sec: 0, status: "todo", time_record_ids: [],
      category: "general", slot: null, block: null,
      date: todayStrVal, created_at: new Date().toISOString(),
      day_label: dayLabel,
      ...partial
    });

    const tasks = plan.items.map(item => {
      const typeMap = { course: "course", review: "review", problem: "problem" };
      return mk({
        title: item.title,
        task_type: typeMap[item.type] || "other",
        completed_note: item.detail || ""
      });
    });

    tasks.forEach(t => Store.addTask(t));
    if (window.UI) window.UI.showAlert(`✅ 已从网站导入 ${tasks.length} 条今日计划`, 2500);
    render();
  }

  /* ---------- 导入西综 Excel 计划 ---------- */
  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        const tasks = parseXizongPlan(rows);
        if (tasks.length === 0) {
          if (window.UI) window.UI.showAlert("未解析到任务，请检查文件格式", 3000);
          return;
        }
        // 确认导入
        const ok = confirm(`解析到 ${tasks.length} 条任务（西综），是否导入到今日任务？`);
        if (!ok) { e.target.value = ""; return; }
        tasks.forEach(t => Store.addTask(t));
        if (window.UI) window.UI.showAlert(`✅ 已导入 ${tasks.length} 条西综任务`, 2500);
        e.target.value = "";
      } catch (err) {
        console.error(err);
        if (window.UI) window.UI.showAlert("导入失败：" + err.message, 3000);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function parseXizongPlan(rows) {
    const today = new Date();
    // 本地日期（toISOString 是 UTC，凌晨 0~8 点会错拿成"昨天"的行）
    const p2 = (n) => String(n).padStart(2, "0");
    const todayStrVal = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;
    const result = [];

    // 找今天对应的行（第0列是日期）
    let todayRow = null;
    for (let i = 2; i < rows.length; i++) {
      const cell = rows[i][0];
      if (!cell) continue;
      let dateStr;
      if (cell instanceof Date) {
        dateStr = cell.toISOString().slice(0, 10);
      } else if (typeof cell === "string" || typeof cell === "number") {
        const d = new Date(cell);
        if (!isNaN(d.getTime())) dateStr = d.toISOString().slice(0, 10);
      }
      if (dateStr === todayStrVal) {
        todayRow = rows[i];
        break;
      }
    }

    if (!todayRow) {
      // 没找到今天的，提示并导入最近一天的
      for (let i = 2; i < rows.length; i++) {
        if (rows[i][0]) { todayRow = rows[i]; break; }
      }
    }
    if (!todayRow) return result;

    // 列：0=日期 1=天数 2=课程内容 3=课程时长 4=空 5=复习计划 6=刷题计划 7=滚动复习
    const courseContent = todayRow[2] ? String(todayRow[2]).trim() : "";
    const courseDuration = todayRow[3] ? String(todayRow[3]).trim() : "";
    const reviewPlan = todayRow[5] ? String(todayRow[5]).trim() : "";
    const problemPlan = todayRow[6] ? String(todayRow[6]).trim() : "";
    const rollReview = todayRow[7] ? String(todayRow[7]).trim() : "";

    // 天数列 → DAY 卡片标签（如 "DAY 1"）
    const dayNum = todayRow[1] ? String(todayRow[1]).trim() : "";
    const dayLabel = dayNum ? `DAY ${dayNum}` : "";

    // 任务工厂
    const mk = (partial) => ({
      id: uid(), user_id: C.USER_ID,
      done: false, subject: "xizong",
      estimated_min: null, remind_on_estimate: true,
      total_focus_sec: 0, status: "todo", time_record_ids: [],
      category: "general", slot: null, block: null,
      date: todayStr(), created_at: new Date().toISOString(),
      day_label: dayLabel,
      ...partial
    });

    // 课程任务（拆分成多条）
    if (courseContent && courseContent !== "/" && courseContent !== "／") {
      const items = courseContent.split(/[\n&]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
      // 时长解析
      const durations = courseDuration.split(/[\n]+/).map(s => {
        const m = s.match(/(\d+)\s*min/);
        return m ? parseInt(m[1]) : null;
      }).filter(x => x !== null);

      items.forEach((item, idx) => {
        const estMin = durations[idx] || null;
        result.push(mk({
          title: `听课：${item}`,
          task_type: "course",
          estimated_min: estMin
        }));
      });
    }

    // 复习任务
    if (reviewPlan && reviewPlan !== "/" && reviewPlan !== "／") {
      const items = reviewPlan.split(/[\n;；]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
      items.forEach(item => {
        result.push(mk({
          title: `复习：${item.slice(0, 40)}`,
          task_type: "review"
        }));
      });
    }

    // 刷题任务
    if (problemPlan && problemPlan !== "/" && problemPlan !== "／") {
      const items = problemPlan.split(/[\n;；]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
      items.forEach(item => {
        result.push(mk({
          title: `刷题：${item.slice(0, 40)}`,
          task_type: "problem"
        }));
      });
    }

    // 滚动复习任务
    if (rollReview && rollReview !== "/" && rollReview !== "／") {
      const items = rollReview.split(/[\n;；]+/).map(s => s.trim()).filter(s => s && s !== "/" && s !== "／");
      items.forEach(item => {
        result.push(mk({
          title: `滚动复习：${item.slice(0, 40)}`,
          task_type: "review"
        }));
      });
    }

    return result;
  }

  /// autoImportXizongPlan 结束后插入 ... 实际以固定调用处为准
  /* ---------- 自动导入 生理学·人可研梦滚动复习（独立系列）---------- */
  const PHYSIO_IMPORT_FLAG = "xizong_physio_imported_v2";
  function autoImportPhysioPlan() {
    const plan = window.PHYSIO_PLAN;
    if (!plan || !plan.length) return;

    // 双重守卫：Store 数据 + localStorage 标记（防止 pullOnce 覆盖后误判）
    if (Store.getTasks().some(t => t.source === "physio_rolling")) return;
    if (localStorage.getItem(PHYSIO_IMPORT_FLAG)) return;

    const mk = (partial) => ({
      id: uid(), user_id: C.USER_ID,
      done: false, subject: "xizong",
      estimated_min: null, remind_on_estimate: true,
      total_focus_sec: 0, status: "todo", time_record_ids: [],
      category: "general", slot: null, block: null,
      created_at: new Date().toISOString(),
      source: "physio_rolling",
      ...partial
    });

    let count = 0;
    plan.forEach(p => {
      Store.addTask(mk({
        title: p.title,
        task_type: "review",
        day_label: `DAY ${p.day}`,
        date: "",  // 与日期完全解耦，不进入日期定向界面
        note: `第二期：${p.term2} 起滚动复习；第三期：${p.term3} 起滚动复习`
      }));
      count++;
    });

    // 设置标记防止 pullOnce 覆盖后重复导入（该标记不在 kaoyan: 前缀下，不受 pullOnce 影响）
    localStorage.setItem(PHYSIO_IMPORT_FLAG, "1");

    if (count && window.UI && window.UI.showAlert) {
      window.UI.showAlert(`📖 已导入生理学·人可研梦滚动复习（DAY1-${plan.length}）`, 2500);
    }
  }

  /* ---------- 交互绑定 ---------- */
  function init() {
    // 1. 立即本地渲染（不从远端等，Supabase 慢也不阻塞）
    Store.setLog && Store.setLog("任务页启动，本地导入…");
    autoImportXizongPlan();
    autoImportLivePlan();
    autoImportPhysioPlan();
    Store.setLog && Store.setLog(`导入完成：共${Store.getTasks().length}条任务`);
    render();

    // 2. 后台异步同步云端（不阻塞用户操作）
    (Store.initSupabase() || Promise.resolve(false))
      .then(ok => {
        if (!ok) { Store.setLog && Store.setLog("无Supabase配置，使用本地"); return; }
        Store.setLog && Store.setLog("Supabase连接成功，同步中…");
        return Store.pullOnce();
      })
      .then(() => {
        Store.setLog && Store.setLog("同步完成：重渲染");
        // 远端数据拉完后再次检查导入（防止本地无数据但云端有新数据）
        autoImportXizongPlan();
        autoImportLivePlan();
        autoImportPhysioPlan();
        render();
      })
      .catch(err => {
        console.error(err);
        Store.setLog && Store.setLog("同步异常：" + (err && err.message || err));
      });

    const addBtn = document.getElementById("addTask");
    if (addBtn) addBtn.addEventListener("click", openAddDialog);

    // 导入西综计划
    const importBtn = document.getElementById("importBtn");
    const importFile = document.getElementById("importFile");
    if (importBtn && importFile) {
      importBtn.addEventListener("click", () => importFile.click());
      importFile.addEventListener("change", handleImport);
    }

    // 从网站获取今日计划
    const importWebBtn = document.getElementById("importWebBtn");
    if (importWebBtn) {
      importWebBtn.addEventListener("click", importTodayFromWeb);
    }

    // 视图切换
    const viewSwitch = document.getElementById("viewSwitch");
    if (viewSwitch) {
      viewSwitch.addEventListener("click", e => {
        const b = e.target.closest("button[data-view]"); if (!b) return;
        currentView = b.dataset.view;
        viewSwitch.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
        render();
      });
    }

    // 大块筛选
    const blockFilterEl = document.getElementById("blockFilter");
    if (blockFilterEl) {
      blockFilterEl.addEventListener("click", e => {
        const b = e.target.closest("button[data-block]"); if (!b) return;
        blockFilter = b.dataset.block;
        blockFilterEl.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
        render();
      });
    }

    // 科目筛选
    const subjFilterEl = document.getElementById("subjectFilter");
    if (subjFilterEl) {
      subjFilterEl.addEventListener("click", e => {
        const b = e.target.closest("button[data-subj]"); if (!b) return;
        subjectFilter = b.dataset.subj;
        subjFilterEl.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
        render();
      });
    }

    // 任务卡片交互（事件委托）
    const container = document.getElementById("taskContainer");
    if (container) {
      container.addEventListener("click", e => {
        // 日历视图：展开/折叠日期 Tab 条
        const dayTabsToggle = e.target.closest("[data-daytabs-toggle]");
        if (dayTabsToggle) {
          const tabsWrap = container.querySelector(".cal-day-tabs");
          const opened = tabsWrap && tabsWrap.classList.toggle("open");
          dayTabsOpen = !!opened;
          const tt = dayTabsToggle.querySelector(".tt");
          if (tt) tt.textContent = opened ? "收起日期" : "展开全部日期";
          if (opened && tabsWrap) {
            const act = tabsWrap.querySelector(".cal-day-tab.active");
            if (act) act.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
          if (window.UI && window.UI.showAlert) window.UI.showAlert(opened ? "已展开所有日期" : "日期已收起", 1200);
          return;
        }

        // 日历视图：上一天/下一天/tab切换
        const prevTab = e.target.closest("[data-cal-prev]");
        if (prevTab) { activeDayIdx = Math.max(0, activeDayIdx - 1); render(); return; }
        const nextTab = e.target.closest("[data-cal-next]");
        if (nextTab) { activeDayIdx++; render(); return; }
        const tabIdx = e.target.closest("[data-cal-tab]");
        if (tabIdx) { activeDayIdx = parseInt(tabIdx.dataset.calTab, 10) || 0; render(); return; }

        // 日历视图：手动完成（记录事件到 time_records）
        const manualId = e.target.closest("[data-manual]")?.dataset?.manual;
        if (manualId) {
          manualCompleteTask(manualId);
          return;
        }
        // 日历视图：撤销完成
        const undoId = e.target.closest("[data-undo]")?.dataset?.undo;
        if (undoId) {
          Store.updateTask(undoId, { done: false, status: "todo", completed_at: null, completed_note: "" });
          if (window.UI && window.UI.showAlert) window.UI.showAlert("已撤销完成", 1500);
          render();
          return;
        }

        // 勾选完成
        const toggleId = e.target.getAttribute("data-toggle");
        if (toggleId && e.target.classList.contains("tcheck")) {
          const t = Store.getTasks().find(x => x.id === toggleId);
          if (t) {
            const newDone = !t.done;
            Store.updateTask(toggleId, { done: newDone, status: newDone ? "done" : "todo" });
          }
          return;
        }
        const gridToggle = e.target.getAttribute("data-toggle");
        if (gridToggle && e.target.classList.contains("gcheck")) {
          const t = Store.getTasks().find(x => x.id === gridToggle);
          if (t) Store.updateTask(gridToggle, { done: !t.done });
          return;
        }

        // 开始计时
        const startId = e.target.closest("[data-start]")?.dataset?.start;
        if (startId) {
          if (window.Timer && window.Timer.startTask) {
            window.Timer.startTask(startId);
            // 提示跳转
            if (window.UI && window.UI.showAlert) {
              window.UI.showAlert("开始计时！可前往「计时」页查看 👉", 2000);
            }
          }
          return;
        }

        // 暂停（直接调 Timer API；btnPause 在 timer.html iframe 里，本页 document 拿不到）
        const pauseId = e.target.closest("[data-pause]")?.dataset?.pause;
        if (pauseId) {
          if (window.Timer && window.Timer.pause) {
            const state = window.Timer.getState();
            if (state && state.status === "running") window.Timer.pause();
            render();
          }
          return;
        }

        // 一键完成（弹备注框）
        const qdId = e.target.closest("[data-quickdone]")?.dataset?.quickdone;
        if (qdId) {
          openQuickDoneDialog(qdId);
          return;
        }

        // 完成并停止
        const finishId = e.target.closest("[data-finish]")?.dataset?.finish;
        if (finishId) {
          if (window.Timer && window.Timer.stopAndMarkDone) {
            window.Timer.stopAndMarkDone();
            if (window.UI && window.UI.showAlert) {
              window.UI.showAlert("🎉 任务完成！", 2000);
            }
          }
          return;
        }
      });
    }

    // 人可研梦·生理学滚动复习（独立卡片交互）
    const physioCard = document.getElementById("physioCard");
    if (physioCard) {
      physioCard.addEventListener("click", (e) => {
        // 暂停计时（直接调 Timer API，btnPause 在 iframe 文档里本页拿不到）
        const pauseId = e.target.closest("[data-pause]")?.dataset?.pause;
        if (pauseId) {
          if (window.Timer && window.Timer.pause) {
            const state = window.Timer.getState();
            if (state && state.status === "running") window.Timer.pause();
          }
          render();
          return;
        }
        // 完成并停止
        const finishId = e.target.closest("[data-finish]")?.dataset?.finish;
        if (finishId) {
          if (window.Timer && window.Timer.stopAndMarkDone) {
            window.Timer.stopAndMarkDone();
            if (window.UI && window.UI.showAlert) window.UI.showAlert("🎉 专注完成！", 2000);
          }
          render();
          return;
        }
        // 开始计时（复用任务计时）
        const startId = e.target.closest("[data-start]")?.dataset?.start;
        if (startId) {
          if (window.Timer && window.Timer.startTask) {
            window.Timer.startTask(startId);
            if (window.UI && window.UI.showAlert) window.UI.showAlert("开始专注！", 1500);
            render();
          }
          return;
        }
        // 完成此 DAY → 自动跳下一 DAY
        const doneId = e.target.closest("[data-physio-done]")?.dataset?.physioDone;
        if (doneId) {
          const task = Store.getTasks().find(x => x.id === doneId);
          const phys = physioList();
          if (task && !task.done) manualCompleteTask(task.id); // 标记完成 + 记录事件 + 提示
          // 自动跳到下一个未完成的 DAY
          const nextUndone = phys.findIndex((t, i) => i > physioIdx && !t.done);
          if (nextUndone !== -1) {
            physioIdx = nextUndone;
            if (window.UI && window.UI.showAlert) window.UI.showAlert(`→ 跳到 DAY ${dayNumOf(phys[nextUndone])}`, 1200);
          }
          render();
          return;
        }
        // 撤销完成
        const undoId = e.target.closest("[data-physio-undo]")?.dataset?.physioUndo;
        if (undoId) {
          Store.updateTask(undoId, { done: false, status: "todo" });
          if (window.UI && window.UI.showAlert) window.UI.showAlert("已撤销", 1200);
          render();
          return;
        }
        // 切换 DAY（tab / 前后箭头）
        const tabId = e.target.closest("[data-physio-tab]")?.dataset?.physioTab;
        if (tabId !== undefined) {
          const idx = parseInt(tabId, 10);
          if (!isNaN(idx) && idx >= 0 && idx < physioList().length) physioIdx = idx;
          render();
          return;
        }
        // 展开 / 收起 DAY 全清单
        if (e.target.closest("[data-physio-toggle]")) {
          physioExpanded = !physioExpanded;
          render();
          return;
        }
        // 折叠 / 展开整卡
        if (e.target.closest("[data-physio-collapse]")) {
          physioCollapsed = !physioCollapsed;
          render();
          return;
        }
      });
    }

    Store.subscribeTasks(() => render());
    Store.subscribeTimeRecords(() => render());
    render();
    if (window.Icon) {
      window.Icon.inject(document.getElementById("viewSwitch"));
      window.Icon.inject(document.getElementById("subjectFilter"));
    }

    // 每秒刷新运行中的任务状态
    setInterval(() => {
      const runningId = window.Timer ? window.Timer.getLinkedTaskId() : null;
      const runningCards = document.querySelectorAll(".tcard.isrunning");
      const hasRunning = runningCards.length > 0;
      const shouldHaveRunning = runningId && todayTasks().some(t => t.id === runningId);
      if (hasRunning !== shouldHaveRunning) render();
    }, 1000);

    // 计时 / 任务清单 Tab 切换
    const paneSwitch = document.getElementById("paneSwitch");
    if (paneSwitch) {
      paneSwitch.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-pane]");
        if (!b) return;
        paneSwitch.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
        const p = b.dataset.pane;
        document.getElementById("pane-task")?.classList.toggle("hidden", p !== "task");
        document.getElementById("pane-timer")?.classList.toggle("hidden", p !== "timer");
        // 切到计时时，让 iframe 内部高度自适应（通知加载完的 timer 文档）
        const frame = document.getElementById("timerFrame");
        if (frame && p === "timer") {
          try { frame.contentWindow && frame.contentWindow.dispatchEvent && frame.contentWindow.dispatchEvent(new Event("resize")); } catch (err) { /* ignore */ }
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

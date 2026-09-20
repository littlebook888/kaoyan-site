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
  let calDayRestored = false;  // 本次页面加载是否已恢复过上次的日期选择
  let dayTabsOpen = false;     // 日历视图：日期 Tab 条 展开/收起（跨渲染保持）
  /* 上次 render() 时"计时关联的任务"是哪一个（null = 当前没有任务计时）。
   * 基线由 render() 自己维护（见其尾部），liveTick 只在它【变化】时整页重渲染。 */
  let _lastRenderedRunningId = null;

  const SUBJECT_META = {
    all:       { label: "全部",   color: "#86868b", icon: "layers" },
    xizong:    { label: "西医综合", color: "#66ccff", icon: "book-open" },
    english:   { label: "英语",    color: "#ff7eb9", icon: "languages" },
    politics:  { label: "政治",    color: "#f5a623", icon: "flag" },
    other:     { label: "其他",    color: "#b0b7c3", icon: "sparkles" }
  };

  const TYPE_META = {
    course:  { label: "听课", color: "#66ccff" },
    word:    { label: "背单词", color: "#c96442" },   // 单词突围主色（参考 aim-read.top 暖调纸感配色）
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
    // 每次重渲染都把"运行态基线"对齐到当前真实值（v1.22.2）：
    // 否则本函数被别处（Store.subscribeTasks 等）调用后基线仍是旧值，
    // liveTick 下一拍会误判"运行态变化"而多渲染一次（闪烁 + 丢点击）。
    _lastRenderedRunningId = (window.Timer && window.Timer.getLinkedTaskId) ? (window.Timer.getLinkedTaskId() || null) : null;
    renderWordPlan();
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
  // 返回所有计划任务分组：按日期升序（排除人可研梦生理系列——它与日期无关、独立进度）
  // 含西综计划 + 英语单词突围每日任务（后者按日期推进，需进日历）
  function collectPlanDays() {
    const all = Store.getTasks().filter(t =>
      (t.subject === "xizong" || isWordTask(t)) && !isPhysioTask(t)
    );
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

    // ★ 定位：不再强制跳到"最早未完成日"。首次加载恢复上次浏览的日期（本地记忆），
    //   首次使用 = 第一天；之后完全由用户自由切换（上一天/下一天/日期 Tab）
    if (activeDayIdx >= order.length) activeDayIdx = 0;
    if (!calDayRestored) {
      const stored = (() => { try { return localStorage.getItem("kaoyan:cal_day"); } catch (e) { return null; } })();
      const idx = stored ? order.indexOf(stored) : -1;
      if (idx !== -1) activeDayIdx = idx;
      calDayRestored = true;
    }
    const currentDayKey = order[activeDayIdx];
    // 记住当前浏览的日期（下次打开恢复到这里，配合自由跳转）
    try { localStorage.setItem("kaoyan:cal_day", currentDayKey); } catch (e) {}
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

    // 排序：course → word → review → problem → other
    const typeOrder = ["course", "word", "review", "problem", "other"];
    const typeLabels = { course: "看课", word: "背单词", review: "复习", problem: "刷题", other: "其他" };

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

    // 日历导航（★ 自由跳转：前后都可用，不再以"全部完成"为前提）
    html += `<div class="cal-nav">`;
    if (activeDayIdx > 0) {
      html += `<button class="cal-nav-btn" data-cal-prev><span data-icon="chevron-up"></span> 上一天</button>`;
    }
    if (activeDayIdx < order.length - 1) {
      html += `<button class="cal-nav-btn cal-nav-next" data-cal-next>下一天 <span data-icon="chevron-down"></span></button>`;
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
  /* ---------- 任务 ↔ 计时会话的联动状态（v1.22.6 根修）----------
   * ⚠️ 旧写法 `Timer.getLinkedTaskId() === t.id` 只回答"这个任务有没有被计时器挂着"，
   *   **不看会话是 running 还是 paused**。而 getLinkedTaskId 读的是 at.task_id（v1.22.1 改的），
   *   暂停后 at 仍然存在、task_id 仍然等于该任务 → 卡片判定为"计时中"，只渲染「暂停/完成」，
   *   **没有「继续」** → 用户报「任务暂停后怎么就无法继续了」。
   * 现在按会话真实状态分三种：running（计时中）/ paused（已暂停 → 给「继续」）/ none（未开始）。
   * 与日期无关：DAY 3 是 09-15 的任务，今天点「继续」照样接着上一段（跨天继续）。 */
  function linkState(taskId) {
    if (!taskId || !window.Timer) return "none";
    const st = window.Timer.getState ? window.Timer.getState() : null;
    const linked = window.Timer.getLinkedTaskId ? window.Timer.getLinkedTaskId() : null;
    if (!st || !linked || linked !== taskId) return "none";
    if (st.status === "running") return "running";
    if (st.status === "paused") return "paused";
    return "none";
  }
  /* 已暂停会话的累计时长（秒）——暂停时 pause() 会把累计写进 elapsed_sec */
  function pausedFocusSec() {
    const st = window.Timer && window.Timer.getState ? window.Timer.getState() : null;
    return st ? Math.max(0, Math.floor(st.elapsed_sec || 0)) : 0;
  }
  /* 暂停发生在"别的日子"时标出来（说明这是跨天继续的那一段）：updated_at = 暂停时刻 */
  function pausedSinceText() {
    const st = window.Timer && window.Timer.getState ? window.Timer.getState() : null;
    if (!st || !st.updated_at) return "";
    const d = new Date(st.updated_at), t = new Date();
    if (d.toDateString() === t.toDateString()) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `（${p(d.getMonth() + 1)}-${p(d.getDate())} 暂停，可继续）`;
  }
  /* 已暂停时的展示文案（各处卡片共用） */
  function pausedFocusText() {
    return `已暂停 · 累计 ${fmtDuration(pausedFocusSec())}${pausedSinceText()}`;
  }
  /* 联动状态徽标文案（卡片右上角的"计时中/已暂停"） */
  function linkBadge(state) {
    if (state === "running") return `<span class="cs-badge" style="--cb:#2563eb">计时中</span>`;
    if (state === "paused") return `<span class="cs-badge" style="--cb:#b45309">已暂停</span>`;
    return "";
  }

  function renderCalSubCard(t, dayAllDone) {
    const subj = SUBJECT_META[t.subject] || SUBJECT_META.other;
    const focusSec = t.total_focus_sec || 0;
    const estMin = t.estimated_min || 0;
    const lk = linkState(t.id);   // 计时会话真实状态：running / paused / none（v1.22.6）
    const isDone = t.done;
    const tm = TYPE_META[t.task_type] || TYPE_META.other;
    const color = taskColor(t);

    let actions = "";
    if (isDone) {
      actions = `<span class="cs-done-tag">✓ 已完成</span>
        <button class="cs-btn cs-undo" data-undo="${t.id}">撤销</button>`;
    } else if (lk === "running") {
      actions = `
        <button class="cs-btn cs-pause" data-pause="${t.id}"><span data-icon="pause"></span> 暂停</button>
        <button class="cs-btn cs-finish" data-finish="${t.id}">完成</button>`;
    } else if (lk === "paused") {
      actions = `
        <button class="cs-btn cs-start" data-resume="${t.id}"><span data-icon="play"></span> 继续</button>
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
      <div class="cs-card ${isDone ? 'cs-done' : ''} ${lk === "running" ? 'cs-running' : ''}" style="--ct:${color}" data-id="${t.id}">
        <div class="cs-main">
          <div class="cs-title">${escapeHtml(t.title)}</div>
          <div class="cs-meta">
            ${t.ref_id ? `<span class="cs-ref" title="人类可读任务ID">${escapeHtml(t.ref_id)}</span>` : ''}
            <span class="cs-badge" style="--cb:${color}">${tm.label}</span>
            ${estMin > 0 ? `<span class="cs-est">预估 ${estMin}分</span>` : ''}
            ${linkBadge(lk)}
            ${lk === "running"
              ? `<span class="cs-focus" data-live-focus="${t.id}">计时中</span>`
              : lk === "paused"
                ? `<span class="cs-focus">${pausedFocusText()}</span>`
                : focusSec > 0 ? `<span class="cs-focus">${isDone ? '花费' : '已消耗：'}${fmtDuration(focusSec)}</span>` : '<span class="cs-focus">未开始</span>'}
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
    return Store.getTasks().filter(isPhysioTask).sort((a, b) => {
      const na = dayNumOf(a), nb = dayNumOf(b); return na - nb;
    });
  }
  /* ---------- 计划系列的身份识别（v1.22.2）----------
   * ⚠️ 事故背景：tasks 表的 source/day_label/note 三列是**后补建**的。建列之前的推送
   *   被"缺列自愈"剥掉了这几个字段 → 云端存成 null；此后的每次全量拉取又把本地丰富的
   *   字段值覆盖成 null 并推回云端 → null 在全网自我延续。
   *   后果：按 source 过滤的「英语单词突围」「人可研梦」卡片永远取到 0 条 → 一直显示
   *   "加载中…"；且新设备（无 localStorage 标记）会把整个计划再导入一遍 → 云端出现双份 DAY。
   * 对策：识别不再只认 source，同时认**标题特征**（标题一直同步得好）；并把缺失的
   *   身份字段从标题反推回来（repairPlanIdentity），让卡片与增补逻辑都能自愈。 */
  const WORD_TITLE_RE = /每日单词任务|^背单词\s*[·:：]/;   // 新格式 + 早期格式「背单词 · 新词 216」
  const PHYSIO_TITLE_RE = /人可研梦滚动复习/;
  function isWordTask(t) {
    return !!t && (t.source === "english_words" || WORD_TITLE_RE.test(t.title || ""));
  }
  function isPhysioTask(t) {
    return !!t && (t.source === "physio_rolling" || PHYSIO_TITLE_RE.test(t.title || ""));
  }
  /* DAY 号提取：day_label →（"DAY N"）标题 →（"第 N 天"）备注。
   * day_label 在云端可能为 null（见上），必须有后备来源，否则全都算成 DAY 0 →
   * 增补逻辑误判"整个计划都缺" → 重复导入。 */
  function dayNumOf(t) {
    const fromLabel = (t.day_label || "").match(/\d+/);
    if (fromLabel) return parseInt(fromLabel[0], 10);
    const fromTitle = (t.title || "").match(/DAY\s*(\d+)/i);
    if (fromTitle) return parseInt(fromTitle[1], 10);
    const fromNote = (t.note || "").match(/第\s*(\d+)\s*天/);
    if (fromNote) return parseInt(fromNote[1], 10);
    return 0;
  }
  /* 一天的西综计划 → 任务条目 [{title, task_type, estimated_min?, completed_note?}]
   * 导入与自愈共用的唯一构造点——标题逐字一致，是自愈按 (日期+标题) 认领云端旧行的前提。 */
  function xizongDayItemsOf(dayData) {
    const out = [];
    const ok = (s) => s && s !== "/" && s !== "／";
    if (ok(dayData.course)) {
      const items = dayData.course.split(/[\n]+/).map(s => s.trim()).filter(ok);
      const durations = (dayData.duration || "").split(/[\n]+/).map(s => {
        const mm = s.match(/(\d+)\s*min/);
        return mm ? parseInt(mm[1], 10) : null;
      });
      items.forEach((item, i) => out.push({
        title: `听课：${item}`, task_type: "course", estimated_min: durations[i] || null
      }));
    }
    if (ok(dayData.review)) {
      dayData.review.split(/[\n;；]+/).map(s => s.trim()).filter(ok)
        .forEach(item => out.push({ title: `复习：${item.slice(0, 40)}`, task_type: "review" }));
    }
    if (ok(dayData.problem)) {
      const items = dayData.problem.split(/[\n;；]+/).map(s => s.trim()).filter(ok);
      if (items.length) {
        const full = items.join("；");
        out.push({ title: `刷题：${full.slice(0, 60)}${full.length > 60 ? "…" : ""}`, task_type: "problem", completed_note: full });
      }
    }
    if (ok(dayData.rolling)) {
      dayData.rolling.split(/[\n]+/).map(s => s.trim()).filter(ok)
        .forEach(item => out.push({ title: `滚动复习：${item.slice(0, 40)}`, task_type: "review", completed_note: item }));
    }
    return out;
  }
  /* 西综计划索引：日期|标题 → 应填字段（供身份/内容自愈认领云端旧行） */
  function xizongPlanIndex() {
    const idx = new Map();
    (window.XIZONG_PLAN || []).forEach(dayData => {
      if (!dayData.date) return;
      const [y, m, d] = dayData.date.split("-");
      const dateStr = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)).toDateString();
      const dayLabel = dayData.day ? `DAY ${dayData.day}` : "";
      xizongDayItemsOf(dayData).forEach(it => {
        idx.set(dateStr + "|" + it.title, {
          day_label: dayLabel, source: "xizong_plan",
          estimated_min: it.estimated_min, completed_note: it.completed_note
        });
      });
    });
    return idx;
  }
  /* 把云端 null 掉的身份/内容字段从标题与计划表补回（幂等；改了才写，返回补了多少条）
   * 覆盖三个系列：单词突围、人可研梦、西综计划（听课/复习/刷题/滚动复习）。 */
  function repairPlanIdentity() {
    const all = Store.getTasks();
    const wordPlan = window.WORD_PLAN || [];
    const physioPlan = window.PHYSIO_PLAN || [];
    const wp = {}; wordPlan.forEach(p => { wp[p.day] = p; });
    const pp = {}; physioPlan.forEach(p => { pp[p.day] = p; });
    const xz = xizongPlanIndex();
    let changed = 0;
    const next = all.map(t => {
      /* 西综计划：只填空值，绝不新建、绝不覆盖已有内容（completed_note 是复习原文） */
      const want = (t.subject === "xizong" && t.date && t.title) ? xz.get(t.date + "|" + t.title) : null;
      if (want) {
        const patch = {};
        if (!t.source) patch.source = want.source;
        if (!t.day_label && want.day_label) patch.day_label = want.day_label;
        if (!t.completed_note && want.completed_note) patch.completed_note = want.completed_note;
        if (t.estimated_min == null && want.estimated_min != null) patch.estimated_min = want.estimated_min;
        if (!Object.keys(patch).length) return t;
        changed++;
        return { ...t, ...patch };
      }
      if (!isWordTask(t) && !isPhysioTask(t)) return t;
      const n = dayNumOf(t);
      const patch = {};
      if (isWordTask(t)) {
        if (t.source !== "english_words") patch.source = "english_words";
        if (!t.day_label && n > 0) patch.day_label = "DAY " + n;
        const p = wp[n];
        if (!t.note && p) patch.note = `词书：考研英语 6700｜第 ${p.day} 天｜${p.words} 词`;
      } else {
        if (t.source !== "physio_rolling") patch.source = "physio_rolling";
        if (!t.day_label && n > 0) patch.day_label = "DAY " + n;
        const p = pp[n];
        if (!t.note && p) patch.note = `第二期：${p.term2} 起滚动复习；第三期：${p.term3} 起滚动复习`;
      }
      if (!Object.keys(patch).length) return t;
      changed++;
      return { ...t, ...patch };
    });
    if (changed) {
      Store.setLocal("tasks", next);
      console.log(`[tasks] 已从标题/计划表补回 ${changed} 条计划任务的身份字段（source/day_label/note）`);
    }
    return changed;
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
      const lk = linkState(cur.id);
      bodyHtml = `<div class="cs-card ${lk === "running" ? 'cs-running' : ''}" style="--ct:#059669">
        <div class="cs-main">
          <div class="cs-title">${escapeHtml(cur.title)}</div>
          <div class="cs-meta">
            <span class="cs-badge" style="--cb:#059669">复习</span>
            ${linkBadge(lk)}
            ${lk === "running"
              ? `<span class="cs-focus" data-live-focus="${cur.id}">计时中</span>`
              : lk === "paused"
                ? `<span class="cs-focus">${pausedFocusText()}</span>`
                : focusSec > 0 ? `<span class="cs-focus">已消耗：${fmtDuration(focusSec)}</span>` : '<span class="cs-focus">未开始</span>'}
          </div>
        </div>
        <div class="cs-actions">
          ${lk === "running"
            ? `<button class="cs-btn cs-pause" data-pause="${cur.id}"><span data-icon="pause"></span> 暂停</button>
               <button class="cs-btn cs-finish" data-finish="${cur.id}">完成</button>`
            : lk === "paused"
            ? `<button class="cs-btn cs-start" data-resume="${cur.id}"><span data-icon="play"></span> 继续</button>
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

  /* ---------- 英语单词突围 · 每日背单词（独立系列、按日期推进，与西综/生理互不影响） ---------- */
  let vocabIdx = -1;          // 当前查看的 DAY 下标（-1 = 跟随今天）
  let vocabExpanded = false;  // 全部 DAY 清单是否展开
  let vocabCollapsed = false; // 整卡是否收起
  function vocabList() {
    return Store.getTasks().filter(isWordTask)
      .sort((a, b) => dayNumOf(a) - dayNumOf(b));
  }
  function vocabTodayIdx(list) {
    const today = todayStr();
    return list.findIndex(t => (t.date || "") === today);
  }
  function vocabTabBtn(i, t) {
    return `<button type="button" class="physio-tab ${i === vocabIdx ? "active" : ""}" data-vocab-tab="${i}" ${t.done ? 'data-done="1"' : ""}>
      DAY${dayNumOf(t)}${t.done ? ' <span class="ptick">✓</span>' : ""}</button>`;
  }
  function isWindowsDesktop() {
    return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "");
  }
  function renderWordPlan() {
    const el = document.getElementById("wordCard");
    if (!el) return;
    const list = vocabList();
    if (!list.length) {
      // 空态占位（区分"没导入"和"被隐藏"）
      el.style.display = "";
      el.innerHTML = `
        <div style="text-align:center;padding:18px 0;color:var(--ink-3);font-size:13px">
          <div style="font-size:26px;margin-bottom:6px">📕</div>
          英语单词突围：加载中…<br>
          <span style="font-size:11px;opacity:0.7">若长时间停留此状态，请刷新或检查网络</span>
        </div>`;
      return;
    }
    el.style.display = "";

    const todayI = vocabTodayIdx(list);
    const idx = vocabIdx >= 0 ? Math.min(vocabIdx, list.length - 1)
                              : (todayI >= 0 ? todayI : list.length - 1);
    const cur = list[idx];
    const curDay = dayNumOf(cur);
    const doneTotal = list.filter(t => t.done).length;
    const isReview = /复习/.test(cur.title || "");
    const todayHint = (vocabIdx < 0 && todayI >= 0) ? `<span class="pcur-sub">今天</span>`
                    : (todayI < 0 ? `<span class="pcur-sub">今日无任务</span>` : "");

    // DAY 切换区
    let navHtml;
    if (vocabExpanded) {
      navHtml = `<div class="physio-tabs open">${list.map((t, i) => vocabTabBtn(i, t)).join("")}
        <button type="button" class="physio-tab physio-more" data-vocab-toggle>收起 ▴</button></div>`;
    } else {
      navHtml = `<div class="physio-tabs">
        <button type="button" class="physio-nav" data-vocab-tab="${idx - 1}" ${idx > 0 ? "" : "disabled"}>◀</button>
        <button type="button" class="physio-cur" data-vocab-done="${cur.id}">DAY ${curDay}${todayHint}<span class="pcur-sub">${doneTotal}/${list.length}</span></button>
        <button type="button" class="physio-nav" data-vocab-tab="${idx + 1}" ${idx < list.length - 1 ? "" : "disabled"}>▶</button>
        <button type="button" class="physio-more" data-vocab-toggle>全部DAY ▾</button>
        ${vocabIdx >= 0 ? `<button type="button" class="physio-more" data-vocab-today>回到今天</button>` : ""}
      </div>`;
    }

    // 当前 DAY 卡片
    let bodyHtml;
    if (cur.done) {
      const focusSec = cur.total_focus_sec || 0;
      const nextUndone = list.findIndex((t, i) => i > idx && !t.done);
      bodyHtml = `<div class="physio-done">
        <div class="physio-day-done"><span class="pd-check">✓</span> DAY ${curDay} 已完成</div>
        ${focusSec > 0 ? `<div class="physio-focus-time">花费 ${fmtDuration(focusSec)}</div>` : ''}
        ${nextUndone !== -1 ? `<div class="physio-next-hint">下一个未完成：DAY ${dayNumOf(list[nextUndone])}</div>` : `<div class="physio-next-hint">🎉 计划的 ${list.length} 个 DAY 已全部完成！</div>`}
        <button class="cs-btn cs-undo" data-vocab-undo="${cur.id}">撤销</button>
      </div>`;
    } else {
      const focusSec = cur.total_focus_sec || 0;
      const lk = linkState(cur.id);
      bodyHtml = `<div class="cs-card ${lk === "running" ? 'cs-running' : ''}" style="--ct:#c96442">
        <div class="cs-main">
          <div class="cs-title">${escapeHtml(cur.title)}</div>
          <div class="cs-meta">
            <span class="cs-badge" style="--cb:${vocabBadgeColor(isReview)}">${isReview ? "复习" : "新词"}</span>
            ${linkBadge(lk)}
            ${lk === "running"
              ? `<span class="cs-focus" data-live-focus="${cur.id}">计时中</span>`
              : lk === "paused"
                ? `<span class="cs-focus">${pausedFocusText()}</span>`
                : focusSec > 0 ? `<span class="cs-focus">已消耗：${fmtDuration(focusSec)}</span>` : '<span class="cs-focus">未开始</span>'}
          </div>
        </div>
        <div class="cs-actions">
          ${lk === "running"
            ? `<button class="cs-btn cs-pause" data-pause="${cur.id}"><span data-icon="pause"></span> 暂停</button>
               <button class="cs-btn cs-finish" data-finish="${cur.id}">完成</button>`
            : lk === "paused"
            ? `<button class="cs-btn cs-start" data-resume="${cur.id}"><span data-icon="play"></span> 继续</button>
               <button class="cs-btn cs-finish" data-finish="${cur.id}">完成</button>`
            : `<button class="cs-btn cs-start" data-start="${cur.id}"><span data-icon="play"></span> 开始</button>
               <button class="cs-btn cs-vocab-done" data-vocab-done="${cur.id}"><span data-icon="check"></span> 完成此 DAY</button>`}
        </div>
      </div>`;
    }

    // 总进度（整个计划）+ 冲刺倒计时（鼓励超前：按实际节奏推算，一天完成多天会自动提前结束）
    const pct = Math.round((doneTotal / list.length) * 100);
    const remainDays = list.length - doneTotal;                       // 还剩多少个 DAY
    const startMs = new Date(list[0].date).getTime();
    const elapsedDays = Math.max(1, Math.round((Date.now() - startMs) / 86400000));
    // 节奏 = 平均每个 DAY 花几天（超前完成 <1；没开始按 1 天/DAY 推算）
    const daysPerDay = doneTotal > 0 ? Math.max(0.5, elapsedDays / doneTotal) : 1;
    const etaMs = Date.now() + remainDays * daysPerDay * 86400000;
    const eta = new Date(etaMs);
    const etaLabel = `${String(eta.getMonth() + 1).padStart(2, "0")}-${String(eta.getDate()).padStart(2, "0")}`;
    // 英语六级：2026-12-12
    const cetMs = new Date(2026, 11, 12).getTime();
    const cetGap = Math.round((cetMs - etaMs) / 86400000);
    const paceTxt = doneTotal === 0
      ? "按每天 1 个 DAY 推算"
      : `当前节奏：日均 ${(1 / daysPerDay).toFixed(1)} 个 DAY${(1 / daysPerDay) > 1.05 ? " · 超前 ✅" : ""}`;
    // 进度提醒分两种口径：
    // 1) 只有“今天之前仍未完成”的 DAY 才算历史欠账/进度滞后；
    // 2) 今天排期但尚未完成，只提醒“今日待完成”，不能误报为落后 1 天。
    const todayKey = (() => {
      const d = window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const overdue = list.filter(t => {
      const key = planDateLabel(t);
      return key && key < todayKey && !t.done;
    });
    const dueToday = list.filter(t => planDateLabel(t) === todayKey && !t.done);
    const lagHtml = overdue.length > 0
      ? `<div class="vocab-lag">⚠️ 进度滞后：今天以前仍有 <b>${overdue.length}</b> 个 DAY 未完成——先补历史欠账，再推进今日任务</div>`
      : (dueToday.length > 0
        ? `<div class="vocab-lag vocab-today">📌 今日任务尚未完成：还有 <b>${dueToday.length}</b> 个 DAY 待完成——今天完成即可，不计为落后</div>`
        : "");
    const winBtn = isWindowsDesktop()
      ? `<button type="button" class="vocab-openapp" data-vocab-openapp><span data-icon="graduation-cap"></span> 打开单词突围</button>`
      : "";

    el.innerHTML = `<div class="physio-wrap">
      <div class="physio-head">
        <div class="physio-htitle">
          <span class="physio-logo">📕</span>
          <span class="physio-name">英语单词突围 · 每日背单词</span>
          <span class="physio-badge">独立进度 · 与天天师兄互不影响</span>
        </div>
        <div class="vocab-head-actions">
          ${winBtn}
          <button type="button" class="physio-collapse-btn" data-vocab-collapse>${vocabCollapsed ? "▼ 展开" : "▲ 收起"}</button>
        </div>
      </div>
      <div class="physio-body" style="${vocabCollapsed ? "display:none" : ""}">
        ${navHtml}
        ${bodyHtml}
        <div class="vocab-total">
          <div class="vocab-total-top"><span>计划总进度</span><span>${doneTotal}/${list.length} 天 · ${pct}%</span></div>
          <div class="vocab-total-bar"><i style="width:${pct}%"></i></div>
          <div class="vocab-total-meta">
            还剩 <b>${remainDays}</b> 天 · 预计结束 <b>${etaLabel}</b>
            · 届时距英语六级（12-12）还有 <b>${Math.max(0, cetGap)}</b> 天
            <span class="vocab-total-pace">${paceTxt}；一天完成多天的量，结束日期自动提前</span>
            ${lagHtml}
          </div>
        </div>
      </div>
    </div>`;
    if (window.Icon) window.Icon.inject(el);
  }
  // 新词/复习徽章配色（新词=单词突围主色陶土红棕；复习沿用全局「复习」绿，保持语义一致）
  function vocabBadgeColor(isReview) { return isReview ? "#059669" : "#c96442"; }

  function renderTaskCard(t) {
    const subj = SUBJECT_META[t.subject] || SUBJECT_META.other;
    const focusSec = t.total_focus_sec || 0;
    const estMin = t.estimated_min || 0;
    const estSec = estMin * 60;
    const progress = estSec > 0 ? Math.min(100, (focusSec / estSec) * 100) : 0;
    const lk = linkState(t.id);   // 计时会话真实状态：running / paused / none（v1.22.6）
    const isDone = t.done;

    // 操作按钮
    let actionBtn = "";
    if (isDone) {
      actionBtn = `<button class="tac-btn done-btn" title="已完成"><span class="tac-icon">✓</span></button>`;
    } else if (lk === "running") {
      actionBtn = `
        <button class="tac-btn pause-btn" data-pause="${t.id}" title="暂停">
          <span class="tac-icon" data-icon="pause"></span>
        </button>
        <button class="tac-btn finish-btn" data-finish="${t.id}" title="完成并停止">
          <span class="tac-icon" data-icon="check"></span>
        </button>`;
    } else if (lk === "paused") {
      actionBtn = `
        <button class="tac-btn play-btn" data-resume="${t.id}" title="继续（接着上一段计时）">
          <span class="tac-icon" data-icon="play"></span>
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

    /* v1.22.1：运行中的任务实时显示已耗时（此前运行中也显示"未开始"——用户反馈的主症状） */
    const focusLine = lk === "running"
      ? `<span class="tmeta-focus" data-live-focus="${t.id}">计时中</span>`
      : lk === "paused"
        ? `<span class="tmeta-focus">${pausedFocusText()}</span>`
      : focusSec > 0
        ? `<span class="tmeta-focus">${isDone ? '花费' : '已消耗：'}${fmtDuration(focusSec)}</span>`
        : `<span class="tmeta-focus">未开始</span>`;

    return `
      <div class="tcard ${isDone ? "isdone" : ""} ${lk === "running" ? "isrunning" : ""}" style="--sc:${subj.color}" data-id="${t.id}">
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
    /* ★ 跨设备守卫（v1.22.2 放宽）：旧写法只认 source==="xizong_live"，
     *   而云端 tasks.source **全表为 null**（后补列时代的 null 传染）→ 新设备上守卫恒不通过
     *   → 同一套计划被重新导入（新 id 推上云端 → 全端重复）。
     *   改为看标题特征（官方计划任务都以「听课：/刷题：/复习：」开头且属西综）。 */
    if (Store.getTasks().some(t => t.subject === "xizong" && /^(听课|刷题)：/.test(t.title || ""))) {
      localStorage.setItem(IMPORT_KEY, "1");
      return;
    }
    if (waitFirstPull()) return;   // 首次拉取没结束 → 等它回来再决定（防双份计划）

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
    /* ★ 跨设备守卫（v1.22.2 放宽）：旧写法同时要求 source==="xizong_plan" 与
     *   completed_note 长度>10 —— 这两列在云端**全表为 null**（后补列时代的 null 传染），
     *   于是守卫在任何新设备上都不可能通过 → 会把整套西综计划再导一遍（云端数百条重复）。
     *   改为只看**标题**：标题是同步最可靠、从未丢失的字段；只要已有 v2 形态的滚动复习任务，
     *   就说明本账号早就导过了。 */
    if (Store.getTasks().some(t => /^滚动复习/.test(t.title || ""))) {
      localStorage.setItem(IMPORT_KEY, "1");
      return;
    }
    if (waitFirstPull()) return;   // 首次拉取没结束 → 等它回来再决定（防双份计划）

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

      /* 条目构造与"自愈/去重"共用同一份逻辑（xizongPlanIndex），标题永远不会漂移：
       * 其一，导入不重复；其二，repairPlanIdentity 能按 (日期+标题) 认领云端旧行补字段。 */
      xizongDayItemsOf(dayData).forEach(it => {
        const { title, task_type, completed_note } = it;
        addUnique(title, { task_type, ...(completed_note !== undefined ? { completed_note } : {}) });
      });
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
    if (Store.getTasks().some(isPhysioTask)) return;
    if (localStorage.getItem(PHYSIO_IMPORT_FLAG)) return;
    if (waitFirstPull()) return;   // 首次拉取没结束 → 等它回来再决定（防双份 DAY）

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

  /* ---------- 自动导入 英语单词突围·每日背单词（独立系列，按日期推进）----------
   * 每天一个任务：DAY N（新词 216/215 词 或 复习 648/647/645 词），date = 当天
   * → 既出现在上方独立卡，也进入日历/当日完成度 */
  const WORD_IMPORT_FLAG = "english_words_imported_v1";
  /* 统一标题格式（用户指定）：
   *   09-15 DAY 3 每日单词任务：背单词·新词 216
   *   09-16 DAY 4 每日单词任务：背单词·复习 648
   * 日期取计划里的 MM-DD，DAY 取 day_label，末尾为 类型·词量 */
  function vocabTitle(p) {
    const mmdd = String(p.dateStr).slice(5);            // "09-15"
    const kind = p.kind === "review" ? "复习" : "新词";
    return `${mmdd} ${p.label} 每日单词任务：背单词·${kind} ${p.words}`;
  }
  /* 标题规范化迁移（幂等）：早期版本标题为「背单词 · 新词 216」，改为统一格式。
   * 只改 title，保留 done / total_focus_sec / time_record_ids 等全部进度。
   * 一次性批量写入（避免逐条 updateTask 触发 41 次全表推送） */
  function migrateVocabTitles() {
    const plan = window.WORD_PLAN || [];
    const byDay = {};
    plan.forEach(p => { byDay[p.day] = p; });
    const all = Store.getTasks();
    let changed = 0;
    const next = all.map(t => {
      if (t.source !== "english_words") return t;
      const n = dayNumOf(t);
      const p = byDay[n];
      if (!p) return t;
      const want = vocabTitle(p);
      if (t.title === want) return t;
      changed++;
      return { ...t, title: want };
    });
    if (changed) {
      Store.setLocal("tasks", next);
      console.log(`[tasks] 单词突围标题已规范化 ${changed} 条`);
    }
    return changed;
  }
  /* 云端已配置但"首次拉取"还没结束时，暂缓【整套计划导入】。
   * 否则新设备（清过缓存/换浏览器）会先把整套计划导入本地并推上云端，紧接着首次拉取
   * 又带回云端那套 → 云端出现双份 DAY。拉取【尝试过】即放行（失败也导，保持离线可用）。 */
  function waitFirstPull() {
    return !!(Store.isPullSettled && !Store.isPullSettled());
  }
  function autoImportWordPlan() {
    const plan = window.WORD_PLAN;
    if (!plan || !plan.length) return;

    // 双重守卫：Store 数据 + localStorage 标记（顺序照生理卡——先查 Store 更安全）
    // 已有数据时顺带做一次标题规范化迁移（老版本导入的标题格式需更新）
    const existing = () => Store.getTasks().filter(isWordTask);
    if (existing().length > 0) {
      migrateVocabTitles();
      /* v1.22.1 增量补齐：旧守卫"有任何一条就整段跳过"，导致部分缺失的 DAY
       * （如云端只同步到 DAY29）永远补不上——用户看到"单词突围加载中/缺 DAY"。
       * 现按缺失的 DAY 号增量导入（已有 DAY 不动，done 状态不碰）。
       * v1.22.2 安全阀：历史上身份字段被云端 null 掉时 dayNumOf 全为 0，会把整个计划
       *   误判为"全缺"再导一份 → 这里按剩余名额截断，结构上不可能超过计划天数。 */
      const haveDays = new Set(existing().map(t => dayNumOf(t)));
      const room = plan.length - existing().length;
      if (room <= 0) return;
      const missing = plan.filter(p => !haveDays.has(p.day)).slice(0, room);
      if (!missing.length) return;
      const mk = (partial) => ({
        id: uid(), user_id: C.USER_ID,
        done: false, subject: "english", task_type: "word",
        estimated_min: null, remind_on_estimate: true,
        total_focus_sec: 0, status: "todo", time_record_ids: [],
        category: "general", slot: null, block: null,
        created_at: new Date().toISOString(),
        source: "english_words",
        ...partial
      });
      missing.forEach(p => {
        const [y, m, d] = p.dateStr.split("-").map(Number);
        Store.addTask(mk({
          title: vocabTitle(p),
          day_label: p.label,
          date: new Date(y, m - 1, d).toDateString(),
          note: `词书：考研英语 6700｜第 ${p.day} 天｜${p.words} 词`
        }));
      });
      if (window.UI && window.UI.showAlert) {
        window.UI.showAlert(`📕 单词突围补齐缺失 DAY（${missing.map(p => p.day).join(",")}）`, 2500);
      }
      return;
    }
    if (localStorage.getItem(WORD_IMPORT_FLAG)) return;
    if (waitFirstPull()) return;   // 首次拉取没结束 → 等它回来再决定（防双份 DAY）

    const mk = (partial) => ({
      id: uid(), user_id: C.USER_ID,
      done: false, subject: "english", task_type: "word",
      estimated_min: null, remind_on_estimate: true,
      total_focus_sec: 0, status: "todo", time_record_ids: [],
      category: "general", slot: null, block: null,
      created_at: new Date().toISOString(),
      source: "english_words",
      ...partial
    });

    let count = 0;
    plan.forEach(p => {
      const [y, m, d] = p.dateStr.split("-").map(Number);
      Store.addTask(mk({
        title: vocabTitle(p),                        // 09-15 DAY 3 每日单词任务：背单词·新词 216
        day_label: p.label,                          // DAY n
        date: new Date(y, m - 1, d).toDateString(),  // 进日历（与西综同一格式）
        note: `词书：考研英语 6700｜第 ${p.day} 天｜${p.words} 词`
      }));
      count++;
    });

    // 标记不在 kaoyan: 前缀下，不受 pullOnce 覆盖影响
    localStorage.setItem(WORD_IMPORT_FLAG, "1");

    if (count && window.UI && window.UI.showAlert) {
      window.UI.showAlert(`📕 已导入英语单词突围计划（DAY1-${plan.length}）`, 2500);
    }
  }

  /* ---------- 交互绑定 ---------- */
  function init() {
    // 1. 立即本地渲染（不从远端等，Supabase 慢也不阻塞）
    Store.setLog && Store.setLog("任务页启动，本地导入…");
    repairPlanIdentity();   // 先补回可能被云端 null 掉的身份字段（source/day_label/note）
    autoImportXizongPlan();
    autoImportLivePlan();
    autoImportPhysioPlan();
    autoImportWordPlan();
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
        repairPlanIdentity();     // 云端可能带回 null 的身份字段 → 再补一次（改了会自动推回云端）
        autoImportXizongPlan();
        autoImportLivePlan();
        autoImportPhysioPlan();
        autoImportWordPlan();      // 云端可能带来单词任务 → 顺带规范化标题
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

        /* 继续（v1.22.6）：接着上一段计时（暂停前的分段原样保留，新分段从现在开始）。
         * 跨天也成立——DAY 3 是 09-15 的任务，今天点继续照样续上。 */
        const resumeId = e.target.closest("[data-resume]")?.dataset?.resume;
        if (resumeId) {
          const ok = window.Timer && window.Timer.resume ? window.Timer.resume() : false;
          if (window.UI && window.UI.showAlert) {
            window.UI.showAlert(ok ? "▶️ 已继续上一段计时" : "当前没有可继续的计时", 1600);
          }
          render();
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
        // 继续（v1.22.6）：接着上一段（暂停前的分段保留，新分段从现在开始；跨天照旧可用）
        const resumeId = e.target.closest("[data-resume]")?.dataset?.resume;
        if (resumeId) {
          const ok = window.Timer && window.Timer.resume ? window.Timer.resume() : false;
          if (window.UI && window.UI.showAlert) window.UI.showAlert(ok ? "▶️ 已继续上一段计时" : "当前没有可继续的计时", 1600);
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

    // 英语单词突围·每日背单词（独立卡片交互）
    const wordCard = document.getElementById("wordCard");
    if (wordCard) {
      wordCard.addEventListener("click", (e) => {
        // 打开本地 APP（自定义协议，仅桌面端按钮存在）
        if (e.target.closest("[data-vocab-openapp]")) {
          const a = document.createElement("a");
          a.href = "dancitw://";
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 0);
          return;
        }
        const pauseId = e.target.closest("[data-pause]")?.dataset?.pause;
        if (pauseId) {
          if (window.Timer && window.Timer.pause) {
            const state = window.Timer.getState();
            if (state && state.status === "running") window.Timer.pause();
          }
          render();
          return;
        }
        // 继续（v1.22.6）：接着上一段（暂停前的分段保留，新分段从现在开始；跨天照旧可用）
        const resumeId = e.target.closest("[data-resume]")?.dataset?.resume;
        if (resumeId) {
          const ok = window.Timer && window.Timer.resume ? window.Timer.resume() : false;
          if (window.UI && window.UI.showAlert) window.UI.showAlert(ok ? "▶️ 已继续上一段计时" : "当前没有可继续的计时", 1600);
          render();
          return;
        }
        const finishId = e.target.closest("[data-finish]")?.dataset?.finish;
        if (finishId) {
          if (window.Timer && window.Timer.stopAndMarkDone) {
            window.Timer.stopAndMarkDone();
            if (window.UI && window.UI.showAlert) window.UI.showAlert("🎉 专注完成！", 2000);
          }
          render();
          return;
        }
        const startId = e.target.closest("[data-start]")?.dataset?.start;
        if (startId) {
          if (window.Timer && window.Timer.startTask) {
            window.Timer.startTask(startId);
            if (window.UI && window.UI.showAlert) window.UI.showAlert("开始背单词！", 1500);
            render();
          }
          return;
        }
        // 完成此 DAY
        const doneId = e.target.closest("[data-vocab-done]")?.dataset?.vocabDone;
        if (doneId) {
          const task = Store.getTasks().find(x => x.id === doneId);
          if (task && !task.done) manualCompleteTask(task.id);
          // 若正在看今天且已完成 → 自动跟到下一个未完成
          const list = vocabList();
          if (vocabIdx < 0) {
            const next = list.findIndex((t) => !t.done);
            if (next !== -1) vocabIdx = next;
          }
          render();
          return;
        }
        const undoId = e.target.closest("[data-vocab-undo]")?.dataset?.vocabUndo;
        if (undoId) {
          Store.updateTask(undoId, { done: false, status: "todo" });
          if (window.UI && window.UI.showAlert) window.UI.showAlert("已撤销", 1200);
          render();
          return;
        }
        const tabId = e.target.closest("[data-vocab-tab]")?.dataset?.vocabTab;
        if (tabId !== undefined) {
          const idx = parseInt(tabId, 10);
          if (!isNaN(idx) && idx >= 0 && idx < vocabList().length) vocabIdx = idx;
          render();
          return;
        }
        if (e.target.closest("[data-vocab-today]")) { vocabIdx = -1; render(); return; }
        if (e.target.closest("[data-vocab-toggle]")) { vocabExpanded = !vocabExpanded; render(); return; }
        if (e.target.closest("[data-vocab-collapse]")) { vocabCollapsed = !vocabCollapsed; render(); return; }
      });
    }

    Store.subscribeTasks(() => render());
    Store.subscribeTimeRecords(() => render());
    render();
    if (window.Icon) {
      window.Icon.inject(document.getElementById("viewSwitch"));
      window.Icon.inject(document.getElementById("subjectFilter"));
    }

    /* 每秒刷新运行中的任务状态（v1.22.1 根修两处）：
     * 1) 旧选择器 ".tcard.isrunning" 与实际卡片 class（.cs-card.cs-running）对不上
     *    → hasRunning 恒为 false，任务开始后卡片不会重渲染（按钮一直停在"开始"）。
     *    现改为"存在运行中会话"这一事实判断，不依赖 DOM class。
     * 2) 运行中的卡片实时显示已耗时（此前 total_focus_sec 只在停止时落盘，
     *    运行中永远显示"未开始"）：给 [data-live-focus] 每秒回填，不整页重渲染。 */
    /* v1.22.2：重渲染判定改为"运行态发生【变化】才 render"。
     * 旧行为：运行中的任务被科目筛选滤掉/藏在收起的分组里时，卡片永不在 DOM →
     * shouldHaveRunning(true) ≠ hasRunningCard(false) 恒成立 → 每秒整页重建（闪烁、丢点击）。
     * 现在用 _lastRenderedRunningId 记住上次渲染时的运行任务，只有它变了才重渲染；
     * 实时秒数仍每秒回填到 [data-live-focus]（卡片不在视图时 querySelector 为空集，零开销）。
     * 基线 _lastRenderedRunningId 声明在文件顶部、由 render() 每次自行对齐，此处只读。 */
    const liveTick = () => {
      const runningId = window.Timer ? window.Timer.getLinkedTaskId() : null;
      const st = window.Timer ? window.Timer.getState() : null;
      if ((runningId || null) !== _lastRenderedRunningId) {
        render();   // render() 内部会把基线更新为新值
        return;
      }
      if (runningId && st && st.status === "running") {
        const el = Math.max(0, Math.floor((st.elapsed_sec || 0) + (Date.now() - (st.started_at || Date.now())) / 1000));
        document.querySelectorAll(`[data-live-focus="${runningId}"]`).forEach(node => {
          node.textContent = "计时中 · 已 " + fmtDuration(Math.max(0, el));
        });
      }
    };
    setInterval(liveTick, 1000);
    // 注：任务页的内嵌计时 pane 已移除（v1.11.4）——计时统一走底部导航的计时页；
    // 本页保留 timer.js 的无头模式（window.Timer API），任务卡「开始/暂停/完成」不受影响
  }

  document.addEventListener("DOMContentLoaded", init);

  /* 只读诊断面（供手机端控制台自查 + .dev-tools 桩回归直接调用内部纯函数）：
   * 这三个函数不写任何数据，暴露它们不会改变页面行为。 */
  window.TasksDebug = {
    dayNumOf, isWordTask, isPhysioTask, repairPlanIdentity,
    stats: () => ({
      total: Store.getTasks().length,
      word: Store.getTasks().filter(isWordTask).length,
      physio: Store.getTasks().filter(isPhysioTask).length,
      missingSource: Store.getTasks().filter(t => (isWordTask(t) || isPhysioTask(t)) && !t.source).length
    })
  };
})();

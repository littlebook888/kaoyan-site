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
  /* v1.41.0：上次 render() 时是否处于「休息中」（休息段无 task_id，
   * 只能靠 Timer.isResting() 单独记一个基线，否则按钮态不会自动切换）。 */
  let _lastRenderedResting = 0;

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

    renderMedpath();
    renderSurgeryCard();
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
    /* ★ v1.129.0：外科冲刺「配套任务」按原定 DAY 归在独立区块，
     *   date 恒为空串，绝不能混进日历的 __nodate__ 未排期组（那会显得杂乱）。 */
    const all = Store.getTasks().filter(t =>
      (t.subject === "xizong" || isWordTask(t)) && !isPhysioTask(t) &&
      t.source !== "surgery_support" && t.source !== "surgery_legacy"
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

  /* ---------- ★ v1.112.0 看课完成日（日期 Tab 淡紫）判据 ----------
   * 语义 = 「这一天不用再听课」，两种情况都算：
   *   ① 当天有听课任务（task_type=course，天天师兄的主任务）且全部完成；
   *   ② 当天**根本没有**听课任务 —— 课程全部学完之后，空档日同样属于「课已听完」，
   *      一直白着会被误读成「还有课没听」（用户 2026-11-05 现场反馈）。
   * ⚠️ 未排期组（__nodate__）不是真实日期，**不参与**：那 44 件无日期任务会把标签染紫、
   *   且无法回答"哪一天"，与"按天看课进度"的语义无关。
   * ⚠️ 全部完成（绿色 alldone）优先于淡紫，调用方按 `allDone ? "alldone" : (...)` 取。 */
  function courseDayDone(key, arr) {
    if (key === "__nodate__") return false;
    const courseArr = (arr || []).filter(t => t && t.task_type === "course");
    if (courseArr.length === 0) return true;
    return courseArr.every(t => t.done);
  }

  /* ---------- 日历视图（DAY 大卡 + 分卡 + 导航）---------- */
  /* ---------- ★ v1.28.4 月历视图（仿课程表 APP） ----------
   * 整月网格：每天一个格子，下划线=有任务；✓=全部完成；今天高亮。
   * 点格子 → 关弹窗并跳到那天的日历任务卡（复用 activeDayIdx 机制）。 */
  function renderMonthModal() {
    const { groups, order } = collectPlanDays();
    const grid = document.getElementById("monthGrid");
    if (!grid) return;
    if (!order.length) { grid.innerHTML = '<div class="dlt-empty">暂无计划任务</div>'; return; }
    /* 每组键 = t.date 原文（如 "Thu May 28 2026"）；用 new Date() 解析出年月日归格。 */
    const perDay = {};
    order.forEach(k => {
      const arr = groups[k];
      const dt = new Date(k);
      if (isNaN(dt)) return;
      const done = arr.filter(t => t.done).length;
      perDay[dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0")] =
        { total: arr.length, done, rawKey: k };
    });
    const keys = Object.keys(perDay).sort();
    if (!keys.length) { grid.innerHTML = '<div class="dlt-empty">暂无有日期的计划任务</div>'; return; }
    const todayKey = window.Blocks && window.Blocks.bizDateStr ? window.Blocks.bizDateStr() : new Date().toISOString().slice(0, 10);
    let html = "";
    const fm = new Date(keys[0] + "T00:00:00");
    const lm = new Date(keys[keys.length - 1] + "T00:00:00");
    let cm = new Date(fm.getFullYear(), fm.getMonth(), 1);
    while (cm <= lm) {
      const y = cm.getFullYear(), mIdx = cm.getMonth();
      html += `<div class="mm-month"><div class="mm-month-name">${y} 年 ${mIdx + 1} 月</div><div class="mm-grid">`;
      const dow = (new Date(y, mIdx, 1).getDay() + 6) % 7;
      for (let i = 0; i < dow; i++) html += "<i></i>";
      const days = new Date(y, mIdx + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const key = `${y}-${String(mIdx + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const info = perDay[key];
        const isToday = key === todayKey;
        if (!info) { html += `<span class="mm-cell empty">${d}</span>`; continue; }
        const allDone = info.done >= info.total;
        html += `<button type="button" class="mm-cell has-task${allDone ? " alldone" : ""}${isToday ? " today" : ""}" data-day="${key}" data-rawkey="${encodeURIComponent(info.rawKey)}" title="${key}：${info.done}/${info.total} 完成"><b>${d}</b>${allDone ? " ✓" : ""}</button>`;
      }
      html += "</div></div>";
      cm = new Date(y, mIdx + 1, 1);
    }
    grid.innerHTML = html;
    grid.querySelectorAll(".mm-cell.has-task").forEach(c => {
      c.addEventListener("click", () => {
        const rawKey = decodeURIComponent(c.dataset.rawkey || "");
        const idx = order.indexOf(rawKey);
        if (idx >= 0) {
          activeDayIdx = idx;
          try { localStorage.setItem("kaoyan:cal_day", rawKey); } catch (e) {}
          closeMonthModal();
          currentView = "calendar";
          renderAll();
          const sw = document.getElementById("viewSwitch");
          if (sw) sw.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.view === "calendar"));
        }
      });
    });
  }
    function openMonthModal() { renderMonthModal(); const m = document.getElementById("monthModal"); const mk = document.getElementById("monthMask");
    if (m) m.classList.add("show"); if (mk) mk.classList.add("show"); }
  function closeMonthModal() { const m = document.getElementById("monthModal"); const mk = document.getElementById("monthMask");
    if (m) m.classList.remove("show"); if (mk) mk.classList.remove("show"); }

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
        /* ★ v1.32.0 看课完成日：淡紫提示（全部完成=绿优先）。
         * ★ v1.112.0 改判据：当天**没有**听课任务也算（课程已全部学完的空档日），详见 courseDayDone()。 */
        const courseArr = arr.filter(t => t.task_type === "course");
        const courseDone = courseDayDone(k, arr);
        const courseTitle = allDone
          ? "当日任务全部完成"
          : (courseDone ? (courseArr.length ? "当日听课任务已完成" : "当日无听课任务（课程已学完）") : "");
        const cls = i === activeDayIdx ? "active" : "";
        const doneCls = allDone ? "alldone" : (courseDone ? "coursedone" : "");
        const label = planDateLabel(arr[0]) || "未排期";
        html += `<button class="cal-day-tab ${cls} ${doneCls}" data-cal-tab="${i}"${courseTitle ? ` title="${courseTitle}"` : ''}>${allDone ? '<span class="ct-check">✓</span>' : ''}${label} <span class="ct-count">${dc}/${arr.length}</span></button>`;
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
  /* ---------- 休息中状态（v1.41.0，任务页「休息」按钮）----------
   * ⚠️ 为什么必须单独判：休息走 startCountup("rest", ..., taskId=null)，
   *   **不带 taskId**（用户明示「休息不带 taskId」）→ at.task_id 为 null
   *   → linkState() 因 `linked !== taskId` 一律返回 "none"，
   *   若不特判，休息期间任务卡会显示「开始」按钮（因为看起来"没在计时"），
   *   语义完全错乱。
   * 返回「正在休息的任务 id」或 null。任务仍处running（status 未改），
   *   所以休息结束后随时能按「回到学习」接上。 */
  function restingTaskId() {
    if (!window.Timer || !window.Timer.isResting) return null;
    if (!window.Timer.isResting()) return null;
    const st = window.Timer.getState ? window.Timer.getState() : null;
    if (!st) return null;
    //休息段无 task_id（按设计），因此"当前正在计时的那个任务"由 Store 找：
    //取 status=running 且未被休息覆盖的最新任务。取不到就返回 "resting-any"，
    // 调用方按"是否有任务在跑"处理。
    const tasks = (window.Store && Store.getTasks) ? Store.getTasks() : [];
    const running = tasks.filter(t => t && !t.done && t.status === "running");
    return running.length ? running[running.length - 1].id : null;
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
    const restingId = restingTaskId();
    const isResting = !!restingId && restingId === t.id;   // 本卡正在「休息中」
    const isDone = t.done;
    const tm = TYPE_META[t.task_type] || TYPE_META.other;
    const color = taskColor(t);

    let actions = "";
    if (isDone) {
      actions = `<span class="cs-done-tag">✓ 已完成</span>
        <button class="cs-btn cs-undo" data-undo="${t.id}">撤销</button>`;
    } else if (isResting) {
      /* 休息中：不显示「暂停/完成」，给「回到学习」接上；任务仍running */
      actions = `
        <button class="cs-btn cs-start" data-backtowork="${t.id}"><span data-icon="play"></span> 回到学习</button>
        <button class="cs-btn cs-finish" data-finish="${t.id}">完成</button>`;
    } else if (lk === "running") {
      actions = `
        <button class="cs-btn cs-pause" data-pause="${t.id}"><span data-icon="pause"></span> 暂停</button>
        <button class="cs-btn cs-rest" data-rest="${t.id}" data-live-rest="1" title="休息一下（正计时，不计入本任务进度）">休息</button>
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
  const PHYSIO_TITLE_RE = /生理学.*人可研梦滚动复习|人可研梦滚动复习.*生理学/;
  /*⚠️ v1.42.1 修正（2026-10-08实测发现的串味bug）：
   * 原先PHYSIO_TITLE_RE = /人可研梦滚动复习/ —— **两个系列标题都含这7个字**，
   *   且两个系列的 source 判据是"或"关系：
   *     isPhysioTask = source==='physio_rolling' || TITLE_RE.test(title)
   *   → 内科+病理的 44 行（source=medpath_rolling）同样匹配 TITLE_RE
   *   → **全部混进 physioList()**，生理学卡会显示 43+44=87 个 DAY。
   *   症状：生理学卡显示"DAY1-87"、进度算错、笔记挂错任务。
   * → 现在标题判据必须**先把内科+病理排除**（MEDPATH_TITLE_RE 在下方声明，
   *   故这里用行内正则而非引用常量，避免 TDZ；判定逻辑与 MEDPATH_TITLE_RE 一致）。 */
  function isMedpathTitle(title) {
    return /内科\+病理.*人可研梦滚动复习|人可研梦滚动复习.*内科/.test(title || "");
  }
  function isPhysioTask(t) {
    if (!t) return false;
    if (t.source === MEDPATH_SOURCE || t.source === "medpath_rolling") return false;
    if (isMedpathTitle(t.title)) return false;          // ← 串味修复
    return t.source === "physio_rolling" || PHYSIO_TITLE_RE.test(t.title || "");
  }
  function isWordTask(t) {
    return !!t && (t.source === "english_words" || WORD_TITLE_RE.test(t.title || ""));
  }
  /* ---------- 内科+病理·人可研梦滚动复习（第二条独立系列，2026-10-08 新增）----------
   * 识别方式同 v1.22.2 的教训：**source 与标题特征双认**。
   * tasks 表的 source/day_label/note 是后补建列，早期推送被"缺列自愈"剥掉过、
   * 云端可能存成 null；标题是唯一从未丢失的字段，故必须认标题。 */
  const MEDPATH_TITLE_RE = /内科\+病理.*人可研梦滚动复习|人可研梦滚动复习.*内科/;
  const MEDPATH_SOURCE = "medpath_rolling";
  function isMedpathTask(t) {
    return !!t && (t.source === MEDPATH_SOURCE || MEDPATH_TITLE_RE.test(t.title || ""));
  }
  /* 任一滚动复习系列（笔记功能对两者都生效） */
  function isRollingReviewTask(t) { return isPhysioTask(t) || isMedpathTask(t); }
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
  /* 计划系列的"重复导入"自愈（v1.22.10；v1.22.16 改用【稳定身份】分组）
   * 背景：计划类任务被重复导入过多次（旧页面守卫失效 + 页面长期不刷新），云端一度出现
   * 6 份同样的任务（一次实测 3127 行里 2687 行是重复）。
   * ⭐ v1.22.16 关键修正：分组键必须用**稳定身份**，不能用（日期|标题）——
   *   计划改期（如单词 09-13→09-23 起步）后，同一 DAY 的新旧两代标题/日期不同，
   *   按（日期|标题）分组会把它们当成不同任务 → 旧代永远清不掉，还会被旧页面的
   *   标题迁移改来改去（用户看到"09-26 DAY 14"×3 这种错乱）。
   *   稳定身份：单词 = `word|DAY n`（day_label → 标题）、生理 = `phys|DAY n`、
   *   西综 = 日期|标题（其日期是计划固有属性，无改期史）。
   * 每组保留 1 条：优先有进度的（已完成/有专注时长/关联过记录），否则最早创建；其余删除。
   * 安全边界：只动计划系列，**绝不碰用户手建的任务**；幂等。 */
  const PLAN_AUTO_TITLE = /^(滚动复习|听课：|复习：|刷题：|做题：|生物化学思维导图)/;
  function prunePlanDuplicates() {
    const planIdx = xizongPlanIndex();
    const all = Store.getTasks();
    const groups = new Map();
    all.forEach(t => {
      if (!t || !t.title) return;
      let key = null;
      if (isWordTask(t)) key = "word|DAY" + dayNumOf(t);
      else if (isPhysioTask(t)) key = "phys|DAY" + dayNumOf(t);
      else {
        key = (t.date || "") + "|" + t.title;
        if (!planIdx.has(key) && !PLAN_AUTO_TITLE.test(t.title)) return;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });
    const score = (t) => (t.done ? 100 : 0) + ((t.total_focus_sec || 0) > 0 ? 50 : 0) + ((t.time_record_ids || []).length > 0 ? 25 : 0);
    let removed = 0;
    const doomed = [];
    groups.forEach(rows => {
      if (rows.length < 2) return;
      const sorted = rows.slice().sort((a, b) =>
        score(b) - score(a) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
      sorted.slice(1).forEach(t => { doomed.push(t.id); removed++; });
    });
    // ★ v1.22.19：改为一次批量删除（1 次广播 1 次渲染），替代逐条 deleteTask
    //   （每条一次广播 + 一次整页重渲染——启动时的渲染风暴源头之一）
    if (doomed.length) Store.deleteTasksBulk(doomed);
    if (removed) console.warn(`[tasks] 计划任务去重：删除 ${removed} 条重复行（按稳定身份分组，每组保留 1 条，优先保留有进度的）`);
    return removed;
  }
  function repairPlanIdentity() {
    /* ★ v1.22.20 系统性防复发：云端已配置但首次拉取未结束时，**不写 tasks**。
     * 此时的本地是"设备休眠前的旧状态"，任何写入都会整表推上云端，
     * 用旧状态覆盖云端的新状态（实测后果：别的设备上勾选的「已完成」被整批抹掉）。
     * 这些修复都是幂等的，拉取结束后会再跑一次（init 的 post-pull 分支）。 */
    if (waitFirstPull()) return 0;
    prunePlanDuplicates();   // 先修剪重复导入（幂等），再做字段自愈
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
        if (!t.note && p) patch.note = vocabNote(p);
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
/* ---------- 滚动复习 · 任务笔记（v1.42.0，用户 2026-10-08 要求）----------
   * 需求原话：每天「完成任务前、任务后或者完成任务时」，都能用笔记记录相关内容，
   * 随时编辑、随时保存。
   * ⚠️ 存储字段选**rr_note**（滚动复习笔记）而**不是任务自带的 note**：
   *   note 被系列自身占用了（如生理学的「第二期/第三期起滚动复习」、内科病理的
   *   日期说明），若复用，用户写笔记会把日期说明覆盖掉，且 repairPlanIdentity()
   *   的自愈逻辑只「填空值不覆盖」→ 写了笔记后日期说明再也补不回来。
   *   独立字段两边互不干扰，也让「系统说明」与「我的笔记」语义清晰。
   * 保存时机：失焦(blur) 即存 —— 覆盖"随时编辑、随时保存"，不做显式保存按钮
   *   （少一次交互，且不会忘点）。输入中另有 debounce 兜底，防长文逐字推送云端。 */
  const RR_NOTE_SAVE_DEBOUNCE = 800;
  const _rrNoteTimers = {};
  function rrNoteOf(t) { return (t && t.rr_note) || ""; }
  function noteBlock(t) {
    const v = rrNoteOf(t);
    return `<div class="rr-note">
      <textarea class="rr-note-ta" data-rr-note="${t.id}" rows="3"
        placeholder="📝 今日笔记（复盘、易错点、口诀补充…随时编辑，自动保存）">${escapeHtml(v)}</textarea>
      <div class="rr-note-st" data-rr-note-st="${t.id}">${v ? "已保存" : ""}</div>
    </div>`;
  }
  /* 保存滚动复习笔记：走 Store.updateTask → 触发既有 tasks 表同步链路（三端一致） */
  function saveRrNote(taskId, value) {
    const txt = String(value == null ? "" : value);
    if (rrNoteTimersPending(taskId)) return;   // debounce 未到，跳过（避免覆盖新输入）
    const t = (Store.getTasks() || []).find(x => x.id === taskId);
    if (!t) return;
    if ((t.rr_note || "") === txt) return;      // 无变化不写（省一次同步）
    Store.updateTask(taskId, { rr_note: txt });
    const st = document.querySelector(`[data-rr-note-st="${taskId}"]`);
    if (st) {
      st.textContent = "已保存 " + new Date().toTimeString().slice(0, 5);
      st.classList.add("saved");
      setTimeout(() => st.classList.remove("saved"), 1200);
    }
  }
  function rrNoteTimersPending(taskId) { return !!_rrNoteTimers[taskId]; }
  function bumpRrNoteTimer(taskId) {
    if (_rrNoteTimers[taskId]) clearTimeout(_rrNoteTimers[taskId]);
    _rrNoteTimers[taskId] = setTimeout(function () {
      delete _rrNoteTimers[taskId];
      const ta = document.querySelector(`[data-rr-note="${taskId}"]`);
      if (ta) saveRrNote(taskId, ta.value);
    }, RR_NOTE_SAVE_DEBOUNCE);
  }
  /* 事件委托：失焦立即存 + 输入中 debounce（任一路径都不会丢内容） */
  function bindRollingNotes(root) {
    root.addEventListener("blur", (e) => {
      const ta = e.target.closest && e.target.closest("[data-rr-note]");
      if (!ta) return;
      if (_rrNoteTimers[ta.getAttribute("data-rr-note")]) {
        clearTimeout(_rrNoteTimers[ta.getAttribute("data-rr-note")]);
        delete _rrNoteTimers[ta.getAttribute("data-rr-note")];
      }
      saveRrNote(ta.getAttribute("data-rr-note"), ta.value);
    }, true);
    root.addEventListener("input", (e) => {
      const ta = e.target.closest && e.target.closest("[data-rr-note]");
      if (!ta) return;
      bumpRrNoteTimer(ta.getAttribute("data-rr-note"));
    });
  }

  /* ---------- 滚动复习卡片 · 通用交互绑定（v1.42.0）----------
   * 逻辑自 physio 原事件处理原样搬迁，只把 series 相关的四个状态
   * （idx / expanded / collapsed / list）换成 cfg 读写，**分支判断逐字未改**。
   * ⚠️ 这段曾因按行号替换区间而丢失（调用还在、定义没了 → 卡片交互整体失效、
   *   但语法与页面加载都不报错）。教训：**做"按行号批量替换"后必须立刻
   *   grep 一次函数名确认「有调用、有定义」**，不能只看语法检查通过。 */
  function bindRollingCard(cfg) {
    const el = document.getElementById(cfg.elId);
    if (!el) return;
    el.addEventListener("click", (e) => {
      /* ★ v1.131.0：本轮补上「开始 / 完成」两个动作。
       *   此前本函数只处理 暂停 / 继续 / 完成此DAY / 撤销 / 切 DAY / 折叠，
       *   卡面上的 [data-start] 与 [data-finish] 点了毫无反应（任务卡和单词卡各自
       *   在自己的容器上绑了委托，覆盖不到本卡）—— 外科冲刺卡要求真联动，
       *   顺手把生理学 / 内科病理两张卡的同款失效一起修掉。
       *   走的是与任务卡、单词卡完全相同的 Timer API，不另造一套计时。 */
      const startId = e.target.closest("[data-start]")?.dataset?.start;
      if (startId) {
        if (window.Timer && window.Timer.startTask) {
          window.Timer.startTask(startId);
          if (window.UI && window.UI.showAlert) window.UI.showAlert("▶️ 开始计时", 1500);
          render();
        }
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
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert(ok ? "▶️ 已继续上一段计时" : "当前没有可继续的计时", 1600);
        }
        render();
        return;
      }
      // 完成此 DAY → 自动跳下一 DAY
      const doneId = e.target.closest(`[data-${cfg.dataAttr}-done]`)?.dataset?.[cfg.dataAttr + "Done"];
      if (doneId) {
        const task = Store.getTasks().find(x => x.id === doneId);
        const list = cfg.list();
        const idx = cfg.idx();
        if (task && !task.done) manualCompleteTask(task.id); // 标记完成 + 记录事件 + 提示
        const nextUndone = list.findIndex((t, i) => i > idx && !t.done);
        if (nextUndone !== -1) {
          cfg.setIdx(nextUndone);
          if (window.UI && window.UI.showAlert) window.UI.showAlert(`→ 跳到 DAY ${dayNumOf(list[nextUndone])}`, 1200);
        }
        render();
        return;
      }
      // 撤销完成
      const undoId = e.target.closest(`[data-${cfg.dataAttr}-undo]`)?.dataset?.[cfg.dataAttr + "Undo"];
      if (undoId) {
        Store.updateTask(undoId, { done: false, status: "todo" });
        if (window.UI && window.UI.showAlert) window.UI.showAlert("已撤销", 1200);
        render();
        return;
      }
      // 切换 DAY（tab / 前后箭头）
      const tabSel = `[data-${cfg.dataAttr}-tab]`;
      if (e.target.closest(tabSel)) {
        const i = parseInt(e.target.closest(tabSel).dataset[cfg.dataAttr + "Tab"], 10);
        if (!isNaN(i) && i >= 0 && i < cfg.list().length) cfg.setIdx(i);
        render();
        return;
      }
      // 展开 / 收起 DAY 全清单
      if (e.target.closest(`[data-${cfg.dataAttr}-toggle]`)) {
        cfg.setExpanded(!cfg.expanded());
        render();
        return;
      }
      // 折叠 / 展开整卡
      if (e.target.closest(`[data-${cfg.dataAttr}-collapse]`)) {
        cfg.setCollapsed(!cfg.collapsed());
        render();
        return;
      }
    });
    // 笔记：blur 立即存 + input debounce
    bindRollingNotes(el);
  }

  /* ---------- 滚动复习卡片 · 通用渲染器（v1.42.0）----------
 *  抽出共用渲染的原因：两个系列的交互完全同构（DAY 切换 / 完成 / 撤销 / 计时 / 笔记），
 *  若各写一份，改一处 bug（如下方的笔记按钮）必须同步改两遍，漏一遍就出不一致。
 * cfg 见各 series 的 cfg 工厂函数。
 *   ⚠️ 逻辑自 physio 的 renderPhysio() 原样搬迁，只把「固定值」参数化，
 *      未改任何分支判断（交接惯例：搬迁后必须逐字段比对输出一致性）。 */
  function renderRollingCard(cfg) {
    const el = document.getElementById(cfg.elId);
    if (!el) return false;
    const list = cfg.list();
    if (!list.length) return false;          // 本机暂无该系列任务 → 由调用方渲染占位
    let idx = cfg.idx();
    if (idx >= list.length) { idx = list.length - 1; cfg.setIdx(idx); }
    const cur = list[idx];
    const curDay = dayNumOf(cur);
    const total = list.length;
    const doneTotal = list.filter(t => t.done).length;

    // DAY 切换区
    let navHtml;
    if (cfg.expanded()) {
      navHtml = `<div class="physio-tabs open">${list.map((t, i) => rollingTabBtn(i, t, cfg)).join("")}
        <button type="button" class="physio-tab physio-more" data-${cfg.dataAttr}-toggle>收起 ▴</button></div>`;
    } else {
      const prevOk = idx > 0;
      const nextOk = idx < list.length - 1;
      navHtml = `<div class="physio-tabs">
        <button type="button" class="physio-nav" data-${cfg.dataAttr}-tab="${idx - 1}" ${prevOk ? "" : "disabled"}>◀</button>
        <button type="button" class="physio-cur" data-${cfg.dataAttr}-done="${cur.id}">${cfg.curLabel ? cfg.curLabel(cur) : ("DAY " + curDay)}<span class="pcur-sub">${doneTotal}/${total}</span></button>
        <button type="button" class="physio-nav" data-${cfg.dataAttr}-tab="${idx + 1}" ${nextOk ? "" : "disabled"}>▶</button>
        <button class="physio-more" data-${cfg.dataAttr}-toggle>全部DAY ▾</button>
      </div>`;
    }

    // 当前 DAY 卡片
    let bodyHtml;
    if (cur.done) {
      const focusSec = cur.total_focus_sec || 0;
      const nextUndone = list.findIndex((t, i) => i > idx && !t.done);
      bodyHtml = `<div class="physio-done">
        <div class="physio-day-done"><span class="pd-check">✓</span> ${cfg.curLabel ? cfg.curLabel(cur) : ("DAY " + curDay)} 已完成</div>
        ${focusSec > 0 ? `<div class="physio-focus-time">花费 ${fmtDuration(focusSec)}</div>` : ''}
        ${nextUndone !== -1 ? `<div class="physio-next-hint">已自动跳到下一 DAY（DAY ${dayNumOf(list[nextUndone])}）</div>` : `<div class="physio-next-hint">🎉 全部 ${total} 个 DAY 已完成！有空随时回来复习</div>`}
        ${noteBlock(cur)}
        <button class="cs-btn cs-undo" data-${cfg.dataAttr}-undo="${cur.id}">撤销</button>
      </div>`;
    } else {
      const focusSec = cur.total_focus_sec || 0;
      const lk = linkState(cur.id);
      const p = cfg.planDay ? cfg.planDay(curDay) : null;
      bodyHtml = `<div class="cs-card ${lk === "running" ? 'cs-running' : ''}" style="--ct:${cfg.color}">
        <div class="cs-main">
          <div class="cs-title">${escapeHtml(cur.title)}</div>
          <div class="cs-meta">
            <span class="cs-badge" style="--cb:${cfg.color}">${cfg.tagOf ? cfg.tagOf(cur) : "复习"}</span>
            ${linkBadge(lk)}
            ${lk === "running"
              ? `<span class="cs-focus" data-live-focus="${cur.id}">计时中</span>`
              : lk === "paused"
                ? `<span class="cs-focus">${pausedFocusText()}</span>`
                : focusSec > 0 ? `<span class="cs-focus">已消耗：${fmtDuration(focusSec)}</span>` : '<span class="cs-focus">未开始</span>'}
          </div>
          ${cfg.bodyHtml ? cfg.bodyHtml(cur) : (p ? detailBlock(p) : "")}
          ${cfg.tip ? `<div class="physio-tip">${escapeHtml(cfg.tip)}</div>` : ""}
        </div>
        <div class="cs-actions">
          ${lk === "running"
            ? `<button class="cs-btn cs-pause" data-pause="${cur.id}"><span data-icon="pause"></span> 暂停</button>
               <button class="cs-btn cs-finish" data-finish="${cur.id}">完成</button>`
            : lk === "paused"
            ? `<button class="cs-btn cs-start" data-resume="${cur.id}"><span data-icon="play"></span> 继续</button>
               <button class="cs-btn cs-finish" data-finish="${cur.id}">完成</button>`
            : `<button class="cs-btn cs-start" data-start="${cur.id}"><span data-icon="play"></span> 开始</button>
               <button class="cs-btn cs-physio-done" data-${cfg.dataAttr}-done="${cur.id}"><span data-icon="check"></span> 完成此DAY</button>`}
        </div>
        ${noteBlock(cur)}
      </div>`;
    }

    el.style.display = "";
    el.innerHTML = `<div class="physio-wrap">
      <div class="physio-head">
        <div class="physio-htitle">
          <span class="physio-logo">${cfg.logo || "📖"}</span>
          <span class="physio-name">${cfg.title}</span>
          <span class="physio-badge">${cfg.badge}</span>
          ${cfg.link ? `<a class="physio-extlink" href="${escapeHtml(cfg.link.url)}"
             target="_blank" rel="noopener noreferrer"
             title="${escapeHtml(cfg.link.title || "打开新页面")}">${escapeHtml(cfg.link.text)}</a>` : ""}
        </div>
        <button type="button" class="physio-collapse-btn" data-${cfg.dataAttr}-collapse>${cfg.collapsed() ? "▼ 展开" : "▲ 收起"}</button>
      </div>
      <div class="physio-body" style="${cfg.collapsed() ? "display:none" : ""}">
        ${navHtml}
        ${bodyHtml}
        ${cfg.footerHtml ? cfg.footerHtml() : ""}
      </div>
    </div>`;
    if (window.Icon) window.Icon.inject(el);
    return true;
  }
  function rollingTabBtn(i, t, cfg) {
    /* ★ v1.131.0：可选 tabLabel 钩子（外科冲刺要显示「DAY1/7」与「7.10+7.12」，
     *   默认仍是「DAYn」，生理学/内科病理两个系列的输出逐字不变）。 */
    const label = cfg.tabLabel ? cfg.tabLabel(t, i) : ("DAY" + dayNumOf(t));
    return `<button type="button" class="physio-tab ${i === cfg.idx() ? "active" : ""}" data-${cfg.dataAttr}-tab="${i}" ${t.done ? 'data-done="1"' : ""}>
      ${label}${t.done ? ' <span class="ptick">✓</span>' : ""}</button>`;
  }

  /* ---------- 内科+病理 当天详情（系统 / 条目 / 需回一期标记）---------- */
  function detailBlock(p) {
    if (p.isEmpty) {
      return `<div class="rr-detail rr-empty">当日为空目录（原表标注为工作日但无资料）</div>`;
    }
    const marks = [];
    if (p.needT1) marks.push('<span class="rr-mark must">🔴 需回一期题库</span>');
    if (p.optT1) marks.push('<span class="rr-mark opt">🟡 一期配套挖空可选</span>');
    return `<div class="rr-detail">
      <div class="rr-sys">${escapeHtml(p.systems || "—")}<span class="rr-count">${p.items} 条</span></div>
      <div class="rr-items">${escapeHtml(p.detail || "")}</div>
      ${marks.length ? `<div class="rr-marks">${marks.join("")}</div>` : ""}
    </div>`;
  }

  /* ---------- 生理学·人可研梦滚动复习（v1.42.6 起不再暂停）----------
   * 曾于 2026-10-08 暂停（把 43 行移出 tasks 试图省同步量），并于
   * 2026-10-09 **整体撤销**（见 sql/撤销生理学暂停-20261009.sql）。
   * 撤销原因：本项目是**整表 upsert**，省流量的唯一变量是表总行数；
   * 生理学 43 行在清理重复行后的 520 行里只占 8%（≈22 KB/次），
   * 而暂停带来的 6 处复杂度已导致一次「暂停被自我推翻」的真 bug。
   * 现在 43 行常驻 tasks，卡照常显示，功能一点不丢。 */
  function physioCfg() {
    return {
      elId: "physioCard", dataAttr: "physio",
      title: "生理学·人可研梦滚动复习",
      /* v1.42.6：badge 恢复为固定文案。
       * v1.42.4 曾按 physioList() 是否为空动态取值（「数据走了=已暂停」），
       * 那套是为了配合暂停机制；机制撤销后数据恒在，动态判断失去意义，
       * 固定文案更简单也更准确（不会再出现「显示已暂停但其实能打卡」的矛盾态）。 */
      badge: "独立进度 · 有空随时参加",
      color: "#059669",
      list: physioList, planDay: null, tip: "",
      idx: function () { return physioIdx; }, setIdx: function (v) { physioIdx = v; },
      expanded: function () { return physioExpanded; }, setExpanded: function (v) { physioExpanded = v; },
      collapsed: function () { return physioCollapsed; }, setCollapsed: function (v) { physioCollapsed = v; }
    };
  }
  function renderPhysio() {
    const el = document.getElementById("physioCard");
    if (!el) return;
    /* v1.42.6（2026-10-09）：**撤销暂停机制**，恢复原行为。
     * 用户实测结论：省下的流量远不值得引入的复杂度——
     * 本项目是**整表 upsert**（setLocal → pushToSupabase → upsertRows 整张表），
     * 省流量的唯一变量是表的总行数；生理学 43 行在清理重复行后的 520 行里
     * **只占 8%（约 22 KB/次）**。
     * 为这 8% 引入「轻量表 + 跨设备标记 + 守卫链前移 + 搬回SQL + 迁移脚本」
     * 6 处复杂度，代价与收益完全不成比例 → 撤销。
     * 现在 physioCfg().list 恒有数据，renderRollingCard 必定走完整渲染；
     * 保留这里的空态兜底（若将来数据真的为空，也只是显示空态而不是崩）。 */
    if (renderRollingCard(physioCfg())) return;
    el.style.display = "";
    el.innerHTML = `<div class="rr-empty-note">
      <div style="font-size:26px;margin-bottom:6px">🌱</div>
      生理学·人可研梦滚动复习：暂无任务<br>
      <span style="font-size:11px;opacity:.7">若长时间停留此状态，请刷新页面</span>
    </div>`;
  }

  /* ---------- 内科+病理·人可研梦滚动复习【二期】（独立系列，当前进行中）----------
   * 用户 2026-10-08 新增：DAY1 = 7.28 → DAY 44 = 9.14，共 44 个**工作日**
   * （不计休息日 8.10/ 8.15 / 8.23 / 9.1 / 9.10）。表头只写二期进度。 */
  let medpathIdx = 0;
  let medpathExpanded = false;
  let medpathCollapsed = false;
  function medpathList() {
    return Store.getTasks().filter(isMedpathTask).sort((a, b) => dayNumOf(a) - dayNumOf(b));
  }
  function medpathCfg() {
    return {
      elId: "medpathCard", dataAttr: "medpath",
      title: "内科+病理·人可研梦滚动复习",
      badge: "二期 · 44 个工作日 · 独立进度",
      color: "#0f766e",
      list: medpathList,
      planDay: function (d) { return (window.MEDPATH_PLAN || [])[d - 1] || null; },
      tip: "主要跟二期，一期为必要补充",
      /* 小入口：卡头右侧的极简外链（用户 2026-10-08 指定）。
       * 做成cfg 可选字段而非硬编码 —— 通用渲染器服务两个系列，
       * 只有这个系列需要外链，另一个不传就不会渲染。 */
      link: {
        text: "对照表 ↗",
        title: "打开《一期二期 Day-日期-内容对照表》",
        url: "https://www.workbuddy.link/p/Enst777q5gOlLTd2j8o88V?source=2"
      },
      idx: function () { return medpathIdx; }, setIdx: function (v) { medpathIdx = v; },
      expanded: function () { return medpathExpanded; }, setExpanded: function (v) { medpathExpanded = v; },
      collapsed: function () { return medpathCollapsed; }, setCollapsed: function (v) { medpathCollapsed = v; }
    };
  }
  function renderMedpath() {
    const el = document.getElementById("medpathCard");
    if (!el) return;
    if (renderRollingCard(medpathCfg())) return;
    // 空态：即使没任务也显示占位（区分"没导入"与"被隐藏"）
    el.style.display = "";
    el.innerHTML = `<div style="text-align:center;padding:18px 0;color:var(--ink-3);font-size:13px">
      <div style="font-size:26px;margin-bottom:6px">📖</div>
      内科+病理·人可研梦滚动复习：加载中…<br>
      <span style="font-size:11px;opacity:.7">若长时间停留此状态，请刷新或检查网络</span>
    </div>`;
  }

  /* ---------- 英语单词突围 · 每日背单词（独立系列、按日期推进，与西综/生理互不影响） ---------- */
  let vocabIdx = -1;          // 当前查看的 DAY 下标（-1 = 跟随今天）
  let vocabExpanded = false;  // 全部 DAY 清单是否展开
  let vocabCollapsed = false; // 整卡是否收起
  /* ★ v1.103.0：排序从「按 DAY 号」改为「按日期」。
   * 原因：第二轮新词是 DAY 42–48，而补复习仍叫「复习 DAY 4/8/…/40」（day 号沿用第一轮）。
   * 若还按 day 号排，复习 DAY 4 会插到 DAY 42 前面，卡片顺序就乱了。
   * 日期才是真实推进顺序（新词段在前 → 补复习段在后；具体日期一律读 word-plan.js）。
   * 同日的兜底仍按 day 号，保证稳定。 */
  function vocabList() {
    return Store.getTasks().filter(isWordTask)
      .sort((a, b) => {
        const ta = planDateStr(a), tb = planDateStr(b);
        const va = ta ? ta.getTime() : Infinity;   // 无日期的排最后，不抢占"今天"
        const vb = tb ? tb.getTime() : Infinity;
        if (va !== vb) return va - vb;
        return dayNumOf(a) - dayNumOf(b);
      });
  }
  function vocabTodayIdx(list) {
    const today = todayStr();
    return list.findIndex(t => (t.date || "") === today);
  }
  /* ★ v1.103.0：今天没有排任务时，指向「下一项」而不是最后一项。
   *   第二轮有固定起点，起点之前打开页面若回落到 list.length-1，
   *   卡面会显示最后一天的「复习 DAY 40」——看着像"已经落后到底"，实际是还没开始。
   *   ⚠️ 注释里不写死日期：计划每次顺延都会变，写死只会误导下一个人。 */
  function vocabNextIdx(list) {
    const t0 = new Date(todayStr()).getTime();
    const i = list.findIndex(t => {
      const d = planDateStr(t);
      return d && d.getTime() >= t0;
    });
    return i >= 0 ? i : list.length - 1;
  }
  /* ★ v1.103.0：复习日的标签单独显示，避免「DAY 4」与「DAY 42」在同一排里看不出区别。
   *   day_label = "复习 DAY 4" → 显示「复习4」；"DAY 42" → 显示「DAY42」。 */
  function vocabDayLabel(t) {
    const n = dayNumOf(t);
    const isRev = /复习/.test(t.day_label || "") || /复习/.test(t.title || "");
    return isRev ? `复习${n}` : `DAY${n}`;
  }
  /* ★ v1.118.0（用户 2026-11-10 指定）：每天用小字标出「这批词到底是哪些」，
   *   别让人对着「新词 300 / 复习 648」猜范围。
   *   · 新词日：阶段构成 + 首末词（表内四列）＋ **Excel「排期总览」的操作列**：
   *     系统需点击的 DAY（按此顺序）、需点开 DAY 数、其中 ≥3 词值得点开、累计词数、预计耗时，
   *     以及「系统无 N 词（用红宝书/大纲表）」——APP 里搜不到，照着点会白找。
   *   · 复习日：补的是第一轮哪个 DAY + cover（覆盖哪 3 个新词日）+ 词量。
   *     ⚠️ 用户这份 Excel **只覆盖新词 7 天（DAY 42–48）**，不含补复习 10 天；
   *        复习范围沿用第一轮计划口径，并给一句可见说明，不编造 Excel 里没有的东西。
   *   ⚠️ 只读 window.WORD_PLAN（单一数据源），**不读任务的 note**：旧任务 note 可能为空或是用户手写，
   *      align 也只在 note 为空时才补；靠 note 会出现「同一天有的显示、有的不显示」的静默分叉。
   *   ⚠️ 没有确切范围就返回空串，绝不编一句"具体范围"糊上去。 */
  function vocabPlanOf(t) {
    const plan = window.WORD_PLAN || [];
    const n = dayNumOf(t);
    return plan.find(p => p && p.day === n) || null;
  }
  function vocabRangeHint(t) {
    const p = vocabPlanOf(t);
    if (!p) return "";
    const bits = [];
    const lines = [];
    if (p.kind === "review") {
      if (!p.cover) return "";
      bits.push(`补第一轮 DAY ${p.day} 复习`);
      bits.push(p.cover);
      bits.push(`${p.words} 词`);
      lines.push("补复习 10 天不在 Excel 表内，范围按第一轮计划口径");
    } else {
      if (!p.phase || !p.range) return "";   // 没有确切范围就不编造（护栏实在探针锁着）
      bits.push(p.phase);
      bits.push(p.range);
      if (p.clickPath) lines.push(`点开：${p.clickPath}`);
      const stat = [];
      if (typeof p.clickDays === "number") stat.push(`需点开 ${p.clickDays} 个 DAY`);
      if (typeof p.worthDays === "number") stat.push(`其中 ≥3 词值得点开 ${p.worthDays} 个`);
      if (typeof p.cum === "number") stat.push(`累计 ${p.cum} 词`);
      if (typeof p.minutes === "number") stat.push(`约 ${p.minutes} 分钟`);
      if (stat.length) lines.push(stat.join(" · "));
      if (p.offline > 0) lines.push(`系统无 ${p.offline} 词：用红宝书/大纲表背（APP 搜不到）`);
      if (p.seq) lines.push(`表内第 ${p.seq} 天 = ${p.label}`);
    }
    if (!bits.length) return "";
    const sub = lines.map(s =>
      `<div class="vocab-range-line${/系统无/.test(s) ? " vocab-range-warn" : ""}">${escapeHtml(s)}</div>`
    ).join("");
    return `<div class="vocab-range-hint">范围：${escapeHtml(bits.join("｜"))}${sub}</div>`;
  }
  function vocabTabBtn(i, t) {
    return `<button type="button" class="physio-tab ${i === vocabIdx ? "active" : ""}" data-vocab-tab="${i}" ${t.done ? 'data-done="1"' : ""}>
      ${vocabDayLabel(t)}${t.done ? ' <span class="ptick">✓</span>' : ""}</button>`;
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
                              : (todayI >= 0 ? todayI : vocabNextIdx(list));
    const cur = list[idx];
    const curDay = dayNumOf(cur);
    const doneTotal = list.filter(t => t.done).length;
    const isReview = /复习/.test(cur.title || "");
    /* 今天无任务时写清"哪天才开始"，而不是干巴巴一句「今日无任务」——
     * 用户 10-28 打开页面必须一眼知道是还没开始，不是漏了/坏了。 */
    const todayHint = (vocabIdx < 0 && todayI >= 0) ? `<span class="pcur-sub">今天</span>`
                    : (todayI < 0 ? `<span class="pcur-sub">${planDateLabel(cur).slice(5)} 起</span>` : "");

    // DAY 切换区
    let navHtml;
    if (vocabExpanded) {
      navHtml = `<div class="physio-tabs open">${list.map((t, i) => vocabTabBtn(i, t)).join("")}
        <button type="button" class="physio-tab physio-more" data-vocab-toggle>收起 ▴</button></div>`;
    } else {
      navHtml = `<div class="physio-tabs">
        <button type="button" class="physio-nav" data-vocab-tab="${idx - 1}" ${idx > 0 ? "" : "disabled"}>◀</button>
        <button type="button" class="physio-cur" data-vocab-done="${cur.id}">${vocabDayLabel(cur)}${todayHint}<span class="pcur-sub">${doneTotal}/${list.length}</span></button>
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
        <div class="physio-day-done"><span class="pd-check">✓</span> ${vocabDayLabel(cur)} 已完成</div>
        ${focusSec > 0 ? `<div class="physio-focus-time">花费 ${fmtDuration(focusSec)}</div>` : ''}
        ${nextUndone !== -1 ? `<div class="physio-next-hint">下一个未完成：${vocabDayLabel(list[nextUndone])}</div>` : `<div class="physio-next-hint">🎉 计划的 ${list.length} 个 DAY 已全部完成！</div>`}
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

    /* ★ v1.118.0：范围小字跟当前选中的 DAY 走（切 Tab / 回今天都会重渲染），
     *   放在卡片外、总进度上方 —— 已完成 / 未完成两种形态都看得到。 */
    const rangeHtml = vocabRangeHint(cur);

    // 总进度（整个计划）+ 冲刺倒计时（鼓励超前：按实际节奏推算，一天完成多天会自动提前结束）
    const pct = Math.round((doneTotal / list.length) * 100);
    const remainDays = list.length - doneTotal;                       // 还剩多少个 DAY
    const startMs = new Date(list[0].date).getTime();
    const elapsedDays = Math.max(1, Math.round((Date.now() - startMs) / 86400000));
    // 节奏 = 平均每个 DAY 花几天（超前完成 <1；没开始按 1 天/DAY 推算）
    const daysPerDay = doneTotal > 0 ? Math.max(1, elapsedDays / doneTotal) : 1;   // ★ v1.103.0：第二轮每天 1 个 DAY，兜底由 0.5 改回 1
    const etaMs = Date.now() + remainDays * daysPerDay * 86400000;
    const eta = new Date(etaMs);
    const etaLabel = `${String(eta.getMonth() + 1).padStart(2, "0")}-${String(eta.getDate()).padStart(2, "0")}`;
    // 英语六级：2026-12-12
    const cetMs = new Date(2026, 11, 12).getTime();
    const cetGap = Math.round((cetMs - etaMs) / 86400000);
    // ★ v1.103.0：第二轮计划（新词 DAY 42–48 + 补复习 DAY 4/8/…/40）
    //   收官日不再硬编码 10-26，改为读 word-plan.js 的 WORD_PLAN_META.reviewEnd（现 11-27）。
    //   ⚠️ 下面三个兜底值只在 META 读不到时生效，改计划起点必须同步改（护栏 v1118 锁着）。
    const META = window.WORD_PLAN_META || {};
    const idealMs = META.reviewEnd
      ? new Date(META.reviewEnd + "T00:00:00").getTime()
      : new Date(2026, 10, 27).getTime();
    const idealLabel = META.reviewEnd ? META.reviewEnd.slice(5) : "11-27";
    const idealGap = Math.max(0, Math.round((etaMs - idealMs) / 86400000));
    const paceTxt = doneTotal === 0
      ? "按每天 1 个 DAY 推算"
      : `当前节奏：日均 ${(1 / daysPerDay).toFixed(1)} 个 DAY${(1 / daysPerDay) > 1.05 ? " · 超前 ✅" : ""}`;
    // 阶段提示：新词段（现 11-10~11-16）与复习段（现 11-18~11-27）分开报数，
    // 避免"17 天里只完成 1 天 = 6%"这种把两个阶段搅在一起看的错觉。
    const newList = list.filter(t => !/复习/.test(t.day_label || t.title || ""));
    const revList = list.filter(t => /复习/.test(t.day_label || t.title || ""));
    const newDone = newList.filter(t => t.done).length;
    const revDone = revList.filter(t => t.done).length;
    const phaseHtml = (newList.length || revList.length)
      ? `<div class="vocab-total-meta" style="margin-top:4px">
           <b>第二轮</b>　新词 ${newDone}/${newList.length}${META.newEnd ? `（${META.newStart.slice(5)} ~ ${META.newEnd.slice(5)}）` : ""}
           · 补复习 ${revDone}/${revList.length}${META.reviewEnd ? `（${META.reviewStart ? META.reviewStart.slice(5) : "11-18"} ~ ${META.reviewEnd.slice(5)}）` : ""}
         </div>`
      : "";
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
          <span class="physio-badge">第二轮 · 独立进度 · 与天天师兄互不影响</span>
        </div>
        <div class="vocab-head-actions">
          ${winBtn}
          <button type="button" class="physio-collapse-btn" data-vocab-collapse>${vocabCollapsed ? "▼ 展开" : "▲ 收起"}</button>
        </div>
      </div>
      <div class="physio-body" style="${vocabCollapsed ? "display:none" : ""}">
        ${navHtml}
        ${bodyHtml}
        ${rangeHtml}
        <div class="vocab-total">
          <div class="vocab-total-top"><span>计划总进度</span><span>${doneTotal}/${list.length} 天 · ${pct}%</span></div>
          <div class="vocab-total-bar"><i style="width:${pct}%"></i></div>
          <div class="vocab-total-meta">
            还剩 <b>${remainDays}</b> 天 · 预计结束 <b>${etaLabel}</b>
            · 届时距英语六级（12-12）还有 <b>${Math.max(0, cetGap)}</b> 天
            · 距理想目标（${idealLabel}）还多 <b>${idealGap}</b> 天
            <span class="vocab-total-pace">${paceTxt}；一天完成多天的量，结束日期自动提前</span>
            ${lagHtml}
          </div>
          ${phaseHtml}
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
  /* 列表分组键（★ v1.133.0）：外科冲刺改成「一节课一条」后 day_label 各不相同
   * （外科冲刺 D134-1 / D134-2 …），直接用会把同一天拆成 4 张卡。
   * 这里统一归回「外科冲刺 DAY2」一张卡。
   * ⚠️ 只影响列表分组显示，**绝不动 day_label 本身** —— 它是任务的节级身份键。 */
  function listGroupKey(t) {
    if (isSurgerySprintTask(t)) {
      const m = String(t.title || "").match(/【外科冲刺】DAY(\d+)\/\d+/);
      if (m) return "外科冲刺 DAY" + m[1];
    }
    return t.day_label || "";
  }
  function renderList(box) {
    const tasks = todayTasks();
    if (!tasks.length) { box.innerHTML = emptyHint(); return; }

    // 按 day_label 分组（DAY 卡片）
    const groups = {};
    const order = [];
    tasks.forEach(t => {
      const dl = listGroupKey(t);
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

    /* ★ v1 的"碎片清理"已移除（v1.22.14）。
     * 它原本删「滚动复习：开头且无 completed_note」的任务（v1 按换行拆出的碎片），
     * 但 v1 碎片与"被 null 传染的 v2 正规任务"（completed_note 曾被云端整列置 null）
     * **无法区分**——本轮实测它一次误删了 28 条正规任务（本地并推云端）。
     * v1 碎片早在 months 前的 v2 导入时就被清掉了；这里不再自动删任何任务。
     * 真有碎片要清，用 window.TasksDebug / 手动按 id 删。 */

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
  /* ⛔ v1.42.6（2026-10-09）：生理学「暂停」机制**已整体撤销**。
   * ------------------------------------------------------------------
   * 当初（v1.42.1）为什么要加这一整套：
   *   暂停的做法是把 43 行移出 tasks 表，而导入守卫的第一条恰恰是
   *   `if (Store.getTasks().some(isPhysioTask)) return;`
   *   —— 暂停后 tasks 里一行 physio 都没有 → 守卫判定「从未导入」
   *   → **立刻把 43 行重新灌回来**，暂停完全失效（这正是历史上
   *     paused 表被灌成 129 行的机制性原因）。于是又追加了
   *   云端共享标记 + 守卫链前移 + hydrate 编排等 6 处复杂度。
   *
   * 为什么撤销（用户 2026-10-09 实测后的决定）：
   *   本项目**不是增量同步，而是整表 upsert**：
   *     setLocal(key,value) → pushToSupabase(key,value)
   *     → upsertRows(table, 整张表)  ← 改任何一行都推整张 tasks
   *   所以省流量的唯一变量是**表的总行数**，与「哪一行变没变」无关。
   *   实测单行约 527 字节，清理重复行后 520 行 ≈ 268 KB/次；
   *   生理学 43 行 ≈ **22 KB/次 = 8%**。
   *   → 为省这 8% 而背上 6 处复杂度（且已因此出过一次
   *     「暂停被自我推翻」的真 bug），代价与收益完全不成比例。
   *
   * 现在恢复成最朴素的形态：43 行常驻 tasks，卡片正常渲染/打卡/计时。
   * 下方只剩最基础的三重守卫（Store数据 / localStorage 标记 / 首次拉取门禁）。
   * ------------------------------------------------------------------ */

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

  /* ---------- 自动导入 内科+病理·人可研梦滚动复习【二期】（独立系列）----------
   * 用户 2026-10-08 新增。DAY1 = 7.28 → DAY 44 = 9.14，共 44 个**工作日**
   * （对照表已核：不计 day 的休息/异常目录 5 个 = 8.10 / 8.15 / 8.23 / 9.1 / 9.10；
   *   49 自然日 − 5 休息 = 44 工作日，与原表逐行吻合）。
   * ⚠️ **标题只写二期**（用户明示"表头不用写一期进度，只要写二期"），
   *   一期信息只出现在卡片内的小字提示里（「主要跟二期，一期为必要补充」）。
   * ⚠️ date 字段保持空串：与自然日完全解耦，不进入日历/当日完成度——
   *   二期日程按"工作日"排（含 8.4/ 8.9 / 9.4 / 9.7 四个**空目录**日），
   *   绑到具体日期会让空目录日显得"逾期未做"，反而误导。 */
  const MEDPATH_IMPORT_FLAG = "xizong_medpath_imported_v1";
  function autoImportMedpathPlan() {
    const plan = window.MEDPATH_PLAN;
    if (!plan || !plan.length) return;

    // 双重守卫：Store 数据 + localStorage 标记（防止 pullOnce 覆盖后误判）
    if (Store.getTasks().some(isMedpathTask)) return;
    if (localStorage.getItem(MEDPATH_IMPORT_FLAG)) return;
    if (waitFirstPull()) return;   // 首次拉取没结束 → 等它回来再决定（防双份 DAY）

    const mk = (partial) => ({
      id: uid(), user_id: C.USER_ID,
      done: false, subject: "xizong",
      estimated_min: null, remind_on_estimate: true,
      total_focus_sec: 0, status: "todo", time_record_ids: [],
      category: "general", slot: null, block: null,
      created_at: new Date().toISOString(),
      source: MEDPATH_SOURCE,
      ...partial
    });

    let count = 0;
    plan.forEach(p => {
      Store.addTask(mk({
        title: `【复习】《内科+病理》人可研梦滚动复习DAY${p.day}【二期${p.date}】`,
        task_type: "review",
        day_label: `DAY ${p.day}`,
        date: "",
        // note 只放系统说明（用户笔记走 rr_note，两者不混）
        note: `二期：${p.date}｜${p.systems || "—"}｜${p.items} 条` + (p.isEmpty ? "｜空目录（无资料）" : "")
      }));
      count++;
    });

    localStorage.setItem(MEDPATH_IMPORT_FLAG, "1");

    if (count && window.UI && window.UI.showAlert) {
      window.UI.showAlert(`📖 已导入内科+病理·人可研梦滚动复习（DAY1-${plan.length} · 二期7.28起）`, 2800);
    }
  }

  /* ---------- 自动导入 英语单词突围·每日背单词（独立系列，按日期推进）----------
   * 每天一个任务：DAY N（新词 216/215 词 或 复习 648/647/645 词），date = 当天
   * → 既出现在上方独立卡，也进入日历/当日完成度 */
  /* ★ v1.103.0 升版 v1 → v2：第一轮任务被归档删除后，旧标记还在会让"首次导入"被永久跳过
   *   （用户会看到卡片空着且不报错）。换 key 等于让第二轮重新走一次首次导入。 */
  const WORD_IMPORT_FLAG = "english_words_imported_v2";
  /* 统一标题格式（用户指定）：
   *   09-15 DAY 3 每日单词任务：背单词·新词 216
   *   09-16 DAY 4 每日单词任务：背单词·复习 648
   * 日期取计划里的 MM-DD，DAY 取 day_label，末尾为 类型·词量 */
  function vocabTitle(p) {
    const mmdd = String(p.dateStr).slice(5);            // "09-15"
    const kind = p.kind === "review" ? "复习" : "新词";
    return `${mmdd} ${p.label} 每日单词任务：背单词·${kind} ${p.words}`;
  }
  /* ★ v1.103.0：备注统一构造（第二轮起带阶段构成与首末词，方便和 APP 逐日对账）。
   *   复习日写清"补的是第一轮的哪个 DAY"，避免以后看不出来源。 */
  function vocabNote(p) {
    const parts = ["词书：考研英语 6700"];
    if (p.round === 2) {
      if (p.kind === "review") {
        parts.push("第二轮补复习", `补第一轮 DAY ${p.day} 复习`, `${p.words} 词`);
        if (p.cover) parts.push(p.cover);   // ★ v1.118.0：补的是哪一批旧词（有据可查才写）
      } else {
        parts.push(`第2轮 第${p.seq}天/共7天`, `${p.words} 词`);
        if (p.phase) parts.push(p.phase);
        if (p.range) parts.push(p.range);
        /* ★ v1.118.0：备注也带上 Excel 的操作路径，导出/多端同步时不用回网站查 */
        if (p.clickPath) parts.push(`点开：${p.clickPath}`);
        if (p.offline > 0) parts.push(`系统无 ${p.offline} 词（用红宝书/大纲表）`);
      }
    } else {
      parts.push(`第 ${p.day} 天`, `${p.words} 词`);
    }
    return parts.join("｜");
  }
  /* ★ v1.103.0 第一轮归档：把 date 早于 2026-11-04 的单词任务全部移除。
   *   ⚠️ 这是「第一轮归档闸门」，**不是计划起点的镜像**：第一轮最晚 10-26，11-04 已足够清干净。
   *      唯一不变量 = cutoff 严格小于 NEW_START（护栏 verify-word-round2-v1103 锁着），
   *      这样起点当天/前一天已生成的行都不会被删，交给 alignVocabTasksToPlan 按 DAY 号改期。
   *  ★ v1.118.0（起点 11-05 → 11-10，顺延 5 天）**刻意不把 cutoff 抬到 11-09**：
   *      抬了就会把上一版 11-05~11-08 已生成的第二轮行删掉再重导，万一其中已勾完成就永久丢进度；
   *      而 align 本来就能按 day 号把它们整体平移到新日期，根本不需要删。
   *      历史小步顺延（1 天）跟着抬无感，大幅顺延再抬就是数据事故 —— 这条口径已写进护栏。
   *   动机（用户 2026-10-28）：第一轮 DAY 1–41 已背完，不再需要，撤下来可减少
   *   tasks 表的前后端交互量（全量拉取/整表推送都会带上这些行）。
   *   ⚠️ **只删 tasks，不碰 time_records** —— 学习时长是统计页的历史依据，
   *      删了以后所有时长报表都会少掉这 143 小时。
   *   ⚠️ 幂等且不加一次性标记：任何一台设备把旧行推回云端，下次开页还会再删一次。
   *      唯一兜底是 waitFirstPull()（首拉未结束不删，否则会被 setLocal 整表覆盖后"删了又回来"）。 */
  const WORD_LEGACY_CUTOFF = "2026-11-04";
  function purgeLegacyWordTasks() {
    const cut = new Date(WORD_LEGACY_CUTOFF + "T00:00:00").getTime();
    const old = Store.getTasks().filter(t => {
      if (!isWordTask(t)) return false;
      const d = planDateStr(t);
      return !d || d.getTime() < cut;     // 无日期的一并清掉（第二轮每条都有日期）
    });
    if (!old.length) return 0;
    Store.deleteTasksBulk(old.map(t => t.id));
    console.log(`[tasks] 单词突围第一轮归档：移除 ${old.length} 条（date < ${WORD_LEGACY_CUTOFF}）；time_records 保留`);
    return old.length;
  }
  /* （v1.22.13：原 migrateVocabTitles 已被 alignVocabTasksToPlan 取代——后者除了标题，
   *   还会按 DAY 号对齐 date / day_label / 备注，用户改计划起点后旧任务才会跟着走。） */
  /* 云端已配置但"首次拉取"还没结束时，暂缓【整套计划导入】。
   * 否则新设备（清过缓存/换浏览器）会先把整套计划导入本地并推上云端，紧接着首次拉取
   * 又带回云端那套 → 云端出现双份 DAY。拉取【尝试过】即放行（失败也导，保持离线可用）。 */
  function waitFirstPull() {
    return !!(Store.isPullSettled && !Store.isPullSettled());
  }
  /* 把已导入的单词任务按 **DAY 号** 对齐到当前计划表（v1.22.13 起不只是标题）：
   *   · 标题里的日期（09-25 DAY 3 …）
   *   · date 字段（进日历/当日完成度要靠它）
   *   · day_label / note
   * 幂等；只在"与计划不一致"时写。完成状态、累计专注时长、关联记录都在任务本身上，不受影响。
   * 为什么需要：用户改了计划起点（DAY 3 = 9/25），旧任务的日期还停在 9/15。 */
  function alignVocabTasksToPlan() {
    if (waitFirstPull()) return 0;   // ★ v1.22.20：首拉未结束不写 tasks（防旧状态整表覆盖云端）
    const plan = window.WORD_PLAN || [];
    const byDay = {};
    plan.forEach(p => { byDay[p.day] = p; });
    const all = Store.getTasks();
    let changed = 0;
    const next = all.map(t => {
      if (!isWordTask(t)) return t;
      const n = dayNumOf(t);
      const p = byDay[n];
      if (!p) return t;
      const [y, m, d] = p.dateStr.split("-").map(Number);
      const wantDate = new Date(y, m - 1, d).toDateString();
      const wantTitle = vocabTitle(p);
      const wantNote = vocabNote(p);
      const patch = {};
      if (t.title !== wantTitle) patch.title = wantTitle;
      if ((t.date || "") !== wantDate) patch.date = wantDate;
      if ((t.day_label || "") !== p.label) patch.day_label = p.label;
      if ((t.note || "") !== wantNote && !t.note) patch.note = wantNote;   // 备注只在为空时补（别覆盖手写的）
      if (!Object.keys(patch).length) return t;
      changed++;
      return { ...t, ...patch };
    });
    if (changed) {
      Store.setLocal("tasks", next);
      console.log(`[tasks] 单词突围任务已对齐计划表（改期/改标题）${changed} 条`);
    }
    return changed;
  }

  function autoImportWordPlan() {
    const plan = window.WORD_PLAN;
    if (!plan || !plan.length) return;

    /* ★ v1.103.0：首拉未结束 → 整段不动（含下面的归档删除）。
     *   理由：pullOnce 落地是 setLocal(云端全表)，此刻删掉的行会被整表覆盖带回来，
     *   还会把"删除意图"变成一次无意义的云端 DELETE；等首拉结束再执行才是干净的。 */
    if (waitFirstPull()) return;

    /* ★ v1.103.0：先归档第一轮（幂等），再走原有的导入/补齐流程。
     * 删完后 existing() 变空 → 下面的 flag 分支用新 key（v2）放行首次导入。 */
    purgeLegacyWordTasks();

    // 双重守卫：Store 数据 + localStorage 标记（顺序照生理卡——先查 Store 更安全）
    // 已有数据时顺带把任务对齐到当前计划表（标题/日期/day_label/备注；老版本导入的格式与起点都需更新）
    const existing = () => Store.getTasks().filter(isWordTask);
    if (existing().length > 0) {
      alignVocabTasksToPlan();
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
          note: vocabNote(p)
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
        note: vocabNote(p)
      }));
      count++;
    });

    // 标记不在 kaoyan: 前缀下，不受 pullOnce 覆盖影响
    localStorage.setItem(WORD_IMPORT_FLAG, "1");

    if (count && window.UI && window.UI.showAlert) {
      window.UI.showAlert(`📕 已导入单词突围第二轮计划（新词 ${plan.filter(p => p.kind !== "review").length} 天 + 补复习 ${plan.filter(p => p.kind === "review").length} 天）`, 2800);
    }
  }

  /* ===================================================================
   * 天天师兄·外科学冲刺（v1.129.0，2026.11.15 起）
   * 数据源：static/js/xizong-surgery.js（配置驱动，13 个网课日 → 7 个冲刺日；
   *         22 个原定 DAY 的复习/做题/注意/滚动复习 → 独立配套区块）
   *
   * ⚠️ 与旧 5 个 autoImport*() 的区别（本次「优化相关机制」的落点）：
   *   ① 不靠一次性 localStorage flag，而是**每次开页按序号幂等对齐**：
   *      改 startDate / packPerDay 后旧任务自动改期改标题，
   *      done、total_focus_sec、time_record_ids、用户手写备注一律保留。
   *   ② 只补缺、不删用户数据：计划变短时多出来的行改标为「历史」并退出认领，
   *      已勾选的完成状态不会被静默删掉（生理学暂停事故的历史教训）。
   *   ③ 自动备注带【自动】前缀：用户一旦手写改动就不再覆盖，避免对齐吃掉笔记。
   *   ④ 配套（复习计划/做题/注意/滚动复习）**不进任务表**（v1.131.0 起）：
   *      只在当天冲刺卡里折叠展示，不勾选、不进日历、不进今日完成度。
   *   ⑤ 本系列不参与通话任务门禁（门禁只统计单词突围），不影响学习日 04:00 口径。
   * =================================================================== */
  const SURGERY_SPRINT_SOURCE = "surgery_sprint";
  /* 历史来源标记：v1.129.0 曾把 22 条配套写成 source="surgery_support" 的任务行，
   * v1.131.0 起不再生成，并在 syncSurgeryPlan() 里幂等清掉（字面量比较，不引用不存在的常量）。
   * ⚠️ v1.133.0 起 surgery_legacy 行**不再被清掉**：粒度从「天」改成「节」后，
   *    旧 DAY 级行必须留作历史记录 task_id 的落点，删了历史记录就断链。 */
  const SURGERY_LEGACY_SOURCE = "surgery_legacy";
  const SURGERY_AUTO_PREFIX = "【自动】";
  /* 节级身份：day_label = 「外科冲刺 D134-1」（原定 DAY + 该日第几节）。
   * ⚠️ 为什么不用冲刺日序号：改 startDate / packPerDay 会让序号整体移位，
   *    那样每改一次计划全表身份就变 → 任务被当成"新的一天"重建、完成状态全丢。
   *    原定 DAY + 节序是原表事实，永不变。 */
  const SURGERY_LESSON_LABEL_RE = /^外科冲刺\s*D(\d+)-(\d+)$/;
  /* 旧（v1.131.0）DAY 级行的 day_label：「外科冲刺 DAY 2」 */
  const SURGERY_OLD_DAY_LABEL_RE = /^外科冲刺\s*DAY\s*(\d+)\s*$/;

  /* 身份识别：source 与标题特征双认（云端可能把后补列存成 null，标题从未丢过，
   * 沿用生理学 / 二期系列的教训）。字面量比较而不引用 const，避免 TDZ。 */
  function isSurgerySprintTask(t) {
    return !!t && (t.source === "surgery_sprint" || /^【外科冲刺】/.test(t.title || ""));
  }
  function isSurgerySupportTask(t) {
    return !!t && (t.source === "surgery_support" || /^【外科配套】DAY/.test(t.title || ""));
  }
  /* 历史行：旧 DAY 级行、计划里已不存在的节、重复行。退出认领、不进卡片、不进日历，
   * **但绝不删除** —— time_records.task_id 可能还挂在它上面。 */
  function isSurgeryLegacy(t) {
    return !!t && (t.source === SURGERY_LEGACY_SOURCE || /^【外科冲刺·历史】/.test(t.title || ""));
  }
  /* 从一条任务上还原它的节级身份（lid）。首选 day_label 里的机器键，
   * 兜底用标题「7.13 第1节」反查 —— 云端历史上把 day_label 整列置过 null。 */
  function surgeryLessonKeyOf(t) {
    const m = (t.day_label || "").match(SURGERY_LESSON_LABEL_RE);
    if (m) return "sx-" + m[1] + "-" + m[2];
    const m2 = (t.title || "").match(/^【外科冲刺】[^·]*·\s*([\d.]+)\s*第(\d+)节/);
    if (!m2) return "";
    const seq = parseInt(m2[2], 10);
    const arr = window.SURGERY_LESSONS || [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].orig === m2[1] && arr[i].seq === seq) return arr[i].lid;
    }
    return "";
  }
  /* 旧 DAY 级行 → 认它的冲刺日序号（1..7），用于把完成状态继承给该日的每一节。 */
  function surgeryOldDayIndexOf(t) {
    const m = (t.day_label || "").match(SURGERY_OLD_DAY_LABEL_RE) ||
              (t.title || "").match(/DAY\s*(\d+)\s*\/\s*\d+/);
    return m ? parseInt(m[1], 10) : 0;
  }
  const mkSurgery = (partial) => ({
    id: uid(), user_id: C.USER_ID,
    done: false, subject: "xizong",
    estimated_min: null, remind_on_estimate: true,
    total_focus_sec: 0, status: "todo", time_record_ids: [],
    category: "general", slot: null, block: null,
    created_at: new Date().toISOString(),
    ...partial
  });
  /* 任务标题既要能一眼看出「这是第几个冲刺日」，也要能区分同一天的几节课 ——
   * 用户就是在「选择这条记录关联的任务」弹窗里按标题挑的，一天 4 条若只差一个
   * 序号是挑不出来的，所以课程名必须进标题。 */
  function surgeryLessonTitle(c) {
    const total = (window.SURGERY_META || {}).sprintDayCount || 7;
    return `【外科冲刺】DAY${c.sprintIndex}/${total} · ${c.orig} 第${c.seq}节 ${c.name}`;
  }
  function surgeryLessonLabel(c) {
    return "外科冲刺 D" + c.day + "-" + c.seq;
  }
  function surgeryLessonNote(c) {
    return SURGERY_AUTO_PREFIX +
      `原定 DAY${c.day}(${c.orig}) 第${c.seq}/${c.daySeq} 节 · 计划 ${c.min}min`;
  }
  /* 只在「空备注」或「仍是上次自动生成的备注」时才允许对齐覆盖；
   * 用户手写过的备注一律保留（不静默吞掉）。 */
  function surgeryNotePatch(t, want) {
    const cur = t.note || "";
    if (cur === want) return null;
    if (!cur || cur.indexOf(SURGERY_AUTO_PREFIX) === 0) return want;
    return null;
  }
  /* 计划变短/出现重复行时不删除用户数据，改标为历史并退出认领。 */
  function surgeryLegacy(t) {
    return {
      ...t,
      source: SURGERY_LEGACY_SOURCE,
      title: "【外科冲刺·历史】" + String(t.title || "").replace(/^【外科(冲刺|配套)】/, ""),
      date: ""
    };
  }

  function syncSurgeryPlan() {
    const lessons = window.SURGERY_LESSONS || [];
    if (!lessons.length) return 0;
    /* 首拉未结束不写 tasks：pullOnce 的 setLocal(云端全表) 会把改动覆盖回去。 */
    if (waitFirstPull()) return 0;

    const byKey = {};
    lessons.forEach(c => { byKey[c.lid] = c; });

    const seen = {};
    const inheritDone = {};   // 冲刺日序号 → 旧 DAY 级行是否已勾完成
    let changed = 0, purged = 0, migrated = 0;
    const next = [];

    Store.getTasks().forEach(t => {
      /* ① 旧 DAY 级行（v1.131.0 生成的「一天一条」）→ 降级为历史行。
       *    不删除：可能已有 time_records / active_timer 挂在它上面。
       *    完成状态记下来，稍后继承给该冲刺日的每一节（那天他确实听完了）。 */
      if (isSurgerySprintTask(t) && !isSurgeryLegacy(t) && !surgeryLessonKeyOf(t)) {
        const i = surgeryOldDayIndexOf(t);
        if (i && t.done) inheritDone[i] = true;   // 只有已完成的旧行才需要继承
        next.push(surgeryLegacy(t));
        migrated++; changed++;
        return;
      }
      /* ② 节级行：按 lid 认领；认不到或重复 → 历史行（重复是 v1.131.0 的真实事故，
       *    图 1 里同一天出现过两条一模一样的候选）。 */
      if (isSurgerySprintTask(t) && !isSurgeryLegacy(t)) {
        const key = surgeryLessonKeyOf(t);
        const c = byKey[key];
        if (!c || seen[key]) { next.push(surgeryLegacy(t)); changed++; return; }
        seen[key] = 1;
        const patch = {};
        const wantTitle = surgeryLessonTitle(c);
        if (t.title !== wantTitle) patch.title = wantTitle;
        if ((t.date || "") !== c.dateText) patch.date = c.dateText;
        const wantLabel = surgeryLessonLabel(c);
        if ((t.day_label || "") !== wantLabel) patch.day_label = wantLabel;
        if (t.source !== SURGERY_SPRINT_SOURCE) patch.source = SURGERY_SPRINT_SOURCE;
        if (t.task_type !== "course") patch.task_type = "course";
        const note = surgeryNotePatch(t, surgeryLessonNote(c));
        if (note) patch.note = note;
        if (Object.keys(patch).length) { next.push({ ...t, ...patch }); changed++; }
        else next.push(t);
        return;
      }
      /* ③ 旧的配套任务行（v1.129.0）：从来没有用户数据，幂等清掉。
       *    ⚠️ 只清配套，**不清历史行** —— 历史行现在要长期留作记录关联的落点。 */
      if (isSurgerySupportTask(t)) { purged++; return; }
      next.push(t);
    });

    /* 只补缺：新增行一律带自动备注，已有行绝不重建（保住 done / 专注时长 / 笔记）。 */
    lessons.forEach(c => {
      if (seen[c.lid]) return;
      const done = !!inheritDone[c.sprintIndex];
      next.push(mkSurgery({
        title: surgeryLessonTitle(c), task_type: "course",
        day_label: surgeryLessonLabel(c), date: c.dateText,
        source: SURGERY_SPRINT_SOURCE, note: surgeryLessonNote(c),
        done: done, status: done ? "done" : "todo"
      }));
      changed++;
    });

    if (changed || purged) {
      Store.setLocal("tasks", next);
      console.log(`[tasks] 外科冲刺已对齐（按节）：${lessons.length} 节 / 旧日级行转历史 ${migrated} 条 / ` +
        `清理配套行 ${purged} 条 / 改动 ${changed} 处`);
    }
    return changed + purged;
  }

  /* ===================================================================
   * 天天师兄·外科学冲刺 —— 专用卡（★ v1.133.0：一节课一条任务）
   *
   * 用户 2026-11-16 原话：「外科冲刺，对于每一节网课，都需要有个独立的计时 ID
   *   和计时关联。」—— 上一版（v1.131.0）是「一天一条任务」，同一天 4 节课共用
   *   一条 id，于是计时到底记在哪一节、记录关联的是哪一节，全都分不出来；
   *   用户截图里那一天还出现了两条一模一样的候选（重复行）。
   *
   * 现在：**一节课 = 一条任务**（22 条），id 由 syncSurgeryPlan() 幂等认领；
   *   卡片仍按冲刺日翻页（◀ ▶ / 全部DAY / 回到今天），但每天卡里逐节列出，
   *   每节自带「开始 / 暂停 / 继续 / 完成 / 撤销」与自己的笔记框。
   *   走的是与任务卡、单词卡完全相同的 Timer API 与 manualCompleteTask，
   *   不另造一套计时 —— 切到计时页看到的、记录里关联的就是这一节。
   *
   * 与单词突围同构的部分：一天一页、◀ ▶ 翻页、总进度 x/7 + 预计收官 + 距初试。
   * 非网课（配套）部分不变：当天卡下方 <details> 折叠展示，纯文本、无勾选、
   *   **不写 tasks**（数据来自 xizong-surgery.js 的 SURGERY_SUPPORT_GROUPS）。
   * =================================================================== */
  let surgeryIdx = -1;          // -1 = 跟随「当前该学的那一天」（正在计时 → 第一个没听完）
  let surgeryExpanded = false;
  let surgeryCollapsed = false;

  /* ===== 暂时跳过（v1.139.0，用户 2026-11-17）=====
   * 原话：「仅针对外科学冲刺任务：新增"暂时跳过"按钮，由于目前时间紧张，
   *   部分内容可能需要跳过，最后返回学习。」
   * 语义 = **暂时**跳过：不计入「剩余」，但也不算听完 —— 跳过的那几节单独计数，
   *   当天清零时会明确写「还有 N 节当初跳过、M 分钟，记得回来补」。
   *
   * 为什么按 lid 存：lid 是节级稳定身份（v1.133.0 铁律 —— 别用 sprintIndex 拼，
   *   改 startDate / packPerDay 会整体移位）。跳过记录必须跟着「哪一节课」走。
   * 为什么走 koujue_state 的独立 scope：跨设备要一致（手机跳过、电脑也认），
   *   而给 tasks 加字段要改 schema、anon key 没有 DDL 权限。
   * 值形如 { "sx-134-1": 1794xxxxxx, "sx-134-2": 0 }：带时间戳，**0 = 已恢复**（墓碑）。
   * 多端合并逐 key 取较大值 —— 否则「这台恢复了、那台又把它跳回去」。
   */
  const SURGERY_SKIP_LS = "kaoyan:surgery_skip";
  const SURGERY_SKIP_SCOPE = "surgery.skip";
  let _surgerySkips = null;      // { lid: ts }，ts=0 表示已恢复

  function surgerySkipMap() {
    if (_surgerySkips) return _surgerySkips;
    let o = {};
    try {
      const raw = localStorage.getItem(SURGERY_SKIP_LS);
      const j = raw ? JSON.parse(raw) : null;
      if (j && typeof j === "object" && !Array.isArray(j)) {
        Object.keys(j).forEach(k => { o[k] = Number(j[k]) || 0; });
      }
    } catch (e) { o = {}; }
    _surgerySkips = o;
    return _surgerySkips;
  }
  function isSurgerySkipped(lid) {
    if (!lid) return false;
    return (surgerySkipMap()[lid] || 0) > 0;
  }
  function saveSurgerySkips(next) {
    _surgerySkips = next || {};
    try { localStorage.setItem(SURGERY_SKIP_LS, JSON.stringify(_surgerySkips)); } catch (e) {}
    try {
      if (window.Store && window.Store.setShared) {
        window.Store.setShared(SURGERY_SKIP_SCOPE, _surgerySkips).catch(function () {});
      }
    } catch (e) {}
  }
  /* on=true 写时间戳；on=false 写 0（墓碑 —— 只有 0 能压掉云端的旧"已跳过"） */
  function setSurgerySkip(lid, on) {
    if (!lid) return false;
    const m = Object.assign({}, surgerySkipMap());
    m[lid] = on ? Date.now() : 0;
    saveSurgerySkips(m);
    return true;
  }
  /* 开页把云端并进来：逐 key 取较大的 ts。返回 true 表示本地有变化（需要重渲染） */
  function syncSurgerySkipsFromCloud() {
    let p;
    try {
      if (!window.Store || !window.Store.getShared) return Promise.resolve(false);
      p = window.Store.getShared(SURGERY_SKIP_SCOPE, null);
    } catch (e) { return Promise.resolve(false); }
    return Promise.resolve(p).then(cloud => {
      if (!cloud || typeof cloud !== "object") return false;
      const local = surgerySkipMap();
      const merged = Object.assign({}, local);
      let changed = false;
      Object.keys(cloud).forEach(k => {
        const c = Number(cloud[k]) || 0;
        const l = Number(local[k]) || 0;
        if (c > l) { merged[k] = c; changed = true; }
      });
      if (!changed) return false;
      _surgerySkips = merged;
      try { localStorage.setItem(SURGERY_SKIP_LS, JSON.stringify(merged)); } catch (e) {}
      return true;
    }).catch(() => false);
  }

  /* 节级任务表：lid → task（只取有效节级行；历史行 / 配套行不进卡片） */
  function surgeryLessonTasks() {
    const map = {};
    Store.getTasks().forEach(t => {
      if (!isSurgerySprintTask(t) || isSurgeryLegacy(t)) return;
      const k = surgeryLessonKeyOf(t);
      if (k && !map[k]) map[k] = t;
    });
    return map;
  }
  /* 把「7 个冲刺日」与「22 条节任务」拼成渲染用的页对象 */
  function surgeryPages() {
    const map = surgeryLessonTasks();
    return (window.SURGERY_SPRINT || []).map(s => {
      const rows = s.courses.map(c => ({ c: c, t: map[c.lid] || null }));
      const doneCount = rows.filter(r => r.t && r.t.done).length;
      /* ★ v1.139.0：跳过 ≠ 听完。skippedCount 单独计，
       *   pending = 既没听也没跳过的节数 —— 「第一个没完成的那天」和「还剩几天」
       *   都按 pending 算，否则跳过的节会永远挡在前面、永远跳不出去。 */
      const skippedCount = rows.filter(r => !(r.t && r.t.done) && isSurgerySkipped(r.c.lid)).length;
      const pending = rows.filter(r => !(r.t && r.t.done) && !isSurgerySkipped(r.c.lid)).length;
      return {
        index: s.index, dateStr: s.dateStr, dateText: s.dateText,
        origs: s.origs, rows: rows, totalMin: s.totalMin,
        lessonCount: rows.length, doneCount: doneCount,
        skippedCount: skippedCount, pending: pending,
        allDone: rows.length > 0 && doneCount === rows.length
      };
    });
  }
  /* 默认停在哪一天（v1.139.0 修）：
   *   ① 正在计时 / 暂停中的那一节所在的那天
   *   ② 第一个还有未完成（且没被跳过）的一天
   *   ③ 全清 → 最后一天
   * 用户原话：「切换页面或者刷新时，外科学冲刺计划总是按照日期进行跳转，
   *   其实应该是跳转到第一个未完成的任务或者正在计时的任务所在日期。」
   * 旧实现是拿 dateText 对「今天」—— 滞后或超前时必然跳错，
   * 而且刷新一次就重置成按日期，正在计时的那一节常常不在视野里。 */
  function surgeryFocusIndex(pages) {
    if (!pages || !pages.length) return 0;
    let linked = null;
    try {
      linked = window.Timer && window.Timer.getLinkedTaskId ? window.Timer.getLinkedTaskId() : null;
    } catch (e) { linked = null; }
    if (linked) {
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].rows.some(r => r.t && r.t.id === linked)) return i;
      }
    }
    for (let i = 0; i < pages.length; i++) if (pages[i].pending > 0) return i;
    return pages.length - 1;
  }
  function surgeryPageTitle(p) {
    const total = (window.SURGERY_META || {}).sprintDayCount || 7;
    return `DAY${p.index}/${total} · 原定 ${p.origs.join(" + ")} 网课`;
  }
  function surgerySupportOf(idx) {
    return (window.SURGERY_SUPPORT_GROUPS || []).filter(g => g.index === idx)[0] || null;
  }

  /* ---- 单节一行：状态 + 这一节自己的按钮 ----
   * ★ v1.134.0（用户 2026-11-17）三处改动：
   *   ① 行尾多一个「▾ 更多功能」（与 ✎ 同款小图标），点开是行内一排小按钮，
   *      收起时不占地方 —— 手机上 4 节 × 5 个按钮会挤成一坨；
   *   ②「暂停」语义改成**停止这一段计时**（Timer.stopSegment），不再是主计时器的
   *      pause()。用户原话：「暂停功能的逻辑应该是：停止计时器计时。按继续后再次开始。
   *      （而不是关联主计时器的暂停功能。）」所以暂停后主按钮变「继续」，
   *      点它 = startTask() 重新开一段，上一段已经落盘，不会丢时间；
   *   ③ 新增「☕ 休息」→ 主计时器切成休息正计时（Timer.startRest），
   *      切换前若这一节正在计时，先把本段落盘，时间不丢。
   *
   * 主按钮只留"下一步最可能做的事"，其余全进菜单：
   *   未开始 → 开始｜计时中 → 完成｜暂停后(有专注) → 继续｜已完成 → 撤销
   * 「✓ 一键完成」只在**不在计时**时出现在菜单里（不开计时器也能补标完成，
   *   正是截图里「已听过课只是没点完成」的场景）；计时中的完成就是主按钮本身。 */
  function sxLessonMore(row) {
    const t = row.t;
    if (!t) return "";
    const lk = linkState(t.id);
    const live = lk === "running";
    const skipped = isSurgerySkipped(row.c.lid);
    const items = [];
    if (!t.done) {
      if (lk === "running") {
        items.push(`<button type="button" class="sx-mini sx-mini-warn" data-sx-stop="${t.id}">⏸ 暂停</button>`);
      } else {
        items.push(`<button type="button" class="sx-mini sx-mini-ok" data-sx-finish="${t.id}">✓ 一键完成</button>`);
      }
      /* ★ v1.139.0：暂时跳过 / 恢复。跳过的节不计入剩余，但也不算听完 ——
       *   当天清零时会在合计行提醒「还有 N 节跳过、M 分钟，记得回来补」。 */
      items.push(skipped
        ? `<button type="button" class="sx-mini sx-mini-back" data-sx-unskip="${t.id}">↩ 恢复学习</button>`
        : `<button type="button" class="sx-mini sx-mini-skip" data-sx-skip="${t.id}">⏭ 暂时跳过</button>`);
    }
    items.push(`<button type="button" class="sx-mini" data-sx-rest="${t.id}">☕ 休息</button>`);
    /* ★ v1.138.0（用户 2026-11-17）：「计时中的任务，保持展开」。
     *   正在计时的这一节，菜单默认就是打开的 —— 否则点了「开始」一 render 就收回去，
     *   想暂停还得先点一次 ▾。其余行仍旧默认收起。 */
    return `<div class="sx-l-more${live ? " is-open" : ""}"${live ? "" : " hidden"}>` +
      `<span class="sx-more-tip">${live ? "本段进行中" : "更多"}</span>${items.join("")}</div>`;
  }
  function sxLessonBtn(row) {
    const t = row.t;
    if (!t) return `<span class="sx-l-wait">任务待生成</span>`;
    const lk = linkState(t.id);
    const live = lk === "running";
    const skipped = isSurgerySkipped(row.c.lid);
    const more = t.id
      ? `<button type="button" class="sx-more-btn${live ? " on" : ""}" data-sx-more="${t.id}"
           aria-expanded="${live ? "true" : "false"}" title="更多功能（一键完成 / 暂停 / 跳过 / 休息）">▾</button>`
      : "";
    if (t.done) {
      return `<button type="button" class="sx-btn sx-btn-undo" data-sx-undo="${t.id}">撤销</button>` + more;
    }
    /* 跳过的节：主按钮直接给「恢复」—— 这是它唯一的出口（顺手就能回来学） */
    if (skipped) {
      return `<button type="button" class="sx-btn sx-btn-back" data-sx-unskip="${t.id}">恢复</button>` + more;
    }
    if (live) {
      return `<button type="button" class="sx-btn sx-btn-ok" data-sx-finish="${t.id}">完成</button>` + more;
    }
    /* paused = 旧版 pause() 留下的会话（兼容历史数据）；
     * 有专注但无会话 = v1.134.0 的「暂停」停掉了一段 —— 两者都叫「继续」，
     * 但前者走 resume() 续接旧会话，后者走 startTask() 新开一段。 */
    if (lk === "paused") {
      return `<button type="button" class="sx-btn sx-btn-go" data-sx-resume="${t.id}">继续</button>` + more;
    }
    const focus = t.total_focus_sec || 0;
    return `<button type="button" class="sx-btn sx-btn-go" data-sx-start="${t.id}">${focus > 0 ? "继续" : "开始"}</button>` + more;
  }
  function sxLessonRow(row) {
    const c = row.c, t = row.t;
    const lk = t ? linkState(t.id) : "none";
    const focus = t && t.total_focus_sec ? t.total_focus_sec : 0;
    const skipped = !(t && t.done) && isSurgerySkipped(c.lid);
    const cls = ["sx-lesson",
      t && t.done ? "is-done" : "",
      skipped ? "is-skipped" : "",
      lk === "running" ? "is-running" : "",
      lk === "paused" ? "is-paused" : ""].filter(Boolean).join(" ");
    const bits = ["DAY" + c.day, c.orig, c.min + "min"];
    if (t && t.done) bits.push("已听完");
    /* ★ v1.139.0：跳过的节单列一档（不是"已听完"，也不是"未开始"）——
     *   已听过的部分照实写出来，用户回头补的时候知道从哪接。 */
    else if (skipped) bits.push(focus > 0 ? "已跳过 · 已听 " + fmtDuration(focus) : "已跳过");
    else if (lk === "running") bits.push("计时中");
    else if (lk === "paused") bits.push("已暂停 · " + fmtDuration(pausedFocusSec()));
    /* ★ v1.134.0：暂停=停止本段后，这里不再是「已消耗」而是「已暂停 · 已听 X」
     *   —— 让用户一眼看出这节听过一段、点「继续」会接着记新的。 */
    else if (focus > 0) bits.push("已暂停 · 已听 " + fmtDuration(focus));
    /* 每节自己的笔记：默认收起（4 节各挂一个 textarea 会把卡撑得很长）。
     * 字段仍用 rr_note（v1.131.0 起就是它，别复用 note：note 被系列自动备注占着）。 */
    const noteHtml = t ? `<div class="sx-l-note" hidden>
        <textarea class="rr-note-ta" data-rr-note="${t.id}" rows="2"
          placeholder="这一节的笔记（复盘、易错点、口诀补充…失焦即存）">${escapeHtml(rrNoteOf(t))}</textarea>
      </div>` : "";
    return `<div class="${cls}" data-sx-lid="${escapeHtml(c.lid)}">
      <div class="sx-l-main">
        <div class="sx-l-title"><b>第${c.seq}节</b><span class="sx-l-name">${escapeHtml(c.name)}</span></div>
        <div class="sx-l-meta">${(t && !t.done && lk === "running")
          ? escapeHtml(bits.join(" · ")).replace("计时中", '<span class="sx-live"><i></i>计时中</span>')
          : escapeHtml(bits.join(" · "))}</div>
        ${noteHtml}
      </div>
      <div class="sx-l-acts">
        ${t ? `<button type="button" class="sx-note-btn" data-sx-note="${t.id}" title="这一节的笔记">✎</button>` : ""}
        ${sxLessonBtn(row)}
      </div>
      ${t ? sxLessonMore(row) : ""}
    </div>`;
  }
  function surgeryCourseHtml(p) {
    if (!p) return "";
    const doneMin = p.rows.filter(r => r.t && r.t.done).reduce((a, r) => a + r.c.min, 0);
    /* ★ v1.139.0：跳过的节从「剩余」里扣掉，但单独列一个「已跳过 N 分钟」——
     *   否则用户会以为跳过就白赚了：那部分时间最后还是得回来补。 */
    const skipMin = p.rows.filter(r => !(r.t && r.t.done) && isSurgerySkipped(r.c.lid))
      .reduce((a, r) => a + r.c.min, 0);
    const h = Math.floor(p.totalMin / 60), m = p.totalMin % 60;
    /* ★ v1.138.0（用户 2026-11-17）：「合计 384 分钟 · 已听 202 分钟」还缺剩余 →
     *   补「剩余 N 分钟（约 H 小时 M 分）」，全听完时改说「已全部听完」。 */
    const remainMin = Math.max(0, p.totalMin - doneMin - skipMin);
    const rh = Math.floor(remainMin / 60), rm = remainMin % 60;
    /* 三个语义块各自 nowrap（合计 / 已听 / 剩余），窄屏放不下时整块换行，
     *   不会出现「剩余」和数字被拆到两行、或行尾孤零零一个「·」。 */
    const remainHtml = remainMin > 0
      ? `<span class="sx-remain">剩余 <b>${remainMin}</b> 分钟${rh ? `（约 ${rh} 小时${rm ? " " + rm + " 分" : ""}）` : ""}</span>`
      : (p.totalMin > 0
        ? `<span class="sx-total-all">${skipMin > 0 ? "本日已清空" : "已全部听完"}</span>`
        : "");
    const heardHtml = doneMin ? `<span class="sx-heard">已听 <b>${doneMin}</b> 分钟</span>` : "";
    const skipHtml = skipMin
      ? `<span class="sx-skip">已跳过 <b>${skipMin}</b> 分钟</span>`
      : "";
    return `<div class="sx-courses">
      <div class="sx-ctitle">当日网课 · ${p.rows.length} 节<span class="sx-ctitle-tip">原表 ${escapeHtml(p.origs.join(" + "))} · 每节独立计时</span></div>
      ${p.rows.map(sxLessonRow).join("")}
      <div class="sx-total"><span class="sx-sum">合计 <b>${p.totalMin}</b> 分钟${h ? `（约 ${h} 小时${m ? " " + m + " 分" : ""}）` : ""}</span>${heardHtml}${skipHtml}${remainHtml}</div>
    </div>`;
  }
  function surgerySupportHtml(idx) {
    const g = surgerySupportOf(idx);
    if (!g || !g.items.length) return "";
    const items = g.items.map(p =>
      `<div class="sg-item" data-sx-sg="1">
         <div class="sg-main">
           <div class="sg-head"><b>DAY${p.day}</b><span>原定 ${escapeHtml(p.orig)}</span><em class="${p.hasCourse ? "has" : "none"}">${p.hasCourse ? "网课日" : "无网课 · 纯复习"}</em></div>
           <div class="sg-brief">${escapeHtml(p.brief)}</div>
           <div class="sg-detail" hidden>${escapeHtml(p.detail).replace(/\n/g, "<br>")}</div>
         </div>
       </div>`).join("");
    return `<details class="sx-support">
      <summary>当日配套 · ${g.items.length} 条<span class="sx-support-note">仅展示 · 不联动</span></summary>
      <div class="sg-list">${items}</div>
    </details>`;
  }
  /* 总进度 / 预计收官：一天里所有课节都标完成，才算这一天听完；
   * 滞后多少天就把收官日往后推多少天，不假装按原计划。 */
  function surgeryFooterHtml(pages) {
    const meta = window.SURGERY_META || {};
    const total = pages.length || meta.sprintDayCount || 7;
    const done = pages.filter(p => p.allDone).length;
    const doneLessons = pages.reduce((a, p) => a + p.doneCount, 0);
    const allLessons = pages.reduce((a, p) => a + p.lessonCount, 0);
    /* ★ v1.139.0：跳过的节不该把进度条永远卡在 99% ——
     *   「已清空的天」= 全听完，或剩下的全被跳过；「还剩 N 天」只数还有活要干的天。 */
    const skipLessons = pages.reduce((a, p) => a + p.skippedCount, 0);
    const cleared = pages.filter(p => p.pending === 0).length;
    const pct = total ? Math.round((cleared / total) * 100) : 0;
    const remain = pages.filter(p => p.pending > 0).length;
    const todayKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const lag = pages.filter(p => p.dateStr < todayKey && p.pending > 0).length;
    const endKey = meta.endDate || "";
    let etaLabel = endKey ? endKey.slice(5) : "—";
    if (endKey && lag > 0) {
      const [y, m, d] = endKey.split("-").map(Number);
      const e = new Date(y, m - 1, d + lag);
      etaLabel = `${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}（滞后 ${lag} 天）`;
    }
    const exam = (window.APP_CONFIG && window.APP_CONFIG.EXAM_DATE) || "";
    let examGap = null;
    if (exam) {
      const [ey, em, ed] = exam.split("-").map(Number);
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      examGap = Math.round((new Date(ey, em - 1, ed) - t0) / 86400000);
    }
    const lagHtml = lag > 0
      ? `<div class="sx-lag">⚠️ 今天以前还有 <b>${lag}</b> 个冲刺日没听完 —— 若确实滞后，就顺延收官；已听过课只是没点完成，现在补标即可</div>`
      : "";
    /* ★ v1.134.0：「☕ 休息」是从这里的菜单点的，主计时器切走后卡片本身没有行会变蓝，
     *   不提示一句用户会以为没生效。 */
    const resting = !!(window.Timer && window.Timer.isResting && window.Timer.isResting());
    const restHtml = resting
      ? `<div class="sx-resting">☕ 主计时器在休息（正计时）· 回来点任意一节的「继续」接着听</div>`
      : "";
    /* ★ v1.139.0：「最后返回学习」—— 紧迫的做完了、当初跳过的还欠着，
     *   这时才提示回头补（平时不吵，否则跳过按钮就成了告警源）。 */
    const backHtml = (remain === 0 && skipLessons > 0)
      ? `<div class="sx-back">⏭ 当初跳过 <b>${skipLessons}</b> 节 · 现在没有卡着的活了，回头把它们补掉</div>`
      : "";
    return `<div class="sx-foot">
      <div class="sx-bar"><i style="width:${pct}%"></i></div>
      <div class="sx-meta">已听 <b>${done}/${total}</b> 天 · 还剩 <b>${remain}</b> 天
        · 课节 <b>${doneLessons}/${allLessons}</b> 节${skipLessons ? ` · 跳过 <b>${skipLessons}</b> 节` : ""}
        · 预计收官 <b>${etaLabel}</b>${examGap !== null ? ` · 距初试还有 <b>${Math.max(0, examGap)}</b> 天` : ""}</div>
      ${backHtml}
      ${restHtml}
      ${lagHtml}
    </div>`;
  }
  function renderSurgeryCard() {
    const el = document.getElementById("surgeryCard");
    if (!el) return;
    if (!(window.SURGERY_LESSONS || []).length) { el.style.display = "none"; return; }
    const pages = surgeryPages();
    if (!pages.length) { el.style.display = "none"; return; }
    /* 当前页：用户切过页就听他的；否则跳到「正在计时 / 第一个没听完」的那天
     * （v1.139.0 起不再按日期对表 —— 见 surgeryFocusIndex 的注释） */
    let idx = surgeryIdx;
    if (!(idx >= 0 && idx < pages.length)) idx = surgeryFocusIndex(pages);
    const cur = pages[idx];
    let navHtml;
    if (surgeryExpanded) {
      navHtml = `<div class="physio-tabs open">${pages.map((p, i) =>
        `<button type="button" class="physio-tab ${i === idx ? "active" : ""}" data-surgery-tab="${i}" ${p.allDone ? 'data-done="1"' : ""}>
          DAY${p.index}${p.allDone ? ' <span class="ptick">✓</span>' : (p.doneCount ? ` <span class="ptick">${p.doneCount}/${p.lessonCount}</span>` : "")}</button>`).join("")}
        <button type="button" class="physio-tab physio-more" data-surgery-toggle>收起 ▴</button></div>`;
    } else {
      navHtml = `<div class="physio-tabs">
        <button type="button" class="physio-nav" data-surgery-tab="${idx - 1}" ${idx > 0 ? "" : "disabled"}>◀</button>
        <button type="button" class="physio-cur" data-surgery-today="1">DAY${cur.index}/${pages.length}<span class="pcur-sub">${cur.doneCount}/${cur.lessonCount} 节</span></button>
        <button type="button" class="physio-nav" data-surgery-tab="${idx + 1}" ${idx < pages.length - 1 ? "" : "disabled"}>▶</button>
        <button class="physio-more" data-surgery-toggle>全部DAY ▾</button>
      </div>`;
    }
    el.style.display = "";
    el.innerHTML = `<div class="physio-wrap">
      <div class="physio-head">
        <div class="physio-htitle">
          <span class="physio-logo">🩺</span>
          <span class="physio-name">天天师兄 · 外科学冲刺</span>
          <span class="physio-badge">独立进度 · 每节独立计时</span>
        </div>
        <button type="button" class="physio-collapse-btn" data-surgery-collapse>${surgeryCollapsed ? "▼ 展开" : "▲ 收起"}</button>
      </div>
      <div class="physio-body" style="${surgeryCollapsed ? "display:none" : ""}">
        ${navHtml}
        <div class="cs-card" style="--ct:#0369a1">
          <div class="cs-main">
            <div class="cs-title">${escapeHtml(surgeryPageTitle(cur))}</div>
            <div class="cs-meta">
              <span class="cs-badge" style="--cb:#0369a1">网课</span>
              <span class="cs-focus">${cur.lessonCount} 节 · 合计 ${cur.totalMin} 分钟</span>
            </div>
            ${surgeryCourseHtml(cur)}
            ${surgerySupportHtml(cur.index)}
          </div>
        </div>
        ${surgeryFooterHtml(pages)}
      </div>
    </div>`;
    if (window.Icon) window.Icon.inject(el);
  }
  function bindSurgeryCard() {
    const el = document.getElementById("surgeryCard");
    if (!el) return;
    el.addEventListener("click", e => {
      let n;
      /* 每节自己的开始 / 暂停 / 继续 / 完成 / 撤销 —— 与任务卡、单词卡同一套 API */
      if ((n = e.target.closest("[data-sx-start]"))) {
        const id = n.dataset.sxStart;
        if (window.Timer && window.Timer.startTask) {
          window.Timer.startTask(id);
          if (window.UI && window.UI.showAlert) window.UI.showAlert("▶️ 开始计时 · 这一节", 1500);
        }
        render();
        return;
      }
      /* ★ v1.134.0：「暂停」= 真的停掉这一段（落记录、不标完成），点「继续」重新开始。
       *   data-sx-pause 是 v1.133.0 的旧属性，一并接住 —— 手机上是旧 HTML + 新 JS
       *   时也不至于点了没反应。两条路径都只走 stopSegment，绝不再调 Timer.pause()。 */
      if ((n = e.target.closest("[data-sx-stop],[data-sx-pause]"))) {
        const ok = window.Timer && window.Timer.stopSegment ? window.Timer.stopSegment() : false;
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert(ok
            ? "⏸ 已暂停 · 本段已记入，点「继续」重新开始"
            : "当前没有正在进行的计时", ok ? 2000 : 1600);
        }
        render();
        return;
      }
      /* ☕ 休息：主计时器转「休息」正计时。若这一节正在计时，先把本段落盘再切，时间不丢；
       *   休息不带 taskId（Timer.startRest 的既有约定），所以休息时长不计进这一节。 */
      if ((n = e.target.closest("[data-sx-rest]"))) {
        const st = window.Timer && window.Timer.getState ? window.Timer.getState() : null;
        if (st && window.Timer.stopSegment) window.Timer.stopSegment();
        const ok = window.Timer && window.Timer.startRest ? window.Timer.startRest() : false;
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert(ok
            ? "☕ 主计时器已转入休息（正计时）· 回来点「继续」接着听"
            : "休息没能启动，请到计时页手动开始", ok ? 2400 : 2000);
        }
        render();
        return;
      }
      /* ▾ 更多功能：纯 DOM 展开/收起，不重渲染（否则刚点开就被 render 收回去） */
      if ((n = e.target.closest("[data-sx-more]"))) {
        const row = n.closest("[data-sx-lid]");
        const box = row && row.querySelector(".sx-l-more");
        if (box) {
          box.hidden = !box.hidden;
          n.setAttribute("aria-expanded", box.hidden ? "false" : "true");
          n.classList.toggle("on", !box.hidden);
        }
        return;
      }
      if ((n = e.target.closest("[data-sx-resume]"))) {
        const ok = window.Timer && window.Timer.resume ? window.Timer.resume() : false;
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert(ok ? "▶️ 已继续这一节" : "当前没有可继续的计时", 1600);
        }
        render();
        return;
      }
      if ((n = e.target.closest("[data-sx-finish]"))) {
        const id = n.dataset.sxFinish;
        /* 正在计时的那一节：正常结束会话并标完成（会落一条时间记录）；
         * 没在计时的：直接标完成（手动完成事件，与任务卡同一路径）。 */
        if (linkState(id) === "none") {
          manualCompleteTask(id);
          if (window.UI && window.UI.showAlert) window.UI.showAlert("🎉 这一节已完成", 1800);
        } else if (window.Timer && window.Timer.stopAndMarkDone) {
          window.Timer.stopAndMarkDone();
          if (window.UI && window.UI.showAlert) window.UI.showAlert("🎉 专注完成！", 2000);
        }
        render();
        return;
      }
      if ((n = e.target.closest("[data-sx-undo]"))) {
        Store.updateTask(n.dataset.sxUndo, { done: false, status: "todo" });
        if (window.UI && window.UI.showAlert) window.UI.showAlert("已撤销", 1200);
        render();
        return;
      }
      /* ⏭ 暂时跳过 / ↩ 恢复（v1.139.0）
       * 跳过 = 这几天先不看它：不计入「剩余」、也不再挡着「第一个没完成的那天」，
       *   但**不算听完**（tasks 里 done 仍是 false），最后会提示回头补。
       * 正在计时的那一节被跳过时，先把本段落盘（时间不丢），再标跳过。 */
      if ((n = e.target.closest("[data-sx-skip]"))) {
        const id = n.dataset.sxSkip;
        const tk = Store.getTasks().filter(t => t.id === id)[0];
        const lid = tk ? surgeryLessonKeyOf(tk) : "";
        if (!lid) { if (window.UI && window.UI.showAlert) window.UI.showAlert("认不出这一节的编号，跳过失败", 2000); return; }
        if (linkState(id) === "running" && window.Timer && window.Timer.stopSegment) {
          window.Timer.stopSegment();   // 本段已落盘，不标完成
        }
        setSurgerySkip(lid, true);
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert("⏭ 已暂时跳过 · 不占「剩余」，回头点「恢复」接着学", 2400);
        }
        render();
        return;
      }
      if ((n = e.target.closest("[data-sx-unskip]"))) {
        const id = n.dataset.sxUnskip;
        const tk = Store.getTasks().filter(t => t.id === id)[0];
        const lid = tk ? surgeryLessonKeyOf(tk) : "";
        if (lid) setSurgerySkip(lid, false);
        if (window.UI && window.UI.showAlert) window.UI.showAlert("↩ 已恢复这一节（重新计入剩余）", 1800);
        render();
        return;
      }
      /* 每节的笔记框：点 ✎ 展开/收起（textaera 的保存由 bindRollingNotes 兜） */
      if ((n = e.target.closest("[data-sx-note]"))) {
        const row = n.closest("[data-sx-lid]");
        const box = row && row.querySelector(".sx-l-note");
        if (box) {
          box.hidden = !box.hidden;
          if (!box.hidden) {
            const ta = box.querySelector("textarea");
            if (ta) ta.focus();
          }
        }
        return;
      }
      /* 切换冲刺日（tab / 前后箭头） */
      if ((n = e.target.closest("[data-surgery-tab]"))) {
        const i = parseInt(n.dataset.surgeryTab, 10);
        if (!isNaN(i) && i >= 0 && i < surgeryPages().length) { surgeryIdx = i; render(); }
        return;
      }
      if (e.target.closest("[data-surgery-today]")) { surgeryIdx = -1; render(); return; }
      if (e.target.closest("[data-surgery-toggle]")) { surgeryExpanded = !surgeryExpanded; render(); return; }
      if (e.target.closest("[data-surgery-collapse]")) { surgeryCollapsed = !surgeryCollapsed; render(); return; }
      /* 配套条目：点一下展开四列详情（纯展示，没有勾选框） */
      const item = e.target.closest("[data-sx-sg]");
      if (item) {
        const d = item.querySelector(".sg-detail");
        if (d) { d.hidden = !d.hidden; item.classList.toggle("open", !d.hidden); }
      }
    });
    bindRollingNotes(el);   // 笔记：blur 立即存 + input debounce（与其它卡同一套）
  }

  /* ---------- 交互绑定 ---------- */
  function init() {
    // 1. 立即本地渲染（不从远端等，Supabase 慢也不阻塞）
    Store.setLog && Store.setLog("任务页启动，本地导入…");
    repairPlanIdentity();   // 先补回可能被云端 null 掉的身份字段（source/day_label/note）
    autoImportXizongPlan();
    autoImportLivePlan();
    autoImportPhysioPlan();
    autoImportMedpathPlan();
    autoImportWordPlan();
    syncSurgeryPlan();   // ★ v1.129.0：外科冲刺（配置驱动 + 幂等对齐，不靠一次性 flag）
    Store.setLog && Store.setLog(`导入完成：共${Store.getTasks().length}条任务`);
    render();

    /* ★ v1.139.0：把云端「暂时跳过」并进来（手机跳过、电脑也认）。
     *   本地 localStorage 先跑，云端只做补充 —— 合并有变化才重渲染，避免白闪。 */
    syncSurgerySkipsFromCloud().then(changed => { if (changed) render(); }).catch(() => {});

    // 2. 后台异步同步云端（不阻塞用户操作）
    (Store.initSupabase() || Promise.resolve(false))
      .then(ok => {
        if (!ok) { Store.setLog && Store.setLog("无Supabase配置，使用本地"); return; }
        Store.setLog && Store.setLog("Supabase连接成功，同步中…");
        return Store.pullOnce();
      })
      .then(() => {
        Store.setLog && Store.setLog("同步完成：重渲染");
        /* v1.42.6：暂停机制撤销后，这里的「先 hydrate 再导入」编排不再需要，
         * 恢复为直接顺序执行（与 v1.42.0 之前一致）。 */
        repairPlanIdentity();     // 云端可能带回 null 的身份字段 → 再补一次（改了会自动推回云端）
        autoImportXizongPlan();
        autoImportLivePlan();
        autoImportPhysioPlan();
        autoImportMedpathPlan();
        autoImportWordPlan();      // 云端可能带来单词任务 → 顺带规范化标题
        syncSurgeryPlan();         // ★ v1.129.0：首拉后再对齐一次（云端可能带回旧冲刺行）
        render();
      })
      .catch(err => {
        console.error(err);
        Store.setLog && Store.setLog("同步异常：" + (err && err.message || err));
      });

    const addBtn = document.getElementById("addTask");
    if (addBtn) addBtn.addEventListener("click", openAddDialog);

    // 导入西综计划


    // ★ v1.28.4 月历弹窗
    const monthBtn = document.querySelector('#viewSwitch button[data-view="month"]');
    if (monthBtn) monthBtn.addEventListener("click", openMonthModal);
    ["monthClose", "monthCancel", "monthMask"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", closeMonthModal);
    });
    // 视图切换
    const viewSwitch = document.getElementById("viewSwitch");
    if (viewSwitch) {
      viewSwitch.addEventListener("click", e => {
        const b = e.target.closest("button[data-view]"); if (!b) return;
        if (b.dataset.view === "month") { openMonthModal(); return; }   // ★ v1.28.4 月历开弹窗
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

        /* ---------- v1.41.0 休息：开始休息 ----------
         * 用户 2026-10-08 要求：正在计时的任务加「休息」按钮，
         * 按下自动进入计时器的**正计时**休息（分类 rest / rest_general 休息），
         * **不带 taskId**（休息时长不累计进任务专注进度），
         * 休息中再按「回到学习」即可继续本任务。
         * ⚠️ 为什么必须先停掉原学习段：startCountup 内部会 stopStaleBeforeStart()
         *   自动落盘旧会话（学习那段正常入库），无需手动 stop；这里只做幂等校验。 */
        const restId = e.target.closest("[data-rest]")?.dataset?.rest;
        if (restId) {
          if (window.Timer && window.Timer.startRest) {
            // 已经在休息中就别重复触发（连点保护）
            if (!(window.Timer.isResting && window.Timer.isResting())) {
              window.Timer.startRest();
              render();
              if (window.UI && window.UI.showAlert) {
                window.UI.showAlert("🌿 休息中（正计时）· 不计入本任务进度 · 结束按「回到学习」接上", 2600);
              }
            }
          }
          return;
        }

        /* ---------- v1.41.0 休息：回到学习 ----------
         * 休息段（rest/countup）→ 回到该任务的学习正计时。
         * 复用 startTask(该任务 id)：它会按任务科目映射二级分类、
         * 并用 task_id 完成结构化关联（★ v1.74.0 起不再写「任务：标题」备注，见 timer.js），
         * 与直接从「开始」进入完全一致，休息→学习的衔接不留断层。 */
        const backId = e.target.closest("[data-backtowork]")?.dataset?.backtowork;
        if (backId) {
          if (window.Timer && window.Timer.startTask) {
            /* 不手动 stop 休息段：startCountup 开头会 stopStaleBeforeStart()
             * 自动落盘休息段（不弹标签抽屉、不标任务完成），
             * 若在此再调stopSilent 会重复落盘一次。多写不如少写。 */
            window.Timer.startTask(backId);
            render();
            if (window.UI && window.UI.showAlert) {
              window.UI.showAlert("▶️ 回到学习 · 休息段已记录", 2000);
            }
          }
          return;
        }
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

    // 滚动复习系列 · 卡片交互（生理学 / 内科+病理 共用同一套，v1.42.0 抽出）
    bindRollingCard(physioCfg());
    bindRollingCard(medpathCfg());
    bindSurgeryCard();      // ★ v1.131.0：外科冲刺专用卡（按日 + 主站计时联动；配套仅折叠展示）


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

    /* ★ v1.22.19：渲染合并（防抖）。启动序列（云端拉取落地 6 表 + 身份自愈 + 对齐 +
     *   重复修剪）会连发多次数据写入，每次 emit 都整页重渲染 = 加载头几秒的"渲染风暴"。
     *   数据驱动的重渲染改走 scheduleRender（120ms 合并多次 emit 为一次）；
     *   用户点击类交互仍走同步 render()，操作手感不变。 */
    let _renderTimer = 0;
    function scheduleRender() {
      if (_renderTimer) return;
      _renderTimer = setTimeout(() => { _renderTimer = 0; render(); }, 120);
    }
    Store.subscribeTasks(() => scheduleRender());
    Store.subscribeTimeRecords(() => scheduleRender());
    /* ★ v1.27.8 修复：任务卡「计时中」判定读 active_timer（task_id + status），
     * 但任务页此前不订阅 active_timer——计时页「正↔倒互换」（v1.27.0）或任何会话
     * mode/duration 变化后，任务卡片不重渲染，显示的仍是旧状态（用户报：转换后任务关联"失败"）。
     * 补订阅：会话变化 → scheduleRender（防抖合并，行为与 tasks/time_records 订阅一致）。 */
    if (Store.subscribeActiveTimer) Store.subscribeActiveTimer(() => scheduleRender());
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
      /* ⚠️ v1.41.0：休息段**不带 task_id** → runningId 变 null、elapsed 不再增长，
       *   原来这两个条件都不满足 → 休息开始/结束都不会触发重渲染，
       *   按钮会卡在「休息」而回不到「回到学习」。故把"休息态"也纳入判据。 */
      const resting = (window.Timer && window.Timer.isResting && window.Timer.isResting()) ? 1 : 0;
      if ((runningId || null) !== _lastRenderedRunningId || resting !== _lastRenderedResting) {
        _lastRenderedResting = resting;
        render();   // render() 内部会把基线更新为新值
        return;
      }
      if (runningId && st && st.status === "running") {
        const el = Math.max(0, Math.floor((st.elapsed_sec || 0) + (Date.now() - (st.started_at || Date.now())) / 1000));
        document.querySelectorAll(`[data-live-focus="${runningId}"]`).forEach(node => {
          node.textContent = "计时中 · 已 " + fmtDuration(Math.max(0, el));
        });
      } else if (resting) {
        /* 休息中：让「休息」按钮上的计时可见（正计时往上走） */
        const el = Math.max(0, Math.floor((st ? (st.elapsed_sec || 0) + (Date.now() - (st.started_at || Date.now())) / 1000 : 0)));
        document.querySelectorAll("[data-live-rest]").forEach(node => {
          node.textContent = "休息 " + fmtDuration(el);
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

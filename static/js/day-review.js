/* =====================================================================
 * day-review.js —— 统计页「每日复盘」：4AM 学习日、8 项指标、时间线与 AI 文本复制
 * 依赖：config.js / blocks.js / store.js / today-records.js / day-view.js / ui.js
 * ===================================================================== */
window.DayReview = (function () {
  const C = window.APP_CONFIG;
  const DAY_MS = 24 * 3600 * 1000;
  const FRAGMENT_SEC = 20 * 60;
  const REVIEW_KEY = "kaoyan:review_day";
  let initialized = false;
  let initRetries = 0;
  /* ★ v1.102.0 当前正在看的学习日提到模块级。
   * 以前它是 init() 里的局部 `selected`，而 render() 内部有兜底
   * （非法日期 / 超过今天 → 改回今天）却改不到 `selected` →
   * 出现「界面显示今天、selected 还停在昨天」的状态分叉，
   * 下一次 store 推送把视图又拽回去。提级后 render 兜底的结果能回写，单一真相。 */
  let currentDay = null;

  /* ★ v1.114.0 复盘页时间线的三种视图状态（模块级单一真相）：
   *   reviewView    = "strip"（条形，默认）| "clock"（24H 圆形表盘），持久化到 LS
   *   selectedIdx   = 当前选中的 slot 下标，条状 / 时钟扇区 / 列表行三处共用
   *   currentReview = 最近一次 render 的复盘数据，供事件处理器取 slots（root 重建后仍在）
   * ⚠️ 切换日期必须重置 selectedIdx，否则下标的含义会串到另一天。 */
  const VIEW_KEY = "kaoyan:review_timeline_view";
  let reviewView = "strip";
  let selectedIdx = -1;
  let currentReview = null;
  let renderedDay = null;

  function pad(n) { return String(n).padStart(2, "0"); }
  function cleanText(v) { return String(v == null ? "" : v).replace(/[\r\n|]+/g, " ").trim(); }
  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[c]);
  }
  function fmtDuration(sec) {
    // v1.21.3：统一走 UI.fmtDur（<1 分钟显示"29秒"，不再显示"0分"）
    return window.UI && window.UI.fmtDur ? window.UI.fmtDur(sec) : (Math.max(0, Math.round(Number(sec) || 0)) < 60 ? Math.max(0, Math.round(Number(sec) || 0)) + "秒" : Math.floor(Math.max(0, Math.round(Number(sec) || 0)) / 60) + "分");
  }
  function fmtClock(ms) {
    const d = window.Blocks.beijing(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtShortDate(day) {
    const p = String(day).split("-");
    return p.length === 3 ? `${p[1]}-${p[2]}` : day;
  }
  function categoryMeta(key) {
    return (C.TIME_CATEGORIES || []).find(c => c.key === key) || { key, label: key || "其他", color: "#94a3b8", countTowardGoal: false };
  }

  /* ---------- v1.45.0 通话豁免申报台账 ----------
   * 通话页申请豁免时勾选的「我接受本次豁免留痕并进入每日复盘」此前**没有落地**：
   * 申报只写一个当天计数，复盘页看不到任何申报记录。这里把当天的申报明细读出来。
   * ⚠️ key 必须与 call.js 的 OV_REC_KEY 逐字一致，否则复盘永远是空的。 */
  const OV_REC_KEY = "kaoyan:call_override_records";
  function overrideRecordsOf(dateStr) {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(OV_REC_KEY) || "[]"); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr.filter(r => {
      if (!r || !r.ts) return false;
      /* 学习日归属：凌晨 0–4 点的申报属于**前一天**的学习日，按 bizDateStr 归位，
       * 不能用申报时写的自然日 date 字段（会把凌晨的申报错记到第二天）。 */
      const biz = (window.Blocks && window.Blocks.bizDateStr) ? window.Blocks.bizDateStr(r.ts) : r.date;
      return biz === dateStr;
    });
  }
  function overrideStateOf(r, nowMs) {
    if (r.used) return { txt: `通话 ${Math.round(r.callMin || 0)} 分`, cls: "used" };
    if (r.endedBy === "manual") return { txt: "自行收手，未通话", cls: "manual" };
    if ((r.ts + (r.minutes || 0) * 60000) <= nowMs) return { txt: "到期未用", cls: "expired" };
    return { txt: "生效中", cls: "live" };
  }
  function renderOverrideBlock(dateStr) {
    const rows = overrideRecordsOf(dateStr);
    if (!rows.length) return "";
    const nowMs = Date.now();
    const used = rows.filter(r => r.used).length;
    const items = rows.map(r => {
      const st = overrideStateOf(r, nowMs);
      return `<div class="rv-ov-row ${st.cls}"><span class="rv-ov-t">${fmtClock(r.ts)}</span>` +
        `<b>${escapeHtml(r.type === "necessary" ? "正经时间豁免" : "周额度豁免")}</b>` +
        `<span class="rv-ov-r">${escapeHtml(cleanText(r.reason) || "（未填理由）")}</span>` +
        `<em>${escapeHtml(st.txt)}</em></div>`;
    }).join("");
    return `<div class="rv-section"><h3>通话豁免申报 <small>${rows.length} 次 · 其中 ${used} 次真的通了话</small></h3>` +
      `<div class="rv-ov">${items}</div>` +
      `<div class="hint">豁免理由同时写在对应通话记录的备注里；「自行收手」是自律的正向证据，同样留痕。</div></div>`;
  }
  function countsTowardGoal(r) { return Boolean(categoryMeta(r.category).countTowardGoal); }

  // 任意记录在绝对窗口中的有效秒数；segments 优先，避免暂停时间被算入。
  function overlapDuration(r, startMs, endMs) {
    const seg = window.TodayRecords.segDurSec(r, startMs, endMs);
    if (seg != null) return seg;
    const s = Date.parse(r.started_at), e = Date.parse(r.ended_at);
    if (!isFinite(s) || !isFinite(e) || e <= s) return 0;
    const os = Math.max(s, startMs), oe = Math.min(e, endMs);
    if (oe <= os) return 0;
    const ratio = (oe - os) / (e - s);
    return Math.round(Math.max(0, Number(r.duration_sec) || 0) * ratio);
  }

  function computeReview(dateStr, nowMs) {
    const win = window.Blocks.bizDayWindow(dateStr);
    if (!win) return null;
    nowMs = isFinite(nowMs) ? nowMs : Date.now();
    const effectiveEndMs = Math.max(win.startMs, Math.min(win.endMs, nowMs));
    const records = window.TodayRecords.getBizDayRecords(dateStr);
    const totalSec = records.reduce((sum, r) => sum + (Number(r.duration_sec) || 0), 0);
    const goalRecords = records.filter(countsTowardGoal);
    const studySec = goalRecords.reduce((sum, r) => sum + (Number(r.duration_sec) || 0), 0);
    const goalTargetSec = (parseFloat(C.DAILY_GOAL_HOURS) || 8) * 3600;

    const blockSec = { morning: 0, afternoon: 0, evening: 0 };
    goalRecords.forEach(r => { const key = window.Blocks.blockOf(r.started_at); if (key in blockSec) blockSec[key] += Number(r.duration_sec) || 0; });
    const blockGoals = C.BLOCK_GOAL_HOURS || { morning: 3, afternoon: 2.5, evening: 2.5 };

    const byCat = {};
    records.forEach(r => { byCat[r.category || "other"] = (byCat[r.category || "other"] || 0) + (Number(r.duration_sec) || 0); });
    const categories = Object.keys(byCat).map(key => {
      const meta = categoryMeta(key);
      return { key, label: meta.label, color: meta.color, sec: byCat[key], pct: totalSec ? Math.round(byCat[key] / totalSec * 100) : 0 };
    }).sort((a, b) => b.sec - a.sec);

    const studyRecords = records.filter(r => r.category === "study");
    const longest = studyRecords.reduce((best, r) => !best || (r.duration_sec || 0) > (best.duration_sec || 0) ? r : best, null);
    const fragments = records.filter(r => (Number(r.duration_sec) || 0) > 0 && (Number(r.duration_sec) || 0) < FRAGMENT_SEC);
    const fragmentSec = fragments.reduce((sum, r) => sum + (Number(r.duration_sec) || 0), 0);
    const effectiveCount = records.filter(r => (Number(r.duration_sec) || 0) >= FRAGMENT_SEC).length;

    // 学习日尾部 = 次日北京时间 00:00–04:00，即 start + 20h → end。
    const overtimeStartMs = win.startMs + 20 * 3600 * 1000;
    const overtimeSec = goalRecords.reduce((sum, r) => sum + overlapDuration(r, overtimeStartMs, win.endMs), 0);
    const firstMs = records.length ? Math.min(...records.map(r => Date.parse(r.started_at)).filter(isFinite)) : null;
    const lastMs = records.length ? Math.max(...records.map(r => Date.parse(r.ended_at)).filter(isFinite)) : null;
    const slots = window.DayView.buildWindowSlots(records, win.startMs, effectiveEndMs).slots;

    return {
      dateStr, win, effectiveEndMs, records, slots, totalSec, studySec, goalTargetSec,
      goalPct: goalTargetSec ? Math.round(studySec / goalTargetSec * 100) : 0,
      blockSec, blockGoals, categories, longest, fragments, fragmentSec, effectiveCount,
      fragmentPct: totalSec ? Math.round(fragmentSec / totalSec * 1000) / 10 : 0,
      overtimeSec, firstMs, lastMs, hasOvertime: overtimeSec > 0
    };
  }

  function slotClock(review, sec) { return fmtClock(review.win.startMs + sec * 1000); }
  /* ★ v1.44.0 关联任务后缀：与首页列表、计时页同一口径（都走 TaskPicker.titleOf）。
   *   用户要求「每日复盘也要同步」——以前复盘里完全看不出这条记录挂在哪件事上，
   *   挂错了只能回计时页或者删记录重记。 */
  function taskSuffix(rec) {
    const tid = rec && rec.task_id;
    if (!tid) return "";
    const t = (window.TaskPicker && window.TaskPicker.titleOf) ? window.TaskPicker.titleOf(tid) : "";
    return ` 🔗${t || "已关联任务"}`;
  }
  function recordTitle(slot) {
    if (slot.type === "gap") return "未记录";
    const m = slot.meta || window.DayView.defaultMeta(slot.rec || {});
    const cat = m.isSub && m.parent ? `${m.parent}·${m.label}` : m.label;
    const label = cleanText(slot.rec && slot.rec.label);
    const base = label && label !== m.label ? `${cat}｜${label}` : cat;
    return base + taskSuffix(slot.rec);
  }

  function buildCopyText(review) {
    const longest = review.longest;
    const longestText = longest
      ? `${fmtDuration(longest.duration_sec)}（${fmtClock(Date.parse(longest.started_at))}–${fmtClock(Date.parse(longest.ended_at))} ${cleanText(longest.label || categoryMeta(longest.category).label)}）`
      : "无";
    const blockText = window.Blocks.KEYS.map(key => `${window.Blocks.NAMES[key].replace("块", "")} ${fmtDuration(review.blockSec[key])}/${review.blockGoals[key]}小时`).join("｜");
    const lines = [
      `# 每日复盘 ${review.dateStr}（学习日 04:00 – 次日 04:00）`,
      "", "## 摘要",
      `- 有效学习：${fmtDuration(review.studySec)} / 目标 ${fmtDuration(review.goalTargetSec)}（${review.goalPct}%）`,
      `- 记录 ${review.records.length} 条 · 总记录 ${fmtDuration(review.totalSec)} · 碎片 ${review.fragments.length} 条共 ${fmtDuration(review.fragmentSec)}（${review.fragmentPct}%）`,
      `- 最长单次专注：${longestText}`,
      `- 三块达成：${blockText}`,
      `- 加时学习（00:00–04:00）：${fmtDuration(review.overtimeSec)}｜开始 ${review.firstMs == null ? "无" : fmtClock(review.firstMs)}｜收尾 ${review.lastMs == null ? "无" : fmtClock(review.lastMs)}`,
      "", "## 分类明细", "", "| 分类 | 时长 | 占比 |", "|---|---:|---:|"
    ];
    if (review.categories.length) review.categories.forEach(c => lines.push(`| ${cleanText(c.label)} | ${fmtDuration(c.sec)} | ${c.pct}% |`));
    else lines.push("| 暂无记录 | 0分 | 0% |");
    const ovs = overrideRecordsOf(review.dateStr);
    if (ovs.length) {
      lines.push("", "## 通话豁免申报");
      ovs.forEach(r => lines.push(`- ${fmtClock(r.ts)} ${r.type === "necessary" ? "正经时间豁免" : "周额度豁免"}｜申报 ${r.minutes || 0} 分钟｜${cleanText(r.reason) || "（未填理由）"}｜${overrideStateOf(r, Date.now()).txt}`));
    }
    lines.push("", "## 时间线");
    if (!review.slots.length) lines.push("- 暂无已经发生的时间记录");
    review.slots.forEach(slot => {
      const range = `${slotClock(review, slot.s)}–${slotClock(review, slot.e)}`;
      if (slot.type === "gap") lines.push(`- （未记录）${range}（${fmtDuration(slot.durSec)}）`);
      else {
        const tags = Array.isArray(slot.rec.tags) && slot.rec.tags.length ? ` [${slot.rec.tags.map(cleanText).join(", ")}]` : "";
        const note = cleanText(slot.rec.note) ? `｜备注：${cleanText(slot.rec.note)}` : "";
        lines.push(`- ${range} ${recordTitle(slot)}（${fmtDuration(slot.durSec)}）${tags}${note}`);
      }
    });
    return lines.join("\n");
  }

  function progressRow(label, sec, targetSec, color) {
    const pct = targetSec ? Math.round(sec / targetSec * 100) : 0;
    return `<div class="rv-progress-row"><div class="rv-progress-meta"><b>${escapeHtml(label)}</b><span>${fmtDuration(sec)} / ${fmtDuration(targetSec)} · ${pct}%</span></div><div class="rv-progress"><i style="width:${Math.min(100, pct)}%;background:${color}"></i></div></div>`;
  }

  /* ==================================================================
   * ★ v1.114.0 复盘页「时钟视图」：24H 环形表盘
   *  - 口径与条形时间线**完全一致**：整圈 = 学习日 04:00 → 次日 04:00（86400s），
   *    正上方 = 04:00，顺时针走满 24 小时；slot.s/slot.e 是相对学习日起点的秒数。
   *  - 不用首页的 buildLoveTimeSlots（那是自然日 00:00 起点、只画到 now），
   *    否则复盘页凌晨 0–4 点的记录会跑到表的另一头，与「04:00→次日 04:00」打架。
   *  - 尚未发生的时段铺白底，与灰色「未记录」区分；hint 里另有文案说明。
   *  - 每个彩色扇区带 data-seg，与条状色块 / 列表行共用同一个下标做三处联动。
   * ================================================================== */
  const DIAL = { SIZE: 360, CX: 180, CY: 180, R_DIAL: 160, R_OUT: 145, R_IN: 85, R_NUM: 142, DAY_SEC: 86400 };
  function clockChartSVG(review, selIdx) {
    const { SIZE, CX, CY, R_DIAL, R_OUT, R_IN, R_NUM, DAY_SEC } = DIAL;
    const secA = sec => (sec / DAY_SEC) * 360 - 90;
    const polar = (aDeg, r) => {
      const t = aDeg * Math.PI / 180;
      return { x: CX + r * Math.cos(t), y: CY + r * Math.sin(t) };
    };
    const pieArc = (sSec, eSec, rOuter, rInner) => {
      const a1 = secA(sSec), a2 = secA(eSec);
      const largeArc = (eSec - sSec) > DAY_SEC / 2 ? 1 : 0;
      const p1 = polar(a1, rOuter), p2 = polar(a2, rOuter);
      const p3 = polar(a2, rInner), p4 = polar(a1, rInner);
      return `M ${p1.x} ${p1.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x} ${p4.y} Z`;
    };

    /* 1. 灰底环 = 未记录。整圈都铺，彩色段再叠上去（与首页爱时间式一致）*/
    let svg = `<circle cx="${CX}" cy="${CY}" r="${R_DIAL + 2}" fill="#ffffff"/>` +
      `<circle cx="${CX}" cy="${CY}" r="${(R_OUT + R_IN) / 2}" fill="none" stroke="#e5e7eb" stroke-width="${R_OUT - R_IN}"/>`;

    /* 2. 尚未发生的时段：白底压淡（此刻之前才可能有记录）*/
    const effSec = Math.max(0, Math.min(DAY_SEC, Math.round((review.effectiveEndMs - review.win.startMs) / 1000)));
    if (effSec < DAY_SEC) {
      svg += `<path d="${pieArc(effSec, DAY_SEC, R_OUT, R_IN)}" fill="#ffffff" opacity="0.88" aria-label="尚未发生的时段"/>`;
    }

    /* 3. 彩色扇区 = 一条计时记录（gap 不画，露出灰底）*/
    review.slots.forEach((s, i) => {
      if (s.type !== "rec") return;
      const isSel = i === selIdx;
      svg += `<path data-seg="${i}" class="lt-seg rv-seg ${isSel ? "is-target" : ""}" ` +
        `d="${pieArc(s.s, s.e, R_OUT, R_IN)}" fill="${s.color}" opacity="${isSel ? 1 : 0.9}" ` +
        `stroke="#fff" stroke-width="0.8"><title>${escapeHtml(slotClock(review, s.s) + "–" + slotClock(review, s.e) + " " + recordTitle(s))}</title></path>`;
    });

    /* 4. 刻度：每小时长线 + 每 5 分钟短线 */
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const sec = h * 3600 + m * 60;
        const isHour = m === 0;
        const rIn = isHour ? R_DIAL - 10 : R_DIAL - 4;
        const a = secA(sec);
        const p1 = polar(a, rIn), p2 = polar(a, R_DIAL);
        svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${isHour ? "#475569" : "#cbd5e1"}" stroke-width="${isHour ? 1.5 : 0.6}" stroke-linecap="round"/>`;
      }
    }

    /* 5. 小时数字：正上方是 04（学习日起点），顺时针 05…23,00…03
     *    ⚠️ 标的是**真实北京时间钟点**，不是学习日内的第几小时。 */
    for (let h = 0; h < 24; h++) {
      const p = polar(secA(h * 3600), R_NUM);
      const major = h % 6 === 0;
      svg += `<text x="${p.x}" y="${p.y}" class="lt-hour-num ${major ? "major" : ""}" text-anchor="middle" dominant-baseline="central">${pad((4 + h) % 24)}</text>`;
    }

    /* 6. 中心卡片：选中段优先；未选中给一句可操作的引导 */
    const sel = selIdx >= 0 ? review.slots[selIdx] : null;
    let t1, t2, col, mid, bot;
    if (sel) {
      t1 = `${slotClock(review, sel.s)}~${slotClock(review, sel.e)}`;
      t2 = fmtDuration(sel.durSec);
      col = sel.type === "gap" ? "#9ca3af" : sel.color;
      mid = recordTitle(sel);
      if (mid.length > 13) mid = mid.slice(0, 12) + "…";
    } else {
      t1 = "04:00 → 次日 04:00";
      t2 = `共 ${review.slots.length} 段`;
      col = "#475569";
      mid = "点色块查看该段";
    }
    svg += `<circle cx="${CX}" cy="${CY}" r="${R_IN}" fill="#ffffff"/>` +
      `<text x="${CX}" y="${CY - 18}" class="lt-center-range rv-center-range" text-anchor="middle" fill="${col}">${escapeHtml(t1)}</text>` +
      `<text x="${CX}" y="${CY + 6}" class="lt-center-mid rv-center-mid" text-anchor="middle" fill="${col}">${escapeHtml(mid)}</text>` +
      `<text x="${CX}" y="${CY + 32}" class="lt-center-bot rv-center-bot" text-anchor="middle" fill="${col}">${escapeHtml(t2)}</text>`;

    return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="clock-chart lt-clock rv-clock" role="img" aria-label="学习日 04:00 起点的 24 小时时钟视图">${svg}</svg>`;
  }

  /* 把时钟 SVG 画进容器（root.innerHTML 每次重建后都要重画）*/
  function renderClockChart() {
    const box = document.getElementById("rvClockBox");
    if (!box || !currentReview) return;
    box.innerHTML = clockChartSVG(currentReview, selectedIdx);
    box.querySelectorAll("path[data-seg]").forEach(p => { p.style.cursor = "pointer"; });
  }

  /* 三处高亮同步：条状色块 / 时钟扇区 / 列表行都带同一个 data-seg */
  function applyHighlight(idx) {
    const root = document.getElementById("dayReviewRoot");
    if (!root) return;
    root.querySelectorAll(".is-target[data-seg]").forEach(el => el.classList.remove("is-target"));
    if (idx >= 0) root.querySelectorAll('[data-seg="' + idx + '"]').forEach(el => el.classList.add("is-target"));
  }

  /* 只改中心三行文字，不重建整个 SVG（点色块时避免整表闪一下）*/
  function updateClockCenter(idx) {
    const root = document.getElementById("dayReviewRoot");
    const rv = currentReview;
    if (!root || !rv || !rv.slots[idx]) return;
    const s = rv.slots[idx];
    const col = s.type === "gap" ? "#9ca3af" : s.color;
    let mid = recordTitle(s);
    if (mid.length > 13) mid = mid.slice(0, 12) + "…";
    const vals = [
      [".rv-center-range", `${slotClock(rv, s.s)}~${slotClock(rv, s.e)}`],
      [".rv-center-mid", mid],
      [".rv-center-bot", fmtDuration(s.durSec)]
    ];
    vals.forEach(([sel, txt]) => {
      const el = root.querySelector(sel);
      if (el) { el.textContent = txt; el.setAttribute("fill", col); }
    });
  }

  function applyViewState() {
    const strip = document.getElementById("rvStripWrap");
    const clock = document.getElementById("rvClockWrap");
    if (strip) strip.style.display = reviewView === "strip" ? "" : "none";
    if (clock) clock.style.display = reviewView === "clock" ? "" : "none";
    document.querySelectorAll("[data-rv-view]").forEach(b =>
      b.classList.toggle("active", b.getAttribute("data-rv-view") === reviewView));
    if (reviewView === "clock") renderClockChart();
    applyHighlight(selectedIdx);
  }

  function switchView(v) {
    reviewView = v === "clock" ? "clock" : "strip";
    try { localStorage.setItem(VIEW_KEY, reviewView); } catch (e) {}
    applyViewState();
  }

  /* 点条状色块 / 时钟扇区 → 跳到具体的那条计时任务：
   *   ① 三处同步高亮 + 时钟中心卡片  ② 列表行滚动到位
   *   ③ 记录 → 打开编辑抽屉；未记录 → 打开补记抽屉（与列表行点击完全同一套口径）*/
  function focusSlot(idx) {
    const rv = currentReview;
    idx = Number(idx);
    if (!rv || !isFinite(idx) || !rv.slots[idx]) {
      if (window.UI && window.UI.showAlert) window.UI.showAlert("这一段没有对应的计时记录", 2200);
      return;
    }
    selectedIdx = idx;
    applyHighlight(idx);
    updateClockCenter(idx);
    const row = document.querySelector('#rvLines .rv-line[data-seg="' + idx + '"]');
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    const s = rv.slots[idx];
    if (!window.RecEdit) {
      if (window.UI && window.UI.showAlert) window.UI.showAlert("编辑抽屉未加载，请刷新页面后重试", 2400);
      return;
    }
    if (s.type === "gap") {
      const bw = window.Blocks.bizDayWindow(currentDay);
      if (!bw) {
        if (window.UI && window.UI.showAlert) window.UI.showAlert("这一天的日期无法解析，请用上面的日期框重新选择", 2400);
        return;
      }
      window.RecEdit.openForRange(s.s, s.e, {
        base: "bizday",
        startMs: bw.startMs + s.s * 1000,
        endMs: bw.startMs + s.e * 1000
      });
      return;
    }
    const rid = s.rec && s.rec.id;
    if (!rid) {
      if (window.UI && window.UI.showAlert) window.UI.showAlert("这条记录缺少 id，无法打开编辑", 2400);
      return;
    }
    window.RecEdit.open(rid, { onViewInClock: viewRecordInClock });
  }

  /* 编辑抽屉里的「在时钟中查看」：切到时钟视图 → 选中该记录所在扇区 → 滚到表盘。
   * 与「色块 → 列表行 → 抽屉」构成双向闭环。 */
  function viewRecordInClock(recId) {
    const rv = currentReview;
    const idx = rv ? rv.slots.findIndex(s => s.type === "rec" && s.rec && s.rec.id === recId) : -1;
    if (idx < 0) {
      if (window.UI && window.UI.showAlert) window.UI.showAlert("当前复盘日里找不到这条记录，可能已被删除或换了日期", 2600);
      return;
    }
    selectedIdx = idx;
    switchView("clock");
    const box = document.getElementById("rvClockBox");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderTimeline(review) {
    if (!review.slots.length) return `<div class="legend-empty">这一天还没有已经发生的时间记录 🕊</div>`;
    /* ★ v1.114.0 每个色块都带 data-seg（与时钟扇区、列表行共用下标），
     *   并给键盘用户 role/tabindex —— 点一下就跳到那条计时任务。 */
    const strip = review.slots.map((s, i) => {
      const tip = slotClock(review, s.s) + "–" + slotClock(review, s.e) + " " + recordTitle(s);
      return `<span class="rv-strip-seg ${s.type === "gap" ? "gap" : "rec"}" data-seg="${i}" data-grp="grp-${s.s}" role="button" tabindex="0" style="width:${Math.max(.25, s.durSec / 864)}%;background:${s.color}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}，点击跳转到这条计时任务"></span>`;
    }).join("");
    /* v1.35.0：**取数层已改为逐条裁剪**，每个 slot 就是一条独立记录（旧的并集成员列表已下线）。
     * v1.22.10 曾把重叠并成一个 slot + 成员列表；现由 TodayRecords 直接平铺，
     * 归属明确（重叠段归后开始者），每行带自己的 id，点谁改谁。 */
    const rows = review.slots.map((s, i) => {
      if (s.type === "gap") {
        return `<div class="rv-line editable gap" data-seg="${i}" data-gap-s="${s.s}" data-gap-e="${s.e}" title="点击补记这段时间"><span class="rv-line-time">${slotClock(review,s.s)}–${slotClock(review,s.e)}</span><span class="rv-line-dot" style="background:${s.color}"></span><span class="rv-line-name">未记录</span><span class="rv-line-dur">${fmtDuration(s.durSec)}</span></div>`;
      }
      const meta = categoryMeta(s.rec ? s.rec.category : s.catKey);
      const spanSec = Math.max(0, s.e - s.s);
      const dur = Math.max(0, Math.round(Math.min(Number(s.durSec) || Number(s.rec && s.rec.duration_sec) || spanSec, spanSec)));
      /* 被更晚开始的记录盖掉过重叠段 → 标注裁掉了多少（可点回原区间） */
      const trimmed = (s.rec && s.rec.__trimmed && s.rec.__trimmed_sec)
        ? `<button type="button" class="rv-overlap rv-focus-btn" data-fg="grp-${s.s}" title="原本 ${s.rec.__orig_span ? slotClock(review, Math.round((s.rec.__orig_span.sMs - review.win.startMs)/1000)) : "?"}–${s.rec.__orig_span ? slotClock(review, Math.round((s.rec.__orig_span.eMs - review.win.startMs)/1000)) : "?"}，被更晚开始的记录盖住 ${Math.round(s.rec.__trimmed_sec/60)} 分">已裁掉 ${Math.round(s.rec.__trimmed_sec/60)} 分</button>`
        : "";
      const name = (s.rec && s.rec.label) ? s.rec.label : s.label;
      const taskChip = (s.rec && s.rec.task_id) ? `<span class="rv-line-task" title="关联任务（点本行可修改）">${escapeHtml(taskSuffix(s.rec).trim())}</span>` : "";
      return `<div class="rv-line editable" data-seg="${i}" data-grp="grp-${s.s}" data-edit="${escapeHtml(s.rec && s.rec.id ? s.rec.id : "")}" title="点击修改这条记录"><span class="rv-line-time">${slotClock(review,s.s)}–${slotClock(review,s.e)}</span><span class="rv-line-dot" style="background:${meta.color}"></span><span class="rv-line-name">${escapeHtml(name)}${taskChip}${trimmed}${s.rec && s.rec.note ? `<small>${escapeHtml(cleanText(s.rec.note))}</small>` : ""}</span><span class="rv-line-dur">${fmtDuration(dur)}</span><button type="button" class="rv-del-btn" data-del="${escapeHtml(s.rec && s.rec.id ? s.rec.id : "")}" title="删除这条记录">🗑</button></div>`;
    }).join("");
    return `<div class="rv-view-toggle" role="group" aria-label="时间线展示方式">
        <button type="button" data-rv-view="strip">条形时间线</button>
        <button type="button" data-rv-view="clock">时钟视图</button>
      </div>
      <div class="rv-strip-wrap" id="rvStripWrap"><div class="rv-strip" aria-label="学习日时间分布">${strip}</div></div>
      <div class="rv-clock-wrap" id="rvClockWrap" style="display:none">
        <div class="clock-chart-box rv-clock-box" id="rvClockBox"></div>
        <div class="hint rv-clock-hint">表盘正上方为 04:00，顺时针走满 24 小时；点彩色扇区可跳到那条计时任务。</div>
      </div>
      <div class="rv-lines" id="rvLines">${rows}</div>
      <div class="hint" style="margin-top:8px">💡 点条状色块、时钟扇区或列表行都能进入这条计时记录（分类 / 标签 / 起止时间 / 删除）；点灰色「未记录」时段可补记一段。</div>`;
  }

  function render(dateStr) {
    const root = document.getElementById("dayReviewRoot");
    if (!root) return;
    const today = window.Blocks.bizDateStr();
    if (!window.Blocks.bizDayWindow(dateStr) || dateStr > today) dateStr = today;
    currentDay = dateStr;   // ★ v1.102.0 兜底后的真实生效日回写，避免状态分叉
    try { localStorage.setItem(REVIEW_KEY, dateStr); } catch (e) {}
    const review = computeReview(dateStr);
    const input = document.getElementById("rvDate");
    if (input) { input.value = dateStr; input.max = today; }
    const next = document.getElementById("rvNext");
    if (next) next.disabled = dateStr >= today;
    document.getElementById("rvTitle").textContent = `${fmtShortDate(dateStr)}（04:00 → 次日 04:00）`;

    const longest = review.longest ? `${fmtDuration(review.longest.duration_sec)} · ${fmtClock(Date.parse(review.longest.started_at))}–${fmtClock(Date.parse(review.longest.ended_at))}` : "无记录";
    const boundary = review.firstMs == null ? "无记录" : `${fmtClock(review.firstMs)} → ${fmtClock(review.lastMs)}`;
    root.innerHTML = `
      <div class="rv-summary-grid">
        <div class="rv-kpi primary"><span>有效学习</span><b>${fmtDuration(review.studySec)}</b><small>目标 ${fmtDuration(review.goalTargetSec)} · ${review.goalPct}%</small></div>
        <div class="rv-kpi"><span>最长专注</span><b>${longest}</b><small>${review.longest ? escapeHtml(cleanText(review.longest.label || "学习")) : "暂无学习记录"}</small></div>
        <div class="rv-kpi"><span>碎片时间</span><b>${review.fragments.length} 条 · ${fmtDuration(review.fragmentSec)}</b><small>占总记录 ${review.fragmentPct}% · ≥20分 ${review.effectiveCount} 条</small></div>
        <div class="rv-kpi"><span>加时学习</span><b>${fmtDuration(review.overtimeSec)}</b><small>00:00–04:00 · ${review.hasOvertime ? "有加时" : "无加时"}</small></div>
        <div class="rv-kpi"><span>记录边界</span><b>${boundary}</b><small>首条开始 → 最后收尾，仅呈现事实</small></div>
      </div>
      <div class="rv-section"><h3>目标与三块</h3>${progressRow("全天有效学习", review.studySec, review.goalTargetSec, "#0d9488")}${window.Blocks.KEYS.map(k => progressRow(window.Blocks.NAMES[k], review.blockSec[k], review.blockGoals[k]*3600, window.Blocks.COLORS[k])).join("")}</div>
      <div class="rv-section"><h3>分类占比</h3><div class="cat-breakdown">${review.categories.length ? review.categories.map(c => `<div class="cat-row"><span class="cat-dot" style="background:${c.color}"></span><span class="cat-name">${escapeHtml(c.label)}</span><span class="cat-val">${fmtDuration(c.sec)}</span><span class="cat-pct">${c.pct}%</span></div>`).join("") : `<div class="legend-empty">暂无分类数据 🕊</div>`}</div></div>
      ${renderOverrideBlock(dateStr)}<div class="rv-section"><h3>24 小时时间线 <small>04:00 → 次日 04:00</small></h3>${renderTimeline(review)}${review.effectiveEndMs < review.win.endMs ? `<div class="rv-future">尚未发生的时段不计入“未记录”</div>` : ""}</div>`;
    window.Icon && window.Icon.inject && window.Icon.inject(root);
    root._review = review;
    /* ★ v1.114.0 root.innerHTML 每次重建都会丢掉时钟 SVG 与选中态，
     *   所以 render 之后必须按模块级状态复原（条形/时钟视图 + 三处高亮）。 */
    currentReview = review;
    if (renderedDay !== dateStr) { selectedIdx = -1; renderedDay = dateStr; }
    applyViewState();
  }

  function shiftDay(day, delta) {
    const win = window.Blocks.bizDayWindow(day);
    return win ? window.Blocks.bizDateStr(win.startMs + delta * DAY_MS) : window.Blocks.bizDateStr();
  }
  async function copyCurrent() {
    const root = document.getElementById("dayReviewRoot");
    const review = root && root._review;
    if (!review) return;
    const text = buildCopyText(review);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
      window.UI && window.UI.showAlert("该日复盘已全量复制，可直接发给 AI 分析 ✅", 2500);
    } catch (e) {
      window.UI && window.UI.showAlert("复制失败，请检查浏览器剪贴板权限", 2500);
    }
  }
  function init() {
    if (initialized) return;
    if (!document.getElementById("dayReviewRoot")) return;
    if (!window.Blocks || !window.Store || !window.TodayRecords || !window.DayView) {
      if (initRetries++ < 20) setTimeout(init, 100);
      return;
    }
    initialized = true;
    /* ★ v1.102.0 每个处理器里现算 today，不再用 init 那一刻的快照。
     * 页面常驻过 04:00 后，旧快照会让「今天」被当成未来日期顶回去。 */
    currentDay = window.Blocks.bizDateStr();
    try {
      const saved = localStorage.getItem(REVIEW_KEY);
      if (saved && saved <= currentDay && window.Blocks.bizDayWindow(saved)) currentDay = saved;
      reviewView = localStorage.getItem(VIEW_KEY) === "clock" ? "clock" : "strip";
    } catch (e) { reviewView = "strip"; }
    document.getElementById("rvPrev").addEventListener("click", () => { currentDay = shiftDay(currentDay, -1); render(currentDay); });
    document.getElementById("rvNext").addEventListener("click", () => { const t = window.Blocks.bizDateStr(); if (currentDay < t) { currentDay = shiftDay(currentDay, 1); render(currentDay); } });
    document.getElementById("rvToday").addEventListener("click", () => { currentDay = window.Blocks.bizDateStr(); render(currentDay); });
    document.getElementById("rvDate").addEventListener("change", e => { const t = window.Blocks.bizDateStr(); if (e.target.value) { currentDay = e.target.value > t ? t : e.target.value; render(currentDay); } });
    document.getElementById("rvCopy").addEventListener("click", copyCurrent);
    window.Store.subscribeTimeRecords(() => render(currentDay));
    /* v1.22.9：点复盘里的记录行 → 共用的记录编辑抽屉（往日记录的修改入口）
     * 事件委托在容器上，重渲染后依然有效（行是每次 render 重建的） */
    const root = document.getElementById("dayReviewRoot");
    if (root) {
      if (window.RecEdit) window.RecEdit.bind();
      root.addEventListener("click", (e) => {
        /* ★ 聚焦开关：点裁剪提示 → 只保留该行，其它淡出；再点还原 */
        const fbtn = e.target.closest(".rv-focus-btn");
        if (fbtn) {
          const grp = fbtn.getAttribute("data-fg");
          const already = root.classList.contains("focus-grp") && root.getAttribute("data-active-grp") === grp;
          if (already) {
            root.classList.remove("focus-grp");
            root.removeAttribute("data-active-grp");
            root.querySelectorAll(".rv-line.dimmed").forEach(l => l.classList.remove("dimmed"));
            fbtn.textContent = fbtn.textContent.replace("· 取消聚焦", "· 聚焦");
          } else {
            root.setAttribute("data-active-grp", grp);
            root.classList.add("focus-grp");
            root.querySelectorAll(".rv-line").forEach(l => {
              l.classList.toggle("dimmed", l.getAttribute("data-grp") !== grp);
            });
            root.querySelectorAll(".rv-focus-btn").forEach(b => { if (b !== fbtn) b.textContent = b.textContent.replace("· 取消聚焦", "· 聚焦"); });
            fbtn.textContent = fbtn.textContent.replace("· 聚焦", "· 取消聚焦");
          }
          return;
        }
        /* ★ v1.28.3 成员行悬浮删除钮 */
        const delBtn = e.target.closest(".rv-del-btn");
        if (delBtn) {
          const rid = delBtn.getAttribute("data-del");
          if (rid && confirm("确定删除这条记录吗？删除后相关统计自动扣减。")) {
            if (window.Store) Store.deleteTimeRecord(rid);
          }
          return;
        }
        const line = e.target.closest(".rv-line");
        if (!line || !window.RecEdit) return;
        const recId = line.getAttribute("data-edit");
        if (recId) {
          // ★ v1.114.0 复盘页已有自己的时钟视图 → 接上「在时钟中查看」闭环
          window.RecEdit.open(recId, { onViewInClock: viewRecordInClock });
          return;
        }
        const gs = line.getAttribute("data-gap-s"), ge = line.getAttribute("data-gap-e");
        if (gs !== null && ge !== null) {
          /* ★ v1.102.0 撤掉「往日先切回今天」的守卫（用户 2026-10-28 报：
           * 点 10-27 的 04:00–20:06「未记录」被硬拽回今天，抽屉根本不开，无法补记）。
           * 那句 "补记抽屉的时段是今天" 的理由早已不成立 —— openForRange 自 v1.35
           * 就支持传绝对毫秒，而**紧接着下面这几行自己传的就是
           * bizDayWindow(选中日).startMs + 秒**，抽屉里显示、保存的就是那一日的真实时刻。
           * 守卫与它下面的实现自相矛盾，属历史残留：删掉后往日/跨午夜空白段都能直接补记。 */
          /* ⚠️ 2026-10-07 修复（4 小时错位）：这里的 s/e 来自 buildWindowSlots，
           * 基准是**学习日 04:00**（见 win.startMs），而 RecEdit.openForRange 默认按
           * **本地零点** 解释 → 补记抽屉整体早了 4 小时，并连带触发假的「重叠」提示。
           * 对策：直接传当前学习日的绝对毫秒窗口（base 唯一、零歧义）。 */
          const bw = window.Blocks.bizDayWindow(currentDay);
          if (!bw) {   // 铁律：拦截分支不许静默
            if (window.UI && window.UI.showAlert) window.UI.showAlert("这一天的日期无法解析，请用上面的日期框重新选择", 2400);
            return;
          }
          window.RecEdit.openForRange(Number(gs), Number(ge), {
            base: "bizday",
            startMs: bw.startMs + Number(gs) * 1000,
            endMs: bw.startMs + Number(ge) * 1000
          });
        }
      });
      /* ★ v1.114.0 条状色块 / 时钟扇区 / 视图切换的独立委托。
       *   刻意不塞进上面那个 handler：老护栏 verify-review-pastday-v1102 靠
       *   gap 分支起始处往后 1200 字符做源码断言，插在中间会把断言窗口挤乱。 */
      root.addEventListener("click", (e) => {
        const vbtn = e.target.closest("[data-rv-view]");
        if (vbtn) { switchView(vbtn.getAttribute("data-rv-view")); return; }
        const seg = e.target.closest("[data-seg]");
        if (!seg) return;
        /* 列表行由上面的 handler 负责开抽屉，这里只同步三处高亮 */
        if (seg.classList.contains("rv-line")) { applyHighlight(Number(seg.getAttribute("data-seg"))); return; }
        focusSlot(seg.getAttribute("data-seg"));
      });
      root.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const seg = e.target.closest(".rv-strip-seg[data-seg]");
        if (!seg) return;
        e.preventDefault();
        focusSlot(seg.getAttribute("data-seg"));
      });
    }
    try {
      render(currentDay);
    } catch (err) {
      initialized = false;
      const root = document.getElementById("dayReviewRoot");
      if (root) root.innerHTML = `<div class="rv-error">每日复盘加载失败，请刷新后重试。<small>${escapeHtml(err && err.message)}</small></div>`;
      console.error("[day-review] init failed", err);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  setTimeout(init, 0);

  /* clockChartSVG / renderTimeline / focusSlot 一并导出：护栏要真跑渲染出口，
   * 不能只靠「源码里有没有这行字」（历史上被自己的说明注释骗过三次）。 */
  return { init, render, computeReview, buildCopyText, fmtDuration,
    clockChartSVG, renderTimeline, focusSlot };
})();

/* =====================================================================
 * day-review.js —— 统计页「每日复盘」：4AM 业务日、8 项指标、时间线与 AI 文本复制
 * 依赖：config.js / blocks.js / store.js / today-records.js / day-view.js / ui.js
 * ===================================================================== */
window.DayReview = (function () {
  const C = window.APP_CONFIG;
  const DAY_MS = 24 * 3600 * 1000;
  const FRAGMENT_SEC = 20 * 60;
  const REVIEW_KEY = "kaoyan:review_day";
  let initialized = false;
  let initRetries = 0;

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

    // 业务日尾部 = 次日北京时间 00:00–04:00，即 start + 20h → end。
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
  function recordTitle(slot) {
    if (slot.type === "gap") return "未记录";
    const m = slot.meta || window.DayView.defaultMeta(slot.rec || {});
    const cat = m.isSub && m.parent ? `${m.parent}·${m.label}` : m.label;
    const label = cleanText(slot.rec && slot.rec.label);
    return label && label !== m.label ? `${cat}｜${label}` : cat;
  }

  function buildCopyText(review) {
    const longest = review.longest;
    const longestText = longest
      ? `${fmtDuration(longest.duration_sec)}（${fmtClock(Date.parse(longest.started_at))}–${fmtClock(Date.parse(longest.ended_at))} ${cleanText(longest.label || categoryMeta(longest.category).label)}）`
      : "无";
    const blockText = window.Blocks.KEYS.map(key => `${window.Blocks.NAMES[key].replace("块", "")} ${fmtDuration(review.blockSec[key])}/${review.blockGoals[key]}小时`).join("｜");
    const lines = [
      `# 每日复盘 ${review.dateStr}（业务日 04:00 – 次日 04:00）`,
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
  function renderTimeline(review) {
    if (!review.slots.length) return `<div class="legend-empty">这一天还没有已经发生的时间记录 🕊</div>`;
    const strip = review.slots.map(s => `<span class="${s.type === "gap" ? "gap" : "rec"}" style="width:${Math.max(.25, s.durSec / 864)}%;background:${s.color}" title="${escapeHtml(slotClock(review,s.s)+"–"+slotClock(review,s.e)+" "+recordTitle(s))}"></span>`).join("");
    /* v1.22.10：**每条记录一行**（重叠时段并成一个 slot，但组内成员各自成行）。
     * 起因（用户报）：两条相接/重叠的记录被并成一行后，后一条在界面上不存在 →
     * 想改它却"没有效果"。现在每行都带自己的 id，点谁改谁。 */
    const rows = review.slots.map(s => {
      if (s.type === "gap") {
        return `<div class="rv-line editable gap" data-gap-s="${s.s}" data-gap-e="${s.e}" title="点击补记这段时间"><span class="rv-line-time">${slotClock(review,s.s)}–${slotClock(review,s.e)}</span><span class="rv-line-dot" style="background:${s.color}"></span><span class="rv-line-name">未记录</span><span class="rv-line-dur">${fmtDuration(s.durSec)}</span></div>`;
      }
      /* 并集成员：取数层（TodayRecords）在合并重叠记录时保留了 __parts，
       * 每条 = { sMs, eMs, durSec, raw }；没有则就是这一条自己。 */
      const parts = (s.rec && Array.isArray(s.rec.__parts) && s.rec.__parts.length) ? s.rec.__parts : null;
      const members = parts
        ? parts.map(p => ({
            s: Math.round((p.sMs - review.win.startMs) / 1000),
            e: Math.round((p.eMs - review.win.startMs) / 1000),
            rec: p.raw, durSec: p.durSec
          }))
        : ((s.members && s.members.length) ? s.members : [{ s: s.s, e: s.e, rec: s.rec, durSec: s.durSec }]);
      return members.map((m, mi) => {
        const meta = categoryMeta(m.rec ? m.rec.category : s.catKey);
        const spanSec = Math.max(0, m.e - m.s);
        const dur = Math.max(0, Math.round(Math.min(Number(m.durSec) || Number(m.rec && m.rec.duration_sec) || spanSec, spanSec)));
        const overlap = (mi === 0 && members.length > 1)
          ? `<span class="rv-overlap" title="这一段时间有 ${members.length} 条记录重叠，统计按并集不重复计算">${members.length} 条重叠</span>` : "";
        const name = (m.rec && m.rec.label) ? m.rec.label : s.label;
        return `<div class="rv-line editable" data-edit="${escapeHtml(m.rec && m.rec.id ? m.rec.id : "")}" title="点击修改这条记录"><span class="rv-line-time">${slotClock(review,m.s)}–${slotClock(review,m.e)}</span><span class="rv-line-dot" style="background:${meta.color}"></span><span class="rv-line-name">${escapeHtml(name)}${overlap}${m.rec && m.rec.note ? `<small>${escapeHtml(cleanText(m.rec.note))}</small>` : ""}</span><span class="rv-line-dur">${fmtDuration(dur)}</span></div>`;
      }).join("");
    }).join("");
    return `<div class="rv-strip" aria-label="业务日时间分布">${strip}</div><div class="rv-lines" id="rvLines">${rows}</div>
      <div class="hint" style="margin-top:8px">💡 点任意一条记录即可修改（分类 / 标签 / 起止时间 / 删除）；点灰色「未记录」时段可补记一段。</div>`;
  }

  function render(dateStr) {
    const root = document.getElementById("dayReviewRoot");
    if (!root) return;
    const today = window.Blocks.bizDateStr();
    if (!window.Blocks.bizDayWindow(dateStr) || dateStr > today) dateStr = today;
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
      <div class="rv-section"><h3>24 小时时间线 <small>04:00 → 次日 04:00</small></h3>${renderTimeline(review)}${review.effectiveEndMs < review.win.endMs ? `<div class="rv-future">尚未发生的时段不计入“未记录”</div>` : ""}</div>`;
    window.Icon && window.Icon.inject && window.Icon.inject(root);
    root._review = review;
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
    const today = window.Blocks.bizDateStr();
    let selected = today;
    try { const saved = localStorage.getItem(REVIEW_KEY); if (saved && saved <= today && window.Blocks.bizDayWindow(saved)) selected = saved; } catch (e) {}
    document.getElementById("rvPrev").addEventListener("click", () => { selected = shiftDay(selected, -1); render(selected); });
    document.getElementById("rvNext").addEventListener("click", () => { if (selected < today) { selected = shiftDay(selected, 1); render(selected); } });
    document.getElementById("rvToday").addEventListener("click", () => { selected = today; render(selected); });
    document.getElementById("rvDate").addEventListener("change", e => { if (e.target.value) { selected = e.target.value > today ? today : e.target.value; render(selected); } });
    document.getElementById("rvCopy").addEventListener("click", copyCurrent);
    window.Store.subscribeTimeRecords(() => render(selected));
    /* v1.22.9：点复盘里的记录行 → 共用的记录编辑抽屉（往日记录的修改入口）
     * 事件委托在容器上，重渲染后依然有效（行是每次 render 重建的） */
    const root = document.getElementById("dayReviewRoot");
    if (root) {
      if (window.RecEdit) window.RecEdit.bind();
      root.addEventListener("click", (e) => {
        const line = e.target.closest(".rv-line");
        if (!line || !window.RecEdit) return;
        const recId = line.getAttribute("data-edit");
        if (recId) {
          window.RecEdit.open(recId, {});   // 复盘页没有时钟视图 → 不传 onViewInClock（按钮自动隐藏）
          return;
        }
        const gs = line.getAttribute("data-gap-s"), ge = line.getAttribute("data-gap-e");
        if (gs !== null && ge !== null) {
          // 复盘页可能在看往日 → 先切回今天再补记（补记抽屉的时段是"今天"的秒数）
          const t = window.Blocks.bizDateStr();
          if (selected !== t) {
            selected = t;
            render(selected);
            if (window.UI && window.UI.showAlert) window.UI.showAlert("补记按「今天」的时刻来填，已切回今天", 2400);
            return;
          }
          window.RecEdit.openForRange(Number(gs), Number(ge), {});
        }
      });
    }
    try {
      render(selected);
    } catch (err) {
      initialized = false;
      const root = document.getElementById("dayReviewRoot");
      if (root) root.innerHTML = `<div class="rv-error">每日复盘加载失败，请刷新后重试。<small>${escapeHtml(err && err.message)}</small></div>`;
      console.error("[day-review] init failed", err);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  setTimeout(init, 0);

  return { init, render, computeReview, buildCopyText, fmtDuration };
})();

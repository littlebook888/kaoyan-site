/* stats.js —— 统计：核心数据、学霸指数、学习热力图、CSV 导出
 * 数据源：time_records（时间记录系统 = 主线）
 * 学习时长 = category === "study" 的所有记录
 */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;

  function isSameDay(d1, d2) { return new Date(d1).toDateString() === new Date(d2).toDateString(); }
  function startOfWeek(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setHours(0,0,0,0); x.setDate(x.getDate() - day); return x; }

  function compute() {
    const all = Store.getTimeRecords();
    // 去重
    const seen = new Set();
    const records = all.filter(r => r.category === "study" && r.id && !seen.has(r.id) && seen.add(r.id));
    const now = new Date();
    const weekStart = startOfWeek(now);
    let today = 0, week = 0, total = 0;
    records.forEach(r => {
      const sec = r.duration_sec || 0;
      total += sec;
      // 今日：started_at 和 ended_at 都在今天
      if (r.ended_at && isSameDay(r.ended_at, now) && r.started_at && isSameDay(r.started_at, now)) today += sec;
      if (r.ended_at && new Date(r.ended_at) >= weekStart) week += sec;
    });
    return { today: today/3600, week: week/3600, total: total/3600, count: records.length };
  }

  function geniusLevel(pct) {
    if (pct >= 100) return "封神学霸 🏆";
    if (pct >= 80) return "学霸在线 🔥";
    if (pct >= 50) return "稳步前进 💪";
    if (pct >= 25) return "渐入佳境 🌿";
    return "学渣起步 🌱";
  }

  function render() {
    const d = compute();
    document.getElementById("sToday").textContent = d.today.toFixed(1);
    document.getElementById("sWeek").textContent = d.week.toFixed(1);
    document.getElementById("sTotal").textContent = d.total.toFixed(1);
    document.getElementById("sCount").textContent = d.count;

    const goal = parseFloat(C.DAILY_GOAL_HOURS) || 8;
    const pct = Math.min(100, Math.round((d.today / goal) * 100));
    const ring = document.getElementById("geniusRing");
    ring.style.setProperty("--p", pct);
    document.getElementById("geniusVal").textContent = pct + "%";
    document.getElementById("geniusLabel").textContent = geniusLevel(pct);

    renderHeat();
    renderCatBreakdown();
    renderTaskStats();
    renderFocusStat();
  }

  function renderHeat() {
    const box = document.getElementById("heat");
    if (!box) return;
    const records = Store.getTimeRecords().filter(r => r.category === "study");
    const map = {};
    records.forEach(r => {
      if (!r.ended_at) return;
      const key = new Date(r.ended_at).toDateString();
      map[key] = (map[key] || 0) + (r.duration_sec || 0);
    });
    let html = "";
    for (let i = 69; i >= 0; i--) {
      const day = new Date(); day.setDate(day.getDate() - i);
      const sec = map[day.toDateString()] || 0;
      const h = sec / 3600;
      let lvl = 0;
      if (h >= 8) lvl = 4; else if (h >= 5) lvl = 3; else if (h >= 2) lvl = 2; else if (h > 0) lvl = 1;
      html += `<div class="cell l${lvl}" title="${day.getMonth()+1}/${day.getDate()} · ${h.toFixed(1)}h"></div>`;
    }
    box.innerHTML = html;
  }

  /* 分类明细（今日各分类时长） */
  function renderCatBreakdown() {
    const box = document.getElementById("catBreakdown");
    if (!box) return;
    const records = Store.getTimeRecords();
    const now = new Date();
    const today = records.filter(r => r.ended_at && isSameDay(r.ended_at, now));

    const byCat = {};
    let total = 0;
    today.forEach(r => {
      byCat[r.category] = (byCat[r.category] || 0) + (r.duration_sec || 0);
      total += (r.duration_sec || 0);
    });

    const cats = C.TIME_CATEGORIES || [];
    const rows = cats.map(c => {
      const sec = byCat[c.key] || 0;
      const pct = total > 0 ? Math.round((sec / total) * 100) : 0;
      return { ...c, sec, pct };
    }).filter(r => r.sec > 0 || r.key === "study");

    if (total === 0) {
      box.innerHTML = `<div class="legend-empty">今天还没有时间记录 🕊</div>`;
      return;
    }

    box.innerHTML = rows.map(r => `
      <div class="cat-row">
        <span class="cat-dot" style="background:${r.color}"></span>
        <span class="cat-name">${r.label}</span>
        <span class="cat-val">${(r.sec/3600).toFixed(1)}h</span>
        <span class="cat-pct">${r.pct}%</span>
      </div>
    `).join("");
  }

  function exportCsv() {
    const records = Store.getTimeRecords();
    const header = "id,category,sub_category,label,tags,started_at,ended_at,duration_sec,source,block,note\n";
    const rows = records.map(r =>
      [r.id, r.category, r.sub_category || "", (r.label||"").replace(/,/g," "),
       (r.tags || []).join(";"), r.started_at, r.ended_at,
       r.duration_sec, r.source, r.block || "", (r.note||"").replace(/,/g," ")].join(",")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kaoyan_time_records_" + new Date().toISOString().slice(0,10) + ".csv";
    a.click();
    window.UI.showAlert("已导出时间记录 CSV ✅", 2500);
  }

  /* ---- 任务汇总报表 ---- */
  function fmtHms(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h}h${String(m).padStart(2,"0")}m`;
    if (m > 0) return `${m}分${String(s).padStart(2,"0")}秒`;
    return `${s}秒`;
  }
  // 任务 date 形如 "Wed Aug 26 2026" → YYYY-MM-DD；统一比较用
  function taskDateKey(t) {
    if (!t || !t.date) return "";
    const d = new Date(t.date);
    if (isNaN(d.getTime())) return String(t.date).slice(0,10);
    return [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"), String(d.getDate()).padStart(2,"0")].join("-");
  }
  function subjLabel(subject) {
    const m = { xizong:"西综", english:"英语", politics:"政治", study:"学习", other:"其他" };
    return m[subject] || subject || "其他";
  }
  function typeLabel(task_type) {
    const m = { course:"看课", review:"复习", problem:"刷题", other:"其他" };
    return m[task_type] || task_type || "其他";
  }
  function renderTaskStats() {
    const box = document.getElementById("taskStatList");
    if (!box) return;
    const fromEl = document.getElementById("taskRangeFrom");
    const toEl = document.getElementById("taskRangeTo");
    const from = fromEl.value ? fromEl.value : "0000-00-00";
    const to = toEl.value ? toEl.value : "9999-99-99";
    const tasks = Store.getTasks()
      .filter(t => { const k = taskDateKey(t); return k >= from && k <= to; })
      .sort((a,b) => { const ka = taskDateKey(a)+String(a.ref_id||""); const kb = taskDateKey(b)+String(b.ref_id||""); return ka < kb ? -1 : ka > kb ? 1 : 0; });

    if (!tasks.length) { box.innerHTML = `<div class="legend-empty">该日期范围内暂无任务 🕊</div>`; return; }

    let totalSec = 0, doneCount = 0;
    tasks.forEach(t => { totalSec += (t.total_focus_sec||0); if (t.done) doneCount++; });
    const donePct = tasks.length ? Math.round((doneCount/tasks.length)*100) : 0;

    let html = `<div class="ts-summary">
        <span>共 <b>${tasks.length}</b> 项</span>
        <span>专注 <b>${fmtHms(totalSec)}</b></span>
        <span>完成 <b>${doneCount}</b> 项 (${donePct}%)</span>
      </div>
      <div class="ts-table">
        <div class="ts-row ts-head">
          <span>日期</span><span>ID</span><span>科目/类</span><span>任务</span><span>专注</span><span>状态</span>
        </div>`;

    tasks.forEach(t => {
      const sec = t.total_focus_sec || 0;
      const status = t.done ? "✅" : (sec>0 ? "⏸进行中" : "⬜未开始");
      const ref = (t.ref_id || "").replace(/^/ ,"");
      // 标题去掉前端冗余前缀，方便阅读
      let title = t.title || "";
      title = title.replace(/^(听课|复习|滚动复习|刷题)：?/, "");
      if (title.length > 26) title = title.slice(0,26) + "…";
      const dk = taskDateKey(t);
      html += `<div class="ts-row">
        <span class="ts-date">${dk.replace(/-/g,"/")}</span>
        <span class="ts-ref" title="${t.ref_id || ""}">${escapeStat(ref)}</span>
        <span>${subjLabel(t.subject)}·${typeLabel(t.task_type)}</span>
        <span class="ts-title" title="${escapeStat(t.title || "")}">${escapeStat(title)}</span>
        <span class="ts-time">${fmtHms(sec)}</span>
        <span>${status}</span>
      </div>`;
    });
    html += `</div>`;
    box.innerHTML = html;
  }
  function escapeStat(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" })[c]); }
  function exportTaskCsv() {
    const fromEl = document.getElementById("taskRangeFrom");
    const toEl = document.getElementById("taskRangeTo");
    const from = fromEl.value ? fromEl.value : "0000-00-00";
    const to = toEl.value ? toEl.value : "9999-99-99";
    const tasks = Store.getTasks().filter(t => { const k = taskDateKey(t); return k >= from && k <= to; })
      .sort((a,b)=>taskDateKey(a).localeCompare(taskDateKey(b)) || String(a.ref_id||"").localeCompare(String(b.ref_id||"")));
    const header = "ref_id,date,subject,task_type,title,status,estimated_min,focus_sec,done,note\n";
    const esc = v => String(v==null?"":v).replace(/,/g," ").replace(/\n/g," ");
    const rows = tasks.map(t => [t.ref_id||"", taskDateKey(t), t.subject, t.task_type,
      esc(t.title), t.status||(t.done?"done":"todo"), t.estimated_min??"", t.total_focus_sec||0,
      t.done?1:0, esc(t.completed_note||"")].join(","));
    const blob = new Blob(["\ufeff"+header+rows.join("\n")], { type:"text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kaoyan_tasks_" + new Date().toISOString().slice(0,10) + ".csv";
    a.click();
    window.UI.showAlert("已导出任务 CSV ✅", 2500);
  }

  /* 进入学习状态统计（独立二级标签 enter_state，source=focus_entry） */
  function renderFocusStat() {
    const box = document.getElementById("focusStat");
    if (!box) return;
    const now = new Date();
    const entries = Store.getTimeRecords().filter(r =>
      r.sub_category === "enter_state" || r.source === "focus_entry" || (r.category === "study" && r.label && r.label.includes("进入学习状态")));
    const today = entries.filter(r => r.ended_at && isSameDay(r.ended_at, now)).length;
    const todaySec = entries.filter(r => r.ended_at && isSameDay(r.ended_at, now)).reduce((s, r) => s + (r.duration_sec || 0), 0);
    const totalSec = entries.reduce((s, r) => s + (r.duration_sec || 0), 0);

    box.innerHTML = `
      <div class="stat-grid">
        <div class="stat-box"><div class="num">${entries.length}</div><div class="lbl">累计进入(次)</div></div>
        <div class="stat-box"><div class="num">${today}</div><div class="lbl">今日进入(次)</div></div>
        <div class="stat-box"><div class="num">${fmtHms(totalSec)}</div><div class="lbl">累计耗时</div></div>
        <div class="stat-box"><div class="num">${fmtHms(todaySec)}</div><div class="lbl">今日耗时</div></div>
      </div>`;
  }

  function init() {
    document.getElementById("exportCsv").addEventListener("click", exportCsv);
    const exportTaskCsvEl = document.getElementById("exportTaskCsv");
    if (exportTaskCsvEl) exportTaskCsvEl.addEventListener("click", exportTaskCsv);
    // 任务报表默认范围：本月
    const now = new Date();
    const fromEl = document.getElementById("taskRangeFrom");
    const toEl = document.getElementById("taskRangeTo");
    if (fromEl) fromEl.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
    if (toEl) toEl.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    [fromEl, toEl].forEach(el => { if (el) el.addEventListener("change", renderTaskStats); });
    Store.subscribeTimeRecords(() => render());
    Store.subscribeSessions(() => render());
    if (Store.isCloud && Store.isCloud()) Store.pullOnce();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();

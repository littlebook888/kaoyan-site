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
    const records = Store.getTimeRecords().filter(r => r.category === "study");
    const now = new Date();
    const weekStart = startOfWeek(now);
    let today = 0, week = 0, total = 0;
    records.forEach(r => {
      const sec = r.duration_sec || 0;
      total += sec;
      if (r.ended_at && isSameDay(r.ended_at, now)) today += sec;
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

  function init() {
    document.getElementById("exportCsv").addEventListener("click", exportCsv);
    Store.subscribeTimeRecords(() => render());
    // 兼容旧表
    Store.subscribeSessions(() => render());
    if (Store.isCloud && Store.isCloud()) Store.pullOnce();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();

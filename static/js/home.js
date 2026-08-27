/* home.js —— 首页逻辑
 * 三套系统：
 *   1. 时间记录系统（主线）：time_records → 饼图 / 时间轴 / 学习进度
 *   2. 计时器系统：正计/倒计 → 写入 time_records
 *   3. 三块系统：仅展示 + 「开始吃饭」按钮 → 写入 meal 类 time_record
 */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;
  const Blocks = window.Blocks;

  let todayView = "donut"; // donut | timeline | clock
  let clockTimer = null;

  function daysBetween(a, b) {
    const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
    return Math.ceil(ms / 86400000);
  }
  function isSameDay(d1, d2) {
    return Blocks.dateStr(d1) === Blocks.dateStr(d2);
  }
  function fmtH(sec) { return (sec / 3600).toFixed(1); }
  function fmtM(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    if (m >= 60) {
      const h = Math.floor(m / 60), mm = m % 60;
      return `${h}h${mm}m`;
    }
    return `${m}m${s}s`;
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }

  // 分类元数据
  function catMeta(key) {
    const list = C.TIME_CATEGORIES || [];
    return list.find(c => c.key === key) || { label: key, color: "#999", icon: "layers" };
  }

  /* 二级分类聚合元数据：对标时间日志「无限级分类」下钻
   * 有 subs 的一级分类 → 取二级的 label/color（西综/英语/政治各自独立）
   * 无 subs 或 sub_category 缺失 → 回退到一级分类
   * 这是饼图/时钟/时间轴/列表能区分「西综 vs 英语 vs 政治」的关键 */
  function segMeta(r) {
    const cats = C.TIME_CATEGORIES || [];
    const cat = cats.find(c => c.key === r.category);
    if (cat && cat.subs && cat.subs.length && r.sub_category) {
      const sub = cat.subs.find(s => s.key === r.sub_category);
      if (sub) return { key: r.sub_category, label: sub.label, color: sub.color, parent: cat.label, isSub: true, catKey: r.category };
    }
    if (cat) return { key: r.category, label: cat.label, color: cat.color, parent: null, isSub: false, catKey: r.category };
    return { key: r.category || "other", label: r.label || (r.category || "其他"), color: "#94a3b8", parent: null, isSub: false, catKey: r.category };
  }

  function renderCountdown() {
    const el = document.getElementById("examDays");
    const sub = document.getElementById("examDate");
    const d = daysBetween(new Date(), C.EXAM_DATE);
    el.textContent = d >= 0 ? d + " 天" : "已开考";
    sub.textContent = "初试日：" + C.EXAM_DATE + (d >= 0 ? " · 加油！" : "");
  }

  /* SVG 环形饼图（细环 + 起点置顶 + 平滑过渡 + 悬浮联动） */
  function donutSVG(segments, centerText, centerSub) {
    const R = 15.9155;
    const total = segments.reduce((a, s) => a + s.value, 0);
    let cum = 0;
    const arcs = segments.map(s => {
      const pct = total > 0 ? (s.value / total) * 100 : 0;
      const dash = `${pct.toFixed(3)} ${(100 - pct).toFixed(3)}`;
      const off = 100 - cum;
      cum += pct;
      return `<circle class="donut-seg" data-key="${s.key}" cx="21" cy="21" r="${R}" fill="none" stroke="${s.color}" stroke-width="4.4" stroke-dasharray="${dash}" stroke-dashoffset="${off}"><title>${s.label} ${fmtH(s.value)}h</title></circle>`;
    }).join("");
    return `<svg viewBox="0 0 42 42" class="donut" role="img" aria-label="今日时间安排饼图">
      <g transform="rotate(-90 21 21)">
        <circle cx="21" cy="21" r="${R}" fill="none" stroke="#eef2f7" stroke-width="4.4"/>
        ${arcs}
      </g>
      <text x="21" y="20.5" class="donut-val" text-anchor="middle">${centerText}</text>
      <text x="21" y="25.5" class="donut-sub" text-anchor="middle">${centerSub}</text>
    </svg>`;
  }

  /* 今日三块：按三餐切分的大块学习概览 */
  function renderBlocks() {
    const wrap = document.getElementById("blockCards");
    if (!wrap) return;
    const now = new Date();
    const curKey = Blocks.currentKey(now);
    const records = Store.getTimeRecords();
    // 去重（防止同步产生重复记录）+ 按开始/结束时间都在今天筛选
    const seenIds = new Set();
    const today = records.filter(r => {
      if (!r.ended_at) return false;
      if (seenIds.has(r.id)) return false; // 去重
      seenIds.add(r.id);
      // ended_at 今天 AND started_at 也是今天（排除跨天超长记录）
      if (!isSameDay(r.ended_at, now)) return false;
      if (r.started_at && !isSameDay(r.started_at, now)) return false;
      return true;
    });

    // 每段学习按「开始时间」归类到所属大块
    const secByBlock = { morning: 0, afternoon: 0, evening: 0 };
    today.forEach(r => {
      if (r.category !== "study") return;
      const start = r.started_at ? new Date(r.started_at) : new Date(r.ended_at);
      const key = Blocks.blockOf(start);
      secByBlock[key] = (secByBlock[key] || 0) + (r.duration_sec || 0);
    });

    wrap.innerHTML = Blocks.KEYS.map(key => {
      const name = Blocks.NAMES[key];
      const color = Blocks.COLORS[key];
      const win = Blocks.windowText(key);
      const h = (secByBlock[key] || 0) / 3600;
      const rem = Blocks.remainingSeconds(key, now);
      let remText = "";
      if (rem != null && rem > 0) {
        const rh = Math.floor(rem / 3600);
        const rm = Math.floor((rem % 3600) / 60);
        if (rh > 0) remText = `本块剩 <b>${rh}小时${rm}分钟</b>`;
        else remText = `本块剩 <b>${rm}分钟</b>`;
      }
      // 加时自习：晚块结束（23:40）后，直到次日早上 7:00，显示距离早 7:00 的剩余
      const nowMs = now.getTime();
      const mkAt = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); };
      const hm = (C.TIME_BLOCKS?.sleep || "23:40").split(":").map(Number);
      const sleepToday = mkAt(hm[0], hm[1] || 0);
      const endTomorrow = mkAt(7, 0) + 86400000; // 次日 07:00
      const isOvertime = nowMs >= sleepToday && nowMs < endTomorrow;
      let overtimeText = "";
      if (isOvertime) {
        const remainSec = Math.floor((endTomorrow - nowMs) / 1000);
        const oh = Math.floor(remainSec / 3600);
        const om = Math.floor((remainSec % 3600) / 60);
        overtimeText = om > 0 ? `加时自习：距离早上7:00还剩 <b>${oh}小时${om}分钟</b>` : `加时自习：距离早上7:00还剩 <b>${oh}小时</b>`;
      }
      const isEvening = key === "evening";
      const curBlockNow = (key === curKey) || (isEvening && isOvertime);
      const finalRem = isEvening && isOvertime ? overtimeText : remText;
      const sub = finalRem || (curBlockNow ? "本块进行中" : "待开始");
      // 本块区间总时长
      const totalSec = Blocks.blockDurationSec(key);
      const totalH = Math.floor(totalSec / 3600);
      const totalM = Math.floor((totalSec % 3600) / 60);
      const totalText = totalM > 0 ? `本块区间共 ${totalH}小时${totalM}分钟` : `本块区间共 ${totalH}小时`;

      return `<div class="bcard ${curBlockNow ? "cur" : ""}" style="--bc:${color}">
        <div class="bcard-top">
          <span class="bico" data-icon="${Blocks.ICONS[key]}"></span>
          <span class="bname">${name}</span>
          ${curBlockNow ? '<span class="bnow">现在</span>' : ''}
        </div>
        <div class="btime">${win}</div>
        <div class="bh">${h.toFixed(1)}<span>h</span></div>
        <div class="bgoal">${sub}</div>
        <div class="btotal">${totalText}</div>
      </div>`;
    }).join("");
    if (window.Icon) window.Icon.inject(wrap);
  }

  /* 今日饼图：按「二级分类优先」聚合，西综/英语/政治各自独立成块
   * 对标：爱时间（按类目饼图）/ 时间日志（子分类下钻）/ TimeLogV3（donut+ranked） */
  function renderTodayDonut() {
    const records = Store.getTimeRecords();
    const now = new Date();
    const seenIds = new Set();
    const today = records.filter(r => {
      if (!r.ended_at) return false;
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      if (!isSameDay(r.ended_at, now)) return false;
      if (r.started_at && !isSameDay(r.started_at, now)) return false;
      return true;
    });

    // 二级分类聚合：有 subs 的一级按二级展开，无 subs 的按一级
    const byKey = {};
    const metaMap = {};
    let totalSec = 0;
    let studySec = 0;
    today.forEach(r => {
      const m = segMeta(r);
      byKey[m.key] = (byKey[m.key] || 0) + (r.duration_sec || 0);
      metaMap[m.key] = m;
      totalSec += (r.duration_sec || 0);
      if (m.catKey === "study") studySec += (r.duration_sec || 0);
    });

    // 排序：按 config 顺序（学习子类优先）→ 时长降序
    const cats = C.TIME_CATEGORIES || [];
    const orderOf = {};
    let idx = 0;
    cats.forEach(c => {
      if (c.subs && c.subs.length) c.subs.forEach(s => { orderOf[s.key] = idx++; });
      else orderOf[c.key] = idx++;
    });
    const segments = Object.keys(byKey)
      .map(k => ({ key: k, label: metaMap[k].label, color: metaMap[k].color, value: byKey[k], isSub: metaMap[k].isSub, parent: metaMap[k].parent }))
      .sort((a, b) => (orderOf[a.key] ?? 999) - (orderOf[b.key] ?? 999) || b.value - a.value);

    const donutEl = document.getElementById("todayDonut");
    const legendEl = document.getElementById("todayLegend");
    if (!donutEl) return;

    if (totalSec === 0) {
      donutEl.innerHTML = donutSVG([], "0.0h", "今日");
      legendEl.innerHTML = `<div class="legend-empty">今天还没开始计时 🕊</div>`;
    } else {
      donutEl.innerHTML = donutSVG(segments, fmtH(studySec) + "h", "学习 · 共" + fmtH(totalSec) + "h");
      legendEl.innerHTML = segments.map(s => {
        const pct = Math.round((s.value / totalSec) * 100);
        const subBadge = s.isSub && s.parent ? `<small class="legend-parent">${s.parent}</small>` : "";
        return `<div class="legend-row" data-key="${s.key}">
          <span class="legend-dot" style="background:${s.color}"></span>
          <span class="legend-label">${s.label}${subBadge}</span>
          <span class="legend-val">${fmtH(s.value)}h</span>
          <span class="legend-pct">${pct}%</span>
        </div>`;
      }).join("");
      bindDonutHover(segments, totalSec);
    }

    // 每日目标进度（按「学习」时长）
    const goal = parseFloat(C.DAILY_GOAL_HOURS) || 8;
    const studyH = studySec / 3600;
    const pct = Math.min(100, Math.round((studyH / goal) * 100));
    const goalText = document.getElementById("goalText");
    const goalFill = document.getElementById("goalFill");
    const goalHint = document.getElementById("goalHint");
    if (goalText) goalText.textContent = `${studyH.toFixed(1)} / ${goal} 小时`;
    if (goalFill) goalFill.style.width = pct + "%";
    if (goalHint) goalHint.textContent = `每日目标 ${goal} 小时 · 学霸指数按学习完成度计算`;
  }

  /* 饼图↔图例悬浮联动：对标时间日志「点段高亮」 */
  function bindDonutHover(segments, totalSec) {
    const donutEl = document.getElementById("todayDonut");
    const legendEl = document.getElementById("todayLegend");
    if (!donutEl || !legendEl) return;
    const segs = donutEl.querySelectorAll(".donut-seg");
    const rows = legendEl.querySelectorAll(".legend-row");
    function highlight(key) {
      segs.forEach(c => {
        const k = c.getAttribute("data-key");
        c.style.opacity = (key && k !== key) ? "0.35" : "1";
        c.style.strokeWidth = (key && k === key) ? "6.2" : "4.4";
      });
      rows.forEach(r => {
        r.classList.toggle("dim", key && r.dataset.key !== key);
        r.classList.toggle("hi", key && r.dataset.key === key);
      });
    }
    function clear() { highlight(null); }
    segs.forEach(c => {
      c.addEventListener("mouseenter", () => highlight(c.getAttribute("data-key")));
      c.addEventListener("mouseleave", clear);
    });
    rows.forEach(r => {
      r.addEventListener("mouseenter", () => highlight(r.dataset.key));
      r.addEventListener("mouseleave", clear);
    });
  }

  /* 双计时格式化：专注时长 → XX时XX分XX秒 */
  function fmtFocus(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}时${m}分${ss}秒`;
    return `${m}分${ss}秒`;
  }
  /* 双计时格式化：实际跨度 → X天XX时XX分XX秒 */
  function fmtSpan(sec) {
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (d > 0) return `${d}天${h}时${m}分${ss}秒`;
    if (h > 0) return `${h}时${m}分${ss}秒`;
    return `${m}分${ss}秒`;
  }

  /* 计算实际跨度（秒）= ended_at - started_at */
  function realSpanSec(r) {
    if (!r.started_at || !r.ended_at) return 0;
    return Math.round((new Date(r.ended_at) - new Date(r.started_at)) / 1000);
  }

  /* 今日时间轴：重叠记录自动分道 + 当前时刻线 + 早午晚块边界
   * 对标：爱时间（时间轴快速回忆）/ 时间日志（日视图·块视图·轴视图） */
  function renderTimeline() {
    const records = Store.getTimeRecords();
    const now = new Date();
    const seenIds = new Set();
    const today = records
      .filter(r => {
        if (!r.started_at) return false;
        if (seenIds.has(r.id)) return false;
        seenIds.add(r.id);
        return isSameDay(r.started_at, now);
      })
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));

    const tlEl = document.getElementById("todayTimeline");
    const emptyEl = document.getElementById("timelineEmpty");
    if (!tlEl) return;

    if (today.length === 0) {
      tlEl.style.display = "none";
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    tlEl.style.display = "block";

    const DAY_SEC = 86400;
    const LANE_H = 42;       // 每道高度
    const LANE_GAP = 4;      // 道间距
    function secOfDay(iso) {
      const d = new Date(iso);
      return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }

    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    // 重叠分道（区间调度：找第一个 endSec<=startSec 的道，否则开新道）
    const lanes = []; // { endSec }
    const segs = [];
    let cursor = 0;
    today.forEach(r => {
      const startSec = secOfDay(r.started_at);
      const endSec = Math.min(startSec + (r.duration_sec || 0), DAY_SEC);
      // 未记录间隙
      if (startSec > cursor) {
        segs.push({ type: "empty", startSec: cursor, endSec: startSec });
      }
      const drawEnd = Math.min(endSec, nowSec);
      if (drawEnd <= startSec) { cursor = Math.max(cursor, endSec); return; }
      let laneIdx = lanes.findIndex(l => l.endSec <= startSec);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push({ endSec: drawEnd }); }
      else { lanes[laneIdx].endSec = drawEnd; }
      segs.push({ type: "record", startSec, endSec: drawEnd, record: r, lane: laneIdx });
      cursor = Math.max(cursor, endSec);
    });

    const laneCount = Math.max(1, lanes.length);
    const trackH = laneCount * LANE_H + (laneCount - 1) * LANE_GAP;
    const rulerH = 30;
    const totalH = trackH + rulerH;
    tlEl.style.height = totalH + "px";

    // 块边界（早/午/晚）
    const tb = C.TIME_BLOCKS || { wake: "08:00", lunch: "12:00", dinner: "17:30", sleep: "23:40" };
    const mkSec = (t) => { const [h, m] = t.split(":").map(Number); return h * 3600 + (m || 0) * 60; };
    const blockLines = [
      { sec: mkSec(tb.lunch), label: "午块" },
      { sec: mkSec(tb.dinner), label: "晚块" },
    ].filter(b => b.sec > 0 && b.sec < DAY_SEC);

    let html = "";

    // 未记录间隙（全高斜纹背景）
    segs.filter(s => s.type === "empty").forEach(seg => {
      const dur = seg.endSec - seg.startSec;
      if (dur < 60) return;
      const leftPct = (seg.startSec / DAY_SEC) * 100;
      const widthPct = ((seg.endSec - seg.startSec) / DAY_SEC) * 100;
      html += `<div class="tl-empty-band" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;height:${trackH}px" title="未记录 · ${Math.round(dur/60)}分钟"><span class="tl-empty-txt">未记录 ${Math.round(dur/60)}分</span></div>`;
    });

    // 块边界线
    blockLines.forEach(b => {
      const leftPct = (b.sec / DAY_SEC) * 100;
      html += `<div class="tl-block-line" style="left:${leftPct.toFixed(2)}%;height:${trackH}px"><span class="tl-block-label">${b.label}</span></div>`;
    });

    // 记录块（按道）
    segs.filter(s => s.type === "record").forEach(seg => {
      const r = seg.record;
      const m = segMeta(r);
      const leftPct = (seg.startSec / DAY_SEC) * 100;
      const widthPct = Math.max(0.4, ((seg.endSec - seg.startSec) / DAY_SEC) * 100);
      const top = seg.lane * (LANE_H + LANE_GAP);
      const tagStr = r.tags && r.tags.length ? `<div class="tl-tags">${r.tags.slice(0,3).map(t => `<span class="tl-tag">#${t}</span>`).join("")}</div>` : "";
      const subTag = m.isSub ? `<small class="tl-sub">${m.parent}</small>` : "";
      html += `<div class="tl-item" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;top:${top}px;height:${LANE_H}px;background:${m.color}" data-key="${m.key}">
        <div class="tl-label">${m.label}${subTag}</div>
        <div class="tl-time">${fmtTime(r.started_at)}–${fmtTime(r.ended_at)}</div>
        <div class="tl-dur">${fmtM(r.duration_sec || 0)}${tagStr}</div>
      </div>`;
    });

    // 当前时刻线
    if (nowSec >= 0 && nowSec <= DAY_SEC) {
      const nowPct = (nowSec / DAY_SEC) * 100;
      const nowStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      html += `<div class="tl-now-line" style="left:${nowPct.toFixed(2)}%;height:${trackH}px"><span class="tl-now-label">现在 ${nowStr}</span></div>`;
    }

    // 标尺
    html += `<div class="tl-ruler">
      <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
    </div>`;

    tlEl.innerHTML = html;
    // 每分钟刷新当前时刻线
    scheduleTimelineNowTick();
  }

  /* 时间轴当前时刻线每分钟自刷新（避免一直停在旧位置） */
  let timelineTickTimer = null;
  function scheduleTimelineNowTick() {
    if (timelineTickTimer) clearInterval(timelineTickTimer);
    timelineTickTimer = setInterval(() => {
      if (todayView === "timeline") renderTimeline();
    }, 60000);
  }

  /* 双计时列表：按块分组 + 汇总头 + 二级分类
   * 修复：写入 #dltList（带滚动容器），不再误写到 #listView
   * 对标：爱时间（时间轴回顾·按段分组）/ TimeLogV3（donut+ranked list） */
  function renderList() {
    const records = Store.getTimeRecords();
    const now = new Date();
    const seenIds = new Set();
    const today = records
      .filter(r => {
        if (!r.started_at) return false;
        if (seenIds.has(r.id)) return false;
        seenIds.add(r.id);
        return isSameDay(r.started_at, now);
      })
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at)); // 块内 chronological

    const wrap = document.getElementById("dltList");
    const summaryEl = document.getElementById("listSummary");
    if (!wrap) return;

    if (today.length === 0) {
      wrap.innerHTML = `<div class="dlt-empty">今天还没有时间记录 🕊</div>`;
      if (summaryEl) summaryEl.style.display = "none";
      return;
    }

    // 汇总头
    const totalFocus = today.reduce((s, r) => s + (r.duration_sec || 0), 0);
    const studySec = today.filter(r => r.category === "study").reduce((s, r) => s + (r.duration_sec || 0), 0);
    if (summaryEl) {
      summaryEl.style.display = "flex";
      summaryEl.innerHTML = `
        <div class="dlt-stat"><span class="dlt-stat-num">${fmtFocus(totalFocus)}</span><span class="dlt-stat-label">总专注</span></div>
        <div class="dlt-stat"><span class="dlt-stat-num">${fmtFocus(studySec)}</span><span class="dlt-stat-label">学习</span></div>
        <div class="dlt-stat"><span class="dlt-stat-num">${today.length}</span><span class="dlt-stat-label">条记录</span></div>
      `;
    }

    // 按块分组（早/午/晚，按开始时间归块）
    const groups = { morning: [], afternoon: [], evening: [] };
    today.forEach(r => {
      const k = (window.Blocks && Blocks.blockOf(new Date(r.started_at))) || "evening";
      (groups[k] || (groups[k] = [])).push(r);
    });

    let html = "";
    Blocks.KEYS.forEach(key => {
      const arr = groups[key] || [];
      if (!arr.length) return;
      const focus = arr.reduce((s, r) => s + (r.duration_sec || 0), 0);
      html += `<div class="dlt-group">
        <div class="dlt-group-head">
          <span class="dlt-group-ico" data-icon="${Blocks.ICONS[key]}"></span>
          <span class="dlt-group-name">${Blocks.NAMES[key]}</span>
          <span class="dlt-group-win">${Blocks.windowText(key)}</span>
          <span class="dlt-group-sum">${fmtFocus(focus)}</span>
        </div>`;
      arr.forEach(r => {
        const m = segMeta(r);
        const focusSec = r.duration_sec || 0;
        const spanSec = realSpanSec(r);
        const hasPause = spanSec > focusSec + 10;
        const segCount = (r.segments && Array.isArray(r.segments)) ? r.segments.length : 0;
        const timeIcon = timeOfDayIcon(r.started_at);
        const tagStr = r.tags && r.tags.length
          ? `<div class="dlt-tags">${r.tags.map(t => `<span class="dlt-tag">#${t}</span>`).join("")}</div>`
          : "";
        const spanLine = hasPause ? `<div class="dlt-span">实际 ${fmtSpan(spanSec)}</div>` : "";
        const segBadge = segCount > 1 ? `<span class="dlt-seg-badge">${segCount}段</span>` : "";
        const note = r.note ? `<div class="dlt-note">${escapeHtml(r.note)}</div>` : "";
        html += `
        <div class="dlt-item" style="--dc:${m.color}">
          <div class="dlt-icon">${timeIcon}</div>
          <div class="dlt-body">
            <div class="dlt-time">${fmtTime(r.started_at)} → ${fmtTime(r.ended_at)}</div>
            <div class="dlt-focus">
              <span class="dlt-focus-num">${fmtFocus(focusSec)}</span>
              ${segBadge}
            </div>
            ${spanLine}
            ${note}
            ${tagStr}
          </div>
          <div class="dlt-cat" style="background:${m.color}">${m.label}</div>
        </div>`;
      });
      html += `</div>`;
    });

    wrap.innerHTML = html;
    if (window.Icon) window.Icon.inject(wrap);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* 根据时间段返回图标 */
  function timeOfDayIcon(iso) {
    const h = new Date(iso).getHours();
    if (h < 6) return "🌙";
    if (h < 12) return "☀️";
    if (h < 18) return "🌤️";
    return "🌆";
  }
  /* 24H 时钟图：二级分类色块 + 早午晚块边界 + 当前时刻指针
   * 对标：时间日志（时钟图）/ 爱时间（双环时间轴） */
  function clockChartSVG(records, now) {
    const SIZE = 280;
    const CX = SIZE / 2;
    const CY = SIZE / 2;
    const R_OUTER = 115;     // 外半径（彩色色块）
    const R_INNER = 70;       // 内半径（白色内圆）
    const R_TICK = 105;       // 刻度半径
    const R_NUM = 92;         // 数字半径
    const R_HAND = R_OUTER - 6; // 指针长度

    const DAY_SEC = 86400;
    function secToAngle(sec) { return (sec / DAY_SEC) * 360 - 90; }
    function polar(angleDeg, r) {
      const rad = angleDeg * Math.PI / 180;
      return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
    }
    function arcPath(startSec, endSec, rOuter, rInner) {
      const startAngle = secToAngle(startSec);
      const endAngle = secToAngle(endSec);
      const largeArc = (endSec - startSec) > DAY_SEC / 2 ? 1 : 0;
      const p1 = polar(startAngle, rOuter);
      const p2 = polar(endAngle, rOuter);
      const p3 = polar(endAngle, rInner);
      const p4 = polar(startAngle, rInner);
      return `M ${p1.x} ${p1.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x} ${p4.y} Z`;
    }
    function secOfDay(iso) {
      const d = new Date(iso);
      return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }

    const curSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const segments = [];
    let cursor = 0;
    records.forEach(r => {
      const startSec = secOfDay(r.started_at);
      let endSec = startSec + (r.duration_sec || 0);
      if (endSec > curSec) endSec = curSec;
      if (endSec <= startSec) return;
      if (startSec > cursor) segments.push({ type: "empty", startSec: cursor, endSec: startSec });
      segments.push({ type: "record", startSec, endSec, record: r });
      cursor = endSec;
    });

    // 色块（二级分类色）
    const segPaths = segments.map(seg => {
      if (seg.type === "empty") {
        const dur = seg.endSec - seg.startSec;
        if (dur < 60) return "";
        return `<path d="${arcPath(seg.startSec, seg.endSec, R_OUTER, R_INNER)}"
                     fill="#eef2f7" opacity="0.6" class="clock-seg clock-seg-empty">
                  <title>未记录 · ${Math.round(dur/60)}分钟</title>
                </path>`;
      }
      const r = seg.record;
      const m = segMeta(r);
      const durMin = Math.round((r.duration_sec || 0) / 60);
      return `<path d="${arcPath(seg.startSec, seg.endSec, R_OUTER, R_INNER)}"
                     fill="${m.color}" opacity="0.92"
                     class="clock-seg" data-key="${m.key}">
                <title>${m.label}${m.isSub ? "（" + m.parent + "）" : ""} · ${durMin}分钟 · ${fmtTime(r.started_at)}-${fmtTime(r.ended_at)}</title>
              </path>`;
    }).join("");

    // 块边界（早/午/晚：午餐 12:00 / 晚餐 17:30 / 睡觉 23:40）
    const tb = C.TIME_BLOCKS || { wake: "08:00", lunch: "12:00", dinner: "17:30", sleep: "23:40" };
    const mkSec = (t) => { const [h, m] = t.split(":").map(Number); return h * 3600 + (m || 0) * 60; };
    const blockEdges = [
      { sec: mkSec(tb.lunch), label: "午" },
      { sec: mkSec(tb.dinner), label: "晚" },
      { sec: mkSec(tb.sleep), label: "寝" },
    ].filter(b => b.sec > 0 && b.sec < DAY_SEC);
    let blockMarks = "";
    blockEdges.forEach(b => {
      const angle = secToAngle(b.sec);
      const p1 = polar(angle, R_INNER - 2);
      const p2 = polar(angle, R_OUTER + 4);
      blockMarks += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#64748b" stroke-width="1.2" stroke-dasharray="2 2" opacity="0.7"/>`;
      const pl = polar(angle, R_OUTER + 12);
      blockMarks += `<text x="${pl.x}" y="${pl.y}" class="clock-block-label" text-anchor="middle" dominant-baseline="central">${b.label}</text>`;
    });

    // 24小时刻度（每 3 小时主刻度）
    let ticks = "";
    for (let h = 0; h < 24; h++) {
      const sec = h * 3600;
      const angle = secToAngle(sec);
      const isMajor = h % 3 === 0;
      const r1 = isMajor ? R_OUTER - 2 : R_OUTER - 4;
      const r2 = R_OUTER + 2;
      const p1 = polar(angle, r1);
      const p2 = polar(angle, r2);
      const w = isMajor ? 1.8 : 0.8;
      ticks += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#cbd5e1" stroke-width="${w}" stroke-linecap="round"/>`;
    }

    // 小时数字（每 3 小时）
    let numbers = "";
    for (let h = 0; h < 24; h += 3) {
      const sec = h * 3600;
      const angle = secToAngle(sec);
      const p = polar(angle, R_NUM);
      numbers += `<text x="${p.x}" y="${p.y}" class="clock-num" text-anchor="middle" dominant-baseline="central">${h}</text>`;
    }

    // 当前时刻指针
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const nowAngle = secToAngle(nowSec);
    const handTip = polar(nowAngle, R_HAND);
    const handBase = polar(nowAngle, 8);
    const nowStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

    // 中心统计
    const totalStudySec = records
      .filter(r => r.category === "study")
      .reduce((s, r) => s + (r.duration_sec || 0), 0);
    const studyH = (totalStudySec / 3600).toFixed(1);

    return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="clock-chart" role="img" aria-label="24小时时钟图">
      <defs>
        <radialGradient id="clockGlow" cx="50%" cy="50%" r="50%">
          <stop offset="85%" stop-color="transparent"/>
          <stop offset="100%" stop-color="rgba(102,204,255,0.12)"/>
        </radialGradient>
        <filter id="clockShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="rgba(20,50,90,0.12)"/>
        </filter>
      </defs>
      <circle cx="${CX}" cy="${CY}" r="${R_OUTER + 8}" fill="url(#clockGlow)"/>
      <circle cx="${CX}" cy="${CY}" r="${R_OUTER}" fill="#f8fafc" filter="url(#clockShadow)"/>
      <circle cx="${CX}" cy="${CY}" r="${R_INNER}" fill="#fff"/>
      <circle cx="${CX}" cy="${CY}" r="${R_INNER}" fill="none" stroke="#eef2f7" stroke-width="1"/>
      ${segPaths}
      ${blockMarks}
      ${ticks}
      ${numbers}
      <line x1="${handBase.x}" y1="${handBase.y}" x2="${handTip.x}" y2="${handTip.y}"
            stroke="#ff6b6b" stroke-width="2.5" stroke-linecap="round" class="clock-hand"/>
      <circle cx="${CX}" cy="${CY}" r="6" fill="#fff" stroke="#ff6b6b" stroke-width="2"/>
      <circle cx="${CX}" cy="${CY}" r="2.5" fill="#ff6b6b"/>
      <text x="${CX}" y="${CY - 8}" class="clock-center-time" text-anchor="middle">${nowStr}</text>
      <text x="${CX}" y="${CY + 14}" class="clock-center-sub" text-anchor="middle">学习 ${studyH}h</text>
    </svg>`;
  }

  function renderClockChart() {
    const wrap = document.getElementById("clockChartBox");
    if (!wrap) return;
    if (todayView !== "clock") return;

    const records = Store.getTimeRecords();
    const now = new Date();
    const seenIds = new Set();
    const today = records
      .filter(r => {
        if (!r.started_at) return false;
        if (seenIds.has(r.id)) return false;
        seenIds.add(r.id);
        return isSameDay(r.started_at, now);
      })
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));

    wrap.innerHTML = clockChartSVG(today, now);

    // 时钟下方图例（二级分类汇总，对标时间日志时钟图配套图例）
    const legendEl = document.getElementById("clockLegend");
    if (legendEl) {
      const byKey = {}, metaMap = {};
      let totalSec = 0;
      today.forEach(r => {
        const m = segMeta(r);
        byKey[m.key] = (byKey[m.key] || 0) + (r.duration_sec || 0);
        metaMap[m.key] = m;
        totalSec += (r.duration_sec || 0);
      });
      if (totalSec === 0) { legendEl.innerHTML = ""; return; }
      const cats = C.TIME_CATEGORIES || [];
      const orderOf = {}; let idx = 0;
      cats.forEach(c => {
        if (c.subs && c.subs.length) c.subs.forEach(s => { orderOf[s.key] = idx++; });
        else orderOf[c.key] = idx++;
      });
      const segs = Object.keys(byKey)
        .map(k => ({ key: k, label: metaMap[k].label, color: metaMap[k].color, value: byKey[k] }))
        .sort((a, b) => (orderOf[a.key] ?? 999) - (orderOf[b.key] ?? 999) || b.value - a.value);
      legendEl.innerHTML = segs.map(s => {
        const pct = Math.round((s.value / totalSec) * 100);
        return `<div class="clk-lg-row" data-key="${s.key}">
          <span class="clk-lg-dot" style="background:${s.color}"></span>
          <span class="clk-lg-label">${s.label}</span>
          <span class="clk-lg-val">${fmtH(s.value)}h</span>
          <span class="clk-lg-pct">${pct}%</span>
        </div>`;
      }).join("");
    }
    if (window.Icon) window.Icon.inject(wrap);
  }

  function startClockTick() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (todayView === "clock") {
        renderClockChart();
      }
    }, 1000);
  }

  /* 视图切换 */
  function bindViewToggle() {
    const toggle = document.getElementById("todayViewToggle");
    if (!toggle) return;
    toggle.addEventListener("click", e => {
      const b = e.target.closest("button[data-view]"); if (!b) return;
      todayView = b.dataset.view;
      toggle.querySelectorAll("button").forEach(x =>
        x.classList.toggle("active", x.dataset.view === todayView));
      const donutView = document.getElementById("donutView");
      const tlView = document.getElementById("timelineView");
      const clkView = document.getElementById("clockView");
      const lstView = document.getElementById("listView");
      if (donutView) donutView.style.display = todayView === "donut" ? "" : "none";
      if (tlView) tlView.style.display = todayView === "timeline" ? "" : "none";
      if (clkView) clkView.style.display = todayView === "clock" ? "" : "none";
      if (lstView) lstView.style.display = todayView === "list" ? "" : "none";
      if (todayView === "clock") {
        renderClockChart();
        startClockTick();
      } else if (todayView === "timeline") {
        renderTimeline();
      } else if (todayView === "list") {
        renderList();
      }
    });
  }

  function renderHomeNotes() {
    const box = document.getElementById("homeNotes");
    if (!box || !window.LANGQIAN_NOTES) return;
    box.innerHTML = window.LANGQIAN_NOTES.slice(0, 2).map(n =>
      `<div class="langqian-note"><b>${n.title}</b><br>${n.body}<span class="src">— ${n.src}</span></div>`
    ).join("");
  }

  function renderAll() {
    renderBlocks();
    renderTodayDonut();
    renderTimeline();
    if (todayView === "clock") renderClockChart();
    if (todayView === "list") renderList();
  }

  function init() {
    renderCountdown();
    renderAll();
    renderHomeNotes();
    bindViewToggle();

    // 订阅时间记录变化（主线数据）
    Store.subscribeTimeRecords(() => {
      renderAll();
    });
    // 兼容：旧表变化也刷新（万一有人直接写旧表）
    Store.subscribeSessions(() => {
      renderAll();
    });

    if (Store.isCloud && Store.isCloud()) Store.pullOnce();
    window.UI.refreshSyncBadge();

    // 一键进入自习状态
    const focusBtn = document.getElementById("focusStartBtn");
    if (focusBtn) {
      focusBtn.addEventListener("click", () => {
        // 预选：学习分类 + 高效/专注标签
        const params = new URLSearchParams({
          focus: "1",
          cat: "study",
          tags: "高效,专注"
        });
        location.href = "timer.html?" + params.toString();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

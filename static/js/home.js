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

  /* ======================================================
   * 🔒 统一"今日记录"唯一真相来源：所有视图共用
   *  ---------------------------------------------------
   *  严格执行：
   *   1) id 去重（防止同步/导入重复）
   *   2) started_at 或 ended_at 任一跨今天：视为今日相关（取重叠部分）
   *   3) 记录真实时长：`duration_sec = min(跨度, 截断到今日范围)`
   *   4) 对跨天记录做切片：只保留 "今日 00:00 ~ 明日 00:00" 之间的交集
   *   5) duration_sec 若与 (ended_at - started_at) 偏差过大（>60s）→ 以真实跨度为准（纠偏脏数据）
   *   6) 时长 > 12 小时自动视为脏数据，截断到最大 8 小时
   *   7) 未结束的记录（!ended_at）：以「started_at ~ 当前时间」截断到今日范围内
   * ====================================================== */
  // 「今日记录」统一口径已提取到 static/js/today-records.js（home/stats 共用一份实现，
  // 新增口径只改一处）。此处仅取引用；8h 安全阀等规则随实现移入模块。
  const getTodayRecords = window.TodayRecords.getTodayRecords;
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
      return `<circle class="donut-seg" data-key="${s.key}" cx="21" cy="21" r="${R}" fill="none" stroke="${s.color}" stroke-width="4.4" stroke-dasharray="${dash}" stroke-dashoffset="${off}"><title>${escapeHtml(s.label)} ${fmtH(s.value)}h</title></circle>`;
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
    // ✅ 统一使用 getTodayRecords（已去重+跨天裁剪+时长纠偏+8h安全阀）
    const today = getTodayRecords();

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
      // 加时自习：晚块结束（23:40）后到次日早 7:00。窗口=[昨日23:40,今晨07:00)∪[今晚23:40,明晨07:00)
      // 凌晨 0:00~07:00 属于昨夜的延续，必须单独判断，否则跨零点就断（曾显示"本块剩23小时"）
      const nowMs = now.getTime();
      const mkAt = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); };
      const hm = (C.TIME_BLOCKS?.sleep || "23:40").split(":").map(Number);
      const sleepTonight = mkAt(hm[0], hm[1] || 0);
      const sevenToday = mkAt(7, 0);
      const isOvertime = (nowMs < sevenToday) ||
        (nowMs >= sleepTonight && nowMs < sevenToday + 86400000);
      let overtimeText = "";
      if (isOvertime) {
        const endAt = nowMs < sevenToday ? sevenToday : sevenToday + 86400000;
        const remainSec = Math.max(0, Math.floor((endAt - nowMs) / 1000));
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
    // ✅ 统一 getTodayRecords：去重+跨天裁剪+时长纠偏+8h安全阀
    const today = getTodayRecords();

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
          <span class="legend-label">${escapeHtml(s.label)}${subBadge}</span>
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
    // ✅ 统一 getTodayRecords：去重+跨天裁剪+时长纠偏
    const today = getTodayRecords();
    const now = new Date(); // ★ 曾缺失此行：renderAll 抛 ReferenceError，init 链中断，
                            //   导致视图切换按钮和「一键进入自习」全部未绑定

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
      const tagStr = r.tags && r.tags.length ? `<div class="tl-tags">${r.tags.slice(0,3).map(t => `<span class="tl-tag">#${escapeHtml(t)}</span>`).join("")}</div>` : "";
      const subTag = m.isSub ? `<small class="tl-sub">${m.parent}</small>` : "";
      html += `<div class="tl-item" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;top:${top}px;height:${LANE_H}px;background:${m.color}" data-key="${m.key}" data-rec="${r.id}">
        <div class="tl-label">${escapeHtml(m.label)}${subTag}</div>
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
    // 点击时间轴记录块 → 编辑抽屉
    tlEl.querySelectorAll(".tl-item").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-rec");
        if (id) openRecordEditor(id);
      });
    });
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

  /* 对标爱时间App：无缝时隙列表（00:00 → now）
   *  每一行严格格式：「时段 色点 分类·子分类 时长 →」，间隙=未记录
   *  选中态 & 时钟↔列表双向高亮联动
   */
  function renderList() {
    // ✅ 统一 getTodayRecords：去重+跨天裁剪+时长纠偏
    const today = getTodayRecords();
    const now = new Date();
    const { slots } = buildLoveTimeSlots(today, now);

    const wrap = document.getElementById("dltList");
    const summaryEl = document.getElementById("listSummary");
    if (!wrap) return;

    if (slots.length === 0) {
      wrap.innerHTML = `<div class="dlt-empty">今天还没有时间记录 🕊</div>`;
      if (summaryEl) summaryEl.style.display = "none";
      return;
    }

    // 汇总头（仅统计"已记录段"，未记录不计入）
    const real = slots.filter(s => s.type === "rec");
    const totalFocus = real.reduce((s, r) => s + r.durSec, 0);
    const studySec = real.filter(r => r.catKey === "study").reduce((s, r) => s + r.durSec, 0);
    if (summaryEl) {
      summaryEl.style.display = "flex";
      summaryEl.innerHTML = `
        <div class="dlt-stat"><span class="dlt-stat-num">${fmtFocus(totalFocus)}</span><span class="dlt-stat-label">总专注</span></div>
        <div class="dlt-stat"><span class="dlt-stat-num">${fmtFocus(studySec)}</span><span class="dlt-stat-label">学习</span></div>
        <div class="dlt-stat"><span class="dlt-stat-num">${real.length}</span><span class="dlt-stat-label">条记录</span></div>
      `;
    }

    // 爱时间式行：HH:MM~HH:MM  ●色点  分类·子分类  X小时Y分钟  →
    const sel = _selectedSlotKey;
    wrap.innerHTML = slots.map(sl => {
      const t1 = sec2hmm(sl.s), t2 = sec2hmm(sl.e);
      const isGap = sl.type === "gap";
      const isSel = sel === sl.key;
      const left = isGap
        ? `<span class="lt-dot lt-dot-gap"></span> <span class="lt-gap-txt">未记录</span>`
        : `<span class="lt-dot" style="background:${sl.color}"></span>
           <span class="lt-cat-name">
             ${sl.subLabel ? `<span class="lt-cat-sup">${escapeHtml(sl.subLabel)}・</span>` : ""}
             <span class="lt-cat-main">${escapeHtml(sl.label)}</span>
           </span>`;
      return `
        <div class="lt-row ${isSel ? "selected" : ""} ${isGap ? "gap" : "rec"}" data-slot="${sl.key}">
          <div class="lt-row-time">${t1}~${t2}</div>
          <div class="lt-row-main">${left}</div>
          <div class="lt-row-dur" style="${isGap ? "color:#9ca3af" : ""}">${fmtLTSpan(sl.durSec)}</div>
          <div class="lt-row-arrow" aria-hidden="true">›</div>
        </div>`;
    }).join("");

    // 绑定：点击记录行 → 打开编辑抽屉（对标爱时间/时间日志：归档记录可改）
    wrap.querySelectorAll(".lt-row").forEach(row => {
      row.addEventListener("click", () => {
        const key = row.getAttribute("data-slot");
        if (!key || !key.startsWith("rec_")) return; // 未记录间隙行不可编辑
        const recId = key.slice(4, key.lastIndexOf("_"));
        if (recId) openRecordEditor(recId);
      });
    });
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

  // 选中的段 key（时钟↔列表双向高亮联动）
  let _selectedSlotKey = null;

  /* 爱时间式：格式化秒数 → "X小时Y分钟"（对标 未记录8小时20分钟 / 1小时 / 1分钟）*/
  function fmtLTSpan(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec - h * 3600) / 60);
    const parts = [];
    if (h > 0) parts.push(h + "小时");
    if (m > 0 || parts.length === 0) parts.push(m + "分钟");
    return parts.join("");
  }
  /* 秒数→HH:MM */
  function sec2hmm(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }

  /**
   * 🔁 把 records 展开为「今日 00:00 → now 的无缝时隙」
   *  段间空白自动插入「未记录」灰色行 —— 完全对标爱时间截图
   */
  function buildLoveTimeSlots(records, now) {
    const DAY_SEC = 86400;
    const secOf = (iso) => {
      const d = new Date(iso);
      return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    };
    const nowSec = Math.min(DAY_SEC,
      now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds());
    const slots = [];
    // 1) 已记录段展开成"当日秒"，裁剪到 [0, nowSec]
    const recs = records.map(r => {
      const s = Math.max(0, secOf(r.started_at));
      let e = s + Math.max(0, (r.duration_sec || 0));
      // 用 started/ended 做兜底裁剪
      if (r.ended_at) {
        const e2 = secOf(r.ended_at);
        if (Math.abs(e - e2) > 60) e = Math.min(e, e2);
      }
      if (e > nowSec) e = nowSec;
      return { s, e, rec: r };
    }).filter(x => x.e > x.s).sort((a, b) => a.s - b.s);

    // 2) 合并重叠（M2 修复：durSec 用并集宽度 e-s，不用首条原始 duration_sec）
    const merged = [];
    for (const r of recs) {
      const last = merged[merged.length - 1];
      if (last && r.s < last.e) {
        last.e = Math.max(last.e, r.e);
      } else {
        merged.push(r);
      }
    }

    // 3) 从头到 nowSec 插入未记录时隙
    let cursor = 0;
    let slotIdx = 0;
    merged.forEach((r, idx) => {
      if (r.s > cursor) {
        const dur = r.s - cursor;
        if (dur >= 30) {
          slots.push({
            key: "gap_" + slotIdx++,
            type: "gap",
            s: cursor, e: r.s, durSec: dur,
            label: "未记录", color: "#cbd5e1",
            subLabel: null, catKey: "__gap"
          });
        }
      }
      const m = segMeta(r.rec);
      // ★ M2 修复：durSec 用裁剪后的并集宽度 (e - s)，与时段一致
      const slotDur = Math.min(r.rec.duration_sec || (r.e - r.s), r.e - r.s);
      slots.push({
        key: "rec_" + (r.rec.id || idx) + "_" + slotIdx++,
        type: "rec",
        s: r.s, e: r.e, durSec: slotDur,
        label: m.label, color: m.color, catKey: m.catKey,
        subLabel: m.isSub ? m.parent : null,
        rec: r.rec, meta: m
      });
      cursor = Math.max(cursor, r.e);
    });
    // 尾部未记录（最后一段 → nowSec）
    if (cursor < nowSec) {
      const dur = nowSec - cursor;
      if (dur >= 30) {
        slots.push({
          key: "gap_tail_" + slotIdx++,
          type: "gap",
          s: cursor, e: nowSec, durSec: dur,
          label: "未记录", color: "#cbd5e1", catKey: "__gap"
        });
      }
    }
    return { slots, nowSec };
  }

  /* 🕒 爱时间式 24H 时钟：
   *  - 纯白底 + 外圈每小时刻度(长线+数字0-23) + 5分钟短线
   *  - 扇形彩色块贴在内侧（无外环）；未记录段=统一浅灰底
   *  - 中心三行卡片（对标截图：08:20~09:20 / 学习 / 1小时）
   *  - 点击段 ↔ 中心文字切换；和列表双向高亮
   */
  function clockChartSVG(records, now, selKey) {
    const SIZE = 360;          // 放大到和爱时间截图同比例（更舒展）
    const CX = SIZE / 2;
    const CY = SIZE / 2;
    const R_DIAL = 160;         // 表盘外半径(刻度环)
    const R_SEG_OUTER = 145;    // 彩色扇形外半径
    const R_SEG_INNER = 85;     // 彩色扇形内半径
    const R_NUM = R_DIAL - 18;  // 小时数字半径
    const R_MIN_TICK_OUT = R_DIAL;
    const R_MIN_TICK_IN = R_DIAL - 4;
    const R_HOUR_TICK_IN = R_DIAL - 10;

    const DAY_SEC = 86400;
    // 以 0:00 = 角度 -90°（正上方）。顺时针 1 秒 = 360/86400°。
    const secA = (sec) => (sec / DAY_SEC) * 360 - 90;
    const polar = (aDeg, r) => {
      const r2 = aDeg * Math.PI / 180;
      return { x: CX + r * Math.cos(r2), y: CY + r * Math.sin(r2) };
    };
    // 扇形 SVG path（从 s 到 e 的环形扇，rOuter/rInner）—— 对标爱时间实心扇形
    const pieArc = (sSec, eSec, rOuter, rInner) => {
      const a1 = secA(sSec), a2 = secA(eSec);
      const largeArc = (eSec - sSec) > DAY_SEC / 2 ? 1 : 0;
      const p1 = polar(a1, rOuter);
      const p2 = polar(a2, rOuter);
      const p3 = polar(a2, rInner);
      const p4 = polar(a1, rInner);
      return `M ${p1.x} ${p1.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x} ${p4.y} Z`;
    };
    const { slots, nowSec } = buildLoveTimeSlots(records, now);

    // ===== 1. 背景灰扇形：未记录部分=浅灰色（让空段也有"底"，和爱时间一致）=====
    // 简单方案：先整圈灰 → 再把彩色段叠上去
    let bgCircle = `
      <circle cx="${CX}" cy="${CY}" r="${R_DIAL + 2}" fill="#ffffff"/>
      <circle cx="${CX}" cy="${CY}" r="${(R_SEG_OUTER + R_SEG_INNER)/2}"
              fill="none" stroke="#e5e7eb" stroke-width="${R_SEG_OUTER - R_SEG_INNER}"/>`;

    // ===== 2. 彩色扇形段（records） =====
    let segEls = "";
    slots.forEach(sl => {
      if (sl.type !== "rec") return;
      const isSel = selKey === sl.key;
      segEls += `
        <path data-slot="${sl.key}"
              class="lt-seg ${isSel ? "selected" : ""}"
              d="${pieArc(sl.s, sl.e, R_SEG_OUTER, R_SEG_INNER)}"
              fill="${sl.color}" opacity="${isSel ? 1 : 0.9}"
              stroke="#fff" stroke-width="0.8"/>`;
    });

    // ===== 3. 刻度：24小时刻度 + 5分钟细刻度 =====
    let ticks = "";
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const sec = h * 3600 + m * 60;
        if (sec > DAY_SEC) continue;
        const isHour = m === 0;
        const rIn = isHour ? R_HOUR_TICK_IN : R_MIN_TICK_IN;
        const a = secA(sec);
        const p1 = polar(a, rIn);
        const p2 = polar(a, R_MIN_TICK_OUT);
        const w = isHour ? 1.5 : 0.6;
        const color = isHour ? "#475569" : "#cbd5e1";
        ticks += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
      }
    }

    // ===== 4. 小时数字 0~23（全部显示，对标爱时间）=====
    let numbers = "";
    for (let h = 0; h < 24; h++) {
      const a = secA(h * 3600);
      const p = polar(a, R_NUM);
      const bold = (h % 6 === 0 || h === 0);
      numbers += `<text x="${p.x}" y="${p.y}"
                       class="lt-hour-num ${bold ? "major" : ""}"
                       text-anchor="middle" dominant-baseline="central">${h}</text>`;
    }

    // ===== 5. 中心卡片：优先显示选中段；否则显示"当前正位于的段/总学习"=====
    const selectedSlot = selKey ? slots.find(s => s.key === selKey) : null;
    // 当前时段（如果没有选中）—— 取 nowSec 所在的段
    let currentSlot = selectedSlot || null;
    if (!currentSlot) {
      for (const sl of slots) {
        if (nowSec >= sl.s && nowSec < sl.e) { currentSlot = sl; break; }
      }
    }
    let centerEl;
    if (currentSlot) {
      const t1 = sec2hmm(currentSlot.s);
      const t2 = sec2hmm(currentSlot.e);
      const col = currentSlot.type === "gap" ? "#9ca3af" : currentSlot.color;
      const midLabel = currentSlot.subLabel
        ? `${currentSlot.subLabel}・${currentSlot.label}`
        : currentSlot.label;
      const bottom = fmtLTSpan(currentSlot.durSec);
      centerEl = `
        <text x="${CX}" y="${CY - 18}" class="lt-center-range" text-anchor="middle" fill="${col}">${t1}~${t2}</text>
        <text x="${CX}" y="${CY + 6}" class="lt-center-mid" text-anchor="middle" fill="${col}">${escapeHtml(midLabel)}</text>
        <text x="${CX}" y="${CY + 32}" class="lt-center-bot" text-anchor="middle" fill="${col}">${bottom}</text>`;
    } else {
      // 没有段也给总学习
      const studySec = records.filter(r => r.category === "study").reduce((s, r) => s + (r.duration_sec || 0), 0);
      centerEl = `
        <text x="${CX}" y="${CY - 12}" class="lt-center-mid" text-anchor="middle" fill="#475569">今日学习</text>
        <text x="${CX}" y="${CY + 18}" class="lt-center-bot" text-anchor="middle" fill="#16a34a">${(studySec / 3600).toFixed(1)}小时</text>`;
    }

    return `
      <svg viewBox="0 0 ${SIZE} ${SIZE}" class="clock-chart lt-clock" role="img" aria-label="爱时间式24H时钟图">
        ${bgCircle}
        ${segEls}
        <circle cx="${CX}" cy="${CY}" r="${R_SEG_INNER}" fill="#ffffff"/>
        ${ticks}
        ${numbers}
        ${centerEl}
      </svg>`;
  }

  // M4: 缓存上次数据签名，避免每秒全量重建 SVG
  let _lastClockDataSig = null;
  let _clockTimer = null;

  function renderClockChart() {
    const wrap = document.getElementById("clockChartBox");
    if (!wrap) return;
    if (todayView !== "clock") return;

    const today = getTodayRecords();
    const now = new Date();

    // M4: 数据签名（记录数+各段时长+选中态+当前秒）
    //   只有签名变化才重建 SVG；否则只更新中心卡片文字
    const dataSig = today.length + ":" + today.map(r=>r.duration_sec).join(",") + ":" + (_selectedSlotKey||"");
    const nowMin = Math.floor(now.getTime() / 60000); // 分钟级（秒会变但不需要重建SVG框架）

    if (dataSig === _lastClockDataSig) {
      // 数据不变 → 只更新中心文字（性能优化：不重建 313 节点 SVG）
      const centerEl = wrap.querySelector(".lt-center-range");
      if (centerEl) {
        // 重新计算当前段（nowMin 所在段）
        const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
        const { slots } = buildLoveTimeSlots(today, now);
        let cur = _selectedSlotKey ? slots.find(s=>s.key===_selectedSlotKey) : null;
        if (!cur) { for (const sl of slots) { if (nowSec>=sl.s && nowSec<sl.e) { cur=sl; break; } } }
        if (cur) {
          const t1 = sec2hmm(cur.s), t2 = sec2hmm(cur.e);
          const col = cur.type==="gap" ? "#9ca3af" : cur.color;
          const mid = cur.subLabel ? cur.subLabel+"・"+cur.label : cur.label;
          const bot = fmtLTSpan(cur.durSec);
          const range = wrap.querySelector(".lt-center-range");
          const mid2 = wrap.querySelector(".lt-center-mid");
          const bot2 = wrap.querySelector(".lt-center-bot");
          if (range) { range.textContent = t1+"~"+t2; range.setAttribute("fill", col); }
          if (mid2) { mid2.textContent = mid; mid2.setAttribute("fill", col); }
          if (bot2) { bot2.textContent = bot; bot2.setAttribute("fill", col); }
        }
      }
      return;
    }
    _lastClockDataSig = dataSig;

    // 数据变化 → 全量重建
    wrap.innerHTML = clockChartSVG(today, now, _selectedSlotKey);

    // 时钟段点击 → M3 修复：真正切到 list 视图（更新 todayView + 按钮 + 互斥）
    wrap.querySelectorAll("path[data-slot]").forEach(p => {
      p.style.cursor = "pointer";
      p.addEventListener("click", () => {
        const key = p.getAttribute("data-slot");
        if (!key) return;
        _selectedSlotKey = (_selectedSlotKey === key) ? null : key;
        renderClockChart();
        // M3 修复：如果不在 list/timeline 视图，真正切过去（而非强插 display）
        if (todayView !== "list" && todayView !== "timeline") {
          const toggle = document.getElementById("todayViewToggle");
          if (toggle) {
            const btn = toggle.querySelector('button[data-view="list"]');
            if (btn) btn.click(); // 模拟点击切换（走 bindViewToggle 正确切换互斥+按钮态）
            else { todayView = "list"; switchViewDisplay("list"); }
          } else {
            todayView = "list";
            switchViewDisplay("list");
          }
        }
        renderList();
        requestAnimationFrame(() => {
          const row = document.querySelector(`.lt-row[data-slot="${key}"]`);
          if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      });
    });

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
          <span class="clk-lg-label">${escapeHtml(s.label)}</span>
          <span class="clk-lg-val">${fmtH(s.value)}h</span>
          <span class="clk-lg-pct">${pct}%</span>
        </div>`;
      }).join("");
    }
    if (window.Icon) window.Icon.inject(wrap);
  }

  // M3 辅助：统一视图切换显示逻辑（供点时钟段后 fallback 用）
  function switchViewDisplay(view) {
    const donutView = document.getElementById("donutView");
    const tlView = document.getElementById("timelineView");
    const clkView = document.getElementById("clockView");
    const lstView = document.getElementById("listView");
    if (donutView) donutView.style.display = view === "donut" ? "" : "none";
    if (tlView) tlView.style.display = view === "timeline" ? "" : "none";
    if (clkView) clkView.style.display = view === "clock" ? "" : "none";
    if (lstView) lstView.style.display = view === "list" ? "" : "none";
    const toggle = document.getElementById("todayViewToggle");
    if (toggle) toggle.querySelectorAll("button").forEach(x =>
      x.classList.toggle("active", x.dataset.view === view));
  }

  function startClockTick() {
    if (_clockTimer) clearInterval(_clockTimer);
    _clockTimer = setInterval(() => {
      if (todayView === "clock") {
        renderClockChart();
      } else {
        // M4: 离开 clock 视图 → 清 interval 停止空转
        if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
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

  /* ======================================================
   * 📝 记录编辑抽屉（对标爱时间/时间日志：已归档记录可改分类/标签/时间/删除）
   * 数据走 Store.updateTimeRecord / deleteTimeRecord（含云端同步）
   * ====================================================== */
  function getCategoryMeta(key) {
    const cats = C.TIME_CATEGORIES || [];
    for (const c of cats) {
      if (c.key === key) return c;
      if (c.subs) {
        for (const s of c.subs) { if (s.key === key) return { ...s, parent: c.key }; }
      }
    }
    return null;
  }

  let editRecId = null;
  let editTags = [];
  let editCategory = "";   // 一级或二级 key（二级在保存时换算为 category+sub_category）

  function reToLocalDT(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function openRecordEditor(recId) {
    // 用原始记录（getTodayRecords 是裁剪副本，跨天记录的真实起止在原表里）
    const raw = (Store.getTimeRecords() || []).find(r => r.id === recId);
    if (!raw) return;
    editRecId = recId;
    editTags = Array.isArray(raw.tags) ? [...raw.tags] : [];
    editCategory = raw.sub_category || raw.category || "study";

    const q = (id) => document.getElementById(id);
    q("reStart").value = reToLocalDT(new Date(raw.started_at).getTime());
    q("reEnd").value = reToLocalDT(new Date(raw.ended_at || Date.now()).getTime());
    q("reNote").value = raw.note || "";
    q("reTimeHint").style.display = "none";
    renderEditCat();
    renderEditTags();
    updateEditDur();
    q("recEditMask").classList.add("show");
    q("recEditDrawer").classList.add("show");
    if (window.Icon) window.Icon.inject(q("recEditDrawer"));
  }

  function closeRecordEditor() {
    document.getElementById("recEditMask").classList.remove("show");
    document.getElementById("recEditDrawer").classList.remove("show");
    editRecId = null;
  }

  function updateEditDur() {
    const s = new Date(document.getElementById("reStart").value).getTime();
    const e = new Date(document.getElementById("reEnd").value).getTime();
    const durEl = document.getElementById("reDurLabel");
    durEl.textContent = (isFinite(s) && isFinite(e) && e > s)
      ? fmtLTSpan(Math.round((e - s) / 1000)) : "--";
  }

  function renderEditCat() {
    const cats = C.TIME_CATEGORIES || [];
    const grid = document.getElementById("reCatGrid");
    const meta = getCategoryMeta(editCategory);
    const activeParent = meta && meta.parent ? meta.parent : editCategory;
    grid.innerHTML = cats.map(c => `
      <button type="button" class="td-cat-chip ${c.key === activeParent ? "active" : ""}" data-cat="${c.key}">
        <span class="chip-dot" style="color:${c.color}"></span>${c.label}
      </button>`).join("");
    grid.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => {
      editCategory = b.dataset.cat;
      renderEditCat();
    }));
    // 二级
    const sec = document.getElementById("reSubCatSection");
    const box = document.getElementById("reSubCats");
    const parent = cats.find(c => c.key === activeParent);
    const subs = parent && parent.subs ? parent.subs : [];
    if (!subs.length) { sec.style.display = "none"; }
    else {
      sec.style.display = "block";
      box.innerHTML = subs.map(s => `
        <button type="button" class="td-sub-cat ${s.key === editCategory ? "active" : ""}" data-sub="${s.key}">${s.label}</button>`).join("");
      box.querySelectorAll("[data-sub]").forEach(b => b.addEventListener("click", () => {
        editCategory = b.dataset.sub;
        renderEditCat();
      }));
    }
    const badge = document.getElementById("reCatBadge");
    const m = getCategoryMeta(editCategory);
    if (m) {
      badge.textContent = m.label;
      badge.style.background = m.color + "20";
      badge.style.color = m.color;
    }
  }

  function renderEditTags() {
    const box = document.getElementById("reTags");
    const common = C.COMMON_TAGS || [];
    box.innerHTML = common.map(t => `
      <button type="button" class="td-tag ${editTags.includes(t) ? "active" : ""}" data-tag="${t}">${t}</button>`).join("")
      + editTags.filter(t => !common.includes(t)).map(t => `
      <button type="button" class="td-tag active" data-tag="${escapeHtml(t)}">${escapeHtml(t)} ✕</button>`).join("");
    box.querySelectorAll("[data-tag]").forEach(b => b.addEventListener("click", () => {
      const t = b.dataset.tag;
      editTags = editTags.includes(t) ? editTags.filter(x => x !== t) : [...editTags, t];
      renderEditTags();
    }));
  }

  function saveRecordEdit() {
    if (!editRecId) return;
    const q = (id) => document.getElementById(id);
    const hint = q("reTimeHint");
    const s = new Date(q("reStart").value).getTime();
    const e = new Date(q("reEnd").value).getTime();
    if (!isFinite(s) || !isFinite(e)) {
      hint.textContent = "时间格式无效，请重新选择"; hint.style.display = "block"; return;
    }
    if (e <= s) {
      hint.textContent = "结束时间必须晚于开始时间"; hint.style.display = "block"; return;
    }
    const raw = (Store.getTimeRecords() || []).find(r => r.id === editRecId);
    if (!raw) { closeRecordEditor(); return; }
    // 分类换算：二级 key → category(一级) + sub_category(二级)。只改时间/标签时不动 label
    let finalCat = editCategory, finalSub = "";
    const m = getCategoryMeta(editCategory);
    if (m && m.parent) { finalSub = editCategory; finalCat = m.parent; }
    const catChanged = finalCat !== raw.category || finalSub !== (raw.sub_category || "");
    const timeChanged = Math.abs(new Date(raw.started_at).getTime() - s) > 60000 ||
      Math.abs(new Date(raw.ended_at || 0).getTime() - e) > 60000;
    const patch = {
      category: finalCat,
      sub_category: finalSub,
      tags: [...editTags],
      note: q("reNote").value,
      started_at: new Date(s).toISOString(),
      ended_at: new Date(e).toISOString(),
      duration_sec: Math.round((e - s) / 1000)
    };
    // ★ 任务联动的记录（task_id 存在）label 存的是任务标题——它是任务↔计时器关联的显示载体，
    //   改分类时不得覆盖（专注时长按 task_id 累计、tasks.time_record_ids 关联均不受影响）
    if (catChanged && !raw.task_id) patch.label = m ? m.label : raw.label;
    if (window.Blocks) patch.block = window.Blocks.blockOf(new Date(s));
    // ★ 时间改动后旧 segments 已不匹配，必须清掉，否则分段口径统计仍用旧分段
    if (timeChanged) patch.segments = null;
    Store.updateTimeRecord(editRecId, patch);
    closeRecordEditor();
    if (window.UI && window.UI.showAlert) window.UI.showAlert("✅ 记录已更新（三端同步）", 2000);
  }

  function deleteRecordEdit() {
    if (!editRecId) return;
    if (!confirm("确定删除这条时间记录？删除后三端同步，不可恢复。")) return;
    Store.deleteTimeRecord(editRecId);
    closeRecordEditor();
    if (window.UI && window.UI.showAlert) window.UI.showAlert("🗑 记录已删除（三端同步）", 2000);
  }

  /* 「在时钟中查看」：关抽屉 → 切时钟视图 → 高亮该记录所在扇区并滚动到位
   *   （恢复 v1.2.0 编辑化之前的「列表→时钟」联动方向；时钟→列表方向原本就在） */
  function viewRecordInClock(recId) {
    closeRecordEditor();
    const toggle = document.getElementById("todayViewToggle");
    const clockBtn = toggle ? toggle.querySelector('button[data-view="clock"]') : null;
    if (clockBtn) clockBtn.click(); // 走统一的视图切换（互斥 + 按钮态 + 启动 tick）
    else { todayView = "clock"; switchViewDisplay("clock"); renderClockChart(); startClockTick(); }
    // 数据签名的分钟粒度可能缓存旧 SVG：手动选中后强制重绘
    const { slots } = buildLoveTimeSlots(getTodayRecords(), new Date());
    const slot = slots.find(s => s.type === "rec" && s.rec && s.rec.id === recId);
    if (slot) {
      _selectedSlotKey = slot.key;
      renderClockChart();
      const box = document.getElementById("clockChartBox");
      if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
      if (window.UI && window.UI.showAlert) {
        window.UI.showAlert("已定位到该时段（再次点击扇区可切换回列表）", 2200);
      }
    }
  }

  function bindRecordEditor() {
    const mask = document.getElementById("recEditMask");
    if (!mask) return;
    mask.addEventListener("click", closeRecordEditor);
    document.getElementById("reCloseBtn").addEventListener("click", closeRecordEditor);
    document.getElementById("reSaveBtn").addEventListener("click", saveRecordEdit);
    document.getElementById("reDeleteBtn").addEventListener("click", deleteRecordEdit);
    const viewClockBtn = document.getElementById("reViewClockBtn");
    if (viewClockBtn) viewClockBtn.addEventListener("click", () => { if (editRecId) viewRecordInClock(editRecId); });
    document.getElementById("reStart").addEventListener("input", updateEditDur);
    document.getElementById("reEnd").addEventListener("input", updateEditDur);
    const tagInput = document.getElementById("reTagInput");
    tagInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val && !editTags.includes(val)) { editTags = [...editTags, val]; renderEditTags(); }
      tagInput.value = "";
    });
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
    bindViewToggle();
    bindRecordEditor();

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

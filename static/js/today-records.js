/* =====================================================================
 *  today-records.js —— 「今日记录」统一口径（唯一真相来源）
 *  ---------------------------------------------------------------
 *  此前 home.js / stats.js 各维护一份相同实现，容易改一漏一
 *  （v1.2.0 加暂停分段口径时就改了两处），现提取为公共模块。
 *  所有视图共用：三块 / 饼图 / 时间轴 / 时钟 / 列表 / 统计页。
 *
 *  严格执行（历史事故教训，勿删）：
 *   1) id 去重（防同步/导入重复）
 *   2) 与今日 [00:00, 24:00) 求交集（跨天睡觉只计今日部分）
 *      —— 绝不能用 isSameDay(started)&&isSameDay(ended) 过滤（漏跨天记录）
 *   3) 真实时长优先用 segments（暂停分段求和），否则按跨度纠偏（>60s 视为脏数据）
 *   4) 单条今日时长 > 8h 截断（防异常值撑爆统计）
 *   5) 重叠区间并集合并（防重复计时总和 > 24h）
 *  依赖：store.js（window.Store.getTimeRecords）；加载顺序须在 store.js 之后
 * ===================================================================== */
window.TodayRecords = (function () {
  const DAY_MAX_HOURS_SAFETY = 8; // 单条记录最长不超 8h（睡觉/通勤不可能 17h！）

  // 暂停分段感知的真实时长（秒）= Σ(分段 ∩ [winS, winE])；无 segments 返回 null。
  // 倒计时含暂停时，跨度(首开始→结束)≠真实专注时长，必须按分段求和
  function segDurSec(raw, winS, winE) {
    if (!Array.isArray(raw.segments) || !raw.segments.length) return null;
    let sum = 0;
    for (const sg of raw.segments) {
      if (!sg) continue;
      const ss = typeof sg.start === "number" ? sg.start : Date.parse(sg.start);
      let ee = sg.end == null ? null : (typeof sg.end === "number" ? sg.end : Date.parse(sg.end));
      if (!isFinite(ss)) continue;
      if (ee == null || !isFinite(ee)) ee = winE === Infinity ? Date.now() : winE;
      if (ee <= ss) continue;
      const os = Math.max(ss, winS), oe = Math.min(ee, winE);
      if (oe > os) sum += oe - os;
    }
    return Math.round(sum / 1000);
  }

  function getTodayRecords() {
    const records = window.Store.getTimeRecords();
    const now = new Date();
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    const d0ms = d0.getTime(), d1ms = d1.getTime();

    const seenIds = new Set();
    const clips = []; // { sMs, eMs, durSec, raw }
    for (const raw of records) {
      if (!raw || !raw.id) continue;
      if (seenIds.has(raw.id)) continue;
      seenIds.add(raw.id);

      // 1) 解析 started / ended（含 NaN 兜底）
      let sMs = raw.started_at ? new Date(raw.started_at).getTime() : null;
      let eMs = raw.ended_at ? new Date(raw.ended_at).getTime() : null;
      if (sMs !== null && Number.isNaN(sMs)) sMs = null;
      if (eMs !== null && Number.isNaN(eMs)) eMs = null;
      if (!sMs && !eMs) continue;
      if (!sMs && eMs && typeof raw.duration_sec === "number" && raw.duration_sec > 0) {
        sMs = eMs - raw.duration_sec * 1000;
      }
      if (sMs && !eMs) eMs = now.getTime();
      if (!sMs || !eMs || !(eMs >= sMs)) continue;

      // 2) 真实时长：优先用 segments（暂停分段），否则按跨度纠偏
      const realSpanSec = Math.round((eMs - sMs) / 1000);
      const segFull = segDurSec(raw, -Infinity, Infinity);
      let rawDur;
      if (segFull != null) {
        rawDur = segFull;
      } else {
        rawDur = typeof raw.duration_sec === "number" ? Math.max(0, raw.duration_sec) : 0;
        if (Math.abs(rawDur - realSpanSec) > 60) {
          console.warn("[today-records] duration_sec 纠偏：id=" + raw.id + " 原=" + rawDur + " 修正=" + realSpanSec);
          rawDur = realSpanSec;
        }
        if (rawDur > 12 * 3600) rawDur = realSpanSec;
      }

      // 3) 与今天求交集
      const clipS = Math.max(sMs, d0ms);
      const clipE = Math.min(eMs, d1ms);
      if (clipE <= clipS) continue;

      // 今日时长：有 segments 按分段∩今日（暂停不计、跨天准）；否则按跨度比例折算
      const segToday = segDurSec(raw, d0ms, d1ms);
      let todaySec;
      if (segToday != null) {
        todaySec = segToday;
      } else {
        todaySec = Math.round((clipE - clipS) / 1000);
        if (realSpanSec > 0 && rawDur > 0) {
          const ratio = (clipE - clipS) / (eMs - sMs);
          todaySec = Math.round(rawDur * ratio);
        }
      }
      const maxSec = DAY_MAX_HOURS_SAFETY * 3600;
      if (todaySec > maxSec) {
        console.warn("[today-records] 超长记录已截断：id=" + raw.id + " 原=" + todaySec + "s → 8h");
        todaySec = maxSec;
      }
      if (todaySec <= 0) continue;

      clips.push({ sMs: clipS, eMs: clipE, durSec: todaySec, raw });
    }

    // 4) 按 startMs 排序后合并重叠/相邻区间（并集），所有视图看到同一份去重数据
    clips.sort((a, b) => a.sMs - b.sMs);
    const merged = [];
    for (const c of clips) {
      const last = merged[merged.length - 1];
      if (last && c.sMs < last.eMs) {
        const overlap = last.eMs - c.sMs;
        last.eMs = Math.max(last.eMs, c.eMs);
        const overlapSec = Math.max(0, Math.round(overlap / 1000));
        last.durSec += Math.max(0, c.durSec - overlapSec);
      } else {
        merged.push({ sMs: c.sMs, eMs: c.eMs, durSec: c.durSec, raw: c.raw });
      }
    }

    // 5) 输出（附原始字段便于需要时回溯）
    return merged.map(c => {
      const raw = c.raw;
      return Object.assign({}, raw, {
        started_at: new Date(c.sMs).toISOString(),
        ended_at: new Date(c.eMs).toISOString(),
        duration_sec: c.durSec,
        __orig_started_at: raw.started_at,
        __orig_ended_at: raw.ended_at,
        __orig_duration_sec: raw.duration_sec
      });
    });
  }

  return { getTodayRecords, segDurSec };
})();

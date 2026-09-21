/* =====================================================================
 * day-view.js —— 时间记录展开为连续时隙（含「未记录」gap）的唯一公共模块
 * 依赖：config.js；加载顺序须在 home.js / day-review.js 之前
 * ===================================================================== */
window.DayView = (function () {
  const C = window.APP_CONFIG;

  function defaultMeta(r) {
    const cats = C.TIME_CATEGORIES || [];
    const cat = cats.find(c => c.key === r.category);
    if (cat && cat.subs && cat.subs.length && r.sub_category) {
      const sub = cat.subs.find(s => s.key === r.sub_category);
      if (sub) return { key: r.sub_category, label: sub.label, color: sub.color, parent: cat.label, isSub: true, catKey: r.category };
    }
    if (cat) return { key: r.category, label: cat.label, color: cat.color, parent: null, isSub: false, catKey: r.category };
    return { key: r.category || "other", label: r.label || r.category || "其他", color: "#94a3b8", parent: null, isSub: false, catKey: r.category };
  }

  /**
   * 首页兼容入口：把 records 展开为「本地自然日 00:00 → now」的无缝时隙。
   * 函数逻辑自 home.js 原样迁移；metaResolver 用于保持首页既有分类元数据。
   */
  function buildLoveTimeSlots(records, now, metaResolver) {
    const DAY_SEC = 86400;
    const segMeta = metaResolver || defaultMeta;
    const secOf = (iso) => {
      const d = new Date(iso);
      return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    };
    const nowSec = Math.min(DAY_SEC,
      now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds());
    const slots = [];
    const recs = records.map(r => {
      const s = Math.max(0, secOf(r.started_at));
      let e = s + Math.max(0, (r.duration_sec || 0));
      if (r.ended_at) {
        const e2 = secOf(r.ended_at);
        if (Math.abs(e - e2) > 60) e = Math.min(e, e2);
      }
      if (e > nowSec) e = nowSec;
      return { s, e, rec: r };
    }).filter(x => x.e > x.s).sort((a, b) => a.s - b.s);

    const merged = [];
    for (const r of recs) {
      const last = merged[merged.length - 1];
      if (last && r.s < last.e) {
        /* v1.22.10：重叠/相接的记录会被并集成一段（保证"未记录"与统计不重复计），
         * 但**组内每条记录都要留着**——否则后面的记录既看不见、也点不到（用户报过：
         * 改了那一段却"没有效果"，因为界面上代表它的行根本不存在）。 */
        last.e = Math.max(last.e, r.e);
        (last.members || (last.members = [last])).push(r);
      } else merged.push(r);
    }

    let cursor = 0;
    let slotIdx = 0;
    merged.forEach((r, idx) => {
      if (r.s > cursor) {
        const dur = r.s - cursor;
        if (dur >= 30) slots.push({
          key: "gap_" + slotIdx++, type: "gap", s: cursor, e: r.s, durSec: dur,
          label: "未记录", color: "#cbd5e1", subLabel: null, catKey: "__gap"
        });
      }
      const m = segMeta(r.rec);
      const slotDur = Math.min(r.rec.duration_sec || (r.e - r.s), r.e - r.s);
      slots.push({
        key: "rec_" + (r.rec.id || idx) + "_" + slotIdx++, type: "rec",
        s: r.s, e: r.e, durSec: slotDur, label: m.label, color: m.color,
        catKey: m.catKey, subLabel: m.isSub ? m.parent : null, rec: r.rec, meta: m,
        members: r.members || [r]
      });
      cursor = Math.max(cursor, r.e);
    });
    if (cursor < nowSec) {
      const dur = nowSec - cursor;
      if (dur >= 30) slots.push({
        key: "gap_tail_" + slotIdx++, type: "gap", s: cursor, e: nowSec, durSec: dur,
        label: "未记录", color: "#cbd5e1", catKey: "__gap"
      });
    }
    return { slots, nowSec };
  }

  // 绝对窗口入口：用于北京时间 04:00→次日 04:00 的业务日复盘。
  function buildWindowSlots(records, startMs, endMs, metaResolver) {
    const segMeta = metaResolver || defaultMeta;
    const spanSec = Math.max(0, Math.round((endMs - startMs) / 1000));
    const slots = [];
    const recs = records.map(r => {
      const rawS = Date.parse(r.started_at), rawE = Date.parse(r.ended_at);
      if (!isFinite(rawS)) return null;
      const sMs = Math.max(startMs, rawS);
      let eMs = isFinite(rawE) ? Math.min(endMs, rawE) : Math.min(endMs, Date.now());
      const durSec = Math.max(0, Number(r.duration_sec) || 0);
      if (durSec > 0 && isFinite(rawE) && Math.abs((rawE - rawS) / 1000 - durSec) > 60) {
        eMs = Math.min(eMs, sMs + durSec * 1000);
      }
      if (eMs <= sMs) return null;
      return { s: Math.round((sMs - startMs) / 1000), e: Math.round((eMs - startMs) / 1000), rec: r };
    }).filter(Boolean).sort((a, b) => a.s - b.s);

    const merged = [];
    for (const r of recs) {
      const last = merged[merged.length - 1];
      if (last && r.s < last.e) {
        // v1.22.10：同 buildLoveTimeSlots——并集只用于"缺口/统计"，组内每条记录都保留（可点可改）
        last.e = Math.max(last.e, r.e);
        (last.members || (last.members = [last])).push(r);
      } else merged.push(r);
    }

    let cursor = 0, idx = 0;
    for (const r of merged) {
      if (r.s > cursor && r.s - cursor >= 30) slots.push({
        key: "gap_" + idx++, type: "gap", s: cursor, e: r.s, durSec: r.s - cursor,
        label: "未记录", color: "#cbd5e1", catKey: "__gap"
      });
      const m = segMeta(r.rec);
      slots.push({
        key: "rec_" + (r.rec.id || idx) + "_" + idx++, type: "rec",
        s: r.s, e: r.e, durSec: Math.min(Number(r.rec.duration_sec) || r.e - r.s, r.e - r.s),
        label: m.label, color: m.color, catKey: m.catKey,
        subLabel: m.isSub ? m.parent : null, rec: r.rec, meta: m,
        members: r.members || [r]
      });
      cursor = Math.max(cursor, r.e);
    }
    if (cursor < spanSec && spanSec - cursor >= 30) slots.push({
      key: "gap_tail_" + idx++, type: "gap", s: cursor, e: spanSec, durSec: spanSec - cursor,
      label: "未记录", color: "#cbd5e1", catKey: "__gap"
    });
    return { slots, nowSec: spanSec };
  }

  return { buildLoveTimeSlots, buildWindowSlots, defaultMeta };
})();

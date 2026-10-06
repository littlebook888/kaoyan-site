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

  function getRecordsInWindow(startMs, endMs) {
    if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) return [];
    const records = window.Store.getTimeRecords();
    const nowMs = Math.min(Date.now(), endMs);

    const seenIds = new Set();
    const clips = []; // { sMs, eMs, durSec, raw }
    for (const raw of records) {
      if (!raw || !raw.id) continue;
      /* ⭐ v1.22.11：通话边界的「手动补记」**不与主站联动**（用户 2026-09 指示）。
       * 它仍写在 time_records 里（保留三端同步，也让通话页自己的"今日通话/周额度"能统计），
       * 但 source 用 `call_manual` 标记，**不进主站任何视图**——首页时间轴/列表/时钟、
       * 统计页、每日复盘、热力图都走本函数，所以这里一处排除即可全站生效。
       * 主站的「主计时器」（active_timer）本来就不被补记碰过。 */
      if (raw.source === "call_manual") continue;
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
      if (sMs && !eMs) eMs = nowMs;
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
      const clipS = Math.max(sMs, startMs);
      const clipE = Math.min(eMs, endMs);
      if (clipE <= clipS) continue;

      /* ★ v1.35.0（用户 2026-10-06 指定）：今日时长改到**裁剪之后**再算。
       *   原先在此处就算 todaySec 并施加 8h 上限，会让「被截断的时长」成为
       *   后续重叠累加的基数 → 总账失真。实证（2026-10-06 你的实际数据）：
       *   长睡觉 03:53:37→11:59:35 = 8h06m 被砍到 480 分，三条并集因此少算 6 分
       *   （真实 608 分，只出 602 分）。此处只保留原始素材，交给裁剪后统一处理。 */
      if (!(clipE - clipS > 0)) continue;
      clips.push({ sMs: clipS, eMs: clipE, realSpanSec, rawDur, raw });
    }

    // 4) ★ v1.35.0 逐条裁剪（用户 2026-10-06 明确语义，原话照录）：
    //    「在重叠的时间范围内，按照新开始的记录为主，也就是后面的覆盖前面的，
    //      但这只是在重叠的范围之内，并不是说一旦判断有重叠，就只选取其中的一个。」
    //
    //    这与 v1.22.10 的「并集累加」**语义不同**，不是参数微调：
    //      并集累加：合成一条 → 名称/分类/可编辑性都归**最早那条**，另两条只能折叠查看；
    //                且累加基数已被 8h 截断污染，总账偏小。
    //      逐条裁剪：每条**独立保留**，只裁掉「被更晚开始的记录盖住」的那一段；
    //                不重叠的部分一分不少，Σ 时长 = 真实并集，归属明确。
    //
    //    算法：按 sMs 升序；**只裁尾部**（起点恒保留）
    //      effE_i = min( eMs_i , min{ sMs_j | sMs_j > sMs_i 且 sMs_j < eMs_i } )
    //      —— 即「所有比我晚开始、又与我重叠的记录，它们的起点」里最早的那个。
    //      为什么只裁尾部：只有**更晚开始**的记录才可能覆盖我，而它的起点必然在我区间内
    //      （在我之前或之后都不重叠），所以被覆盖的永远是后缀。
    //      ⚠️ 曾经错写成「裁头部（effS = max(sMs, coveredTo)）」——那是"完全被盖住"的处理，
    //         对「后一条起点落在前一条中间」的场景完全不生效（2026-10-06 实测：整段未被裁）。
    //    Σ 时长 = 真实并集（每段只被起点最晚的那条拥有一次）。
    //    O(n²) 扫两遍即可；单日记录数十条量级，无性能问题。
    const OVERLAP_EPS_MS = 1000;
    clips.sort((a, b) => a.sMs - b.sMs);
    const trimmed = [];
    const shadowed = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const effS = c.sMs;                       // 起点不变
      let effE = c.eMs;                         // 终点可能被更晚开始的记录切掉
      let cutBy = null;
      for (let j = i + 1; j < clips.length; j++) {
        const o = clips[j];
        if (o.sMs >= c.eMs) break;              // 已按 sMs 升序，后面的不可能再与 c 重叠
        /* ★ v1.31.0 亚秒容差：重叠 ≤1s 视为「相接」，不裁。
         * 秒级显示下亚秒重叠毫无信息量（22:03:08.853 vs 22:03:08.000），
         * 却会触发「已裁 N 分」让用户困惑（2026-10-04 实证）。 */
        if (o.sMs < effE - OVERLAP_EPS_MS) { effE = o.sMs; cutBy = o; }
      }
      // 今日时长：有 segments 按分段∩有效窗口（暂停不计、跨天准）；否则按跨度比例折算
      const segEff = segDurSec(c.raw, effS, effE);
      let effSec;
      if (segEff != null) {
        effSec = segEff;
      } else {
        effSec = Math.round((effE - effS) / 1000);
        const fullSpan = c.eMs - c.sMs;
        if (fullSpan > 0 && c.rawDur > 0) {
          effSec = Math.round(c.rawDur * ((effE - effS) / fullSpan));
        }
      }
      // ★ 8h 上限移到此处（裁剪之后）——只在单条最终有效时长上生效，不污染其他记录的累加
      const maxSec = DAY_MAX_HOURS_SAFETY * 3600;
      let capped = false;
      if (effSec > maxSec) {
        console.warn("[today-records] 超长记录已截断：id=" + c.raw.id + " 原=" + effSec + "s → 8h");
        effSec = maxSec;
        capped = true;
      }
      /* 被盖掉的秒数 = 原终点 − 有效终点（尾部被切掉的长度） */
      const overlapSec = Math.max(0, Math.round((c.eMs - effE) / 1000));
      if (effSec > 0 && effE - effS > OVERLAP_EPS_MS) {
        trimmed.push({
          sMs: effS, eMs: effE, durSec: effSec, raw: c.raw,
          overlapSec, capped, cutById: cutBy ? cutBy.raw.id : null,
          origS: c.sMs, origE: c.eMs, origDurSec: Math.round((c.eMs - c.sMs) / 1000)
        });
      } else {
        // 完全被盖住（或尾部不足 1s 的相接）→ 不占时长，但记账供「被谁盖住」提示
        shadowed.push({ raw: c.raw, sMs: c.sMs, eMs: c.eMs, overlapSec, cutById: cutBy ? cutBy.raw.id : null });
      }
    }

    // 5) 输出（每条独立；附原始字段与裁剪元信息便于回溯/提示）
    return trimmed.map(c => {
      const raw = c.raw;
      return Object.assign({}, raw, {
        /* 兼容历史分类（v1.20.0）：老「开始休息」落盘用的是 category="break"，而 config 里
         * 没有这个分类 → 各视图的元数据查找会兜底成灰底英文 "break"。云端老记录不迁移，
         * 统一在这一层（所有记录视图的唯一取数入口）按 rest 呈现，一处生效全站。 */
        category: raw.category === "break" ? "rest" : raw.category,
        started_at: new Date(c.sMs).toISOString(),
        ended_at: new Date(c.eMs).toISOString(),
        duration_sec: c.durSec,
        __orig_started_at: raw.started_at,
        __orig_ended_at: raw.ended_at,
        __orig_duration_sec: raw.duration_sec,
        /* ★ v1.35.0 裁剪元信息：尾部重叠段已按「后开始者覆盖」规则让给后者 */
        __trimmed: c.overlapSec > 0,
        __trimmed_sec: c.overlapSec,
        __cut_by: c.cutById || null,
        __orig_span: { sMs: c.origS, eMs: c.origE, durSec: c.origDurSec },
        __capped_8h: c.capped
      });
    });
  }

  // 保持既有自然日口径与调用方行为不变（设备本地 00:00–24:00）。
  function getTodayRecords() {
    const now = new Date();
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    return getRecordsInWindow(d0.getTime(), d1.getTime());
  }

  function getBizDayRecords(dateStr) {
    const win = window.Blocks && window.Blocks.bizDayWindow(dateStr);
    return win ? getRecordsInWindow(win.startMs, win.endMs) : [];
  }

  return { getTodayRecords, getBizDayRecords, getRecordsInWindow, segDurSec };
})();

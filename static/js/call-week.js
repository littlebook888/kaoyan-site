/* =====================================================================
 * call-week.js —— 通话「上周数据 / 上周复盘 / 本周额度」（v1.130.0 起）
 *
 * 用户 2026-11-16 指定：新增「上周数据展示」与「上周复盘」。
 * ★ 2026-11-19 用户指定（v1.143.0）：**取消上周超额向本周抵扣**，
 *   还原各周独立计时 —— 上周超了多少只进复盘，本周上限恒为
 *   120 分钟 / 4 个通话日，不与上周挂钩、也不连环结转。
 *
 * 口径（全部与 call.js / call-verdict.js 现有实现同源，不另造第二套）：
 *   · 周 = **自然周，周一起算**（weeklyRule.weekStart = "mon"）；
 *   · 日期键 = **学习日 key**（凌晨 04:00 换天，Blocks.bizDateStr）；
 *   · 通话记录 = time_records 里 source 为 call_boundary / call_manual，
 *     或 category==="call"（★ v1.137.0 起**不再排除** sub_category="rule_break"：
 *     违规通话同样占用了真实时间，只算时长，不再据此扣下周额度）；
 *   · 「通话日」= 该学习日接通总时长 > 5min（与 CALL_DAY_MIN_THRESHOLD 同值）。
 *
 * ⚠️ 为什么单开一个模块：周统计原先散在 call.js（calcWeeklyCallCount /
 *   calcWeeklyCallMinSec）与 call-verdict.js（weekCap）两处，各算一遍；
 *   再加周复盘如果第三处再算一遍，三处迟早分叉（本项目最易复发的病）。
 *   这里只做**纯函数**：喂 time_records，返回周数据与本周上限，
 *   渲染留给 call.js，判定读同一份结果。
 *
 * 🚫 不要在这里重新引入「上周超额 → 本周抵扣」。用户 2026-11-19 明确取消：
 *   一周的账一周结，超了就只记在复盘里。判定层（call.js weekCaps /
 *   call-verdict.js weekCapsSafe）现在都直接读本模块的 caps()，
 *   想恢复抵扣必须三处一起改，且必须给它配上可见文案 —— 不许静默扣额度。
 * ===================================================================== */
window.CallWeek = (function () {
  "use strict";

  const C = window.CALL_DATA || {};
  const WR = C.weeklyRule || {};
  const BASE_MIN = Number(WR.maxMinPerWeek) || 0;                       // 120
  const BASE_DAYS = (typeof WR.maxPerWeek === "number" && WR.maxPerWeek > 0) ? WR.maxPerWeek : 0;  // 4
  const DAY_MIN = 5;                                                    // 通话日门槛

  const pad2 = n => String(n).padStart(2, "0");

  /* ---------- 日期键工具（全部走「学习日」key，YYYY-MM-DD） ---------- */
  function todayKey() {
    return (window.Blocks && Blocks.bizDateStr) ? Blocks.bizDateStr(Date.now()) : "";
  }
  function keyToUTC(key) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(key || ""));
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  function utcToKey(d) {
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  /* 该学习日所在自然周的周一（周一=本周第一天；周日回退 6 天） */
  function mondayOf(key) {
    const d = keyToUTC(key);
    if (!d) return "";
    const back = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return utcToKey(d);
  }
  function addDays(key, n) {
    const d = keyToUTC(key);
    if (!d) return "";
    d.setUTCDate(d.getUTCDate() + n);
    return utcToKey(d);
  }
  function weekKeys(monKey) {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(addDays(monKey, i));
    return out;
  }

  /* ---------- 记录筛选（与 call.js isCallRec 逐字同口径） ---------- */
  function isCallRec(r) {
    if (!r) return false;
    if (r.source === "call_boundary" || r.source === "call_manual") return true;
    /* ★ v1.136.1（用户 2026-11-17 拍板）：「违规接听」同样计入通话时长。
     *   ★ v1.143.0：它现在**只影响复盘与「本周已用」，不再连带扣下周额度** ——
     *   抵扣已取消，各周独立结算。
     *   仍要求 category === "call"：其他分类下挂 rule_break 的记录不算通话。 */
    return r.category === "call";
  }
  function recordKey(r) {
    const ts = r && r.started_at;
    if (ts == null) return "";
    const ms = typeof ts === "number" ? ts : Date.parse(ts);
    if (!isFinite(ms)) return "";
    return (window.Blocks && Blocks.bizDateStr) ? Blocks.bizDateStr(ms) : "";
  }

  /* ---------- 周统计 ---------- */
  /* 返回 { mon, sun, days, sec, min, perDay:{key:min}, maxDayKey, maxDayMin, overDayList } */
  function statsOf(monKey, records) {
    const mon = monKey || "";
    const sun = mon ? addDays(mon, 6) : "";
    const perDay = {};
    (records || []).forEach(r => {
      if (!isCallRec(r)) return;
      const k = recordKey(r);
      if (!k || !mon || k < mon || k > sun) return;
      perDay[k] = (perDay[k] || 0) + (Number(r.duration_sec) || 0);
    });
    const perDayMin = {};
    Object.keys(perDay).forEach(k => { perDayMin[k] = Math.round(perDay[k] / 60); });
    const dayKeys = Object.keys(perDayMin).sort();
    const days = dayKeys.filter(k => perDayMin[k] > DAY_MIN).length;
    const sec = Object.keys(perDay).reduce((a, k) => a + perDay[k], 0);
    let maxDayKey = "", maxDayMin = 0;
    dayKeys.forEach(k => { if (perDayMin[k] > maxDayMin) { maxDayMin = perDayMin[k]; maxDayKey = k; } });
    const perDayCap = Number(WR.maxMinPerDay) || 0;
    const overDayList = perDayCap > 0
      ? dayKeys.filter(k => perDayMin[k] > perDayCap).map(k => ({ key: k, min: perDayMin[k] }))
      : [];
    return {
      mon: mon, sun: sun, days: days, sec: sec, min: Math.round(sec / 60),
      perDay: perDayMin, maxDayKey: maxDayKey, maxDayMin: maxDayMin,
      overDayList: overDayList
    };
  }

  function lastWeekMon(todayK) {
    const mon = mondayOf(todayK || todayKey());
    return mon ? addDays(mon, -7) : "";
  }

  /* ---------- 本周上限：各周独立（v1.143.0 取消抵扣） ---------- */
  /* 只回看上一自然周做**复盘**（超了多少写出来），但 cap* 与上周无关，
   * 恒等于 CALL_DATA.weeklyRule 的配置值。
   * prevOverMin / prevOverDays 仅供文案，**不参与任何判定**。 */
  function compute(records) {
    const tKey = todayKey();
    const thisMon = mondayOf(tKey);
    const prevMon = lastWeekMon(tKey);
    const prev = statsOf(prevMon, records);
    const cur = statsOf(thisMon, records);

    const capMin = BASE_MIN > 0 ? BASE_MIN : null;
    const capDays = BASE_DAYS > 0 ? BASE_DAYS : null;

    return {
      todayKey: tKey,
      thisMon: thisMon, prevMon: prevMon,
      prev: prev, cur: cur,
      baseMin: BASE_MIN, baseDays: BASE_DAYS,
      capMin: capMin, capDays: capDays,
      /* 上周超了多少（只用于复盘文案，不影响本周） */
      prevOverMin: BASE_MIN > 0 ? Math.max(0, prev.min - BASE_MIN) : 0,
      prevOverDays: BASE_DAYS > 0 ? Math.max(0, prev.days - BASE_DAYS) : 0,
      usedMin: cur.min, usedDays: cur.days,
      leftMin: capMin == null ? null : Math.max(0, capMin - cur.min),
      leftDays: capDays == null ? null : Math.max(0, capDays - cur.days)
    };
  }

  /* 供判定层调用：只要上限（null = 该闸未启用） */
  function caps(records) {
    const d = compute(records);
    return { min: d.capMin, days: d.capDays, baseMin: d.baseMin, baseDays: d.baseDays };
  }

  /* ---------- 上周复盘条目（纯文案数据，渲染在 call.js） ---------- */
  /* tone: "bad" 超时/为负 | "warn" 接近上限 | "ok" 正常 | "mute" 无数据 */
  function review(records) {
    const d = compute(records);
    const lines = [];
    const p = d.prev;

    if (!p.min && !p.days) {
      lines.push({ label: "上周", value: "无通话记录（或未同步）", tone: "mute" });
    } else {
      lines.push({
        label: "上周通话",
        value: p.days + " 天 · " + p.min + " 分钟（上限 " + d.baseDays + " 天 / " + d.baseMin + " 分钟）",
        tone: (d.prevOverMin > 0 || d.prevOverDays > 0) ? "bad" : "ok"
      });
      if (p.maxDayKey) {
        lines.push({ label: "单日最高", value: p.maxDayKey.slice(5) + " · " + p.maxDayMin + " 分钟", tone: p.maxDayMin > (Number(WR.maxMinPerDay) || 0) ? "bad" : "ok" });
      }
      p.overDayList.forEach(function (x) {
        lines.push({ label: "单日超限", value: x.key.slice(5) + " 用了 " + x.min + " 分钟（单日上限 " + WR.maxMinPerDay + "）", tone: "bad" });
      });
      /* ★ v1.143.0：上周超了要写清楚「但本周不受影响」，否则用户会以为额度又被扣了。 */
      if (d.prevOverMin > 0 || d.prevOverDays > 0) {
        lines.push({
          label: "上周超额",
          value: "超 " + d.prevOverMin + " 分钟 / " + d.prevOverDays + " 个通话日 —— 已按周结算，本周额度不受影响",
          tone: "bad"
        });
      }
      lines.push({
        label: "本周额度",
        value: "各周独立：仍是 " + d.baseMin + " 分钟 / " + d.baseDays + " 天",
        tone: "ok"
      });
    }

    lines.push({
      label: "本周已用",
      value: d.usedDays + " 天 · " + d.usedMin + " 分钟；剩余 " +
        (d.leftMin == null ? "—" : d.leftMin + " 分钟") + " / " +
        (d.leftDays == null ? "—" : d.leftDays + " 天"),
      tone: (d.leftMin != null && d.leftMin <= 10) ? "warn" : "ok"
    });
    return { data: d, lines: lines };
  }

  return {
    BASE_MIN, BASE_DAYS, DAY_MIN,
    todayKey, mondayOf, addDays, weekKeys, lastWeekMon,
    statsOf, compute, caps, review, isCallRec
  };
})();

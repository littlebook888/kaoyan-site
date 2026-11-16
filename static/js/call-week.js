/* =====================================================================
 * call-week.js —— 通话「上周数据 / 上周复盘 / 本周抵扣」（v1.130.0）
 *
 * 用户 2026-11-16 指定：
 *   ① 新增「上周数据展示」与「上周复盘」功能；
 *   ② 若上一周通话天数、时长有超时，本周进行抵扣：
 *      上周 160 分钟（上限 120）→ 本周上限 = 120 −（160 − 120）= 80 分钟。
 *      天数同理：上周用了 5 天（上限 4）→ 本周只剩 4 −（5 − 4）= 3 天。
 *
 * 口径（全部与 call.js / call-verdict.js 现有实现同源，不另造第二套）：
 *   · 周 = **自然周，周一起算**（weeklyRule.weekStart = "mon"）；
 *   · 日期键 = **学习日 key**（凌晨 04:00 换天，Blocks.bizDateStr）；
 *   · 通话记录 = time_records 里 source 为 call_boundary / call_manual，
 *     或 category==="call" 且 sub_category!=="rule_break"（与 call.js isCallRec 逐字一致）；
 *   · 「通话日」= 该学习日接通总时长 > 5min（与 CALL_DAY_MIN_THRESHOLD 同值）；
 *   · 抵扣只回看**紧邻的上一自然周**，不跨周连环结转；下限 0（扣到 0 就是整周不接）。
 *
 * ⚠️ 为什么单开一个模块：周统计原先散在 call.js（calcWeeklyCallCount /
 *   calcWeeklyCallMinSec）与 call-verdict.js（weekCap）两处，各算一遍；
 *   再加「抵扣」如果第三处再算一遍，三处迟早分叉（本项目最易复发的病）。
 *   这里只做**纯函数**：喂 time_records，返回周数据与抵扣后的上限，
 *   渲染留给 call.js，判定读同一份结果。
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
    return r.category === "call" && r.sub_category !== "rule_break";
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

  /* ---------- 抵扣计算 ---------- */
  /* 只回看上一自然周。debtMin / debtDays = 超出部分；cap* = 本周可用上限（下限 0）。 */
  function compute(records) {
    const tKey = todayKey();
    const thisMon = mondayOf(tKey);
    const prevMon = lastWeekMon(tKey);
    const prev = statsOf(prevMon, records);
    const cur = statsOf(thisMon, records);

    const debtMin = BASE_MIN > 0 ? Math.max(0, prev.min - BASE_MIN) : 0;
    const debtDays = BASE_DAYS > 0 ? Math.max(0, prev.days - BASE_DAYS) : 0;

    const capMin = BASE_MIN > 0 ? Math.max(0, BASE_MIN - debtMin) : null;
    const capDays = BASE_DAYS > 0 ? Math.max(0, BASE_DAYS - debtDays) : null;

    return {
      todayKey: tKey,
      thisMon: thisMon, prevMon: prevMon,
      prev: prev, cur: cur,
      baseMin: BASE_MIN, baseDays: BASE_DAYS,
      debtMin: debtMin, debtDays: debtDays,
      capMin: capMin, capDays: capDays,
      hasDebt: debtMin > 0 || debtDays > 0,
      usedMin: cur.min, usedDays: cur.days,
      leftMin: capMin == null ? null : Math.max(0, capMin - cur.min),
      leftDays: capDays == null ? null : Math.max(0, capDays - cur.days)
    };
  }

  /* 供判定层调用：只要上限（null = 该闸未启用） */
  function caps(records) {
    const d = compute(records);
    return { min: d.capMin, days: d.capDays, debtMin: d.debtMin, debtDays: d.debtDays, baseMin: d.baseMin, baseDays: d.baseDays };
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
        tone: (d.debtMin > 0 || d.debtDays > 0) ? "bad" : "ok"
      });
      if (p.maxDayKey) {
        lines.push({ label: "单日最高", value: p.maxDayKey.slice(5) + " · " + p.maxDayMin + " 分钟", tone: p.maxDayMin > (Number(WR.maxMinPerDay) || 0) ? "bad" : "ok" });
      }
      p.overDayList.forEach(function (x) {
        lines.push({ label: "单日超限", value: x.key.slice(5) + " 用了 " + x.min + " 分钟（单日上限 " + WR.maxMinPerDay + "）", tone: "bad" });
      });
      if (d.debtMin > 0) {
        lines.push({
          label: "时长抵扣",
          value: "超 " + d.debtMin + " 分钟 → 本周上限 " + d.baseMin + " − " + d.debtMin + " = " + d.capMin + " 分钟",
          tone: "bad"
        });
      }
      if (d.debtDays > 0) {
        lines.push({
          label: "天数抵扣",
          value: "多 " + d.debtDays + " 个通话日 → 本周只剩 " + d.capDays + " 个通话日",
          tone: "bad"
        });
      }
      if (!d.hasDebt) {
        lines.push({ label: "本周额度", value: "无抵扣，仍为 " + d.baseMin + " 分钟 / " + d.baseDays + " 天", tone: "ok" });
      }
    }

    lines.push({
      label: "本周已用",
      value: d.usedDays + " 天 · " + d.usedMin + " 分钟；剩余 " +
        (d.leftMin == null ? "—" : d.leftMin + " 分钟") + " / " +
        (d.leftDays == null ? "—" : d.leftDays + " 天"),
      tone: (d.leftMin != null && d.leftMin <= 10) ? "warn" : "ok"
    });
    if (d.capMin === 0) {
      lines.push({ label: "本周封顶", value: "抵扣后上限为 0 分钟 —— 本周不安排通话", tone: "bad" });
    }
    return { data: d, lines: lines };
  }

  return {
    BASE_MIN, BASE_DAYS, DAY_MIN,
    todayKey, mondayOf, addDays, weekKeys, lastWeekMon,
    statsOf, compute, caps, review, isCallRec
  };
})();

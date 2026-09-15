/* =====================================================================
 *  call.js —— 通话边界管控分站核心逻辑
 *  功能：今日判定 · 话术速查 · 随机借口 · 双闹钟 · 周频率 · 联动计时
 *  依赖：config.js / blocks.js / clock.js / store.js / ui.js / call-data.js / icon.js
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;
  const D = window.CALL_DATA;

  // ---- 状态 ----
  let callStartAt = null;      // 通话开始时间戳
  let warnTimerId = null;      // 15min 预警定时器
  let finalTimerId = null;     // 25min 终极定时器
  let callTickId = null;       // 通话时长刷新
  let weeklyCallCount = 0;    // 本周已用次数（从时间记录推算）

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function p(n) { return String(Math.max(0, Math.floor(n))).padStart(2, "0"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- 当前时段（对齐规则部 9.13 计划表） ----------
   * 学习区间（kind=study）= 计划表的正经学习时间 → 按规则「正经时间一律禁止聊天」
   * 依赖 schedule-data.js（window.SCHEDULE_DATA）；未加载时本功能静默降级 */
  function toMin(t) { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  function nowSecBJ() {
    if (window.Blocks && window.Blocks.secOfDay) return window.Blocks.secOfDay(new Date());
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function currentSlotInfo() {
    const D = window.SCHEDULE_DATA;
    if (!D || !D.slots) return null;
    const s = nowSecBJ();
    const slot = D.slots.find(x => toMin(x.start) * 60 <= s && s < toMin(x.end) * 60);
    if (!slot) return { slot: null, remainMin: 0, isStudy: false };
    const endSec = toMin(slot.end) * 60;
    return {
      slot,
      remainMin: Math.max(0, Math.round((endSec - s) / 60)),
      isStudy: slot.kind === "study",
      // 放松时间是否 ≥30min（接听前提之一：非专注 AND 放松 >30min）
      relaxOk: slot.kind !== "study" && (endSec - s) >= 30 * 60
    };
  }
  function fmtRemain(min) {
    return min >= 60 ? `${Math.floor(min / 60)}小时${min % 60}分` : `${min}分钟`;
  }
  // 展示名去掉括号备注（「睡眠（预计 7 小时）」→「睡眠」）
  function cleanName(n) { return String(n || "").replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim(); }

  /* ---------- 规则部特殊处理（豁免窗口）----------
   * 设计：学习区间不是"一刀切死"——大块时间内的短暂放松/垃圾时间可报规则部，
   * 人工判断后给一段临时豁免（默认 30 分钟），到期自动恢复限制；全程留痕便于复盘。
   * 存储：kaoyan:call_override = { until, reason, at }；日报备次数 kaoyan:call_override_log */
  const OV_KEY = "kaoyan:call_override";
  const OV_LOG_KEY = "kaoyan:call_override_log";
  function getOverride() {
    try {
      const o = JSON.parse(localStorage.getItem(OV_KEY) || "null");
      if (!o || !o.until || o.until <= Date.now()) return null;
      return o;
    } catch (e) { return null; }
  }
  function overrideActive() { return !!getOverride(); }
  /* type: "quota" = 垃圾时间通话（消耗周额度）｜"violation" = 专注时段违规通话（复盘标记） */
  function setOverride(reason, minutes, type) {
    const o = { until: Date.now() + minutes * 60000, reason: reason || "特殊处理",
                type: type === "violation" ? "violation" : "quota", at: Date.now() };
    try { localStorage.setItem(OV_KEY, JSON.stringify(o)); } catch (e) {}
    // 日报备计数（用于复盘自律情况）
    try {
      const today = window.Blocks ? window.Blocks.dateStr(new Date()) : new Date().toDateString();
      const log = JSON.parse(localStorage.getItem(OV_LOG_KEY) || "null");
      const n = (log && log.d === today) ? (log.n || 0) + 1 : 1;
      localStorage.setItem(OV_LOG_KEY, JSON.stringify({ d: today, n }));
    } catch (e) {}
    return o;
  }
  function overrideTypeLabel(o) {
    return o && o.type === "violation" ? "专注时段违规通话" : "垃圾时间通话（周额度）";
  }
  function clearOverride() { try { localStorage.removeItem(OV_KEY); } catch (e) {} }
  function overrideCountToday() {
    try {
      const today = window.Blocks ? window.Blocks.dateStr(new Date()) : new Date().toDateString();
      const log = JSON.parse(localStorage.getItem(OV_LOG_KEY) || "null");
      return (log && log.d === today) ? (log.n || 0) : 0;
    } catch (e) { return 0; }
  }
  function overrideMinutes() {
    const r = (D && D.rules) || {};
    return typeof r.overrideMinutes === "number" ? r.overrideMinutes : 30;
  }

  /* ---------- 今日通话分钟（#12）：从时间账本统计 + 手动补记 ---------- */
  function todayCallMin() {
    const recs = Store.getTimeRecords() || [];
    const today = window.Blocks ? window.Blocks.dateStr(new Date()) : new Date().toDateString();
    let sec = 0;
    recs.forEach(r => {
      if (r.source !== "call_boundary" || !r.started_at) return;
      if (window.Blocks.dateStr(new Date(r.started_at)) === today) sec += r.duration_sec || 0;
    });
    return Math.round(sec / 60);
  }
  function renderTodayCall() {
    const el = document.getElementById("todayCallMin");
    if (el) el.textContent = String(todayCallMin());
  }

  /* 非学习时段的性质提示（不轻易断言"可接听"——接听还受周频率/邀约/主聊日约束）
   * rest 才是规则里说的"放松时间"，睡眠/收尾/预备属作息时段，不该当聊天窗口 */
  const NONSTUDY_HINT = {
    rest:     "休息时段（非专注）——按规则还须「放松时间 >30min」且非邀约，才可考虑接听",
    meal:     "用餐时段——一般用 17:30 话术池推脱，或餐后文字回复",
    sleep:    "睡眠时段——直接拒接或文字回复，别打乱作息",
    winddown: "收尾时段——该准备上床了，建议文字回复",
    prep:     "起床/预备时段——建议文字回复，别打乱开局"
  };

  function renderNowSlot() {
    const el = document.getElementById("nowSlot");
    if (!el) return;
    const info = currentSlotInfo();
    if (!info) { el.innerHTML = `<div class="ns-free">（未加载计划表数据，仅按奇偶日判定）</div>`; return; }
    if (!info.slot) {
      el.innerHTML = `<div class="ns-free">🕊 当前不在计划时段内（自由时段）</div>`;
      return;
    }
    const sl = info.slot;
    const nm = cleanName(sl.name);
    if (info.isStudy) {
      el.innerHTML = `
        <div class="ns-badge ns-study">⚠️ 现在是学习区间</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">本时段还剩 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip">按规则部计划表：<b>正经时间（学习）一律禁止聊天</b>。<br>此刻来电 → 直接拒接 / 只回文字 / 说「回家后我回你」。</div>`;
    } else {
      const base = NONSTUDY_HINT[sl.kind] || "非学习时段——按规则仍需非专注、非邀约且时限内";
      const extra = (sl.kind === "rest" && info.relaxOk)
        ? `（本时段剩余 ≥30min，已具备「放松 >30min」这一条）` : "";
      el.innerHTML = `
        <div class="ns-badge ns-ok">✅ 当前非学习区间</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">本时段还剩 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip">${esc(base)}${esc(extra)}</div>`;
    }
    renderOverride();
  }

  /* 豁免状态显示（卡片内）+ 底部按钮文案；按钮常驻，点击走"选择窗口" */
  function renderOverride() {
    const box = document.getElementById("nsOverride");
    const label = document.getElementById("btnReportRuleText");
    const btn = document.getElementById("btnReportRule");
    if (!box) return;
    const ov = getOverride();
    if (ov) {
      const leftMin = Math.max(0, Math.round((ov.until - Date.now()) / 60000));
      box.style.display = "";
      box.innerHTML = `
        <div class="ns-badge ns-override-on">🔓 已报规则部 · 特殊处理中</div>
        <div class="ns-ov-row">类型：<b>${esc(overrideTypeLabel(ov))}</b></div>
        <div class="ns-ov-row">理由：<b>${esc(ov.reason)}</b></div>
        <div class="ns-ov-row">剩余 <b>${leftMin} 分钟</b>后自动恢复限制 · 今日已报 ${overrideCountToday()} 次</div>
        <div class="ns-ov-row ns-ov-note">豁免期内通话仍会开双闹钟并记入账本（含豁免标记），便于事后复盘。</div>`;
      if (label) label.textContent = "结束特殊处理（恢复限制）";
      if (btn) btn.classList.add("is-ending");
    } else {
      box.style.display = "none";
      if (label) label.textContent = "报规则部 · 特殊处理";
      if (btn) btn.classList.remove("is-ending");
    }
  }

  /* ---------- 选择窗口（思维 → 想法 → 选择 → 行动 → 命运）----------
   * 依据浪前/规则部素材：行为开始前先强行暂停 → 问自己"到底做还是不做" → 选完无脑行动。
   * 学习区间时默认引导"不豁免"；只有能清楚说出理由、且通过冷静自检，才给豁免。 */
  let _choiceGrantMode = false;   // 当前点击是"申报豁免"还是"结束豁免"
  function openChoiceDialog() {
    const mask = document.getElementById("choiceMask");
    const modal = document.getElementById("choiceModal");
    if (!mask || !modal) return;
    const si = currentSlotInfo();
    const inStudy = !!(si && si.isStudy);
    const ov = getOverride();

    // 上下文说明（含时间感知：把抽象区间变成具体的代价感知）
    const ctx = document.getElementById("choiceContext");
    if (ctx) {
      if (ov) {
        ctx.className = "cm-context is-on";
        ctx.innerHTML = `当前生效中：<b>${esc(overrideTypeLabel(ov))} · ${esc(ov.reason)}</b>` +
          `（约剩 ${Math.max(0, Math.round((ov.until - Date.now()) / 60000))} 分钟）`;
      } else if (si && si.slot) {
        const endMin = toMin(si.slot.end) * 60;
        const leftMin = Math.max(0, Math.round((endMin * 60 - nowSecBJ()) / 60));
        const timeSense = `距离 ${si.slot.end} 还有 ${fmtRemain(leftMin)}`;
        if (inStudy) {
          ctx.className = "cm-context is-study";
          ctx.innerHTML = `此刻处于学习区间：<b>${esc(cleanName(si.slot.name))}</b>（${si.slot.start}~${si.slot.end}）` +
            ` · ${timeSense}——现在通话，代价就是这段自习`;
        } else {
          ctx.className = "cm-context";
          ctx.innerHTML = `此刻处于：<b>${esc(cleanName(si.slot.name))}</b>（${si.slot.start}~${si.slot.end}），非学习区间 · ${timeSense}`;
        }
      } else {
        ctx.className = "cm-context";
        ctx.innerHTML = "此刻不在计划时段内";
      }
    }

    // 理由区：仅在"申报豁免"时有意义
    const reasonWrap = document.getElementById("choiceReasonWrap");
    const chips = document.getElementById("choiceReasons");
    const input = document.getElementById("choiceReasonInput");
    const reasons = ((D && D.rules) || {}).overrideReasons || ["垃圾时间·短暂放松"];
    if (chips && !chips.childElementCount) {
      chips.innerHTML = reasons.map(r => `<button type="button" class="cm-chip" data-reason="${esc(r)}">${esc(r)}</button>`).join("");
      chips.addEventListener("click", (e) => {
        const b = e.target.closest("[data-reason]"); if (!b) return;
        if (input) input.value = b.dataset.reason;
      });
    }
    if (input && !input.value) input.value = reasons[0] || "";
    if (reasonWrap) reasonWrap.style.display = "";

    // 按钮态：已生效中 → 只给"结束"；学习区间未豁免 → 三选（不豁免/垃圾时间/违规级）；
    // 非学习区间 → 两选（不豁免/垃圾时间豁免）
    const keep = document.getElementById("choiceKeep");
    const grant = document.getElementById("choiceGrant");
    const grantV = document.getElementById("choiceGrantV");
    if (ov) {
      _choiceGrantMode = true;
      if (keep) keep.style.display = "none";
      if (grant) grant.textContent = "结束特殊处理";
      if (grantV) grantV.style.display = "none";
      if (reasonWrap) reasonWrap.style.display = "none";
    } else {
      _choiceGrantMode = false;
      if (keep) keep.style.display = "";
      if (grant) grant.textContent = inStudy
        ? `申报：垃圾时间通话（${overrideMinutes()} 分钟 · 用周额度）`
        : `申报豁免 ${overrideMinutes()} 分钟`;
      if (grantV) grantV.style.display = inStudy ? "" : "none";
    }

    mask.classList.add("show");
    modal.classList.add("show");
    if (window.Icon) window.Icon.inject(modal);
  }
  function closeChoiceDialog() {
    const mask = document.getElementById("choiceMask");
    const modal = document.getElementById("choiceModal");
    if (mask) mask.classList.remove("show");
    if (modal) modal.classList.remove("show");
  }

  /* ---------- 今日判定 ---------- */
  function judgeToday() {
    const now = new Date();
    const beijing = window.Blocks ? window.Blocks.beijing(now) : now;
    const day = beijing.getDate();
    const isOdd = day % 2 === 1;
    const dayName = ["周日","周一","周二","周三","周四","周五","周六"][beijing.getDay()];
    const dateStr = `${beijing.getFullYear()}-${p(beijing.getMonth()+1)}-${p(day)}`;

    // 计算本周已用次数
    weeklyCallCount = calcWeeklyCallCount(beijing);
    const slotInfo = currentSlotInfo();
    const inStudy = !!(slotInfo && slotInfo.isStudy);
    const isSleep = !!(slotInfo && slotInfo.slot && slotInfo.slot.kind === "sleep");
    const quota = D.weeklyRule.maxPerWeek;

    /* 2026.9.15 新规判定（三档）：每周 4 次额度、不分单双日硬限、
     * 仅垃圾时间/不影响进度、大自习板块人工判断、规则部仅"建议"单数日接听 */
    let verdict, color, advice;
    if (isSleep) {
      verdict = "拒接";
      color = "#ef4444";
      advice = "睡眠时段——规则部规定：请你直接挂断（或只回文字），别打乱作息";
    } else if (inStudy && overrideActive()) {
      const ov = getOverride();
      verdict = "已报规则部 · 特殊处理中";
      color = "#d97706";
      advice = `豁免理由「${ov.reason}」· 到期自动恢复限制；通话仍须双闹钟并及时挂断`;
    } else if (inStudy) {
      verdict = "需人工判断";
      color = "#d97706";
      advice = "大自习板块理论不允许通话——若你此刻确在专注学习，坚决不允许接通；" +
               "若确属垃圾时间/已放松，可接（须双闹钟）或报规则部特殊处理";
    } else if (weeklyCallCount >= quota) {
      verdict = "额度已用尽 · 建议拒绝";
      color = "#ef4444";
      advice = `本周长通话已用 ${weeklyCallCount}/${quota} 次——建议只回文字`;
    } else {
      verdict = "允许（须双闹钟）";
      color = "#2e7d32";
      advice = `垃圾时间可接 · 本周 ${weeklyCallCount}/${quota} 次` +
        (!isOdd ? "｜规则部建议：单数日再接（仅建议）" : "");
    }
    if (isOdd && !isSleep && !inStudy) advice += "｜今日单数日 ✅";

    return { dateStr, dayName, day, isOdd, verdict, color, advice, weeklyCallCount };
  }

  function calcWeeklyCallCount(beijing) {
    // 从 time_records 统计本周通话次数
    const records = Store.getTimeRecords() || [];
    const rule = D.weeklyRule;
    let count = 0;
    records.forEach(r => {
      if (r.source !== "call_boundary") return;
      if (!r.started_at) return;
      const d = new Date(r.started_at);
      const b = window.Blocks.beijing(d);
      // 计算该记录所在周的周一
      const dow = b.getDay() || 7; // 周日=7
      const diffToMon = dow === 1 ? 0 : dow - 1;
      const mon = new Date(b);
      mon.setDate(mon.getDate() - diffToMon);
      mon.setHours(0, 0, 0, 0);
      // 当前周的周一
      const today = new Date(beijing);
      const todayDow = today.getDay() || 7;
      const todayMon = new Date(today);
      todayMon.setDate(todayMon.getDate() - (todayDow === 1 ? 0 : todayDow - 1));
      todayMon.setHours(0, 0, 0, 0);
      if (mon.getTime() === todayMon.getTime()) count++;
    });
    return count;
  }

  /* ---------- 渲染 ---------- */
  function renderJudge() {
    const el = document.getElementById("todayJudge");
    if (!el) return;
    const j = judgeToday();
    el.innerHTML = `
      <div class="j-row">
        <div class="j-date">${j.dateStr} · ${j.dayName} · 第${j.day}日</div>
        <div class="j-verdict" style="color:${j.color}">${j.verdict}</div>
      </div>
      <div class="j-advice">${j.advice}</div>
      <label class="j-check">
        <input type="checkbox" id="affairsDone" ${j.isOdd ? '' : 'disabled'} />
        自身事务已处理完毕
      </label>
      <label class="j-check">
        <input type="checkbox" id="followDeferRule" />
        是否遵循「置后定则」？<small style="margin-left:6px;color:var(--ink-3);font-weight:500">（通话前先问：我能否 XX 分钟后再处理？/ 回你电话？）</small>
      </label>
      <label class="j-check">
        <input type="checkbox" id="impactStudy" />
        是否会影响正常学习进度？<small style="margin-left:6px;color:#b91c1c;font-weight:600">（勾选 = 此项通话会打断学习，应拒接或设通话上限）</small>
      </label>
    `;
    const cb = document.getElementById("affairsDone");
    if (cb) cb.addEventListener("change", () => { renderHostStatus(); updateJudgeHint(); });
    const cb2 = document.getElementById("followDeferRule");
    if (cb2) cb2.addEventListener("change", () => { renderHostStatus(); updateJudgeHint(); });
    const cb3 = document.getElementById("impactStudy");
    if (cb3) cb3.addEventListener("change", () => { renderHostStatus(); updateJudgeHint(); });
  }

  function updateJudgeHint() {
    // 复选框提示摘要：3 项未勾选 → 顶部强调
    const a = document.getElementById("affairsDone");
    const d = document.getElementById("followDeferRule");
    const i = document.getElementById("impactStudy");
    if (!a || !d || !i) return;
    const items = [];
    if (a.disabled ? false : !a.checked) items.push("【自身事务处理】");
    if (!d.checked) items.push("【置后定则】");
    if (i.checked) items.push("【将打断学习→拒接】");
    const box = document.getElementById("checklistHint");
    if (!box) return;
    if (items.length === 0) {
      box.innerHTML = `<div style="padding:8px 12px;border-radius:8px;background:#dcfce7;color:#166534;font-size:12px;font-weight:700">✅ 三项自检通过，可进入「窗口可接」话术</div>`;
      box.style.display = "";
    } else {
      box.innerHTML = `<div style="padding:8px 12px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:12px;font-weight:700">⚠️ 未满足：${items.join(" · ")}</div>`;
      box.style.display = "";
    }
  }

  function renderScenarios() {
    const box = document.getElementById("callScenarios");
    if (!box) return;
    const j = judgeToday();
    const isOdd = j.isOdd;

    let items;
    if (!isOdd) {
      // 偶数日：规则部建议拒绝
      items = [
        { label: "偶数日 · 建议拒接", text: "今天家里有事，急诊值班忙，改日再聊😊" },
        { label: "偶数日 · 备选", text: "今天排班值班忙到很晚，没空看手机，改日哈😊" }
      ];
    } else {
      // 奇数日：自身事务未完毕 → 拒；完毕 → 可接
      items = [
        { label: "奇数日 · 非窗口", text: "今日急诊加班，回家后我回你电话" },
        { label: "奇数日 · 窗口可接", text: "刚忙完手头的事，找我啥？" }
      ];
    }

    box.innerHTML = items.map((s, i) => `
      <div class="scenario-item" data-idx="${i}">
        <div class="s-label">${s.label}</div>
        <div class="s-text">${s.text}</div>
        <button class="s-copy" data-copy="${s.text}">复制</button>
      </div>
    `).join("");

    box.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        copyText(text);
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    });
  }

  function renderWindowScenarios() {
    const box = document.getElementById("windowScenarios");
    if (!box) return;
    const openItems = D.poolOpen.map((t, i) => ({ label: `开场 #${i+1}`, text: t }));
    const closeItems = D.poolClose.map((t, i) => ({ label: `收尾 #${i+1}`, text: t }));
    const all = [...openItems, ...closeItems];
    box.innerHTML = all.map((s, i) => `
      <div class="scenario-item" data-idx="${i}">
        <div class="s-label">${s.label}</div>
        <div class="s-text">${s.text}</div>
        <button class="s-copy" data-copy="${s.text}">复制</button>
      </div>
    `).join("");
    box.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        copyText(text);
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    });
  }

  function renderHostStatus() {
    const at = Store.getActiveTimer();
    const card = document.getElementById("hostCard");
    const status = document.getElementById("hostStatus");
    const hint = document.getElementById("hostHint");
    if (!card || !status) return;

    if (at) {
      // v2：按 at.kind 显示分类（不硬编码为"正在学习"），paused 也显示状态
      const cats = window.APP_CONFIG.TIME_CATEGORIES || [];
      const cm = cats.find(c => c.key === at.kind) || { label: at.kind || "活动", color: "#94a3b8" };
      let elapsed = at.status === "running" ? Math.round(
          (at.elapsed_sec || 0) + (Date.now() - (at.started_at || Date.now())) / 1000
        ) : Math.round(at.elapsed_sec || 0);
      elapsed = Math.max(0, elapsed);
      const label = at.label || cm.label || "学习";
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const statusTxt = at.status === "paused" ? "（已暂停）" : "";
      const tagClass = at.kind === "study" && at.status === "running" ? "host-study" : "host-other";
      card.style.display = "";
      status.innerHTML = `<span class="host-tag ${tagClass}">正在${cm.label} ${mins}分${secs}秒${statusTxt}</span> <span class="host-label">${label}</span>`;
      if (at.kind === "study") {
        hint.textContent = at.status === "running"
          ? "通话将计入今日占用，强化边界意识"
          : "当前学习计时已暂停";
      } else {
        hint.textContent = "当前正处于「" + cm.label + "」状态";
      }
    } else {
      card.style.display = "";
      status.innerHTML = `<span class="host-tag host-idle">主站空闲</span>`;
      hint.textContent = "当前无进行中的计时";
    }
  }

  function renderWeeklyInfo() {
    const el = document.getElementById("weeklyInfo");
    if (!el) return;
    const j = judgeToday();
    const rule = D.weeklyRule;
    el.innerHTML = `
      <div class="wf-row"><span>本周长通话额度</span><span class="wf-count ${j.weeklyCallCount >= rule.maxPerWeek ? 'over' : ''}">${j.weeklyCallCount} / ${rule.maxPerWeek}</span></div>
      <div class="wf-row"><span>规则部建议</span><span>单数日接听（仅建议，非硬规则）</span></div>
      <div class="wf-row"><span>时间前提</span><span>仅限垃圾时间 / 不影响正常进度</span></div>
      <div class="wf-row"><span>当前判定</span><span style="color:${j.color}">${j.verdict}</span></div>
    `;
  }

  /* ---------- 操作 ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
    }
    if (window.UI) window.UI.showAlert("已复制到剪贴板", 1500);
  }

  function randomExcuse() {
    const arr = D.excuses;
    const idx = Math.floor(Math.random() * arr.length);
    const e = arr[idx];
    const typeEl = document.getElementById("excuseType");
    const textEl = document.getElementById("excuseText");
    if (typeEl) typeEl.textContent = `${e.label}（${idx+1}/${arr.length}）`;
    if (textEl) textEl.textContent = e.text;
  }

  function randomPool1730() {
    const arr = D.pool1730;
    const idx = Math.floor(Math.random() * arr.length);
    const el = document.getElementById("poolText");
    if (el) el.textContent = arr[idx];
  }

  function copyExcuse() {
    const t = document.getElementById("excuseText");
    if (t && t.textContent && t.textContent !== "点下方按钮抽一条随机借口") {
      copyText(t.textContent);
    }
  }

  function copyPool() {
    const t = document.getElementById("poolText");
    if (t && t.textContent && !t.textContent.startsWith("点")) {
      copyText(t.textContent);
    }
  }

  /* ---------- 双闹钟 ---------- */
  function startDualAlarm() {
    if (callStartAt) return;
    callStartAt = Date.now();
    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "";

    // 15min 预警
    warnTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(1);
        window.UI.showAlert("⏰ 还有 10 分钟，准备收尾", 5000);
        window.UI.notify("⏰ 预警", "通话 15 分钟了，还有 10 分钟到终极");
      }
    }, 15 * 60 * 1000);

    // 25min 终极
    finalTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(3);
        window.UI.buzz();
        window.UI.showAlert("到点了，刚性挂断！", 5000);
        window.UI.notify("⏰ 通话结束", "25 分钟到了，请挂断");
      }
      endCall(true);
    }, 25 * 60 * 1000);

    // 通话时长刷新
    callTickId = setInterval(updateCallDisplay, 1000);
    updateCallDisplay();

    if (window.UI) window.UI.showAlert("通话开始，双闹钟已启动（15min预警 / 25min终极）", 3000);
  }

  function updateCallDisplay() {
    if (!callStartAt) return;
    const elapsed = Math.floor((Date.now() - callStartAt) / 1000);
    const em = Math.floor(elapsed / 60), es = elapsed % 60;
    const el = document.getElementById("callElapsed");
    if (el) el.textContent = `${p(em)}:${p(es)}`;

    const warnRemain = Math.max(0, 15 * 60 - elapsed);
    const wr = document.getElementById("warnRemain");
    if (wr) wr.textContent = `${p(Math.floor(warnRemain/60))}:${p(warnRemain%60)}`;

    const finalRemain = Math.max(0, 25 * 60 - elapsed);
    const fr = document.getElementById("finalRemain");
    if (fr) fr.textContent = `${p(Math.floor(finalRemain/60))}:${p(finalRemain%60)}`;
  }

  function endCall(forced) {
    if (!callStartAt) return;
    const dur = Math.floor((Date.now() - callStartAt) / 1000);
    const startedAt = callStartAt;
    const endedAt = Date.now();

    // 清除定时器
    if (warnTimerId) clearTimeout(warnTimerId);
    if (finalTimerId) clearTimeout(finalTimerId);
    if (callTickId) clearInterval(callTickId);
    callStartAt = null;

    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "none";

    // 写入时间记录（上行联动）
    const si = currentSlotInfo();
    const inStudySlot = !!(si && si.isStudy);
    const ov = getOverride();
    const tags = ["边界管控", "通话"];
    if (inStudySlot) tags.push("学习区间通话");
    if (ov) tags.push(ov.type === "violation" ? "违规级豁免" : "报规则部特殊处理");
    const rec = {
      id: uid(),
      user_id: C.USER_ID,
      category: "call",
      sub_category: "linyuchen",
      label: "通话",
      tags: tags,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_sec: dur,
      source: "call_boundary",
      note: (forced ? "双闹钟超时·刚性挂断" : "正常挂断") +
            (inStudySlot ? `｜⚠️ 发生在学习区间「${si.slot.name}」` : "") +
            (ov ? `｜🔓 ${overrideTypeLabel(ov)}（已报规则部）：${ov.reason}` : ""),
      created_at: new Date().toISOString()
    };
    Store.addTimeRecord(rec);
    renderTodayCall();

    if (window.UI) {
      window.UI.showAlert(
        `通话结束，时长 ${Math.floor(dur/60)}分${dur%60}秒，已记入时间账本` +
        (inStudySlot ? (ov ? "（学习区间·已报规则部）" : "（学习区间通话，已标记）") : ""), 3000);
    }

    // 刷新周频率
    renderWeeklyInfo();
  }

  /* ---------- 周频率检查 ---------- */
  function checkWeekly() {
    const j = judgeToday();
    const rule = D.weeklyRule;
    if (j.weeklyCallCount >= rule.maxPerWeek) {
      if (window.UI) {
        window.UI.showAlert(`本周通话已达 ${rule.maxPerWeek} 次上限，建议返回学习`, 5000);
        setTimeout(() => {
          const ok = confirm("本周已超额，继续畅聊将违反边界管控。\n\n选择：\n确定 = 继续畅聊（违规）\n取消 = 返回学习");
          if (ok) {
            if (window.UI) window.UI.showAlert("已标记为违规，请自觉遵守边界", 3000);
          }
        }, 100);
      }
    } else {
      if (window.UI) {
        window.UI.showAlert(`本周已用 ${j.weeklyCallCount}/${rule.maxPerWeek} 次，剩余 ${rule.maxPerWeek - j.weeklyCallCount} 次`, 3000);
      }
    }
  }

  /* ---------- 初始化 ---------- */
  // M1: call 页秒级 tick —— 计时器运行中时每秒刷新"正在学习 X分X秒"
  let _hostTickTimer = null;
  function _ensureHostTick() {
    const at = Store.getActiveTimer();
    const isRunning = at && at.status === "running";
    if (isRunning && !_hostTickTimer) {
      _hostTickTimer = setInterval(() => renderHostStatus(), 1000);
    } else if (!isRunning && _hostTickTimer) {
      clearInterval(_hostTickTimer);
      _hostTickTimer = null;
    }
  }

  function init() {
    renderNowSlot();
    renderTodayCall();
    renderJudge();
    updateJudgeHint();       // 初始化复选框摘要提示
    renderScenarios();
    renderWindowScenarios();
    renderHostStatus();
    renderWeeklyInfo();

    // 每 30 秒刷新时段卡与豁免倒计时；跨过时段边界/豁免到期时同步刷新判定
    let lastSlotKey = (currentSlotInfo() && currentSlotInfo().slot) ? currentSlotInfo().slot.start : "none";
    let lastOvOn = overrideActive();
    setInterval(() => {
      renderNowSlot();
      const si = currentSlotInfo();
      const key = (si && si.slot) ? si.slot.start : "none";
      const ovOn = overrideActive();
      if (key !== lastSlotKey || ovOn !== lastOvOn) {
        lastSlotKey = key;
        lastOvOn = ovOn;
        renderJudge();       // 时段切换 / 豁免到期 → 判定结论可能变化
        updateJudgeHint();
      }
    }, 30000);

    // 随机借口
    const btnExcuse = document.getElementById("btnExcuse");
    if (btnExcuse) btnExcuse.addEventListener("click", randomExcuse);
    const btnCopyExcuse = document.getElementById("btnCopyExcuse");
    if (btnCopyExcuse) btnCopyExcuse.addEventListener("click", copyExcuse);

    // 17:30 话术
    const btnPool = document.getElementById("btnPool1730");
    if (btnPool) btnPool.addEventListener("click", randomPool1730);
    const btnCopyPool = document.getElementById("btnCopyPool");
    if (btnCopyPool) btnCopyPool.addEventListener("click", copyPool);

    // 双闹钟
    const btnCall = document.getElementById("btnCall");
    if (btnCall) btnCall.addEventListener("click", () => {
      // 检查是否可以接听（2026.9.15 新规流程）
      const j = judgeToday();
      const si = currentSlotInfo();
      // ① 睡眠时段：硬性拒绝，无豁免出口
      if (si && si.slot && si.slot.kind === "sleep") {
        if (window.UI) window.UI.showAlert("规则部规定：睡眠时段禁止通话，请你直接挂断", 4500);
        return;
      }
      // ② 大自习板块：人工判断——确在专注学习则坚决不允许（豁免中视为已人工判断，跳过）
      if (si && si.isStudy && !overrideActive()) {
        const focusing = confirm(
          `⚠️ 大自习板块「${cleanName(si.slot.name)}」（${si.slot.start}~${si.slot.end}）\n\n` +
          `规则部规定：此板块理论不允许接听电话。\n\n` +
          `你此刻是否处于专注学习中？\n\n` +
          `• 确定 = 是，在专注学习 → 坚决不允许接通（返回）\n` +
          `• 取消 = 否（确属垃圾时间 / 已放松 → 继续接通流程）`);
        if (focusing) {
          if (window.UI) window.UI.showAlert("规则部规定：专注学习一律禁止接通，请你直接挂断", 4500);
          return;
        }
      }
      // ③ 偶数日：规则部仅建议（确认突破）
      if (!j.isOdd && !(si && si.isStudy)) {
        if (!confirm("规则部建议：单数日接听（今日偶数日，仅建议、非硬规则）。\n\n确定 = 仍要接通\n取消 = 拒接 / 只回文字")) return;
      }
      // ④ 自身事务完毕
      const affairsDone = document.getElementById("affairsDone");
      if (!affairsDone || !affairsDone.checked) {
        if (window.UI) window.UI.showAlert("请先勾选「自身事务已处理完毕」", 3000);
        return;
      }
      // ⑤ 周额度（每周 4 次）
      if (j.weeklyCallCount >= D.weeklyRule.maxPerWeek) {
        if (window.UI) {
          window.UI.showAlert(`本周长通话额度已用尽（${j.weeklyCallCount}/${D.weeklyRule.maxPerWeek}），继续将违规`, 5000);
          setTimeout(() => {
            if (confirm("本周额度已用尽。确定要继续通话吗？（将违规并记入复盘）")) {
              startDualAlarm();
            }
          }, 100);
        }
        return;
      }
      // ⑥ 主站计时联动：接通前先结束主站计时（写入账本，不弹抽屉）
      const at = Store.getActiveTimer();
      if (at && (at.status === "running" || at.status === "paused")) {
        const label = at.label || at.kind || "计时";
        const elapsedMin = Math.max(0, Math.round(
          ((at.elapsed_sec || 0) + (at.status === "running" ? (Date.now() - (at.started_at || Date.now())) / 1000 : 0)) / 60));
        if (!confirm(`主站正在计时「${label}」（已 ${elapsedMin} 分钟）。\n\n` +
                     `接通通话将结束该计时（自动写入时间账本），进入通话双闹钟。\n\n` +
                     `确定 = 结束计时并接通\n取消 = 不接通`)) return;
        if (window.Timer && window.Timer.stopSilent) window.Timer.stopSilent();
      }
      startDualAlarm();
    });

    const btnEnd = document.getElementById("btnEnd");
    if (btnEnd) btnEnd.addEventListener("click", () => endCall(false));

    // 底部按钮 → 打开"选择窗口"；窗口内二选一（不豁免 / 申报豁免）
    const btnReport = document.getElementById("btnReportRule");
    if (btnReport) btnReport.addEventListener("click", openChoiceDialog);
    const choiceClose = document.getElementById("choiceClose");
    if (choiceClose) choiceClose.addEventListener("click", closeChoiceDialog);
    const choiceMask = document.getElementById("choiceMask");
    if (choiceMask) choiceMask.addEventListener("click", closeChoiceDialog);

    // 选择 A：不豁免（保持限制）—— 这也是一个明确的正确选择
    const choiceKeep = document.getElementById("choiceKeep");
    if (choiceKeep) choiceKeep.addEventListener("click", () => {
      closeChoiceDialog();
      if (window.UI) {
        window.UI.showAlert("✅ 已选择：不豁免 · 保持学习节奏。该干嘛就干嘛。", 3500);
      }
    });

    // 选择 B：申报豁免（或结束豁免）
    const choiceGrant = document.getElementById("choiceGrant");
    if (choiceGrant) choiceGrant.addEventListener("click", () => {
      if (getOverride()) {
        clearOverride();
        closeChoiceDialog();
        renderOverride();
        renderJudge();
        if (window.UI) window.UI.showAlert("已结束特殊处理，恢复学习区间限制", 2200);
        return;
      }
      const input = document.getElementById("choiceReasonInput");
      const reason = String((input && input.value) || "").trim();
      if (!reason) {
        if (window.UI) window.UI.showAlert("请写明豁免理由（这是「报规则部」的必要动作）", 3000);
        return;
      }
      const mins = overrideMinutes();
      setOverride(reason, mins, "quota");
      closeChoiceDialog();
      renderOverride();
      renderJudge();
      if (window.UI) window.UI.showAlert(`🔓 已报规则部（垃圾时间·用周额度）｜豁免 ${mins} 分钟｜理由：${reason}`, 3500);
    });

    // 选择 C：申报专注时段通话（违规级）——仅在"确实不得不"时选择，二次确认 + 留痕
    const choiceGrantV = document.getElementById("choiceGrantV");
    if (choiceGrantV) choiceGrantV.addEventListener("click", () => {
      const input = document.getElementById("choiceReasonInput");
      const reason = String((input && input.value) || "").trim();
      if (!reason) {
        if (window.UI) window.UI.showAlert("请写明理由——违规级豁免必须说明「为什么确实不得不」", 3500);
        return;
      }
      if (!confirm("⚠️ 违规级豁免确认\n\n这是「专注时段通话」，属于违规备案：\n· 会消耗你的自习时间，事后复盘会看到它\n· 仅限「确实不得不」的情况（紧急/重要事项）\n\n确定 = 我确认确实不得不，申报豁免\n取消 = 收手，继续学习")) return;
      const mins = overrideMinutes();
      setOverride(reason, mins, "violation");
      closeChoiceDialog();
      renderOverride();
      renderJudge();
      if (window.UI) window.UI.showAlert(`🔴 已申报违规级豁免 ${mins} 分钟｜${reason}（已留痕，复盘可见）`, 4000);
    });

    // 今日通话分钟 + 补记
    const btnManual = document.getElementById("btnManualCall");
    if (btnManual) btnManual.addEventListener("click", () => {
      const v = prompt("补记通话（分钟数）：\n例如刚才接了电话没开双闹钟，把时长补进时间账本", "10");
      if (v === null) return;
      const mins = Math.round(parseFloat(v));
      if (!isFinite(mins) || mins <= 0) {
        if (window.UI) window.UI.showAlert("请输入有效的分钟数", 2500);
        return;
      }
      const now = Date.now();
      Store.addTimeRecord({
        id: uid(), user_id: C.USER_ID,
        category: "call", sub_category: "linyuchen",
        label: "通话", tags: ["边界管控", "通话", "手动补记"],
        started_at: new Date(now - mins * 60000).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_sec: mins * 60,
        source: "call_boundary",
        note: "手动补记（未开双闹钟）",
        created_at: new Date(now).toISOString()
      });
      renderTodayCall();
      renderWeeklyInfo();
      if (window.UI) window.UI.showAlert(`✅ 已补记 ${mins} 分钟通话（计入本周额度，三端同步）`, 3000);
    });

    // 周频率检查
    const btnWeekly = document.getElementById("btnWeeklyCheck");
    if (btnWeekly) btnWeekly.addEventListener("click", checkWeekly);

    // 订阅主站状态变化
    Store.subscribeActiveTimer(() => { renderHostStatus(); _ensureHostTick(); });

    // M1 修复：运行中秒级自刷新（Store 不会每秒 emit，call 页自己 tick）
    _ensureHostTick();

    // 图标注入
    if (window.Icon) {
      window.Icon.inject(document.getElementById("callScenarios"));
      window.Icon.inject(document.getElementById("windowScenarios"));
      window.Icon.inject(document.querySelector(".call-actions"));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (window.Blocks && window.Clock) {
      init();
    } else {
      setTimeout(() => { if (window.Blocks) init(); }, 300);
    }
  });
})();

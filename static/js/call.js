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
  let weeklyCallMinSec = 0;   // ★ v1.24.5 本周接通总秒数（≤120min 周时长闸）
  /* ★ v1.45.0 通话开始时的豁免快照。
   * 旧实现在**通话结束时**才读 getOverrides() 写 note/tags，而豁免窗口只有 30 分钟、
   * 单次通话上限 25 分钟，余量仅 5 分钟——从申报到接通的等待一旦吃掉这点余量，
   * 窗口就会在通话结束前到期（getOverrides 会自动清除过期项），
   * 结果：这条通话的 note 里**没有豁免标记**，复盘时看不出这是豁免通话。
   * 现在开始通话即快照，结束时以快照为准。 */
  let callOverrideSnapshot = null;

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
  /* ★ v1.23.0 置后定则优先：本大块内当前时段之后是否还有学习/工作任务。
   * 大块边界取 config.TIME_BLOCKS（早块 wake~lunch、午块 lunch~dinner、晚块 dinner~sleep）。
   * 判定：同块内、开始时刻晚于当前的 kind==="study" 时段存在 → 置后优先（并行规则不适用）。
   * 当前时段本身是学习 → 不走此判定（正经时间另有规则）。 */
  function blockHasStudyAfter(slot) {
    const D = window.SCHEDULE_DATA;
    const tb = C.TIME_BLOCKS || {};
    if (!D || !D.slots || !slot || !tb.wake) return false;
    const sMin = toMin(slot.start), eMin = toMin(slot.end);
    const bounds = [
      { s: toMin(tb.wake), e: toMin(tb.lunch) },
      { s: toMin(tb.lunch), e: toMin(tb.dinner) },
      { s: toMin(tb.dinner), e: toMin(tb.sleep === "24:00" ? "24:00" : tb.sleep) }
    ];
    const blk = bounds.find(b => sMin >= b.s && sMin < b.e);
    if (!blk) return false;                      // 不在任何大块内（如洗漱）→ 并行规则可用
    return D.slots.some(x =>
      x.kind === "study" &&
      toMin(x.start) >= blk.s && toMin(x.end) <= blk.e &&
      toMin(x.start) >= eMin);                   // 本时段之后（含贴接）的同块学习时段
  }
  /* ★ v1.60.0 置后定则的**出口**：下一个「之后无正经安排」的收尾段。
   * 由来：置后定则历来只说「不能现在做」，从不说「推到什么时候」——
   *   执行时最容易卡在这一句（推 30 分钟？推到几点？），于是干脆不推、直接接了。
   * 口径（2026.7.2 定义 + 2026.9.27 升级）：
   *   非学习时段 AND 本大块内其后无学习 AND 未被晚自习/睡眠硬禁窗覆盖。
   * 找不到就如实说「今日无合格窗口」——此时唯一出口是文字或改约明天，不能再含糊。 */
  function nextDeferWindow(dateKey, nowMin) {
    const SD = window.SCHEDULE_DATA;
    const k = dateKey || keyBJ(window.Blocks ? window.Blocks.beijing(new Date()) : new Date());
    const t = (typeof nowMin === "number") ? nowMin : Math.floor(nowSecBJ() / 60);
    if (!SD || !SD.slots) return null;
    return SD.slots.filter(s => {
      const sm = toMin(s.start);
      if (s.kind === "study") return false;
      if (toMin(s.end) <= t) return false;                          // 已过去
      if (blockHasStudyAfter(s)) return false;                      // 之后还排着学习 → 不算置后到位
      if (nightStudyBlocking(k, sm) || nightStudySoftBlocking(k, sm) || sleepWindowBlocking(k, sm)) return false;
      return true;
    }).sort((a, b) => toMin(a.start) - toMin(b.start))[0] || null;
  }
  function deferWindowText(dateKey, nowMin) {
    const s = nextDeferWindow(dateKey, nowMin);
    return s ? `${cleanName(s.name)} ${s.start}~${s.end}` : "";
  }
  /* ★ v1.23.0 特殊管理日：28~32日接通总时长上限（0 = 全天不接） */
  /* ==================== ★ v1.37.0 周长闸 / 日闸 / 奇偶日规则 ====================
   * 用户 2026.10.07 指定（原话）：
   *   「12 日以后：改为，每周以日期分为偶数日和奇数日，奇数日可以接听，
   *     偶数日每周只能接听 1 个偶数日，每周通话总时长限制为 120 分钟，
   *     每日通话最多 40min。（避免一天通话把全周的额度都占完了）」
   * 并已确认：① 硬阻断、豁免不可覆盖；② 取消「每周 6 次」次数闸，纯时长口径。
   * ========================================================================== */

  /* 周次数闸哨兵：maxPerWeek 为 null（已取消）→ 返回 Infinity，让所有既有比较自然跳过。
   * ⚠️ 不直接把 null 拿来比大小：0 >= null 在 JS 里为 true，会误判成"额度已用尽"。 */
  function weeklyCountCap() {
    const q = D.weeklyRule && D.weeklyRule.maxPerWeek;
    return (typeof q === "number" && q > 0) ? q : Infinity;
  }
  /* 展示用「N/M 天 · 」片段；次数闸取消时返回空串，页面自动不出现这一段。
   * ★ v1.93.0：口径由「次」改为「天」（calcWeeklyCallCount 现在数的是**通话日**，
   *   原「N/M 次」会让人以为一天能打好几通——实际一天通几通都只算 1 天）。 */
  function weeklyCountSlot(cur) {
    const q = weeklyCountCap();
    return q === Infinity ? "" : `${cur}/${q} 天 · `;
  }
  /* 日时长闸（min）；null/0 = 不设日闸。
   * ★ v1.93.0：原注释写「与奇偶日同闸门」——奇偶日已废止，日闸是**独立**闸口。 */
  function dayMinCap(dateKey) {
    const v = D.weeklyRule && D.weeklyRule.maxMinPerDay;
    return (typeof v === "number" && v > 0) ? v : 0;
  }
  function keyBJ(d) { const z = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
  /* ★ v1.93.0：通话「一天」改为**业务日**——北京时间 04:00 换天（与主站 Blocks.bizDateStr 同源）。
   *   旧口径按自然日 00:00 换天，把「23:34 开始、00:19 结束」的一通电话劈成两天：
   *   既让连续通话天数虚增，也让深夜通话在跨零后归属到错的日子。
   *   用户 2026-10-25 指定：04:00 之后至次日 04:00 之前，均算同一天。 */
  function bizKeyOf(ts) {
    const B = window.Blocks;
    if (B && typeof B.bizDateStr === "function") return B.bizDateStr(ts == null ? Date.now() : ts);
    const b = (B && B.beijing) ? B.beijing(new Date(ts == null ? Date.now() : ts)) : new Date(ts == null ? Date.now() : ts);
    if (b.getHours() < 4) b.setDate(b.getDate() - 1);
    const z = n => String(n).padStart(2, "0");
    return `${b.getFullYear()}-${z(b.getMonth() + 1)}-${z(b.getDate())}`;
  }
  function todayBizKey() { return bizKeyOf(Date.now()); }
  function parseKey(k) { const p = String(k).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function weekMondayKey(k) { const d = parseKey(k); const dow = d.getDay() || 7; d.setDate(d.getDate() - (dow - 1)); return keyBJ(d); }
  /* ★ v1.93.0（用户 2026-10-25 指定）：**奇偶日策略整体取消**。
   *   原「奇数日可接 · 偶数日每周限 1 天」的 isOddDayNum / oddEvenActive /
   *   evenCallDaysThisWeek 连同判定分支一并删除。
   *   理由：它按「几号」的奇偶决定能不能接，与当天学习安排毫无关系；且与新的
   *   「周 4 天 + 不连续 3 天」双重计数，会出现"偶数日明明额度充足却被拦"的怪象。
   *   call-data.js 的 weeklyRule.oddEven 配置保留但不读（留痕，防止旧代码复活）。 */
  /* ★ v1.43.0：「特殊管理日」整套读値函数（specialDaysList / capAllows / specialDayInfo /
   *   specialDayLabel）已随功能一并删除。specialPlan.days 现为空数组，留着它们只会让
   *   后来的维护者以为「这套还在生效」——历史 14 天配置见
   *   `docs/通话边界-特殊管理期分析报告-20261012.md`，不要在这里回填。 */

  /* ★ v1.24.3 某天实际接通总秒数（★ v1.93.0 改业务日口径：04:00 换天；双闹钟 + 补记都算）
   * ★ v1.101.0：拆出「秒」版本 —— 分钟版要拿去展示「今日已通话」，而展示值还要并入
   *   **正在进行的通话**（按窗口切分后的秒数）。若先各自取整再相加，不足 1 分钟的部分
   *   会被抹掉两次，展示值会比真实值小 1 —— 所以统一先加秒、最后一次性取整。 */
  function dayCallSec(dateKey) {
    const recs = Store.getTimeRecords() || [];
    let sec = 0;
    recs.forEach(r => {
      if (!isCallRec(r) || !r.started_at) return;
      if (bizKeyOf(r.started_at) === dateKey) sec += Number(r.duration_sec) || 0;
    });
    return sec;
  }
  function dayCallMin(dateKey) { return Math.round(dayCallSec(dateKey) / 60); }
  /* ★ v1.93.0：「算不算一个有通话的日子」= 当天接通总时长 > 5 分钟（用户 2026-10-25 拍板）。
   *   目的：3 分钟以内的简短通话（如"我到了"/挂断确认）不该消耗周配额、也不该续上连续链。 */
  const CALL_DAY_MIN_THRESHOLD = 5;
  function isCallDay(dateKey) { return dayCallMin(dateKey) > CALL_DAY_MIN_THRESHOLD; }
  /* 往前数连续通话日：从 endKey 当天起往前，返回 { days:[...], len }（含 endKey 当天）。
   *   跨周照算（用户明确要求「含跨周通话」）。 */
  function consecutiveCallDaysBefore(endKey, hasManual) {
    const out = [];
    let k = endKey;
    for (let i = 0; i < 60; i++) {
      if (!isCallDay(k)) break;
      out.push(k);
      k = prevDayKey(k);
    }
    return out;
  }
  function prevDayKey(k) {
    const d = parseKey(k); d.setDate(d.getDate() - 1);
    const z = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  /* 该业务日是否有「补记/回填」类通话（连续 3 天以上时的加重档判据） */
  function dayHasManualCall(dateKey) {
    const recs = Store.getTimeRecords() || [];
    return recs.some(r => isCallRec(r) && r.started_at &&
      bizKeyOf(r.started_at) === dateKey &&
      (r.source === "call_manual" || r.source === "manual_backfill"));
  }
  /* ★ v1.93.0「今日状态」两个按钮（用户 2026-10-25 指定，规则部置后定则相关·强制规则）
   *   ① 今日有加时自习 → 23:00–24:00 调剂段不再接受垃圾时间调剂，直接禁止通话；
   *   ② 今日不聊天     → 当天全天禁止接听。
   *   按业务日（凌晨 4 点）自动重置——用户不必记得次日来取消，
   *   也不会出现"昨晚设的不聊天，今天下午还在生效"。
   *
   * ★ v1.97.0（用户 2026-10-25 指定）：升为**重要功能**，三件事一起补：
   *   ① 可逆 —— 再按一次取消（原本就是 toggle，但要让人看得见，见 renderTodayMode 文案）；
   *   ② 记录 —— 按天一行留档，可回看「哪几天按过什么」；
   *   ③ 多端同步 —— 手机按了，平板打开就得知道。
   *   落地方式：**localStorage（快、离线可用）+ events 表 `tm-<业务日>` 行（跨端、留档）**双写。
   *     · events 是权威源、LS 是缓存：读的时候 LS 命中就直接返回（O(1)），
   *       没命中才回查 events（别的设备按的），并回写 LS；
   *     · 云端变更（另一台设备改的）靠 subscribeEvents 强制以云端为准 ——
   *       否则「A 设备取消、B 设备还以为在生效」这种不一致会一直挂着；
   *     · 复用 events 表，**不新建表、不改 Supabase 结构**（与签到 ck-* / 违规 viol-* 同一张）。
   *   ⚠️ 行 id 前缀 `tm-` 必须唯一于本模块：checkin 读 ck-*、violation 读 viol-*、本模块读 tm-*。
   *     将来再加前缀，先 grep 确认没撞。 */
  const TODAY_MODE_LS = "kaoyan:call_today_mode";
  const TODAY_MODE_PREFIX = "tm-";
  const TODAY_MODE_TITLE = "call-todaymode";
  let _tmWriting = false;   // 我方写云端时抑制 subscribe 回调，防「写→读→写」自激

  function _tmEmpty() { return { date: todayBizKey(), extraStudy: false, noChat: false }; }
  function _tmReadLS() {
    try {
      const o = JSON.parse(localStorage.getItem(TODAY_MODE_LS)) || null;
      if (!o || o.date !== todayBizKey()) return null;   // 隔天 / 无记录 → 视为未命中
      return { date: o.date, extraStudy: !!o.extraStudy, noChat: !!o.noChat };
    } catch (e) { return null; }
  }
  function _tmWriteLS(m) {
    try { localStorage.setItem(TODAY_MODE_LS, JSON.stringify(m)); } catch (e) {}
  }
  /* note 编码 = 逗号分隔的开关名；空串表示「明确两个都没按」。
   * 用可读串而不是 JSON：这一行可能被人直接在云端看，写成 {"extraStudy":false} 反而难认。 */
  function _tmEncode(m) {
    return [m.extraStudy ? "extraStudy" : "", m.noChat ? "noChat" : ""].filter(Boolean).join(",");
  }
  function _tmDecode(dateKey, note) {
    const s = String(note || "");
    return { date: dateKey, extraStudy: s.indexOf("extraStudy") >= 0, noChat: s.indexOf("noChat") >= 0 };
  }
  function _tmRowId(k) { return TODAY_MODE_PREFIX + (k || todayBizKey()); }
  function _tmFromEvents() {
    if (!Store || typeof Store.getEvents !== "function") return null;
    const k = todayBizKey();
    const row = (Store.getEvents() || []).filter(e => e && e.id === _tmRowId(k))[0];
    return row ? _tmDecode(k, row.note) : null;
  }
  function _tmWriteEvents(m) {
    if (!Store || typeof Store.setEvents !== "function" || typeof Store.getEvents !== "function") return;
    const id = _tmRowId(m.date);
    const note = _tmEncode(m);
    const arr = (Store.getEvents() || []).filter(e => e && e.id);
    const i = arr.findIndex(e => e.id === id);
    const row = { id, user_id: (C && C.USER_ID) || "", date: m.date, title: TODAY_MODE_TITLE, note };
    if (i >= 0) {
      /* 内容没变就不写：events 走整表 upsert，虽然增量推送会按指纹比对，
       * 但少写一次就少一次无谓的写入与 realtime 消息。 */
      if (String(arr[i].note || "") === note) return;
      arr[i] = row;
    } else {
      arr.push(row);
    }
    _tmWriting = true;
    try { Store.setEvents(arr); } finally {
      /* 下一轮再放开：setLocal 是同步的，广播/订阅回调可能排在其后。 */
      setTimeout(() => { _tmWriting = false; }, 0);
    }
  }
  function todayMode() {
    const local = _tmReadLS();
    if (local) return local;
    const remote = _tmFromEvents();     // 别的设备按的 → 本机第一次打开也能看到
    if (remote) { _tmWriteLS(remote); return remote; }
    return _tmEmpty();
  }
  function setTodayMode(patch) {
    const next = Object.assign(todayMode(), patch, { date: todayBizKey() });
    _tmWriteLS(next);
    _tmWriteEvents(next);
    renderTodayMode();
    /* 状态变了 → 结论必须立刻重算，否则按钮按下去判定卡还是旧结论 */
    try { if (typeof refreshCallDecision === "function") refreshCallDecision(); } catch (e) {}
    /* 闪卡也要跟着变（用户 2026-10-25 明确要求「含闪卡」） */
    try { if (typeof renderControlFlash === "function") renderControlFlash(); } catch (e) {}
    return next;
  }
  /* 云端变了（另一台设备按的 / 取消的）→ 以云端为准覆盖本地。
   * ⚠️ _tmWriting 期间直接跳过：那是我方自己刚写进去的，再读回来只会空转。 */
  function _tmApplyRemote() {
    if (_tmWriting) return;
    const remote = _tmFromEvents();
    const next = remote || _tmEmpty();
    const cur = _tmReadLS() || _tmEmpty();
    if (cur.extraStudy === next.extraStudy && cur.noChat === next.noChat) return;
    _tmWriteLS(next);
    renderTodayMode();
    try { if (typeof refreshCallDecision === "function") refreshCallDecision(); } catch (e) {}
    try { if (typeof renderControlFlash === "function") renderControlFlash(); } catch (e) {}
  }
  function renderTodayMode() {
    const m = todayMode();
    const b1 = document.getElementById("btnExtraStudy");
    const b2 = document.getElementById("btnNoChat");
    const note = document.getElementById("todayModeNote");
    if (b1) {
      b1.classList.toggle("is-on", m.extraStudy);
      b1.setAttribute("aria-pressed", m.extraStudy ? "true" : "false");
      /* 按下后再点即取消 —— 按钮上直接写出来，不然没人会去试第二下 */
      b1.innerHTML = '<span data-icon="book-open"></span>' + (m.extraStudy ? "✓ 今日有加时自习（再按取消）" : "今日有加时自习");
    }
    if (b2) {
      b2.classList.toggle("is-on", m.noChat);
      b2.setAttribute("aria-pressed", m.noChat ? "true" : "false");
      b2.innerHTML = '<span data-icon="smartphone-off"></span>' + (m.noChat ? "✓ 今日不聊天（再按取消）" : "今日不聊天");
    }
    /* 按钮的 innerHTML 刚被重建过，图标 span 需要重新注入一次（只注入本块，不动全页） */
    const tmHost = document.querySelector(".call-todaymode");
    if (tmHost && window.Icon) window.Icon.inject(tmHost);
    if (note) {
      note.innerHTML = m.noChat
        ? '<b>已设「今日不聊天」</b> → 今天全天禁止接听（含 23:00–24:00 调剂段），不设例外。<br>' +
          '首屏闪卡已置顶这张、判定卡与「点闪卡问裁定」都会直接给严禁结论。' +
          '<br>要改主意：<b>再按一次同一个按钮</b>即取消；或等凌晨 4 点自动解除。'
        : (m.extraStudy
          ? '<b>已设「今日有加时自习」</b> → 23:00–24:00 调剂段禁止通话（不再接受垃圾时间调剂），其余时段仍按原规则。' +
            '<br>要改主意：<b>再按一次同一个按钮</b>即取消；或等凌晨 4 点自动解除。'
          : '都没按 = 按常规规则走。建议下班前就按，别等电话响了再决定。<br>' +
            '两个按钮都<b>可以再按一次取消</b>；按过的那天会留一条记录，方便以后回看。');
    }
  }
  /* ==================== ★ v1.43.0 长期禁接窗：每日晚自习（核心 18:30–23:00 + 延展 23:00–24:00）====================
   * 用户 2026.10.12 指定（原话）：
   *   「每日晚上18:30-23:40，为晚自习核心时间，禁止接听电话，不得有任何例外」
   * 两点实现约定：
   *   · **判定与展示同源**：只读 D.nightStudy（与 controlFlash 的 night-study-longterm 条目
   *     写成同一组时间），避免「卡片说不能接、判定却放行」——本项目踩过的坑（交接文档 §6.7）。
   *   · **硬阻断且豁免不可覆盖**：在 evaluateCallDecision() 里排在睡眠之后、
   *     专注/邀约/周额度之前；quota_extra / necessary 两类豁免均不能绕过。
   * ★ 与已停用的 specialPlan 的区别：specialPlan 是**逐日**手排（挂在某一天上），
   *   本机制是**每日**常设、无截止日。 */
  function nightStudyInfo() {
    const ns = D.nightStudy || {};
    if (!ns.enabled || !ns.offFrom || !ns.offTo) return null;
    return ns;
  }
  /* 是否处于晚自习核心时间窗内。参数均可省略（默认取当前北京时间）；
   * 传入 dateKey/nowMin 只为**可测试**——断言脚本能逐个时刻算真实输出。 */
  function nightStudyBlocking(dateKey, nowMin) {
    const ns = nightStudyInfo();
    if (!ns) return false;
    const k = dateKey || keyBJ(window.Blocks ? window.Blocks.beijing(new Date()) : new Date());
    if (ns.since && String(k) < String(ns.since)) return false;   // 未到生效日
    const t = (typeof nowMin === "number") ? nowMin : Math.floor(nowSecBJ() / 60);
    const s0 = toMin(ns.offFrom), e0 = toMin(ns.offTo);
    return s0 <= e0 ? (t >= s0 && t < e0) : (t >= s0 || t < e0);   // 后半段兼容跨午夜写法
  }
  /* ★ v1.47.6（用户 2026.10.17 指定）三个窗口共用同一套「在窗内」算法，
   *   抽成公共函数：任一处改口径，三个窗口同步跟随，不会各说各话。 */
  function inWindow(ns, from, to, dateKey, nowMin, sinceOverride) {
    const k = dateKey || keyBJ(window.Blocks ? window.Blocks.beijing(new Date()) : new Date());
    const since = sinceOverride || ns.since;
    if (since && String(k) < String(since)) return false;   // 未到生效日
    const t = (typeof nowMin === "number") ? nowMin : Math.floor(nowSecBJ() / 60);
    const s0 = toMin(from), e0 = toMin(to);
    return s0 <= e0 ? (t >= s0 && t < e0) : (t >= s0 || t < e0);   // 后半段兼容跨午夜写法
  }
  /* ★ v1.47.6 晚自习**延展段** 23:00–24:00（v1.94.0 由 23:40 延长）：仍是晚自习，但**接受垃圾时间调剂** ——
   * 返回 true = 此刻属于延展段（只有确认是垃圾时间后才可接听，见 evaluateCallDecision）。
   * ★ v1.94.0（用户 2026-10-25）：终点延长到 **24:00**，接管原睡眠段的 23:40–24:00。
   *   24:00 即次日 00:00，与睡眠段在钟点上首尾相接（无三不管地带）。 */
  function nightStudySoftBlocking(dateKey, nowMin) {
    const ns = nightStudyInfo();
    if (!ns || !ns.softFrom || !ns.softTo) return false;
    return inWindow(ns, ns.softFrom, ns.softTo, dateKey, nowMin, ns.softSince);
  }
  /* ★ v1.50.0 **睡眠段 23:40–07:00**：不得通话（硬阻断，只看钟点）。
   *   ★ v1.50.0（2026.10.17 修订）起点由 00:00 前移至 23:40 —— 含「准备睡觉」；
   *     缓冲 00:05 → 23:45。
   *   ★★★ v1.94.0（用户 2026-10-25 指定，原话）：「强制睡觉时间改为：次日 0:00 开始」
   *   → 起点**改回 00:00**、缓冲改回 **00:05**；23:40–24:00 移交晚自习延展段
   *   （见 nightStudySoftBlocking，需确认垃圾时间才可接）。
   * 与上方 timerSleeping 的区别：那条看主站**是否正在计时睡眠**，本条**只看钟点**，
   * 一过 00:00 即不得通话，与主站有没有在计时无关。 */
  function sleepWindowBlocking(dateKey, nowMin) {
    const ns = nightStudyInfo();
    if (!ns || !ns.sleepFrom || !ns.sleepTo) return false;
    return inWindow(ns, ns.sleepFrom, ns.sleepTo, dateKey, nowMin, ns.sleepSince);
  }
  /* 已在通话中时的最晚结束时刻（只用于提醒文案，不做自动挂断） */
  /* ★ v1.94.0：兜底默认值随起点后移 23:45 → 00:05（配置缺失时的安全值）。
   * ★ v1.106.0：起点再后移 00:00 → 00:30，兜底同步 00:35（缓冲恒为 5 分钟）。 */
  function sleepEndByText() { const ns = nightStudyInfo(); return (ns && ns.sleepEndBy) || "00:35"; }

  /* ==================== ★ v1.37.0 管控闪卡（通话页置顶）====================
   * 用户 2026.10.07：「10月7日-10月11日新增规定：每日18:30~23:00为晚自习特殊专属时间，
   *   不得任何理由的接打电话。本条规定在执行的时候，请以闪卡的形式在合适的地方进行展示。」
   * 三条设计约束（与 violation.js 的惩罚闪卡对齐）：
   *   ① 只展示、不判定——真正的阻断在 evaluateCallDecision() / weeklyRule / specialPlan，
   *      绝不出现"卡片说能接、判定说不能"的分叉；
   *   ② 数据驱动(= D.controlFlash)，到期自动退场，不用回改代码；
   *   ③ 期内三态随真实时间跳变：窗前倒计时 → 窗中生效中 → 窗后收工结算。 */
  function activeControlFlashItems(dateKey) {
    const list = D.controlFlash || [];
    return list.filter(c => String(dateKey) >= String(c.since) && (!c.until || String(dateKey) <= String(c.until)));
  }
  function hhmmOf(t) { const [h, m] = String(t).split(":").map(Number); return `${p(h || 0)}:${p(m || 0)}`; }

  /* ★ v1.49.0（用户 2026.10.17 指定）：三张时段闪卡改为「按时段自动切换的单卡轮播」。
   *   用户原话：「这 3 个闪卡其实是每一天的 3 个时段，在固定时段中需要提醒固定的内容……
   *   在相关管控时间前一个小时开始，在通话边界管理系统的顶部展现固定的闪卡，直至管控解除；
   *   添加一个小跳转按钮，如果想要看其他的闪卡，可以点击该按钮进行查看。」
   *   落地规则：
   *     ① 每张时段卡的可见区间 = [管控开始前 60 分钟, 管控解除) —— 解除即退场，不再常驻，
   *        因此白天 07:00–17:30 这段没有任何时段卡（那时确实无管控）。
   *     ② 候选可能不止一张（22:00 之后三段相邻/重叠）：按「正在生效 > 距开始更近」取唯一一张，
   *        否则 22:30 会同时挂出核心段（生效中）和睡眠段（1.5 小时后），顶部又变成一堵墙。
   *     ③ 完全没有候选时退回展示长期规则卡（summary），保留它原先的常驻效果，信息不丢。
   *     ④ ‹ › 手动翻页，翻过之后停在该张不被打回（flashPick）；点「回到当前时段」恢复自动跟随。
   *   ⚠️ 仍然只做展示：判定链一行未动，也没有为此新增任何判定分支。 */
  const FLASH_LEAD_MIN = 60;   // 提前展示的分钟数（用户指定「前一个小时」）
  let flashPick = null;        // null = 自动跟随当前时段；数字 = 用户手动选中的序号

  function flashRange(c) {
    const s = toMin(c.offFrom), e = toMin(c.offTo);
    /* leadMin 可按卡覆盖（默认 60）；写成可选字段是为了将来某段想提前 2 小时提醒时不必改代码 */
    const lead = Number.isFinite(Number(c.leadMin)) && Number(c.leadMin) >= 0 ? Number(c.leadMin) : FLASH_LEAD_MIN;
    return { s, e, from: ((s - lead) + 1440) % 1440 };
  }
  /* 区间判断，支持跨午夜：from > to 表示绕过零点（睡眠段 23:00 前置期 → 07:00 解除） */
  function inMinRange(n, from, to) { return from <= to ? (n >= from && n < to) : (n >= from || n < to); }
  /* 倒计时文案：不足 1 小时只说「X 分钟」，避免「0 小时 42 分」这种别扭读法 */
  function fmtLeftMin(left) {
    const t = ((left % 1440) + 1440) % 1440;
    return t < 60 ? `${t} 分钟` : `${Math.floor(t / 60)} 小时 ${t % 60} 分`;
  }
  /* 单张卡的三态（窗前倒计时 / 窗中生效 / 已过终点）—— 抽出来供自动焦点与渲染共用 */
  function flashStateOf(c, nowMin, j) {
    const soft = c.kind === "softWindow";
    const { s, e } = flashRange(c);
    if (inMinRange(nowMin, s, e)) {
      const left = (e - nowMin + 1440) % 1440;
      /* ★ v1.52.0：live:true = 「此刻正在生效」，渲染时额外挂 .cflash-live 类，
       *   供 CSS 只给这一段加呼吸动效。**必须用独立标记而不是复用 cls**：
       *   cls="wait" 同时被「延展段生效中」和「今晚生效（还没开始）」共用，
       *   靠 cls 判断会把尚未开始的卡也点亮。 */
      return { cls: soft ? "wait" : "on", live: true,
        txt: soft ? "生效中 · 可调剂" : "生效中 · 不得接听",
        extra: `剩余 ${fmtLeftMin(left)}` };
    }
    /* **窗口已过去**（如 08:00 手动翻到核心段 / 睡眠段）→ 今天这次确实结束了。
     * ★ v1.106.0 修：原判据是 `(s > 0) && (s <= e) && (nowMin >= e)`，靠 `s > 0` 把
     *   凌晨窗口（睡眠段起点为 0 时）排除掉，让它永远显示「今晚生效」。
     *   可睡眠段起点改为 00:30 后 s=30 不再被排除，而它的前置期从 23:30 就开始
     *   （flashRange 的 from 跨午夜）——23:30 时 `nowMin(1410) >= e(420)` 成立，
     *   会被误判成「今日管控结束」，可实际上 60 分钟后就要强制睡觉。
     *   用户最需要提醒的那一小时，卡片反而说"结束了"。
     *   → 改成「离终点更近，还是离下一次开始更近」（两端取近）：
     *     08:00 → 距终点 60 / 距开始 960 → done；
     *     23:30 → 距终点 990 / 距开始 60 → wait。 */
    const sinceEnd = (nowMin - e + 1440) % 1440;
    const toStart = (s - nowMin + 1440) % 1440;
    if (sinceEnd < toStart) {
      return { cls: "done",
        txt: (j.curDayMin > 0) ? "今日管控结束 · 已通话，注意核对" : "今日管控结束 ✅ 达成",
        extra: (j.curDayMin > 0 ? `今日通话 ${j.curDayMin} 分钟` : "全程未接听，达成") };
    }
    return { cls: "wait", txt: "今晚生效", extra: `距管控开始还有 ${fmtLeftMin(toStart)}` };
  }

  /* 自动焦点：只在「已进入前置期、且尚未解除」的时段卡里挑，取约束最强的一张。
   * 抽成独立纯函数是为了能被断言脚本直接调用（渲染函数依赖 DOM，测不了）。 */
  function pickAutoFlash(winItems, nowMin) {
    let auto = -1, bestRank = 99, bestLeft = Infinity;
    winItems.forEach((c, i) => {
      const { s, e, from } = flashRange(c);
      if (!inMinRange(nowMin, from, e)) return;          // 未到前置期 / 已解除 → 不参与
      const rank = inMinRange(nowMin, s, e) ? 0 : 1;     // 0 = 正在生效，1 = 即将开始
      const left = (s - nowMin + 1440) % 1440;
      if (rank < bestRank || (rank === bestRank && left < bestLeft)) { auto = i; bestRank = rank; bestLeft = left; }
    });
    return auto;
  }

  /* ★ v1.97.0（用户 2026-10-25 指定）：今日状态闪卡。
   *   按下按钮后首屏第一张必须是它 —— 用户原话「含闪卡及闪卡点击后的功能」。
   *   为什么**动态生成**而不写进 D.controlFlash：
   *     ① 它是当天状态，不是长期规则，写进数据表就变成"每天都在"；
   *     ② 它必须跟按钮实时联动，静态数据表做不到。
   *   ⚠️ 仍然只做展示：判定在 evaluateCallDecision / call-verdict 的 judgeChain 里，
   *     这张卡不参与任何计算（与所有闪卡的既有约定一致）。 */
  function todayModeFlashItem() {
    /* ⚠️ 读状态失败也必须让闪卡照常渲染：闪卡是"只做展示"的，
     *   不能因为 Store/本地存储出问题就整块消失（那等于静默失败，用户只会看到功能坏了）。 */
    let m;
    try { m = todayMode(); } catch (e) { return null; }
    if (!m || (!m.noChat && !m.extraStudy)) return null;
    const ns = D.nightStudy || {};
    const sf = ns.softFrom || "23:00", st = ns.softTo || "00:30";   // ★ v1.106.0 兜底随配置改（延展段已跨午夜）
    if (m.noChat) {
      return {
        id: "today-mode-nochat", kind: "summary", todayMode: true,
        icon: "smartphone-off", badge: "今日状态", tone: "night",
        headline: "今日不聊天 · 全天禁止",
        brief: "今天整体关闭（含 " + sf + "–" + st + " 调剂段）",
        rule: "不设例外、不接任何来电：来电直接拒接，或只回一句文字。凌晨 4 点自动解除，也可在页面下方再按一次取消。",
        basis: "你自己按下的 · 今日状态"
      };
    }
    return {
      id: "today-mode-extrastudy", kind: "summary", todayMode: true,
      icon: "book-open", badge: "今日状态", tone: "week",
      headline: "今日有加时自习",
      brief: sf + " – " + st + " 禁止通话",
      rule: "该段不再接受垃圾时间调剂，直接禁止；其余时段仍按原规则。凌晨 4 点自动解除，也可在页面下方再按一次取消。",
      basis: "你自己按下的 · 今日状态"
    };
  }

  function renderControlFlash() {
    const box = document.getElementById("controlFlash");
    if (!box) return;
    const bNow = window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
    const z = n => String(n).padStart(2, "0");
    const todayKey = `${bNow.getFullYear()}-${z(bNow.getMonth() + 1)}-${z(bNow.getDate())}`;
    const tmItem = todayModeFlashItem();
    const baseItems = activeControlFlashItems(todayKey);
    const items = tmItem ? [tmItem].concat(baseItems) : baseItems;
    if (!items.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    const nowMin = Math.floor(nowSecBJ() / 60);
    const j = judgeToday();

    /* 分两拨：时段卡（参与自动切换）与其余卡（summary 长期规则，没有时段概念，只跟着排在手翻序列后面） */
    const isWin = c => c.kind === "offWindow" || c.kind === "softWindow";
    const winItems = items.filter(isWin);
    const restItems = items.filter(c => !isWin(c));
    /* ★ v1.97.0：今日状态卡**永远置顶**。
     *   时段卡是系统按钟点推的，今日状态卡是用户本人刚按下的决定 ——
     *   不能让它被「22:30 正好有两张时段卡」挤到第二屏去。 */
    const tmItems = restItems.filter(c => c.todayMode);
    const seq = tmItems.concat(winItems, restItems.filter(c => !c.todayMode));

    /* 自动焦点：只在「已进入前置期、且尚未解除」的时段卡里挑，取约束最强的一张 */
    let auto = pickAutoFlash(winItems, nowMin);
    /* 白天没有任何时段可提醒 → 退回长期规则卡（原来它一直常驻，这里保住这个效果） */
    if (auto < 0 && restItems.length) auto = winItems.length;

    const autoPick = tmItem ? 0 : auto;
    const pick = (flashPick !== null && flashPick >= 0 && flashPick < seq.length) ? flashPick : autoPick;
    if (pick < 0 || !seq[pick]) { box.style.display = "none"; box.innerHTML = ""; return; }
    const manual = flashPick !== null && flashPick !== autoPick;

    const c = seq[pick];
    const icon = `<span class="cflash-icon"><span data-icon="${esc(c.icon || "phone")}"></span></span>`;
    let cardHtml;
    if (c.kind === "summary") {
      cardHtml = `<div class="cflash cflash-${esc(c.tone || "week")}">
        ${icon}
        <div class="cflash-body">
          <div class="cflash-top"><span class="cflash-badge">${esc(c.badge || "管控")}</span><span class="cflash-headline">${esc(c.headline)}</span></div>
          <div class="cflash-brief">${esc(c.brief)}</div>
          <div class="cflash-rule">${esc(c.rule)}</div>
          <div class="cflash-foot"><span class="cflash-basis">${esc(c.basis)}</span></div>
        </div>
        <div class="cflash-state cflash-state-live">${c.todayMode ? "今日有效" : "长期执行"}</div>
      </div>`;
    } else {
      const st = flashStateOf(c, nowMin, j);
      /* ★ v1.52.0：只有「此刻正在生效」的时段卡挂 .cflash-live（呼吸动效的开关）。
       *   summary 长期规则卡与违规闪卡都不会经过这里 → 天然不受影响。 */
      cardHtml = `<div class="cflash cflash-${esc(c.tone || "night")} cflash-${st.cls}${st.live ? " cflash-live" : ""}">
        ${icon}
        <div class="cflash-body">
          <div class="cflash-top"><span class="cflash-badge">${esc(c.badge || "管控")}</span><span class="cflash-headline">${esc(c.headline)}</span></div>
          <div class="cflash-brief">${esc(c.brief || (hhmmOf(c.offFrom) + " – " + hhmmOf(c.offTo)))}</div>
          <div class="cflash-rule">${esc(c.rule)}</div>
          <div class="cflash-foot"><span class="cflash-basis">${esc(c.basis)}</span><span class="cflash-extra">${esc(st.extra)}</span></div>
        </div>
        <div class="cflash-state cflash-state-${st.cls}">${esc(st.txt)}</div>
      </div>`;
    }

    /* 手翻导航：序列只有 1 张时不给按钮（点了没变化，反而像坏了） */
    const nav = seq.length > 1 ? `<div class="cflash-nav">
        <button type="button" class="cf-nav" data-flash-dir="-1" aria-label="上一张闪卡">‹</button>
        <span class="cf-idx">${pick + 1} / ${seq.length}</span>
        <button type="button" class="cf-nav" data-flash-dir="1" aria-label="下一张闪卡">›</button>
        ${manual ? '<button type="button" class="cf-auto" id="cfAutoBtn">回到当前时段</button>' : ""}
      </div>` : "";

    box.style.display = "";
    box.innerHTML = cardHtml + nav;
    if (window.Icon) window.Icon.inject(box);
    box.querySelectorAll(".cf-nav").forEach(btn => {
      btn.addEventListener("click", () => {
        const dir = Number(btn.dataset.flashDir) || 1;
        flashPick = ((pick + dir) + seq.length) % seq.length;
        renderControlFlash();
      });
    });
    const autoBtn = document.getElementById("cfAutoBtn");
    if (autoBtn) autoBtn.addEventListener("click", () => { flashPick = null; renderControlFlash(); });
    renderViolationFlash();   // ★ v1.47.0 违规闪卡与管控闪卡同源刷新（两卡并列，先后一致）
  }

  /* ★ v1.47.0 违规惩罚闪卡（用户 2026.10.15 指定）：「违规惩罚期间不得通话」，
   *   在本页最上方与管控闪卡**并列**显示。
   *   ⚠️ 只做提醒：evaluateCallDecision / 豁免申请 / 判定脚本一行未动。
   *   · 数据单一来源 = window.VIOLATION（violation.js 导出），本页**不复制**惩罚期算法
   *     （inPenalty / remainDays / penaltyEndKey / RULES 全部直接调用），
   *     否则首页家规卡与通话站两套口径必然分叉。
   *   · 布局并列：两个独立 .cflash-wrap 容器，flex 纵向堆叠，互不覆盖。 */
  function renderViolationFlash() {
    const box = document.getElementById("violationFlash");
    if (!box) return;
    const V = window.VIOLATION;
    if (!V || typeof V.inPenalty !== "function" || !V.inPenalty()) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    const days = V.remainDays ? V.remainDays() : 0;
    const endKey = String((V.penaltyEndKey && V.penaltyEndKey()) || "");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endKey);
    const endCn = m ? `${Number(m[2])}月${Number(m[3])}日` : endKey;
    /* 其余禁项类目：本页主题是「通话」，故把通话提到主句，其余类目在副文案带出。
       类目名仍取自 V.RULES（单一来源），不手写，避免与首页家规卡口径分叉。 */
    const others = (V.RULES || []).filter(r => r.name !== "通话").map(r => r.name).join(" / ");
    box.style.display = "";
    box.innerHTML = `<div class="cflash cflash-on">
      <span class="cflash-icon"><span data-icon="smartphone-off"></span></span>
      <div class="cflash-body">
        <div class="cflash-top"><span class="cflash-badge">违规惩罚中</span><span class="cflash-headline">惩罚期间 · 不得通话</span></div>
        <div class="cflash-brief">与上方时段管控无关 —— 这条在整个惩罚期内持续生效</div>
        <div class="cflash-rule">同时禁止${esc(others ? "：" + others : "")}（口径与首页家规卡一致）</div>
        <div class="cflash-foot"><span class="cflash-basis">惩罚期至 ${esc(endCn)} · 期满自动恢复，无需申请</span></div>
      </div>
      <div class="cflash-state cflash-state-on">剩 ${days} 天</div>
    </div>`;
    if (window.Icon) window.Icon.inject(box);
  }

  // 秒 → 时长文案（此刻快照用；与 day-review.js 同款格式）
  function fmtDuration(sec) {
    // v1.21.3：统一走 UI.fmtDur（<1 分钟显示"29秒"，不再显示"0分"）
    return window.UI && window.UI.fmtDur ? window.UI.fmtDur(sec) : Math.max(0, Math.round(Number(sec) || 0)) + "秒";
  }
  // 展示名去掉括号备注（09.28 版时段名已不带括号；逻辑保留作兜底，如「上午自习（非实习日按 8:00 起床）」）
  function cleanName(n) { return String(n || "").replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim(); }

  /* ---------- 规则部特殊处理（豁免窗口）----------
   * 设计：学习区间不是"一刀切死"——大块时间内的短暂放松/垃圾时间可报规则部，
   * 人工判断后给一段临时豁免（默认 30 分钟），到期自动恢复限制；全程留痕便于复盘。
   * 存储：kaoyan:call_overrides = { quota_extra, necessary }；日报备次数 kaoyan:call_override_log。
   * 两类豁免只放行各自对应的限制，允许同时存在；旧 call_override 会幂等迁移。 */
  const OV_KEY = "kaoyan:call_overrides";
  const OV_LEGACY_KEY = "kaoyan:call_override";
  const OV_LOG_KEY = "kaoyan:call_override_log";
  /* ★ v1.45.0 申报台账（明细留痕）
   * 旧 OV_LOG_KEY 只存 {d, n}「今天申报了几次」，隔天清零、理由不落 →
   * 事后无法回答「这周申报几次、有没有滥用」，成长型复盘缺这块数据。
   * OV_REC_KEY 存明细数组，每条：
   *   { id, ts, date, type, reason, minutes, used, callMin, endedBy }
   *   used    = 这次豁免是否真的产生了通话（通话结束时回填）
   *   callMin = 实际通话分钟
   *   endedBy = null | "manual"（提前结束）| 到期由渲染时按 ts+minutes 推算，不写回
   * 上限 200 条（约够 3 个月），超出丢弃最旧的。 */
  const OV_REC_KEY = "kaoyan:call_override_records";
  const OV_REC_MAX = 200;
  function getOverrides() {
    try {
      let map = JSON.parse(localStorage.getItem(OV_KEY) || "null") || {};
      const legacy = JSON.parse(localStorage.getItem(OV_LEGACY_KEY) || "null");
      if (legacy && legacy.until > Date.now()) {
        const type = legacy.type === "necessary" ? "necessary" : "quota_extra";
        if (!map[type]) map[type] = { ...legacy, type };
      }
      if (legacy) localStorage.removeItem(OV_LEGACY_KEY);
      let changed = false;
      ["quota_extra", "necessary"].forEach(type => {
        if (map[type] && (!map[type].until || map[type].until <= Date.now())) {
          delete map[type]; changed = true;
        }
      });
      if (changed || legacy) localStorage.setItem(OV_KEY, JSON.stringify(map));
      return map;
    } catch (e) { return {}; }
  }
  function getOverride(type) { return getOverrides()[type] || null; }
  function overrideActive(type) {
    const map = getOverrides();
    return type ? !!map[type] : !!(map.quota_extra || map.necessary);
  }
  function overrideStateKey() {
    const map = getOverrides();
    return ["quota_extra", "necessary"].map(t => map[t] ? `${t}:${map[t].until}` : "-").join("|");
  }
  /* 两类真正的豁免：quota_extra = 本周第 5 次及以后；necessary = 正经时间内确实不得不。 */
  function setOverride(reason, minutes, type) {
    const o = { until: Date.now() + minutes * 60000, reason: reason || "特殊处理",
                type: type === "necessary" ? "necessary" : "quota_extra", at: Date.now() };
    try {
      const map = getOverrides();
      map[o.type] = o;
      localStorage.setItem(OV_KEY, JSON.stringify(map));
    } catch (e) {}
    // 日报备计数（用于复盘自律情况）—— 明细台账另写，见 pushOverrideRecord
    try {
      /* ★ v1.101.0：同改业务日（04:00 换天）。「今日申报了几次」与「今日已通话」
       *   必须是同一把尺，否则凌晨 3 点申报会被算到"新的一天"，当天的 2 次护栏形同虚设。 */
      const today = todayBizKey();
      const log = JSON.parse(localStorage.getItem(OV_LOG_KEY) || "null");
      const n = (log && log.d === today) ? (log.n || 0) + 1 : 1;
      localStorage.setItem(OV_LOG_KEY, JSON.stringify({ d: today, n }));
    } catch (e) {}
    pushOverrideRecord(o);
    return o;
  }

  /* ---------- 申报台账（v1.45.0）----------
   * 旧实现只有「今日申报 N 次」这一个数字，等于申报这件事**从未真正留痕**——
   * 弹窗里承诺的「已留痕」「进入每日复盘」，复盘页其实看不到任何申报记录。
   * 现在每次申报写一条明细，通话结束回填是否真的打了电话。 */
  /* ★ v1.101.0：台账日期同改业务日（04:00 换天），与 dayCallMin / todayCallMin 同口径。
   *   ⚠️ 存量记录的 date 仍是旧的自然日 —— 只有凌晨 0–4 点那段会显示成"前一天"，
   *   台账本身按 ts 排序展示，不做迁移（改历史日期比留着更危险）。 */
  function ovDateKey(ts) { return bizKeyOf(ts || Date.now()); }
  function getOverrideRecords() {
    try {
      const arr = JSON.parse(localStorage.getItem(OV_REC_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveOverrideRecords(arr) {
    try { localStorage.setItem(OV_REC_KEY, JSON.stringify(arr.slice(-OV_REC_MAX))); } catch (e) {}
  }
  function pushOverrideRecord(o) {
    const rec = {
      id: uid(), ts: o.at || Date.now(), date: ovDateKey(o.at),
      type: o.type, reason: o.reason || "", minutes: Math.round((o.until - (o.at || Date.now())) / 60000),
      used: false, callMin: 0, endedBy: null, endedAt: null
    };
    saveOverrideRecords(getOverrideRecords().concat([rec]));
    return rec;
  }
  /* 回填：这条豁免是否真的产生了通话（通话结束时调用，按快照里的类型回填最近一条未结束的同类型记录） */
  function markOverrideUsed(type, callMin) {
    if (!type) return;
    const arr = getOverrideRecords();
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].type === type && !arr[i].used && !arr[i].endedBy) {
        arr[i].used = true;
        arr[i].callMin = Math.round(callMin || 0);
        saveOverrideRecords(arr);
        return;
      }
    }
  }
  /* 提前结束（手动收手）——记 endedBy，区别于到期自动失效 */
  function markOverrideEnded(type, by) {
    if (!type) return;
    const arr = getOverrideRecords();
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].type === type && !arr[i].endedBy) {
        arr[i].endedBy = by || "manual";
        arr[i].endedAt = Date.now();
        saveOverrideRecords(arr);
        return;
      }
    }
  }
  function overrideTypeLabel(o) {
    /* ★ v1.45.0 口径修正：次数闸（每周 6 次）已于 v1.37.0 取消，
     * 现在 quota_extra 豁免的是**周 120 分钟时长闸**，不再叫「增加 1 次额度」。
     * 该文本会写进通话记录的 note，改名后旧记录仍保留旧文案（不影响历史）。 */
    return o && o.type === "necessary" ? "正经时间·确实不得不通话" : "周额度豁免（周时长闸）";
  }
  function clearOverride(type) {
    try {
      const map = getOverrides();
      if (type) delete map[type];
      else Object.keys(map).forEach(k => delete map[k]);
      localStorage.setItem(OV_KEY, JSON.stringify(map));
    } catch (e) {}
    /* ★ v1.45.0：提前收手同样留痕——「申报后又自己关掉」是自律的正向证据，
     * 旧实现把这次直接抹掉，复盘只看到"申报了 N 次"，看不到"其中 N-M 次自己收回了"。 */
    if (type) markOverrideEnded(type, "manual");
    else { markOverrideEnded("quota_extra", "manual"); markOverrideEnded("necessary", "manual"); }
  }
  function overrideCountToday() {
    try {
      const today = todayBizKey();   // ★ v1.101.0 业务日（04:00 换天），与今日已通话同尺
      /* ★ v1.45.0：以台账为准（明细可靠），旧 OV_LOG_KEY 仅作兼容兜底取较大值 */
      const fromRec = getOverrideRecords().filter(r => r.date === today).length;
      const log = JSON.parse(localStorage.getItem(OV_LOG_KEY) || "null");
      const fromLog = (log && log.d === today) ? (log.n || 0) : 0;
      return Math.max(fromRec, fromLog);
    } catch (e) { return 0; }
  }
  /* 理由历史（最近 3 次，本机）：快速复用，不跨端同步 */
  const REASON_HIST_KEY = "kaoyan:call_reason_history";
  function getReasonHistory(type) {
    try { return (JSON.parse(localStorage.getItem(REASON_HIST_KEY) || "{}")[type]) || []; }
    catch (e) { return []; }
  }
  function pushReasonHistory(type, reason) {
    try {
      const map = JSON.parse(localStorage.getItem(REASON_HIST_KEY) || "{}") || {};
      const arr = (map[type] || []).filter(r => r !== reason);
      arr.unshift(reason);
      map[type] = arr.slice(0, 3);
      localStorage.setItem(REASON_HIST_KEY, JSON.stringify(map));
    } catch (e) {}
  }
  function overrideMinutes() {
    const r = (D && D.rules) || {};
    return typeof r.overrideMinutes === "number" ? r.overrideMinutes : 30;
  }

  /* ---------- 通话记录的统一识别（v1.22.11）----------
   * call_boundary = 双闹钟记下的真实通话；call_manual = 「补记通话」的条目。
   * 两者都算"这次通话"（今日通话分钟 / 上次通话 / 周额度都计），
   * 区别只在主站是否显示：call_manual 被 today-records.js 排除在主站视图之外
   * （用户指示：补记暂不与主站时间记录联动）。 */
  function isCallRec(r) {
    return !!r && (r.source === "call_boundary" || r.source === "call_manual");
  }

  /* ---------- 今日通话分钟（#12）：从时间账本统计 + 手动补记 ----------
   * ★ v1.101.0（用户 2026-10-27 指出）：截断改成**业务日**（北京时间 04:00 换天）。
   *   旧实现用 Blocks.dateStr —— 那是**自然日 00:00 换天**，与全站「凌晨 4 点换天」
   *   根本不是同一把尺：实测 10-27 00:39 打的一通（业务日上属于 10-26）被算进「今日」，
   *   展示 68 分钟；而判定读的是 dayCallMin（业务日）只有 8 分钟 ——
   *   同一个「今日」屏幕上两个数，日闸 40 分钟到底到没到，看的人自己都判不了。
   *   两条口径从此对齐：
   *   · 已结束的记录：按 started_at 的业务日归属（与 dayCallMin / 周统计同口径，不另起炉灶）；
   *   · 正在进行的通话：只计**落在今天业务日窗口内**的那段秒数 —— 通话跨过 04:00 时
   *     只把 04:00 之后的部分算给今天，既不整段塞给"开始那天"，
   *     也不会在跨点那一秒整段跳过来（那样数字会莫名从 0 蹦到 30）。 */
  function liveCallSecInBiz(key) {
    if (!callStartAt) return 0;
    const win = (window.Blocks && typeof window.Blocks.bizDayWindow === "function")
      ? window.Blocks.bizDayWindow(key) : null;
    if (!win) return 0;
    const from = Math.max(callStartAt, win.startMs);
    const to = Math.min(Date.now(), win.endMs);
    return to > from ? Math.floor((to - from) / 1000) : 0;
  }
  function todayCallSec() {
    const k = todayBizKey();
    return dayCallSec(k) + liveCallSecInBiz(k);
  }
  function todayCallMin() { return Math.round(todayCallSec() / 60); }
  function renderTodayCall() {
    const el = document.getElementById("todayCallMin");
    if (el) el.textContent = String(todayCallMin());
    /* ★ v1.43.0：下面两行原为「特殊管理日置顶卡」与「今日通讯录名卡」的同步刷新，
     *   两张卡已于 2026-10-12 下线（卡片容器也从 call.html 移除），连同其多端同步一起删除。 */
  }

  /* ---------- ★ v1.98.0 近期通话记录台账（用户 2026-10-26 指定）----------
   * 为什么要有这块：通话记录与主站**是两套账** —— call_manual（补记）被 today-records.js
   *   排除在主站视图之外，call_boundary（双闹钟）虽进主站但被切成别的一级分类。
   *   结果就是「补完就消失了」：想核对那天几点打的、打了多久，主站压根查不到。
   *   现在本页翻自己这本账：补记 + 真实计时都列出来、标清来源，删错了也能当场纠正。
   * ⚠️ 统计口径一个字都不改：每日/每周通话分钟仍由 todayCallMin() 与 call-timing 计算，
   *   本板块只做展示 + 删除，**不参与任何判定**，也不写任何自己的存储。
   * ⚠️ 删除走 Store.deleteTimeRecord：主站被掠 / Outbox 同步删云端都是既有机制，这里不重写。 */
  const RC_MAX_ROWS = 40;   // 最多铺多少条：再往前的通话没必要把页面拉到几千像素
  const DOW_CN = ["日", "一", "二", "三", "四", "五", "六"];
  function rcBJ(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return (window.Blocks && window.Blocks.beijing) ? window.Blocks.beijing(d) : d;
  }
  function rcHM(iso) {
    const b = rcBJ(iso);
    if (!b) return "--:--";
    const z = n => String(n).padStart(2, "0");
    return z(b.getHours()) + ":" + z(b.getMinutes());
  }
  function rcNaturalKey(iso) { const b = rcBJ(iso); return b ? keyBJ(b) : ""; }
  function rcDayLabel(k) {
    if (!k) return "未知日期";
    const p = String(k).split("-").map(Number);
    if (p.length < 3) return k;
    const d = new Date(p[0], p[1] - 1, p[2]);
    const today = todayBizKey();
    const yd = parseKey(today); yd.setDate(yd.getDate() - 1);
    const extra = k === today ? " · 今天" : (k === keyBJ(yd) ? " · 昨天" : "");
    return p[1] + "月" + p[2] + "日 周" + DOW_CN[d.getDay()] + extra;
  }
  /* 补记模板那段固定口径说明（写着不进主站）在卡片顶部已经讲了，行内不必再重复一遍 */
  function rcNoteBrief(note) {
    return String(note || "")
      .replace("手动补记（未开双闹钟）｜只进通话页账本，不进主站时间记录", "")
      .replace(/^[｜|]+/, "").trim();
  }
  function recentCallRows() {
    const list = (Store.getTimeRecords ? Store.getTimeRecords() : []).filter(isCallRec);
    return list.map(r => {
      const tsMs = r.started_at ? new Date(r.started_at).getTime() : (r.ended_at ? new Date(r.ended_at).getTime() : 0);
      return {
        r, ts: tsMs,
        bkey: bizKeyOf(tsMs || Date.now()),
        sec: Math.max(0, Math.round(Number(r.duration_sec) || 0))
      };
    }).filter(x => x.ts > 0).sort((a, b) => b.ts - a.ts);
  }
  function renderRecentCalls() {
    const box = document.getElementById("recentCallsBody");
    if (!box) return;
    const rows = recentCallRows();
    /* 空态必须写出"为什么是空的 / 怎么才有数据"，不能整块藏起来（静默失败铁律） */
    if (!rows.length) {
      box.innerHTML = '<div class="rc-empty">还没有通话记录。' +
        '用上面的双闹钟「接通 / 结束通话」会实时记一条（标"双闹钟计时"）；' +
        '没开闹钟的通话点「补记通话」手动补一条（标"手动补记"）。</div>';
      return;
    }
    let totalSec = 0, weekCnt = 0, weekSec = 0;
    const wk = weekMondayKey(todayBizKey());
    rows.forEach(x => {
      totalSec += x.sec;
      if (weekMondayKey(x.bkey) === wk) { weekCnt += 1; weekSec += x.sec; }
    });
    const shown = rows.slice(0, RC_MAX_ROWS);
    const groups = [];
    shown.forEach(x => {
      let g = groups.filter(y => y.key === x.bkey)[0];
      if (!g) { g = { key: x.bkey, rows: [], sec: 0 }; groups.push(g); }
      g.rows.push(x); g.sec += x.sec;
    });
    let h = '<div class="rc-sum">' +
      '<span class="rc-sum-item">近期 <b>' + rows.length + '</b> 通</span>' +
      '<span class="rc-sum-item">合计 <b>' + esc(fmtDuration(totalSec)) + '</b></span>' +
      '<span class="rc-sum-item">本周 <b>' + weekCnt + '</b> 通 <b>' + esc(fmtDuration(weekSec)) + '</b></span>' +
      '</div>';
    groups.forEach(g => {
      h += '<div class="rc-group"><div class="rc-ghead">' +
        '<span class="rc-gday">' + esc(rcDayLabel(g.key)) + '</span>' +
        '<span class="rc-gsum">' + g.rows.length + ' 通 · ' + esc(fmtDuration(g.sec)) + '</span>' +
        '</div>';
      g.rows.forEach(x => {
        const isManual = x.r.source === "call_manual";
        const sK = rcNaturalKey(x.r.started_at), eK = rcNaturalKey(x.r.ended_at);
        /* ★ v1.101.0：分组用的是**业务日**（04:00 换天），所以"10月26日"这一组里
         *   可能出现 27 日凌晨 00:39 的通话——那是 26 日业务日的尾巴，不是归错组。
         *   不标出来，看上去就像把 27 号的电话塞进了 26 号，越看越像 bug。 */
        const xd = !!(sK && sK !== x.bkey);
        const xdTag = xd ? '<i class="rc-xd">' + Number(String(sK).split("-")[2]) + '日</i>' : "";
        const brief = rcNoteBrief(x.r.note);
        h += '<div class="rc-row">' +
          '<div class="rc-main">' +
            '<span class="rc-time">' + xdTag + esc(rcHM(x.r.started_at)) + ' → ' + esc(rcHM(x.r.ended_at)) + '</span>' +
            (sK && eK && sK !== eK ? '<span class="rc-tag rc-tag-night">跨夜</span>' : '') +
            '<span class="rc-tag ' + (isManual ? "is-manual" : "is-timer") + '">' +
              (isManual ? "手动补记" : "双闹钟计时") + '</span>' +
            '<span class="rc-dur">' + esc(fmtDuration(x.sec)) + '</span>' +
          '</div>' +
          (brief ? '<div class="rc-sub">' + esc(brief) + '</div>' : '') +
          '<button type="button" class="rc-del" data-rc-del="' + esc(x.r.id) + '" ' +
            'aria-label="删除这条通话记录"><span data-icon="delete"></span>删除</button>' +
        '</div>';
      });
      h += '</div>';
    });
    if (rows.length > shown.length) {
      h += '<div class="rc-more">还有 ' + (rows.length - shown.length) +
        ' 条更早的记录没铺下去（这里只列最近 ' + RC_MAX_ROWS + ' 条，免得页面拖太长）。</div>';
    }
    box.innerHTML = h;
    if (window.Icon) window.Icon.inject(box);
  }

  /* 非学习时段的性质提示（不轻易断言"可接听"——接听还受周频率/邀约/主聊日约束）
   * rest 才是规则里说的"放松时间"，睡眠/收尾/预备属作息时段，不该当聊天窗口 */
  const NONSTUDY_HINT = {
    rest:     "休息时段（非专注）——按规则还须「放松时间 >30min」且非邀约，才可考虑接听",
    meal:     "用餐时段——一般用 17:30 话术池推脱，或餐后文字回复",
    sleep:    "睡眠时段（规则部建议，非强制）——以主站计时标签为准；无计时且确属垃圾时间可正常判断",
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
        <div class="ns-alert-row">
          <span class="ns-alert-icon" aria-hidden="true">🚫</span>
          <div class="ns-alert-main">
            <div class="ns-alert-title">现在是学习区间</div>
            <div class="ns-alert-sub">正经时间（学习）——来电直接拒接 / 只回文字</div>
          </div>
          <div class="ns-badge ns-study">⚠️ 现在是学习区间</div>
        </div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">本时段还剩 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip">按规则部计划表：<b>正经时间（学习）一律禁止聊天</b>。<br>此刻来电 → 直接拒接 / 只回文字 / 说「回家后我回你」。</div>`;
    } else if (sl.kind === "sleep") {
      el.innerHTML = `
        <div class="ns-badge ns-sleep">🌙 睡眠时段（规则部建议）</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">距离 ${sl.end} 还有 <b>${fmtRemain(info.remainMin)}</b></div>
        <div class="ns-tip ns-advise">此为规则部<b>建议</b>的睡眠时间——是否在睡，以主站计时标签为准。<br>主站正在计时「睡觉」→ 强制禁止接通；无睡眠计时且确属垃圾时间 → 可按正常流程判断。</div>`;
    } else {
      const base = NONSTUDY_HINT[sl.kind] || "非学习时段——按规则仍需非专注、非邀约且时限内";
      const extra = (sl.kind === "rest" && info.relaxOk)
        ? `（本时段剩余 ≥30min，已具备「放松 >30min」这一条）` : "";
      /* ★ v1.23.0 置后定则优先：本大块内当前时段之后还有学习/工作任务 →
       *   休息并行/垃圾并行两条规则不得适用（置后定则优先），应置后处理。 */
      const deferDue = blockHasStudyAfter(sl);
      const deferLine = `
        <div class="ns-defer ${deferDue ? "due" : "ok"}">
          <b>置后定则：</b>${deferDue
            ? "本大块内后续还有学习/工作任务 → <b>优先置后</b>（休息/垃圾时间并行规则不适用），能回电话就别现在接"
            : "本大块内后续无学习/工作任务 → 并行利用规则可用"}
        </div>`;
      el.innerHTML = `
        <div class="ns-badge ns-ok ns-${esc(sl.kind || "free")}">✅ 当前非学习区间</div>
        <div class="ns-name">${esc(nm)} <span class="ns-range">${sl.start}~${sl.end}</span></div>
        <div class="ns-remain">本时段还剩 <b>${fmtRemain(info.remainMin)}</b></div>
        ${deferLine}
        <div class="ns-tip">${esc(base)}${esc(extra)}</div>`;
    }
    renderOverride();
  }

  /* 豁免状态显示（卡片内）+ 两个独立申请入口；两种状态可同时生效、分别结束。 */
  function renderOverride() {
    const box = document.getElementById("nsOverride");
    const quotaLabel = document.getElementById("btnQuotaOverrideText");
    const quotaBtn = document.getElementById("btnQuotaOverride");
    const necessaryLabel = document.getElementById("btnNecessaryOverrideText");
    const necessaryBtn = document.getElementById("btnNecessaryOverride");
    if (!box) return;
    const map = getOverrides();
    const active = [map.quota_extra, map.necessary].filter(Boolean);
    if (active.length) {
      box.style.display = "";
      box.innerHTML = `
        <div class="ns-badge ns-override-on">🔓 已报规则部 · 特殊处理中</div>
        ${active.map(ov => `<div class="ns-ov-row"><b>${esc(overrideTypeLabel(ov))}</b>：${esc(ov.reason)} · 剩余 ${Math.max(0, Math.round((ov.until - Date.now()) / 60000))} 分钟</div>`).join("")}
        <div class="ns-ov-row">今日累计申报 ${overrideCountToday()} 次</div>
        <div class="ns-ov-row ns-ov-note">豁免期内通话仍会开双闹钟并记入账本（含豁免标记），便于事后复盘。</div>`;
    } else {
      box.style.display = "none";
    }
    if (quotaLabel) quotaLabel.textContent = map.quota_extra ? "结束 · 周额度豁免" : "申请 · 周额度豁免";
    if (necessaryLabel) necessaryLabel.textContent = map.necessary ? "结束 · 正经时间豁免" : "申请 · 正经时间不得不通话";
    if (quotaBtn) quotaBtn.classList.toggle("is-ending", !!map.quota_extra);
    if (necessaryBtn) necessaryBtn.classList.toggle("is-ending", !!map.necessary);
    /* ★ v1.60.0：两个入口以前常亮且无说明，点开才发现「不符合条件」——白跑一趟。
     *   这里只加 title 提示适用范围（不改行为、不动样式，避免又踩 CSS 重复定义的坑）。 */
    if (quotaBtn) quotaBtn.title = map.quota_extra
      ? "点击提前结束本次额度豁免（提前收手同样留痕）"
      : "仅在本周 120 分钟额度已用尽、且当前确属垃圾时间时才用得上；置后定则不放行";
    if (necessaryBtn) necessaryBtn.title = map.necessary
      ? "点击提前结束本次特殊豁免（提前收手同样留痕）"
      : "仅在正经时间（学习／任务中）且确实不得不时才用得上；这是置后定则的例外通道";
    renderOverrideLedger();
  }

  /* ---------- 申报台账（v1.45.0）----------
   * 弹窗里承诺的「已留痕」「进入每日复盘」以前是空头支票：只记了个当天计数，
   * 隔天清零，理由与时刻都不落账，事后根本查不到"这周申报了几次、有没有滥用"。
   * 这里把近 7 天的申报明细摆出来，并给出三个数：申报次数 / 真通话次数 / 自行收手次数。 */
  function renderOverrideLedger() {
    const box = document.getElementById("ovLedger");
    if (!box) return;
    const all = getOverrideRecords();
    if (!all.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    const nowMs = Date.now();
    const fromKey = ovDateKey(nowMs - 7 * 86400000);
    const rows = all.filter(r => String(r.date) >= fromKey);
    if (!rows.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    box.style.display = "";
    const usedCount = rows.filter(r => r.used).length;
    const manualCount = rows.filter(r => r.endedBy === "manual").length;
    const expiredUnused = rows.filter(r => !r.used && !r.endedBy && (r.ts + (r.minutes || 0) * 60000) <= nowMs).length;
    const lineOf = (r) => {
      const d = new Date(r.ts || Date.now());
      const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      let res, cls;
      if (r.used) { res = `✅ 通话 ${r.callMin || 0} 分`; cls = "used"; }
      else if (r.endedBy === "manual") { res = "↩ 自行收手（未通话）"; cls = "manual"; }
      else if ((r.ts + (r.minutes || 0) * 60000) <= nowMs) { res = "⚪ 到期未用"; cls = "expired"; }
      else { res = "● 生效中"; cls = "live"; }
      return `<div class="ov-lg-row ${cls}"><span class="ov-lg-t">${esc(stamp)}</span>` +
        `<b class="ov-lg-k">${esc(r.type === "necessary" ? "正经时间豁免" : "周额度豁免")}</b>` +
        `<span class="ov-lg-r">${esc(r.reason || "（未填理由）")}</span><em class="ov-lg-s">${res}</em></div>`;
    };
    box.innerHTML =
      `<div class="ov-lg-head">申报台账 · 近 7 天</div>` +
      `<div class="ov-lg-stat">申报 <b>${rows.length}</b> 次｜真通话 <b>${usedCount}</b> 次｜` +
      `自行收手 <b>${manualCount}</b> 次｜到期未用 <b>${expiredUnused}</b> 次</div>` +
      rows.slice(-15).reverse().map(lineOf).join("") +
      `<div class="ov-lg-note">「真通话 / 申报」比越高，说明豁免越像例行公事；自行收手是自律的正向证据，也记在这里。</div>`;
  }

  /* ---------- 两类独立豁免窗口 ---------- */
  /* 人工复选框只保留"系统无法知道"的项；系统已知事实（专注/周额度/邀约/影响进度/
   * 垃圾时间确认/时段合法性）全部由 getOverrideAudit 自动核验并以徽章呈现，
   * 不满足即整窗拦截——减少决策成本与"顺手全勾"的决策失误（用户 2026-09-16 指示）。 */
  const QUOTA_OVERRIDE_CHECKS = [
    "quotaCheckProgress", "quotaCheckSleep", "quotaCheckAlternative", "quotaCheckAlarm"
  ];
  const NECESSARY_OVERRIDE_CHECKS = [
    "necessaryCheckLoss", "necessaryCheckDelay", "necessaryCheckText",
    "necessaryCheckEscape", "necessaryCheckAlarm", "necessaryCheckReview"
  ];

  function overrideCheckIds(type) {
    return type === "necessary" ? NECESSARY_OVERRIDE_CHECKS : QUOTA_OVERRIDE_CHECKS;
  }

  function overrideChecksPassed(type) {
    return overrideCheckIds(type).every(id => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    });
  }

  function taskDateKey(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    const b = window.Blocks ? window.Blocks.beijing(d) : d;
    return `${b.getFullYear()}-${p(b.getMonth() + 1)}-${p(b.getDate())}`;
  }

  /* ---------- 任务门禁的统计范围（用户 2026-09-20 指示）----------
   * 「今日/昨日未完成」**暂时只统计「单词突围」任务**：
   *   天天师兄（xizong_live 的听课/做题/滚动复习等）与人可研梦（physio_rolling，
   *   本来就无日期）都不参与阻断——它们的量太大，会让门禁永远通不过。
   * 识别口径与任务页 tasks.js 的 isWordTask 保持一致（source **或**标题特征：
   * 云端 tasks.source 曾被 null 传染过，光看 source 认不出）。
   * ⚠️ 以后要恢复"所有今日任务"或换别的系列，只改 isWordGateTask 这一个函数即可。 */
  const WORD_TITLE_RE = /每日单词任务|^背单词\s*[·:：]/;
  function isWordGateTask(t) {
    return !!t && (t.source === "english_words" || WORD_TITLE_RE.test(t.title || ""));
  }
  /* 未完成清单文案（用户要求：阻断时必须指出到底哪几项没完成） */
  function taskListText(list, cap) {
    const n = cap || 4;
    const names = list.slice(0, n).map(t => String(t.title || "(无标题)"));
    return names.join("；") + (list.length > n ? `…等共 ${list.length} 项` : "");
  }
  /* 门禁结论的统一文案：计数 + 具体哪几项（徽标提示、结论卡、弹窗提示共用同一份） */
  function gateText(gate) {
    return [
      `今日未完成 ${gate.dueToday} 项` + (gate.dueToday ? `：${taskListText(gate.todayList)}` : ""),
      `昨日未完成 ${gate.yesterday} 项` + (gate.yesterday ? `：${taskListText(gate.yestList)}` : ""),
      `惩罚任务 ${gate.penalty} 项` + (gate.penalty ? `：${taskListText(gate.penaltyList)}` : "")
    ].join("；");
  }

  /* ★ v1.104.0（用户 2026-10-29 指定）：**任务门禁的空档兜底**。
   *   背景：`purgeLegacyWordTasks()` 会把第一轮的历史任务删掉，第二轮计划 2026-11-01 才起，
   *   在此期间（以及任何「计划内应当有单词任务、但云端查不到那一行」的日子）
   *   getTaskGate() 的三项计数全是 0 → ok:true。**这不是"任务已完成"，是"没数据可判"**，
   *   两者在界面上长得一模一样 —— 正是本项目最怕的静默失败：不报错，只是安静地什么都不做。
   *   口径：计划范围 = `window.WORD_PLAN` 里存在该 date 的条目（与 tasks.js 同一份数据源）。
   *   ⚠️ 只告警、**不阻断**。理由：首拉未完成 / purge 刚跑过时会短暂查不到任务行，
   *     若按"缺失即禁止"处理会误伤（本来能接的电话被拦），代价高于收益；
   *     把结论明示给人看，由他自己判断更稳。 */
  function isWordPlanDay(dateKey) {
    const plan = window.WORD_PLAN;
    if (!Array.isArray(plan)) return false;
    return plan.some(p => p && String(p.date || "") === String(dateKey));
  }

  /* ★ v1.107.0（用户 2026-10-31 指定）：任务门禁**只在夜间生效**（18:30 → 次日 07:00）。
   *   原话：「只针对每天 18:30 以后至次日 7:00，18:30 及其以前不考虑在相关的系统机制之中」。
   *   为什么：门禁的本意是「该学习了，别打电话」——这件事只发生在夜里。
   *     全天生效的后果是：白天一条没勾掉的单词任务，就能把家里 / 医院 / 老师的正经来电硬拦掉，
   *     而白天该不该接，日闸、周闸、专注状态、置后定则已经各管一段，不缺门禁这一刀。
   *   时段源 = D.rules.taskGateWindow（单一数据源，默认 18:30–07:00）；
   *   18:30 > 07:00 属跨午夜，正好走 inMinRange 的 `from > to` 分支（与夜间三段同一套写法）。
   *   ⚠️ 三处判定必须同时生效：evaluateCallDecision / quickVerdict / call-verdict.js 第 7 段。
   *      只改一处 → 「判定卡说禁止、豁免核验表说通过」（v1.93 踩过的老毛病）。 */
  function nowMinOfDay() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function taskGateWindow() {
    const w = (D.rules && D.rules.taskGateWindow) || {};
    return { from: w.from || "18:30", to: w.to || "07:00" };
  }
  function taskGateApplies(minuteOfDay) {
    const w = taskGateWindow();
    const m = typeof minuteOfDay === "number" ? minuteOfDay : nowMinOfDay();
    return inMinRange(m, toMin(w.from), toMin(w.to));
  }

  function getTaskGate(todayKey) {
    const tasks = (Store.getTasks && Store.getTasks()) || [];
    const parts = todayKey.split("-").map(Number);
    const yesterdayKey = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) - 86400000).toISOString().slice(0, 10);
    let dueToday = 0, yesterday = 0, penalty = 0, olderIgnored = 0;
    const todayList = [], yestList = [], penaltyList = [];
    tasks.forEach(t => {
      if (t.done === true || t.status === "done") return;
      const key = taskDateKey(t.date);
      const tags = Array.isArray(t.tags) ? t.tags : [];
      const isPenalty = t.enforcement_level === "penalty" || t.category === "penalty" ||
        t.task_type === "penalty" || tags.includes("惩罚任务") || tags.includes("penalty");
      const inScope = isWordGateTask(t);   // ★ 只有单词突围参与今日/昨日判定
      if (inScope && key === todayKey) { dueToday++; todayList.push(t); return; }
      if (inScope && key === yesterdayKey) { yesterday++; yestList.push(t); return; }
      if (isPenalty) { penalty++; penaltyList.push(t); return; }
      if (key && key < yesterdayKey) olderIgnored++;
    });
    /* ★ v1.104.0：计划内却没有任务行 = 数据缺失（不是"已完成"），见 isWordPlanDay 注释 */
    const dataMissing = !!(todayKey && isWordPlanDay(todayKey) && dueToday === 0 && yesterday === 0);
    return { ok: dueToday === 0 && yesterday === 0 && penalty === 0, dueToday, yesterday, penalty, olderIgnored, dataMissing, todayList, yestList, penaltyList };
  }

  function getOverrideAudit(type) {
    const isNecessary = type === "necessary";
    const j = judgeToday();
    const at = Store.getActiveTimer();
    const taskGate = getTaskGate(j.dateStr);
    const focused = activeStudyTimer() || checked("currentlyFocused");
    const activeCall = !!(at && at.kind === "call");
    const affairs = checked("affairsDone");
    const deferred = checked("followDeferRule");
    const affects = checked("impactStudy");
    const invitation = checked("isInvitation");
    const quotaCovered = (j.weeklyCallCount < weeklyCountCap() && j.weeklyCallMinSec <= (D.weeklyRule.maxMinPerWeek || Infinity) * 60) || overrideActive("quota_extra");
    const taskGateOn = D.rules.taskGateEnabled !== false;   // ★ v1.104.0：门禁已恢复（开关仍在，便于再关）
    const necessaryCovered = overrideActive("necessary");
    /* ★ v1.60.0 置后定则进核验表（原先只有「人工勾选」这一道，纯形式）：
     *   判定卡里 blockHasStudyAfter 会判「置后定则 · 优先置后」禁止接听，且**不豁免 quota**——
     *   于是出现过「豁免申请成功、判定卡仍显示禁止」的错位。现在把同一条判定**前置**到核验表里，
     *   让人在申请前就知道：本大块后面还排着学习，额度放行也接不了。 */
    const siQ = currentSlotInfo();
    const deferBlocked = !!(siQ && siQ.slot && !siQ.isStudy && blockHasStudyAfter(siQ.slot));
    const deferNext = deferWindowText(j.dateStr);
    const items = [
      { ok: !activeCall, label: "主站通话状态", detail: activeCall ? "已经在通话，不允许重复申请" : "当前没有进行中的通话" },
      { ok: !focused, label: "专注状态", detail: focused ? "主站学习计时或人工专注已触发硬阻断" : "未检测到正在专注" },
      { ok: !j.timerSleeping, label: "作息边界", detail: j.timerSleeping ? "主站正在计时睡眠——任何豁免均不可覆盖" : (j.isSleep ? "当前为睡眠时段（规则部建议，非强制）；无睡眠计时即可正常申请" : "当前不在睡眠时段") },
      taskGateOn
        ? (taskGateApplies()
            ? { ok: taskGate.ok, label: "任务完成状态", detail: taskGate.dataMissing
                ? "⚠️ 今日在单词计划内、却查不到任何任务行——门禁本次未生效（只提示、不阻断）；请自行确认是否真的背完了"
                : (taskGate.ok
                    ? `今日、昨日及明确标记的惩罚任务均已完成${taskGate.olderIgnored ? `（更早普通计划 ${taskGate.olderIgnored} 项不作为本规则阻断）` : ""}｜口径：只统计「单词突围」，天天师兄/人可研梦不参与`
                    : `${gateText(taskGate)}；先完成这些再谈通话，豁免也不能绕过`) }
            : { ok: true, label: "任务完成状态",
                detail: `当前不在门禁时段（${taskGateWindow().from} 起至次日 ${taskGateWindow().to} 止）——白天不检查任务完成情况；`
                  + (taskGate.ok ? "今日任务已勾完" : `但 ${gateText(taskGate)}，到 ${taskGateWindow().from} 之后仍未完成就会阻断`) })
        : { ok: true, label: "任务完成状态", detail: "（临时停用）任务门禁已关闭——不进入禁止条件；恢复：call-data.js rules.taskGateEnabled 改回 true" },
      { ok: affairs, label: "自身事务", detail: affairs ? "已沿用日常判定：自身事务处理完毕" : "请先在本次来电结论中确认自身事务已完成" },
      { ok: deferred && !deferBlocked, label: "置后定则",
        detail: deferBlocked
          ? `本大块内后续还有学习／工作任务 → 置后定则优先于垃圾／休息时间并行利用：即便放行了本次额度，判定卡仍会判「优先置后」${deferNext ? `，请改约到「${deferNext}」` : "；今日已无合格的收尾段 → 改文字或改约明天"}`
          : (deferred ? `已确认无法继续置后${deferNext ? `（可推到「${deferNext}」）` : ""}` : "请先执行并确认置后定则") },
      { ok: !affects, label: "进度影响", detail: affects ? "已标记会影响正常进度，禁止豁免" : "未标记影响正常进度" },
      { ok: !invitation, label: "邀约识别", detail: invitation ? "邀约类来电只能文字回复" : "未标记为邀约类来电" }
    ];
    if (isNecessary) {
      items.push(
        { ok: j.inStudy && !checked("garbageTime"), label: "申请场景", detail: j.inStudy && !checked("garbageTime") ? "正处于正经时间，且未冒充垃圾时间" : "仅正经时间、非垃圾时间才需要此豁免" },
        { ok: quotaCovered, label: "周额度限制", detail: quotaCovered ? "本周 120 分钟额度可用，或已另行获得周额度豁免" : "本周 120 分钟额度已用尽；本窗口不豁免日闸与其他硬规则，请另走周额度申请" }
      );
    } else {
      items.push(
        { ok: j.weeklyCallCount >= weeklyCountCap() || j.weeklyCallMinSec > (D.weeklyRule.maxMinPerWeek || Infinity) * 60, label: "周额度触发", detail: `本周 ${weeklyCountSlot(j.weeklyCallCount)}${Math.round(j.weeklyCallMinSec / 60)}/${D.weeklyRule.maxMinPerWeek}min；仅额度用尽后才能申请增加` },
        { ok: checked("garbageTime") || necessaryCovered, label: "时间合法性", detail: checked("garbageTime") ? "主页面已确认垃圾时间" : (necessaryCovered ? "已另行获得正经时间必要豁免" : "须确认垃圾时间；正经时间须先单独申请必要豁免") }
      );
    }
    return { ok: items.every(x => x.ok), items, taskGate };
  }

  function renderOverrideAudit(type) {
    const isNecessary = type === "necessary";
    const box = document.getElementById(isNecessary ? "necessaryAutoAudit" : "quotaAutoAudit");
    if (!box) return;
    const audit = getOverrideAudit(type);
    const passCount = audit.items.filter(x => x.ok).length;
    const failing = audit.items.filter(x => !x.ok);
    box.innerHTML = `<div class="cm-auto-title">系统核验 · ${passCount}/${audit.items.length}${audit.ok ? " · 全部通过" : " · 存在阻断"}</div>` +
      `<div class="cm-badge-grid">` + audit.items.map(x =>
        `<span class="cm-badge ${x.ok ? "ok" : "block"}" title="${esc(x.detail)}">${x.ok ? "✓" : "✕"} ${esc(x.label)}</span>`).join("") + `</div>` +
      (failing.length ? `<div class="cm-auto-block">` + failing.map(x => `· ${esc(x.detail)}`).join("<br>") + `</div>` : "");
  }

  /* ---------- 此刻快照：把系统知道的数据摆到台面上，供充分判断 ---------- */
  function renderOverrideSnapshot(type) {
    const box = document.getElementById(type === "necessary" ? "necessarySnapshot" : "quotaSnapshot");
    if (!box) return;
    const j = judgeToday();
    const gate = getTaskGate(j.dateStr);
    const goalTargetSec = (parseFloat(C.DAILY_GOAL_HOURS) || 8) * 3600;
    const cats = (C.TIME_CATEGORIES || []);
    const countsGoal = (r) => { const c = cats.find(x => x.key === r.category); return !!(c && c.countTowardGoal); };
    const today = window.TodayRecords ? window.TodayRecords.getTodayRecords() : [];
    const studySec = today.filter(countsGoal).reduce((a, r) => a + (Number(r.duration_sec) || 0), 0);
    const studyPct = goalTargetSec ? Math.min(100, Math.round(studySec / goalTargetSec * 100)) : 0;
    let lastCallTxt = "本周暂无";
    let lastMs = 0;
    (Store.getTimeRecords() || []).forEach(r => {
      if (!isCallRec(r) || !r.ended_at) return;
      const t = Date.parse(r.ended_at);
      if (isFinite(t) && t > lastMs) lastMs = t;
    });
    if (lastMs) {
      const agoMin = Math.max(0, Math.round((Date.now() - lastMs) / 60000));
      lastCallTxt = agoMin >= 60 ? `${Math.floor(agoMin / 60)}小时${agoMin % 60}分前` : `${agoMin} 分钟前`;
    }
    const si = currentSlotInfo();
    const slotTxt = si && si.slot ? `${cleanName(si.slot.name)} · 剩 ${fmtRemain(si.remainMin)}` : "自由时段";
    box.innerHTML =
      `<div class="cm-snap-title">此刻快照（系统自动统计）</div>` +
      `<div class="cm-snap-grid">` +
      `<div class="cm-snap-row"><span>今日有效学习</span><b>${fmtDuration(studySec)} / ${fmtDuration(goalTargetSec)}（${studyPct}%）</b></div>` +
      /* ★ v1.104.0：门禁恢复后，「查不到任务行」不能再显示成「均已完成」——
       *   那是本项目的典型静默失败（界面上和真完成长得一样）。数据缺失必须自己说出来。 */
      /* ★ v1.107.0：非门禁时段（白天）要**明说**不检查，不能显示成「均已完成」——
       *   否则界面上和"真的背完了"一模一样，又是一次静默失败。 */
      `<div class="cm-snap-row"><span>任务门禁</span><b>${D.rules.taskGateEnabled === false
        ? "（临时停用 · 不阻断通话）"
        : (!taskGateApplies()
            ? `（现在不在门禁时段 · ${taskGateWindow().from} 起才检查）${gate.ok ? "" : ` · 已剩 ${gate.dueToday} 项待完成`}`
            : (gate.dataMissing ? "⚠️ 今日任务数据缺失 · 门禁未生效" : (gate.ok ? "今日昨日任务均已完成" : `今日剩 ${gate.dueToday} 项 · 昨日剩 ${gate.yesterday} 项`)))}</b></div>` +
      (!gate.ok && D.rules.taskGateEnabled !== false && taskGateApplies() ? `<div class="cm-snap-row"><span>待完成</span><b>${esc(taskListText((gate.todayList || []).concat(gate.yestList || []), 3))}</b></div>` : "") +
      `<div class="cm-snap-row"><span>本周长通话</span><b>${weeklyCountSlot(j.weeklyCallCount)}${Math.round(j.weeklyCallMinSec/60)}/${D.weeklyRule.maxMinPerWeek}min · 上次 ${esc(lastCallTxt)}</b></div>` +
      `<div class="cm-snap-row"><span>当前时段</span><b>${esc(slotTxt)}</b></div>` +
      `</div>` +
      `<div class="cm-snap-stance">上面的数字才是你的尺子 ——<b>我今天的进度，对得起 12 月吗？</b></div>`;
  }
  /* 半自动项的数据提示：数据系统给，判断由人做 */
  function fillOverrideHints(type) {
    const si = currentSlotInfo();
    const gate = getTaskGate(judgeToday().dateStr);
    const q1 = document.getElementById("quotaHintProgress");
    if (q1) q1.textContent = `系统快照：今日剩余任务 ${gate.dueToday} 项${gate.yesterday ? `，昨日剩余 ${gate.yesterday} 项` : ""}` +
      ((gate.dueToday || gate.yesterday) ? `（${taskListText((gate.todayList || []).concat(gate.yestList || []), 3)}）` : "") +
      `｜口径：只统计「单词突围」`;
    const q2 = document.getElementById("quotaHintSleep");
    if (q2) {
      const b = window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
      const minsNow = b.getHours() * 60 + b.getMinutes();
      /* 上床时间取自作息表（睡眠时段的 start）——09.28 版改为 0:00，不再硬编码 00:30 */
      const sleepSlot = ((window.SCHEDULE_DATA || {}).slots || []).find(x => x.kind === "sleep");
      const bedMin = sleepSlot ? toMin(sleepSlot.start) : 24 * 60;   // 兜底 0:00
      let toBed = bedMin - minsNow;
      if (toBed <= 0) toBed += 24 * 60;
      const bedTxt = `${String(Math.floor(bedMin / 60) % 24).padStart(2, "0")}:${String(bedMin % 60).padStart(2, "0")}`;
      q2.textContent = `现在 ${String(b.getHours()).padStart(2, "0")}:${String(b.getMinutes()).padStart(2, "0")} · 距 ${bedTxt} 上床还有 ${Math.floor(toBed / 60)}小时${toBed % 60}分`;
    }
    const n1 = document.getElementById("necessaryHintDelay");
    if (n1) n1.textContent = si && si.slot ? `本时段剩余 ${fmtRemain(si.remainMin)}——延后意味着占用下一个时段` : "";
  }

  function overrideSystemEligible(type) {
    return getOverrideAudit(type).ok;
  }

  function syncOverrideGrantState(type) {
    const isNecessary = type === "necessary";
    const button = document.getElementById(isNecessary ? "necessaryGrant" : "quotaGrant");
    const hint = document.getElementById(isNecessary ? "necessaryStrictHint" : "quotaStrictHint");
    const ids = overrideCheckIds(type);
    const checkedCount = ids.filter(id => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    }).length;
    const checksOk = checkedCount === ids.length;
    const systemOk = overrideSystemEligible(type);
    renderOverrideAudit(type);
    renderOverrideSnapshot(type);
    fillOverrideHints(type);
    if (button) button.disabled = !(checksOk && systemOk);
    if (!hint) return;
    hint.classList.toggle("ready", checksOk && systemOk);
    if (!checksOk) {
      hint.textContent = `人工核验尚未完成：已勾选 ${checkedCount}/${ids.length} 项（系统核验项无需勾选，自动判定）。`;
    } else if (!systemOk) {
      hint.textContent = isNecessary
        ? "人工核验已完成，但系统检测到硬阻断：专注、睡眠、影响进度或邀约时不能豁免。"
        : "人工核验已完成，但系统条件仍不满足：须本周 120 分钟额度确已用尽，且主页面已确认当前是垃圾时间。";
    } else {
      hint.textContent = "全部核验通过。仍可选择取消；确认后将留痕并强制执行双闹钟。";
    }
  }

  function fillOverrideReasons(type) {
    const isNecessary = type === "necessary";
    const chips = document.getElementById(isNecessary ? "necessaryReasons" : "quotaReasons");
    const input = document.getElementById(isNecessary ? "necessaryReasonInput" : "quotaReasonInput");
    const rules = (D && D.rules) || {};
    const configured = isNecessary
      ? (rules.necessaryOverrideReasons || ["紧急事务，延后会造成实际损失"])
      : (rules.quotaOverrideReasons || ["本周额度已用尽，当前确属垃圾时间"]);
    const history = getReasonHistory(type).filter(r => !configured.includes(r));
    const reasons = [...history, ...configured];
    if (chips && !chips.childElementCount) {
      chips.innerHTML = reasons.map((r, i) =>
        `<button type="button" class="cm-chip ${i < history.length ? "is-history" : ""}" data-reason="${esc(r)}">${esc(r)}</button>`).join("");
      chips.addEventListener("click", (e) => {
        const b = e.target.closest("[data-reason]");
        if (b && input) {
          input.value = b.dataset.reason;
          syncOverrideGrantState(type);
        }
      });
    }
    if (input && !input.value) input.value = reasons[0] || "";
    if (input && !input.dataset.strictBound) {
      input.dataset.strictBound = "1";
      input.addEventListener("input", () => syncOverrideGrantState(type));
    }
  }

  /* ---------- ★ v1.70.0 绕过建议指标的二次判断页 ---------- */
  let bypassPending = [];   // 打开弹窗那一刻的建议项（确认时按它记账，避免这期间状态漂移）
  function openBypassDialog() {
    const mask = document.getElementById("bypassMask");
    const modal = document.getElementById("bypassModal");
    if (!mask || !modal) return;
    const j = evaluateCallDecision();
    const items = j.advItems || [];
    if (!items.length) {
      if (window.UI) window.UI.showAlert("当前没有可绕过的建议项（存在强制项时不能绕过）", 4000);
      return;
    }
    bypassPending = items;
    const st = bypassState();
    const left = Math.max(0, BYPASS_MAX_PER_DAY - (st.used || 0));
    const jj = judgeToday();
    const si = currentSlotInfo();
    let timeTxt = "当前无计划时段";
    if (si && si.slot) {
      const leftMin = Math.max(0, Math.round((toMin(si.slot.end) * 60 - nowSecBJ()) / 60));
      timeTxt = `〈${cleanName(si.slot.name)} ${si.slot.start}~${si.slot.end}〉还剩 ${fmtRemain(leftMin)}`;
    }
    /* ★ v1.93.0：解耦奇偶日（否则绕过页永远看不到今日剩余额度） */
    const dayLeft = (jj.dayCapMin > 0) ? Math.max(0, jj.dayCapMin - jj.curDayMin) : null;
    const ctx = document.getElementById("bypassContext");
    if (ctx) {
      ctx.className = "cm-context is-study";
      ctx.innerHTML = `当前：<b>${esc(timeTxt)}</b><br>` +
        `今日已绕过 <b>${st.used || 0} / ${BYPASS_MAX_PER_DAY}</b> 次` +
        (dayLeft != null ? `｜今日通话额度还剩 <b>${dayLeft} 分钟</b>` : "") +
        `｜本周 ${weeklyCountSlot(jj.weeklyCallCount)}${Math.round(jj.weeklyCallMinSec / 60)}/${jj.weekCapMin}min`;
    }
    const rules = document.getElementById("bypassRules");
    if (rules) {
      rules.innerHTML = `<div class="cm-auto-title">规则复习 · 你要绕过的 ${items.length} 条（都不强制）</div>` +
        `<div class="cm-badge-grid">` + items.map(x =>
          `<span class="cm-badge block" title="${esc(x.detail)}">⚠️ ${esc(x.label)}</span>`).join("") + `</div>` +
        `<div class="cm-auto-block">` +
        `· 绕过 = <b>明知违反建议仍要接</b>：本次按「绕过」记一次（今日第 ${(st.used || 0) + 1} 次），<b>不算垃圾时间</b>。<br>` +
        `· 置后三步：能不能改用文字 → 能不能推到本大块末尾的收尾段 → 30 分钟内能不能收口；<b>三步全是「否」才允许不置后</b>。<br>` +
        `· 接通后必须：<b>开双闹钟</b>、约定时间或计时器到点后 <b>3 分钟内挂断</b>（⑬）。<br>` +
        `· 提醒：勾「当前是垃圾时间」走的是<b>合法路径</b>（不消耗次数），只在你确属块内垃圾窗口时才用。` +
        `</div>`;
    }
    const btn = document.getElementById("bypassConfirm");
    if (btn) {
      btn.disabled = left <= 0;
      btn.textContent = left > 0 ? `我已想清楚，仍然接听（今日剩 ${left} 次）` : `今日 ${BYPASS_MAX_PER_DAY} 次已用完 · 需报规则部`;
    }
    mask.classList.add("show");
    modal.classList.add("show");
    if (window.Icon) window.Icon.inject(modal);
  }
  function closeBypassDialog() {
    const mask = document.getElementById("bypassMask");
    const modal = document.getElementById("bypassModal");
    if (mask) mask.classList.remove("show");
    if (modal) modal.classList.remove("show");
  }
  function confirmBypass() {
    if (bypassLeftToday() <= 0) {
      closeBypassDialog();
      if (window.UI) window.UI.showAlert(`今日已绕过 ${BYPASS_MAX_PER_DAY} 次——本次需报规则部（或勾「当前是垃圾时间」走合法路径）`, 6000);
      return;
    }
    const items = bypassPending.length ? bypassPending : (evaluateCallDecision().advItems || []);
    if (!items.length) { closeBypassDialog(); return; }
    const si = currentSlotInfo();
    const slotKey = (si && si.slot) ? (si.slot.start + "-" + si.slot.end) : "";
    const st = grantBypass(items.map(x => x.key), slotKey, items);
    closeBypassDialog();
    renderJudge();     // 绕过状态变了 → 整卡重绘（复选框勾选状态由 renderJudge 内部保留）
    if (window.UI) window.UI.showAlert(
      `⚠️ 已绕过 ${items.length} 条建议（今日第 ${st.used} 次）——双闹钟必须开，到点 3 分钟内挂断`, 6000);
  }

  function openOverrideDialog(type) {
    const isNecessary = type === "necessary";
    const mask = document.getElementById(isNecessary ? "necessaryMask" : "quotaMask");
    const modal = document.getElementById(isNecessary ? "necessaryModal" : "quotaModal");
    if (!mask || !modal) return;
    const si = currentSlotInfo();
    const inStudy = !!(si && si.isStudy);
    const ctx = document.getElementById(isNecessary ? "necessaryContext" : "quotaContext");
    if (ctx) {
      if (si && si.slot) {
        const endSec = toMin(si.slot.end) * 60;
        const leftMin = Math.max(0, Math.round((endSec - nowSecBJ()) / 60));
        const timeSense = `距离 ${si.slot.end} 还有 ${fmtRemain(leftMin)}`;
        if (isNecessary) {
          ctx.className = "cm-context is-study";
          ctx.innerHTML = `当前：<b>${esc(cleanName(si.slot.name))}</b>（${si.slot.start}~${si.slot.end}） · ${timeSense}` +
            (inStudy ? "——现在接听会直接占用正经学习时间" : "——虽非学习区间，仍需证明必须此刻处理");
        } else {
          const j = judgeToday();
          ctx.className = inStudy ? "cm-context is-study" : "cm-context";
          ctx.innerHTML = `本周已通话：<b>${weeklyCountSlot(j.weeklyCallCount)}${Math.round(j.weeklyCallMinSec/60)}/${D.weeklyRule.maxMinPerWeek}min</b>；当前：` +
            `<b>${esc(cleanName(si.slot.name))}</b>（${si.slot.start}~${si.slot.end}） · ${timeSense}` +
            (inStudy ? "——当前不是垃圾时间，不符合本申请条件" : "");
        }
      } else {
        ctx.className = "cm-context";
        ctx.innerHTML = "此刻不在计划时段内";
      }
    }
    fillOverrideReasons(type);
    overrideCheckIds(type).forEach(id => {
      const checkbox = document.getElementById(id);
      if (!checkbox) return;
      checkbox.checked = false;
      if (!checkbox.dataset.strictBound) {
        checkbox.dataset.strictBound = "1";
        checkbox.addEventListener("change", () => syncOverrideGrantState(type));
      }
    });
    syncOverrideGrantState(type);
    mask.classList.add("show");
    modal.classList.add("show");
    if (window.Icon) window.Icon.inject(modal);
  }
  function closeOverrideDialog(type) {
    const isNecessary = type === "necessary";
    const mask = document.getElementById(isNecessary ? "necessaryMask" : "quotaMask");
    const modal = document.getElementById(isNecessary ? "necessaryModal" : "quotaModal");
    if (mask) mask.classList.remove("show");
    if (modal) modal.classList.remove("show");
  }

  /* ---------- 今日判定 ---------- */
  function _judgeTodayRaw() {
    const now = new Date();
    const beijing = window.Blocks ? window.Blocks.beijing(now) : now;
    const day = beijing.getDate();
    const isOdd = day % 2 === 1;
    const dayName = ["周日","周一","周二","周三","周四","周五","周六"][beijing.getDay()];
    /* ★ v1.93.0：dateStr 改**业务日**（04:00 换天）。后面所有「今日 / 昨日 / 连续天数」
     *   的判定都以它为基准——用自然日会把 23:34 开始、00:19 结束的一通电话劈成两天，
     *   连续天数与周配额都会算错。 */
    const dateStr = todayBizKey();

    // 计算本周已用次数
    weeklyCallCount = calcWeeklyCallCount(beijing);
    weeklyCallMinSec = calcWeeklyCallMinSec(beijing);   // ★ v1.24.5 本周接通总秒数（≤120min 周时长闸）
    const slotInfo = currentSlotInfo();
    const inStudy = !!(slotInfo && slotInfo.isStudy);
    /* 睡眠判定改源（用户 2026-09-16 指示）：
     * 硬限制以「主计时器正在计时的标签」为准（计时睡觉/长睡觉/小憩）；
     * 规划表的睡眠时段仅作建议提示——大块时间段内仍可能有垃圾时间。 */
    const atNow = Store.getActiveTimer();
    const timerSleeping = !!(atNow && atNow.status === "running" &&
      (atNow.kind === "sleep" || atNow.sub_category === "long_sleep" || atNow.sub_category === "nap"));
    const isSleep = !!(slotInfo && slotInfo.slot && slotInfo.slot.kind === "sleep"); // 仅建议
    const quota = weeklyCountCap();   // ★ v1.93.0 = 4（周配额改为「4 个通话日」）

    /* ★ v1.93.0 新三门闸（用户 2026-10-25 指定，均按业务日口径）
     *   ① 周配额：7 天最多 4 个通话日（天 = 业务日，当天接通总时长 >5min 才计入）
     *   ② 连续禁令（强制）：连续 2 个通话日 → 第 3 天严禁；已连续 3 天且链上有补记
     *      → 第 4 天严禁，以此类推。跨周不断链（用户明确要求「含跨周通话」）。
     *   ③ 昨日已通话 → 当日**强烈不建议**（建议层，非强制，仅提示） */
    const yestKey = prevDayKey(dateStr);
    const streak = consecutiveCallDaysBefore(yestKey);   // 不含今天的连续链（往前数）
    const streakLen = streak.length;
    const streakHasManual = streak.some(dayHasManualCall);
    const yesterdayCalled = isCallDay(yestKey);
    /* "连续两天有通话" = 昨天+前天都有 → 今天（第 3 天）严禁 */
    const bannedByStreak = streakLen >= 2;
    /* 加重档：已连续 ≥3 天且链上存在补记 → 说明边界已靠补记账兜着，继续严禁 */
    const streakHeavy = streakLen >= 3 && streakHasManual;
    const weekCallDays = weeklyCallCount;
    const weekCapDays = quota;

    /* 基础环境判定。最终结论还要叠加「通话对象 · 联系规则」人工自检。 */
    let verdict, color, advice;
    if (timerSleeping) {
      verdict = "睡眠计时中 · 禁止接听";
      color = "#1e40af";
      advice = "主站正在计时睡眠（以计时标签为准）——规则部规定：请直接挂断或只回文字，任何豁免不可覆盖";
    } else if (inStudy && overrideActive("necessary")) {
      const ov = getOverride("necessary");
      verdict = "已报规则部 · 特殊处理中";
      color = "#d97706";
      advice = `豁免理由「${ov.reason}」· 到期自动恢复限制；通话仍须双闹钟并及时挂断`;
    } else if (inStudy) {
      verdict = "需人工判断";
      color = "#d97706";
      advice = "大自习板块理论不允许接听：若正在专注，必须挂断；若此刻确属垃圾时间，需人工确认后再判断";
    } else if (weeklyCallCount >= quota || weeklyCallMinSec > (D.weeklyRule.maxMinPerWeek || Infinity) * 60) {
      verdict = "额度已用尽 · 建议拒绝";
      color = "#ef4444";
      advice = `本周通话已用 ${weeklyCountSlot(weeklyCallCount)}${Math.round(weeklyCallMinSec / 60)}/${D.weeklyRule.maxMinPerWeek}min——建议只回文字`;
    } else {
      verdict = "等待本次自检";
      color = "#d97706";
      advice = `先确认这是垃圾时间且不影响进度 · 本周 ${weeklyCountSlot(weeklyCallCount)}${Math.round(weeklyCallMinSec / 60)}/${D.weeklyRule.maxMinPerWeek}min` +
        /* ★ v1.93.0：奇偶日策略取消，「单数日再接」这句建议随之作废；
         *   改由下面 yestCalledToday 统一给「昨日已通话 → 今日不建议」的提示。 */
        (yesterdayCalled ? "｜⚠️ 昨日已通话 · 今日强烈不建议" : "");
    }
    if (isSleep && !timerSleeping) advice += "｜🌙 规则部建议：此刻为睡眠时段（仅建议，以计时标签为准）";
    /* ★ v1.93.0：删掉「今日单数日 ✅」——奇偶日策略已取消，留着会误导。 */

    return { dateStr, dayName, day, isOdd, verdict, color, advice, weeklyCallCount, weeklyCallMinSec, slotInfo, isSleep, timerSleeping, inStudy,
      /* ★ v1.37.0 新三门闸的当日实况（供判定、周频率卡、闪卡共用，避免各算各的） */
      /* ★ v1.101.0：与「今日已通话」**同一个函数**取值（含正在进行的通话）。
       *   旧实现这里读 dayCallMin（只算已结束的记录），而顶部双闹钟区读 todayCallMin
       *   （旧的自然日口径）→ 展示 68 / 判定 8 这种自相矛盾就是这么来的。 */
      curDayMin: Math.round((dayCallSec(dateStr) + liveCallSecInBiz(dateStr)) / 60),  // 今日已接通分钟
      /* ★ v1.93.0 奇偶日取消：这三个字段保留为"关闭"态，让 call.js 里 20 处
       *   `j.oddEvenOn && ...` 分支自然短路（逐个删风险远大于留字段）。
       *   ⚠️ 不得再让 oddEvenOn 变回 true —— 那是已废止的策略。 */
      oddEvenOn: false,
      oddDay: true,
      evenUsed: [],
      /* ★ v1.93.0 新三门闸当日实况（判定卡 / 周频率卡 / 闪卡共用同一份，避免各算各的） */
      /* ★ v1.104.0：补 `streak`（连续通话日的 key 数组）。
       *   原先只有 streakLen / streakHasManual，而 evaluateCallDecision 的连续禁令文案
       *   读的是 `j.streak`（用于列出「哪两天」）→ 永远是空数组 → 用户看到
       *   「已连续 2 个通话日（），第 3 天严禁通话」，括号空着，「等」字也永不出现。
       *   这正是最需要说清"哪几天"的地方，所以必须把数组本身也交出去。 */
      streakLen, streakHasManual, yesterdayCalled, bannedByStreak, streakHeavy, streak,
      weekCallDays, weekCapDays,
      dayCapMin: dayMinCap(dateStr),                   // 日闸上限（0 = 不设）
      weekCapMin: (D.weeklyRule && D.weeklyRule.maxMinPerWeek) || 0,
      /* ★ v1.29.7 当日管控指令：判定面板头行用它取代「第N日」（第N日只是单双日载体，用户看着费解）。
       * ★ v1.43.0：原 headline 取自**特殊管理日**的手写指令（如「今日白天睡觉，晚上值班，今日请拒绝」），
       *   该功能停用后不再有逐日手排指令。这里改由**长期规则自动摘要**，
       *   避免面板头行整段空掉（那一行的作用就是「一眼知道今天按什么口径走」）。 */
      /* ★ v1.49.0（用户 2026.10.17 指定）：删掉 18:30–23:00 / 23:00–23:40 / 00:00–07:00
       *   三段罗列——这三段已是每日常态，顶部闪卡会按时段自动亮出**当前那一段**，
       *   写在这里等于把同一件事说两遍，还把结论行挤成一长串（用户原话：「无需书写这么多的内容」）。
       *   保留「当天口径」（奇偶日）——这行原本的作用就是「一眼知道今天按什么规则走」。 */
      headline: (function () {
        const parts = [];
        /* ★ v1.93.0：奇偶日文案作废，换成一眼能懂的三门闸口径 */
        parts.push(`本周通话 ${weekCallDays}/${weekCapDays === Infinity ? "∞" : weekCapDays} 天`);
        if (bannedByStreak) {
          parts.push(streakHeavy ? `连续 ${streakLen} 天·含补记 → 今日严禁` : `连续 ${streakLen} 天 → 今日严禁`);
        } else if (yesterdayCalled) parts.push("昨日已通话 · 今日不建议");
        return parts.join(" · ");
      })() };
  }

  /* ★ v1.104.0（用户 2026-10-29 审查后指定）：judgeToday 的 1 秒记忆化。
   *   起因：勾一次复选框 → refreshCallDecision → evaluateCallDecision（1 次）
   *        → renderWeeklyInfo → evaluateCallDecision（再 1 次），renderJudge 自身还调 1 次。
   *   单次 _judgeTodayRaw 内部：calcWeeklyCallCount + calcWeeklyCallMinSec 各遍历
   *   time_records 全表，consecutiveCallDaysBefore 每天再调 isCallDay → dayCallSec 又遍历一次，
   *   time_records 已 1000+ 行 → 一次勾选 6–10 次全表遍历，手机上肉眼可见地顿。
   *   ⚠️ 只缓存 1 秒，且**只缓存数据层结果**（judgeToday 不读 DOM，读的是 Store 与钟点）。
   *      勾选类人工判断在 evaluateCallDecision 里另读，不受影响。
   *   注：原实现保留为 _judgeTodayRaw，本函数只做薄包装（不改任何判定逻辑）。 */
  let _judgeCache = { at: 0, val: null };
  function judgeToday() {
    const t = Date.now();
    if (_judgeCache.val && t - _judgeCache.at < 1000) return _judgeCache.val;
    const val = _judgeTodayRaw();
    _judgeCache = { at: t, val };
    return val;
  }
  /* ★ v1.104.0：**必须**在数据源变化时立即作废缓存。
   *   否则会出现这种静默失败：t=0 判了一次（睡眠计时中→禁止）并被缓存；
   *   t=0.5s 计时停止 → subscribeActiveTimer 触发 renderJudge → 命中 1 秒内的旧缓存
   *   → 判定卡继续显示「睡眠计时中 · 禁止接听」，而此后**没有任何事件**再触发重判
   *   （30 秒心跳只在时段/豁免/业务日变化时才 renderJudge），于是一直错到下次勾复选框。
   *   所以三个订阅回调（主计时器 / 任务 / 时间记录）开头都必须清这一份。 */
  function _judgeInvalidate() { _judgeCache = { at: 0, val: null }; }

  function activeStudyTimer() {
    const at = Store.getActiveTimer();
    return !!(at && at.status === "running" && at.kind === "study");
  }

  /* ==================== ★ v1.70.0 建议指标 · 一键绕过（用户 2026.10.18 定稿）====================
   * 三层判定（用户拍板口径）：
   *   ① 强制 = 事实状态 + 规则部明令不可覆盖 —— 睡眠段 23:40–07:00、晚自习核心 18:30–23:40、
   *      正在通话、睡眠计时、**主站正在计时学习**、日闸 40 / 周 120 / 奇偶日名额、邀约 / 影响进度。
   *      这些**不出现绕过按钮**，只能走豁免申请。
   *   ② 建议 = 时段推断 + 工作/实习计时 —— 学习区间、本大块后面还排着学习、正在工作/实习。
   *      可一键绕过（弹二次判断页），**每天 2 次**，第 3 次起提示报规则部。
   *   ③ 人工 = 「当前是垃圾时间」「置后定则是否完成」两个复选框。
   *      用户 2026.10.18 选 B：**绕过只管建议项，置后框仍必须自己勾** ——
   *      理由是「大块时间里不乏少量垃圾时间，可以充分利用」：
   *        · 勾「垃圾时间」＝ 判定块内确有垃圾窗口（合法路径，不消耗绕过次数）
   *        · 按绕过按钮 ＝ 明知不是垃圾时间仍然接（消耗次数、留痕）
   * 绕过有效期：**只对本次来电** —— 同一时段 + 30 分钟内，换时段或超时即失效。
   * 存储：localStorage 权威 + 云端轻量 KV（koujue_state / scope=call_bypass）镜像；
   *   **不进时间账本、不进每日复盘、不进统计页**（用户原话：大块绕过暂时先不记录）。
   *   ⚠️ 不复用 sync_ops：那是计时器操作队列，塞非计时行会污染远端 STOP 判定与回放。 */
  const BYPASS_LS = "kaoyan:call_bypass";
  const BYPASS_SCOPE = "call_bypass";
  const BYPASS_MAX_PER_DAY = 2;          // 每日可绕过次数（护栏）
  const BYPASS_TTL = 30 * 60 * 1000;     // 一次绕过 30 分钟内有效（且限同一时段）

  /* ★ v1.93.0：「今天」= 业务日（04:00 换天），与通话日口径同源。
   *   影响：绕过次数、闪卡等按日重置的状态，都改到凌晨 4 点翻篇。 */
  function todayKeyBJ() { return todayBizKey(); }
  function bypassState() {
    const today = todayKeyBJ();
    try {
      const raw = localStorage.getItem(BYPASS_LS);
      const o = raw ? JSON.parse(raw) : null;
      if (!o || o.date !== today) return { date: today, used: 0, active: null, log: [] };
      return { date: o.date, used: o.used || 0, active: o.active || null, log: o.log || [] };
    } catch (e) {
      return { date: today, used: 0, active: null, log: [] };
    }
  }
  function saveBypassLocal(o) {
    try { localStorage.setItem(BYPASS_LS, JSON.stringify(o)); } catch (e) {}
  }
  /* 写本地 + 镜像到云端轻量 KV（失败静默：离线也必须能绕过） */
  function saveBypassState(o) {
    saveBypassLocal(o);
    try {
      if (window.Store && window.Store.setShared) {
        window.Store.setShared(BYPASS_SCOPE, { date: o.date, used: o.used, log: (o.log || []).slice(-20) })
          .catch(() => {});
      }
    } catch (e) {}
  }
  /* 启动时把云端计数并进来（换设备后护栏仍算数）：只取"同日且更大"的值，不覆盖本地日志 */
  function syncBypassFromCloud() {
    try {
      if (!window.Store || !window.Store.getShared) return;
      window.Store.getShared(BYPASS_SCOPE, null).then(v => {
        if (!v || !v.date) return;
        const o = bypassState();
        if (v.date === o.date && (v.used || 0) > (o.used || 0)) {
          o.used = v.used;
          saveBypassLocal(o);   // 只落本地，避免又弹一次 setShared
        }
      }).catch(() => {});
    } catch (e) {}
  }
  /* keys 全部被同一张"绕过通行证"覆盖才算数（避免半覆盖导致状态闪烁） */
  function bypassActiveFor(keys, slotKey) {
    const a = bypassState().active;
    if (!a || !Array.isArray(a.keys) || !a.until) return false;
    if (Date.now() > a.until) return false;
    if (slotKey && a.slot && a.slot !== slotKey) return false;
    return keys.every(k => a.keys.indexOf(k) >= 0);
  }
  function grantBypass(keys, slotKey, items) {
    const o = bypassState();
    o.used = (o.used || 0) + 1;
    o.active = { keys: keys.slice(), slot: slotKey || "", until: Date.now() + BYPASS_TTL };
    o.log = (o.log || []).concat([{
      ts: Date.now(), slot: slotKey || "",
      items: (items || []).map(x => x.label)
    }]).slice(-30);
    saveBypassState(o);
    return o;
  }
  function revokeBypass() {
    const o = bypassState();
    o.active = null;
    saveBypassLocal(o);
    return o;
  }
  function bypassLeftToday() {
    return Math.max(0, BYPASS_MAX_PER_DAY - (bypassState().used || 0));
  }

  function checked(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  }

  /* 把静态规则真正变成可执行判定。顺序即优先级，命中第一条就停止。 */
  function evaluateCallDecision() {
    const j = judgeToday();
    const quotaOv = getOverride("quota_extra");
    const necessaryOv = getOverride("necessary");
    const at = Store.getActiveTimer();
    const taskGate = getTaskGate(j.dateStr);
    const focused = activeStudyTimer() || checked("currentlyFocused");
    const isInvitation = checked("isInvitation");
    const affects = checked("impactStudy");
    const garbage = checked("garbageTime");
    const affairs = checked("affairsDone");
    const deferred = checked("followDeferRule");

    /* ★ v1.50.0：已在通话中且已进入睡眠段 → 提醒须在 sleepEndBy 前结束。
     * ★ v1.94.0：睡眠段起点 23:40 → 00:00，缓冲 23:45 → 00:05（随起点后移）。
     *   ⚠️ 文案里不再硬编码 "00:00"——睡眠段起点已可配置，硬编码会与数据分叉。 */
    if (at && at.kind === "call") {
      const endTip = sleepWindowBlocking(j.dateStr)
        ? `主站已存在通话计时：不要重复开始。⏰ 已进入强制睡觉时间——按规则须在 ${sleepEndByText()} 前结束本次通话（未安排睡觉也同样适用）。`
        : "主站已存在通话计时：不要重复开始，按当前时长执行双闹钟与强硬收尾。";
      return { ...j, allowed: false, hard: true, verdict: "正在通话", color: "#2563eb", advice: endTip };
    }
    if (j.timerSleeping) return { ...j, allowed: false, hard: true, verdict: "睡眠计时中 · 禁止接听", color: "#1e40af", advice: "主站正在计时睡眠（以计时标签为准）——规则部规定：请直接挂断或只回文字，任何豁免不可覆盖。" };
    /* ★ v1.47.6 睡眠段（v1.50.0 起为 23:40–07:00；**v1.94.0 起为 00:00–07:00**）：**只看钟点**，到点即不得通话。
     * 硬阻断、豁免不可覆盖。与上面 timerSleeping 是两条独立口径，任一成立即不接。 */
    if (sleepWindowBlocking(j.dateStr)) {
      const ns = nightStudyInfo();
      return { ...j, allowed: false, hard: true, verdict: "强制睡觉时间 · 禁止接听", color: "#1e40af",
        advice: `${ns.sleepFrom}–${ns.sleepTo} 为强制睡觉时间（含准备睡觉，${ns.basis}）——不得通话；已在通话中的须在 ${sleepEndByText()} 前结束；未安排睡觉的同样适用，任何豁免不可覆盖。` };
    }
    /* ★ v1.43.0 长期禁接窗：每日晚自习时间（核心 18:30–23:00 + 延展 23:00–24:00，用户 2026.10.12 指定，原话
     *   「禁止接听电话，不得有任何例外」）。
     * 位置与强度：**排在 focused / 邀约 / 周额度之前**，硬阻断且豁免不可覆盖——
     *   quota_extra、necessary 两类豁免都只在后面的闸口里起作用，绕不过本条。
     * ★ 原「v1.23.0 特殊管理日」整段判定（offFrom~offTo / from / capMin=0 / 额度用尽 四条）
     *   随该功能一并删除：逐日 capMin 制度已于 2026-10-12 停用，见 call-data.js specialPlan 注释。 */
    if (nightStudyBlocking(j.dateStr)) {
      const ns = nightStudyInfo();
      return { ...j, allowed: false, hard: true, verdict: "晚自习核心时间 · 禁止接听", color: "#dc2626",
        advice: `${ns.offFrom}–${ns.offTo} 为${ns.label}（${ns.basis}）——此刻不得接打电话，来电直接拒接 / 只回文字，**不受垃圾时间调剂**，任何豁免不可覆盖。` };
    }
    /* ★ v1.47.6 晚自习**延展段** 23:00–24:00（v1.94.0 由 23:40 延长）：仍是晚自习，但**接受垃圾时间调剂** ——
     * 勾选确认「当前是垃圾时间」才放行；未确认按不可接处理（软阻断 hard:false）。 */
    /* ★ v1.93.0：按下「今日有加时自习」后，调剂段**不再接受垃圾时间调剂**——
     *   今晚要加时，这段就不是"可以商量的垃圾时间"，而是直接禁止。 */
    const tmSoft = todayMode();
    if (nightStudySoftBlocking(j.dateStr) && (!garbage || tmSoft.extraStudy)) {
      const ns = nightStudyInfo();
      const why = tmSoft.extraStudy
        ? `已设「今日有加时自习」：${ns.softFrom}–${ns.softTo} 这段今晚要加时学习——**不再接受垃圾时间调剂**，直接禁止通话；凌晨 4 点自动解除。`
        : `${ns.softFrom}–${ns.softTo} 仍是晚自习（${ns.softLabel}）——**接受垃圾时间调剂**：仅在主页面确认当前确属垃圾时间后才可接听；未确认按不可接处理。`;
      return { ...j, allowed: false, hard: false,
        verdict: tmSoft.extraStudy ? "加时自习 · 调剂段禁止" : "晚自习延展段 · 需垃圾时间",
        color: "#d97706", advice: why };
    }
    if (focused) return { ...j, allowed: false, hard: true, verdict: "禁止接听", color: "#dc2626", advice: "人工判断为正在专注学习（或主站正在学习计时）：一定不允许接通。" };
    /* ★ v1.24.5 临时取消「任务未完成 → 禁止接听」（用户指定，后续可能恢复）：
     * taskGateEnabled=false 时任务门禁完全不进入禁止条件（判定与核验表都跳过）。
     * 恢复 = call-data.js rules.taskGateEnabled 改回 true，逻辑原样。 */
    /* ★ v1.107.0（用户 2026-10-31）：任务门禁只在夜间（18:30–次日 07:00）生效。
     *   白天不再因「任务未勾完」硬拦来电 —— 见 taskGateApplies() 的说明。 */
    if ((D.rules.taskGateEnabled !== false) && taskGateApplies() && !taskGate.ok) return { ...j, allowed: false, hard: true, verdict: "任务未完成 · 禁止接听", color: "#dc2626", advice: `系统发现 ${gateText(taskGate)}（口径：只统计「单词突围」，天天师兄/人可研梦不参与）；先完成任务，豁免也不能绕过。` };
    if (isInvitation) return { ...j, allowed: false, hard: true, verdict: "禁止接听", color: "#dc2626", advice: "通话对象规则：邀约类来电不得接听，只能文字回复。" };
    if (affects) return { ...j, allowed: false, hard: true, verdict: "禁止接听", color: "#dc2626", advice: "本次通话会影响正常进度：请直接挂断或改期。" };
    /* ★ v1.93.0「今日不聊天」：用户**主动按下**的全天禁令（规则部置后定则相关强制规则）。
     *   与连续禁令不同：那条是系统算出来的、允许走 necessary 豁免；
     *   这一条是用户自己今天不想聊——没有"不得不接"的例外理由，故不可豁免。 */
    if (todayMode().noChat) {
      return { ...j, allowed: false, hard: true, verdict: "今日不聊天 · 全天禁止", color: "#dc2626",
        advice: "已按下「今日不聊天」：今天全天禁止接听（含 23:00–24:00 调剂段），不设例外；凌晨 4 点自动解除。来电直接拒接 / 只回文字。" };
    }
    /* ★ v1.93.0 连续通话禁令（用户 2026-10-25 指定，**规则部强制规则**）：
     *   连续 2 个通话日（每天接通总时长 >5min）→ 第 3 天严禁通话；
     *   已连续 ≥3 天且链上存在补记记录 → 继续严禁（第 4 天、以此类推）。
     *   **跨周不断链**（用户明确要求「含跨周通话」），天 = 业务日（04:00 换天）。
     *   强度：强制层，但**允许走 necessary 豁免**（用户拍板：可豁免但必须留痕）——
     *   这点与睡眠 / 晚自习 / 专注不同，那些是任何豁免都不可覆盖。 */
    if (j.bannedByStreak && !necessaryOv) {
      const tail = (j.streak || []).slice(0, 4).map(k => `${Number(k.slice(5, 7))}月${Number(k.slice(8))}日`).join("、");
      return { ...j, allowed: false, hard: true, verdict: "连续通话 · 今日严禁", color: "#dc2626",
        advice: `规则部强制：已连续 ${j.streakLen} 个通话日（${tail}${(j.streak || []).length > 4 ? "等" : ""}）` +
          (j.streakHeavy ? "，且这串记录里有补记——说明边界一直靠事后补账兜着" : "") +
          `，第 ${j.streakLen + 1} 天严禁通话。来电直接拒接 / 只回文字；确属不得不接时，须走「正经时间豁免」并留痕。` };
    }
    /* ★ v1.37.0 周时长闸（原「次数 ≤N 且 ≤120min」双闸，现只留时长；次数闸由 weeklyCountCap() 判，
     *   maxPerWeek:null → Infinity → 永不触发）。quota_extra 豁免可覆盖周时长。 */
    const wkMinExceeded = j.weeklyCallMinSec > (j.weekCapMin || Infinity) * 60;
    if ((j.weeklyCallCount >= weeklyCountCap() || wkMinExceeded) && !quotaOv) {
      return { ...j, allowed: false, verdict: "周额度已用尽", color: "#dc2626", advice: `本周通话 ${weeklyCountSlot(j.weeklyCallCount)}${Math.round(j.weeklyCallMinSec / 60)}/${j.weekCapMin}min——已达上限；只有确认是垃圾时间后，才可申请“周额度豁免”额外放行一次。` };
    }
    /* ★ v1.37.0 日时长闸 · 奇偶日（用户 2026.10.07 指定：硬阻断，豁免不可覆盖）。
     *   顺序：先日闸（省流，最快排除）→ 再偶日配额。理由写在用户原话里：
     *   「避免一天通话把全周的额度都占完了」——单日封顶是这套规则的**目的本身**，故放在最前。 */
    /* ★ v1.93.0：日闸（单日 40 分钟封顶）**必须与奇偶日解耦**。
     *   原写法是 `j.oddEvenOn && ...`，奇偶日一取消（oddEvenOn 恒 false）日闸会跟着失效，
     *   而"单日封顶"是用户从未要求取消的独立闸口（目的：避免一天把全周额度占完）。 */
    if (j.dayCapMin > 0 && j.curDayMin >= j.dayCapMin) {
      return { ...j, allowed: false, hard: true, verdict: "今日时长已封顶 · 禁止接听", color: "#dc2626",
        advice: `规则部：单日通话不得超过 ${j.dayCapMin} 分钟（今日已通 ${j.curDayMin} 分钟）——本周还剩 ${Math.max(0, j.weekCapMin - Math.round(j.weeklyCallMinSec / 60))} 分钟，明天再聊。来电直接拒接 / 只回文字。` };
    }
    if (j.oddEvenOn && !j.oddDay) {
      const cfg = (D.weeklyRule && D.weeklyRule.oddEven) || {};
      const quotaAlt = cfg.evenDaysPerWeek || 1;
      const mineUsed = j.evenUsed.indexOf(j.dateStr) >= 0;   // 今日就是本周那 1 个名额
      if (!mineUsed && j.evenUsed.length >= quotaAlt) {
        const usedTxt = j.evenUsed.map(k => `${Number(k.slice(5, 7))}月${Number(k.slice(8))}日`).join("、");
        return { ...j, allowed: false, hard: true, verdict: "偶数日 · 本周名额已用 · 禁止接听", color: "#dc2626",
          advice: `规则部：偶数日每个自然周只能通话 ${quotaAlt} 天——本周已用在 ${usedTxt}；今天是偶数日（${Number(j.dateStr.slice(5, 7))}月${Number(j.dateStr.slice(8))}日），名额已满，请等下一个奇数日。来电直接拒接 / 只回文字。` };
      }
    }
    if (!affairs) return { ...j, allowed: false, verdict: "请判断", color: "#d97706", advice: "先处理完自身事务；对方来电排在所有正经任务之后。（下方自检项逐项判断）" };
    /* ★ v1.70.0（用户 2026.10.18 选 B）：置后定则**仍是人工判断**，绕过不覆盖它 ——
     *   绕过只管「学习区间 / 大块后还有学习 / 工作实习计时」这三类建议项。 */
    if (!deferred) return { ...j, allowed: false, verdict: "先置后", color: "#d97706", advice: "先问：能否稍后回拨或用文字解决？确认已执行置后定则。" };

    /* ---------- ★ v1.70.0 建议指标收集（不强制，可一键绕过）----------
     * 三类都来自「推断」而非「事实行为」：
     *   ① 计划表说现在是学习区间 —— 建议，因为每天任务不像大块那样机械化；
     *   ② 大块后面还排着学习（置后推断）—— 建议，理由同上（大块里不乏少量垃圾时间）；
     *   ③ 主站正在计时工作 / 实习 —— 建议（用户 2026.10.18 明确：只有**学习**计时才硬拦）。
     * ⚠️ 主站正在计时**学习**仍在上面的 focused 分支里硬拦，不在此列。 */
    const advItems = [];
    const siNow = j.slotInfo;
    const slotKeyNow = (siNow && siNow.slot) ? (siNow.slot.start + "-" + siNow.slot.end) : "";
    if (j.inStudy && siNow && siNow.slot) {
      const leftMin = Math.max(0, Math.round((toMin(siNow.slot.end) * 60 - nowSecBJ()) / 60));
      advItems.push({ key: "studySlot", label: "现在是学习区间",
        detail: `〈${cleanName(siNow.slot.name)} ${siNow.slot.start}~${siNow.slot.end}〉还剩 ${fmtRemain(leftMin)}——计划表口径：正经时间一律不建议聊天` });
    }
    if (!j.inStudy && siNow && siNow.slot && blockHasStudyAfter(siNow.slot)) {
      const nextWin = deferWindowText(j.dateStr);
      advItems.push({ key: "deferBlock", label: "本大块后面还排着学习",
        detail: `后续还有学习/工作任务 → 置后定则优先于垃圾/休息并行利用${nextWin ? `；可改约「${nextWin}」` : "；今日已无合格收尾段"}` });
    }
    if (at && at.status === "running" && (at.kind === "work" || at.kind === "internship")) {
      const catsNow = (window.APP_CONFIG && window.APP_CONFIG.TIME_CATEGORIES) || [];
      const cmNow = catsNow.find(c => c.key === at.kind) || { label: at.kind };
      const elSec = Math.max(0, Math.round((at.elapsed_sec || 0) + (Date.now() - (at.started_at || Date.now())) / 1000));
      advItems.push({ key: "workTiming", label: `主站正在计时〈${cmNow.label}〉`,
        detail: `已 ${fmtRemain(Math.floor(elSec / 60))}——正经事进行中，建议这边结束后再回电` });
    }
    const advKeys = advItems.map(x => x.key);
    const bypassed = advKeys.length > 0 && bypassActiveFor(advKeys, slotKeyNow);
    if (advItems.length && !bypassed && !garbage && !necessaryOv) {
      return { ...j, allowed: false, hard: false, adviseOnly: true, advItems,
        bypassLeft: bypassLeftToday(), bypassUsedToday: bypassState().used || 0,
        verdict: bypassLeftToday() > 0 ? "建议不接 · 可一键绕过" : "建议不接 · 今日绕过次数已用尽",
        color: "#d97706",
        advice: `上面 ${advItems.length} 条是<b>建议指标</b>（不强制）。` +
          (bypassLeftToday() > 0
            ? `想接就点「绕过建议」：会先弹规则二次判断页，确认后放行，<b>今日还剩 ${bypassLeftToday()} 次</b>。`
            : `<b>今日 ${BYPASS_MAX_PER_DAY} 次已用完</b> → 本次需报规则部（或勾「当前是垃圾时间」走合法路径）。`) +
          `若块内确有垃圾窗口，直接勾「当前是垃圾时间」即可，不消耗绕过次数。` };
    }
    if (!garbage && !necessaryOv && !bypassed) {
      return { ...j, allowed: false, verdict: j.inStudy ? "正经时间 · 不可接" : "尚未确认垃圾时间", color: "#d97706", advice: "所有通话只能发生在垃圾时间或完全不影响进度的时间。确实不得不，才申请正经时间豁免。" };
    }
    /* ★ v1.93.0：奇偶日话术作废（用户 2026-10-25 拍板取消该策略），
     *   换成「昨日是否通话」的强提示——这才是现在对本次通话真正有约束力的建议。
     * ★ v1.104.0：补「这一通的代价」。原先 else 分支只说"不会明令违规"，
     *   却不说接通之后链就接上了 —— 而"连续 2 天 → 第 3 天严禁"这套链式后果
     *   是整套规则里最难自觉记住的部分，必须在放行的那一刻说清，不能等明天再讲。 */
    const oddTip = j.yesterdayCalled
      ? "⚠️ 昨日已通话 · 规则部强烈建议今日不再通话（连续通话链一旦接上，明天就是严禁日）"
      : "昨日未通话 · 连续链已断，今天接一通不会明令违规；" +
        "<b>但接通后即成为连续第 1 天 —— 明天再通一次（>5min），后天就是严禁日</b>";
    const sleepTip = j.isSleep ? "｜🌙 规则部建议：此刻为睡眠时段（仅建议，以计时标签为准）——尽快收尾休息。" : "";
    /* ★ v1.104.0：任务数据缺失时**不阻断但必须说出来**（空档兜底，见 isWordPlanDay 注释）。
     *   静默放行是本项目最易复发的病：门禁没生效，界面上却和"任务都完成了"完全一样。 */
    /* ★ v1.107.0：门禁只在 18:30 起生效 —— 白天要么什么都不说，要么说清「到点会阻断」，
     *   绝不能显示成「门禁未生效」那种像故障的措辞（白天本来就不该生效）。 */
    const gateTip = (D.rules.taskGateEnabled === false)
      ? ""
      : (!taskGateApplies()
          ? (taskGate.ok ? "" : `｜任务门禁现在不检查（${taskGateWindow().from} 起生效）——但今日仍有未勾完的单词任务，到点会阻断`)
          : (taskGate.dataMissing
              ? "｜⚠️ 今日在单词计划内却查不到任务行 —— 任务门禁本次<b>未生效</b>，请自行确认是否真的背完了"
              : ""));
    /* ★ v1.43.0：原 sdTip（特殊管理日余量）随该功能一并删除，改用**长期日闸**的余量提示
     *   （单日 ≤40min）。理由：「今天还剩几分钟能聊」是通话前的刚需信息，
     *   不能因为一次性为期制度下线就跟着消失——它现在由长期规则接续提供。 */
    /* ★ v1.93.0：解耦奇偶日 */
    const dayTip = (j.dayCapMin > 0)
      ? `｜今日已通 ${j.curDayMin}/${j.dayCapMin}min，还剩 ${Math.max(0, j.dayCapMin - j.curDayMin)}min`
      : "";
    return { ...j, allowed: true, advItems, bypassed, bypassLeft: bypassLeftToday(),
      verdict: bypassed ? "已绕过建议 · 允许接听 · 必开双闹钟" : "允许接听 · 必开双闹钟",
      color: "#15803d",
      advice: (bypassed
        ? `⚠️ 这是<b>绕过建议指标</b>后放行的（今日第 ${(bypassState().used || 0)} 次）——建议项：` +
          advItems.map(x => x.label).join(" / ") + "。绕过只对本次来电有效（同时段 30 分钟）。" +
          "双闹钟必须开，到点 3 分钟内挂断。<br>"
        : "人工自检通过：垃圾时间、不影响进度、非邀约；") + `${oddTip}${sleepTip}${dayTip}${gateTip}` };
  }

  /* ---------- ★ v1.55.0 主站计时器联动：给外部一个「此刻口径」取色接口 ----------
   * 需求（用户 2026.10.18）：主站在计时**通话边界分类**时，旁边的入口按钮颜色要与
   *   通话页「本次来电结论」的**文字颜色联动**（不可接=红、可调剂=琥珀、可接=绿…）。
   * ⚠️ 为什么不能直接在主站调 evaluateCallDecision()：它要读 6 个自检复选框的 DOM
   *   （checked()），计时页没有那些元素 → 全按 false 走，结论恒为「请判断」（琥珀），
   *   颜色就废了。故另开 quickVerdict()：**只吃数据与钟点**，命中硬阻断即与判定卡同色，
   *   都没命中说明「还得人去通话页自检」→ 琥珀 + 明确写「需到通话页自检」。
   * ⚠️ 更准的一条：通话页**刚判过**（30 分钟内）就用那次的真实结论（含人工自检项），
   *   存在 localStorage —— 这才是真正的「联动」，否则只是同源估算。 */
  const VERDICT_CACHE_KEY = "kaoyan:call_verdict_cache";
  /* ★ v1.104.0（用户 2026-10-29 审查后指定）：TTL 30 分钟 → **5 分钟**，并绑定时段。
   *   旧口径的漏洞：主站通话中入口优先读缓存，于是可能挂着 30 分钟前的绿色「允许接听」——
   *   这期间日闸封顶 / 跨进 18:30 核心段 / 额度用尽，颜色一个都不变，人看到绿灯就去接。
   *   现在两条一起兜：① 5 分钟过期；② 时段 key 变了立刻判缓存作废（跨 18:30、跨 00:00 都是硬边界）。 */
  const VERDICT_CACHE_TTL = 5 * 60 * 1000;
  function quickVerdict() {
    try {
      const j = judgeToday();
      const at = Store.getActiveTimer();
      if (at && at.kind === "call") return { verdict: "正在通话", color: "#2563eb" };
      /* ★ v1.93.0：主站口径必须与通话页一致 —— 否则「通话页说严禁、主站计时器仍显示
       *   『需到通话页自检』」，用户跨页看到两个相反结论（v1.90.0 静默失败老毛病）。 */
      const tmQ = todayMode();
      if (j.timerSleeping) return { verdict: "睡眠计时中 · 禁止接听", color: "#1e40af" };
      if (sleepWindowBlocking(j.dateStr)) return { verdict: "强制睡觉时间 · 禁止接听", color: "#1e40af" };
      if (nightStudyBlocking(j.dateStr)) return { verdict: "晚自习核心时间 · 禁止接听", color: "#dc2626" };
      /* 加时自习：调剂段 23:00–24:00 由「需垃圾时间」升级为「禁止」 */
      if (nightStudySoftBlocking(j.dateStr)) {
        return tmQ.extraStudy
          ? { verdict: "加时自习 · 调剂段禁止", color: "#dc2626" }
          : { verdict: "晚自习延展段 · 需垃圾时间", color: "#d97706" };
      }
      /* ★ v1.104.0：以下顺序**逐条对齐** evaluateCallDecision（去掉 DOM 复选框相关项）。
       *   旧实现是 noChat 打头、bannedByStreak 排在专注之前，与主判定顺序相反 ——
       *   两者同时成立时两页显示不同结论（同色不同文案，或文案指向不同原因）。 */
      if (activeStudyTimer()) return { verdict: "专注中 · 禁止接听", color: "#dc2626" };
      /* ★ v1.107.0：主站横幅的同一道门禁也必须按时段收窄，否则两页又各说各话 */
      if ((D.rules.taskGateEnabled !== false) && taskGateApplies() && !getTaskGate(j.dateStr).ok) return { verdict: "任务未完成 · 禁止接听", color: "#dc2626" };
      if (tmQ.noChat) return { verdict: "今日不聊天 · 全天禁止", color: "#dc2626" };
      /* ★ v1.104.0：补豁免判断 —— 主判定卡已申请到豁免时会放行，
       *   主站若仍报红色「今日严禁 / 周额度已用尽」，就是两页说两种话（v1.90 老毛病）。 */
      if (j.bannedByStreak && !getOverride("necessary")) {
        return { verdict: j.streakHeavy ? `连续 ${j.streakLen} 天·含补记 · 今日严禁` : `连续 ${j.streakLen} 天 · 今日严禁`, color: "#dc2626" };
      }
      /* ★ v1.104.0：补「周 4 个通话日」天数闸 —— 旧实现只判 120 分钟时长，
       *   周天数用尽时主站会落到「需到通话页自检」，而通话页已经明说「周额度已用尽」。 */
      if ((j.weeklyCallCount >= weeklyCountCap() || j.weeklyCallMinSec > (j.weekCapMin || Infinity) * 60) && !getOverride("quota_extra")) {
        return { verdict: "周额度已用尽", color: "#dc2626" };
      }
      /* ★ v1.93.0：解耦奇偶日（主站判定卡必须仍能显示日闸封顶） */
      if (j.dayCapMin > 0 && j.curDayMin >= j.dayCapMin) return { verdict: "今日时长已封顶", color: "#dc2626" };
      return { verdict: "需到通话页自检", color: "#d97706" };
    } catch (e) {
      /* 取不到（Store 未就绪等）→ 用分类色兜底，绝不抛错打断主站计时 */
      return { verdict: "通话边界", color: "#66ccff" };
    }
  }
  function verdictNow() {
    try {
      const raw = localStorage.getItem(VERDICT_CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        /* ★ v1.104.0：时段变了缓存即作废（旧缓存没有 slot 字段 → 视为可继续用，只是靠 5 分钟兜）。 */
        const si0 = currentSlotInfo();
        const slot0 = (si0 && si0.slot) ? (si0.slot.start + "-" + si0.slot.end) : "";
        const slotOk = !c.slot || !slot0 || c.slot === slot0;
        if (c && c.color && slotOk && (Date.now() - (c.ts || 0)) < VERDICT_CACHE_TTL) {
          return { verdict: c.verdict, color: c.color, source: "last" };
        }
      }
    } catch (e) {}
    return { ...quickVerdict(), source: "quick" };
  }

  /* 某业务日所在自然周的周一（周配额按周一起算，沿用原有自然周机制） */
  function bizWeekMondayOf(dayKey) {
    const d = parseKey(dayKey);
    const dow = d.getDay() || 7;
    d.setDate(d.getDate() - (dow - 1));
    const z = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  /* ★ v1.93.0 本周「有通话的天数」——周配额口径 = 4 天（用户 2026-10-25 拍板）。
   *   旧实现数的是**记录条数**（一天 6 通就计 6 次），与「7 天中只能通话 4 次」的
   *   天口径完全不是一回事：近五天实测条数 16、天数 5，两种算法结论差 3 倍。
   *   天 = 业务日（04:00 换天），且当天接通总时长 > 5min 才计入（3 分钟短通话不消耗配额）。 */
  function calcWeeklyCallCount(beijing) {
    const today = todayBizKey();
    const mon = bizWeekMondayOf(today);
    const byDay = {};
    (Store.getTimeRecords() || []).forEach(r => {
      if (!isCallRec(r) || !r.started_at) return;
      const k = bizKeyOf(r.started_at);
      if (k < mon || k > today) return;
      byDay[k] = (byDay[k] || 0) + (Number(r.duration_sec) || 0);
    });
    return Object.keys(byDay).filter(k => Math.round(byDay[k] / 60) > CALL_DAY_MIN_THRESHOLD).length;
  }
  /* ★ v1.24.5 本周接通总秒数（★ v1.93.0 同步改业务日口径；双闹钟 + 补记都算） */
  function calcWeeklyCallMinSec(beijing) {
    const today = todayBizKey();
    const mon = bizWeekMondayOf(today);
    let sec = 0;
    (Store.getTimeRecords() || []).forEach(r => {
      if (!isCallRec(r) || !r.started_at) return;
      const k = bizKeyOf(r.started_at);
      if (k < mon || k > today) return;
      sec += Number(r.duration_sec) || 0;
    });
    return sec;
  }

  /* ---------- 渲染 ---------- */
  let deferHelpOpen = false;   // ★ v1.51.0「置后定则」说明的展开态（重渲染时保持）
  let aiHelpOpen = false;      // ★ v1.97.0「跑 AI 两例外」说明的展开态（同理：重渲染不许塌回去）
  /* ★ v1.70.0 建议指标清单（HTML）+ 事件绑定 —— 判定卡与「勾选刷新」两条路径共用。
   *   为什么要拆出来：勾复选框走的是 refreshCallDecision（**不重建整卡**，否则勾选状态全丢），
   *   那条路径也必须刷新这块，所以不能只写在 renderJudge 的模板字符串里。 */
  function advBoxHtml(j) {
    if (!j.advItems || !j.advItems.length) {
      return j.bypassed
        ? `<div class="j-bypassed"><b>✓ 已绕过建议指标</b>（今日第 ${bypassState().used || 0} 次）——本次按允许接听处理，必开双闹钟 <button type="button" class="j-bypass-undo" id="bypassUndo">撤销绕过</button></div>`
        : "";
    }
    const rows = j.advItems.map(x =>
      `<div class="jal-row"><b>${esc(x.label)}</b><span>${esc(x.detail)}</span></div>`).join("");
    const left = (j.bypassLeft != null) ? j.bypassLeft : bypassLeftToday();
    const btn = left > 0
      ? `<button type="button" class="jal-btn" id="bypassBtn">绕过建议，仍然接听（今日还剩 ${left} 次）</button>`
      : `<button type="button" class="jal-btn is-out" id="bypassBtn" disabled>今日 ${BYPASS_MAX_PER_DAY} 次已用完 · 需报规则部</button>`;
    return `<div class="j-adv-list"><div class="jal-title">⚠️ 建议指标 · 不强制（可二次判断后绕过）</div>${rows}${btn}</div>`;
  }
  function bindAdvBox() {
    const b = document.getElementById("bypassBtn");
    if (b && !b.disabled) b.addEventListener("click", openBypassDialog);
    const u = document.getElementById("bypassUndo");
    if (u) u.addEventListener("click", () => { revokeBypass(); renderJudge(); });
  }
  function paintAdvBox(j) {
    const box = document.getElementById("judgeAdvBox");
    if (!box) return;
    box.innerHTML = advBoxHtml(j);
    bindAdvBox();
  }

  function renderJudge() {
    const el = document.getElementById("todayJudge");
    if (!el) return;
    const j = judgeToday();
    const timerFocused = activeStudyTimer();
    /* ★ v1.65.0：把「置后到哪里」直接算进面板。
     *   置后定则历来只说「不能现在做」，从不说「推到几点」——执行时最容易卡在这一句，
     *   于是干脆不推、直接接了。deferWindowText() 早在 v1.60.0 就写好了（豁免核验表在用），
     *   这里只是把它搬进三步判断的第 2 步，**纯展示，不做任何判定**。 */
    const deferWinTxt = deferWindowText();
    /* ★ v1.70.0：把主站计时搬进结论区（用户：这是当前最重要的状态）。
     *   正计时说「已 X」，倒计时说「还剩 X」——两种计时语义不同，不能都写成"已进行"。
     *   纯展示，不参与判定（判定在 evaluateCallDecision 里另算）。 */
    const hostLine = (function () {
      const atT = Store.getActiveTimer();
      if (!atT) return `<div class="j-host"><span class="jhost-tag jhost-idle">主站空闲</span><span class="jhost-note">当前无进行中的计时</span></div>`;
      const cats = (window.APP_CONFIG && window.APP_CONFIG.TIME_CATEGORIES) || [];
      const cm = cats.find(c => c.key === atT.kind) || { label: atT.kind || "活动" };
      const el = Math.max(0, Math.round(
        atT.status === "running"
          ? (atT.elapsed_sec || 0) + (Date.now() - (atT.started_at || Date.now())) / 1000
          : (atT.elapsed_sec || 0)));
      const mm = Math.floor(el / 60), ss = el % 60;
      const clock = `${mm}分${String(ss).padStart(2, "0")}秒`;
      const running = atT.status === "running";
      let txt, cls = "jhost-idle";
      if (atT.mode === "countdown" && atT.duration_sec) {
        const remain = Math.max(0, atT.duration_sec - el);
        txt = remain > 0 ? `还剩 ${Math.floor(remain / 60)}分${String(remain % 60).padStart(2, "0")}秒` : `已到点 ${clock}（计时未停）`;
        cls = remain > 0 ? "jhost-cd" : "jhost-over";
      } else {
        txt = `已 ${clock}`;
        cls = "jhost-up";
      }
      if (atT.kind === "study") cls = running ? "jhost-study" : "jhost-idle";
      if (atT.kind === "call") cls = "jhost-call";
      const paused = atT.status === "paused" ? "（已暂停）" : "";
      return `<div class="j-host"><span class="jhost-tag ${cls}">主站：正在${cm.label}${paused}</span>` +
        `<span class="jhost-time">${txt}</span>` +
        `<span class="jhost-note">${atT.label ? esc(atT.label) : ""}</span></div>`;
    })();
    /* ★ v1.70.0：建议指标清单 + 绕过入口（仅 adviseOnly 时出现；强制项外没有按钮）
     *   拆成独立函数：勾选复选框走 refreshCallDecision（不重建整卡，避免勾选状态丢失），
     *   那条路径也要能刷新这块，所以不能只写在模板字符串里。 */
    const advHtml = advBoxHtml(j);
    /* ★ v1.70.0：整卡重绘（绕过 / 撤销 / 时段刷新会触发）时**必须保留复选框勾选状态**，
     *   否则一按"绕过"就把用户刚勾的事务完成、置后定则全清零，等于替他重判。 */
    const prevChecks = {};
    ["currentlyFocused", "garbageTime", "affairsDone", "followDeferRule", "impactStudy", "isInvitation"].forEach(id => {
      const cb = document.getElementById(id);
      if (cb) prevChecks[id] = cb.checked;
    });
    el.innerHTML = `
      <div class="j-row" id="judgeDecision">
        <div class="j-date">${j.dateStr} · ${j.dayName}${j.headline ? " · " + j.headline : " · 第" + j.day + "日"}</div>
        <div class="j-verdict" style="color:${j.color}">${j.verdict}</div>
      </div>
      <div class="j-advice" id="judgeAdvice">${j.advice}</div>
      ${hostLine}
      <div id="judgeAdvBox">${advHtml}</div>
      <!-- ★ v1.29.2 规则部解释（用户 2026.10.04 给的原文）：禁接的权力来源 -->
      <div class="j-rule">📞 规则部解释：在通话规则管理体系中：是<b>规则部</b>不允许<b>陈本祯</b>接打（接通）电话。</div>
      <div class="j-stance">每次想接之前，先回答这一句：<b>我今天的进度，对得起 12 月吗？</b></div>
      <!-- ★ v1.27.7 一句话心法（柔和版，主色融入判定面板） -->
      <div class="j-motto">不接难受<b>一分钟</b>，接了难受<b>一晚上</b>——不接就是最好的选择!!</div>
      <label class="j-check j-check-critical">
        <input type="checkbox" id="currentlyFocused" ${timerFocused ? "checked disabled" : ""} />
        我此刻正在专注学习${timerFocused ? "（主站学习计时已确认）" : "（人工判断）"}
      </label>
      <label class="j-check">
        <input type="checkbox" id="garbageTime" />
        当前确属垃圾时间，且不会挤占计划进度
      </label>
      <!-- ★ v1.97.0（用户 2026-10-25 指定）：这行红字原先是常驻铺在勾选框下面的，
           每次看判定卡都要重读两三行 → 改为**默认折叠**，只保留一行可点的红线标题。
           ⚠️ 折叠块必须放在 </label> **外面**：塞进 label 里的话，点展开会顺带把复选框勾上
             （label 的默认行为），等于替用户做了判断 —— 与置后定则那次是同一个坑。
           ⚠️ 判定侧仍然只认那个勾选框，这里一个字都不参与计算。 -->
      <div class="j-help j-help-tight">
        <button type="button" class="j-help-btn" id="aiHelpBtn" aria-expanded="${aiHelpOpen ? "true" : "false"}" aria-controls="aiHelpBody">
          <span class="j-ai-warn">⚠️ 跑 AI 期间不能通话</span> · 点开看两种例外 ${aiHelpOpen ? "▴" : "▾"}
        </button>
        <div class="j-help-body" id="aiHelpBody"${aiHelpOpen ? "" : " hidden"}>
          <div class="jh-lead"><b>跑 AI 的等待间隙不算垃圾时间</b>（间隙里仍能学习）——
            所以勾上面那个框之前先想清楚：这次是真空档，还是只是在等模型跑完。</div>
          <ul class="jh-tail-rules">
            <li><span class="jh-tr-t">例外一 · 正处在 23:00–24:00 调剂段内（仍须确认是垃圾时间）</span><span class="jh-tr-y">⑳</span></li>
            <li><span class="jh-tr-t">例外二 · 置后定则判定无需置后（三步全「否」，且本大块后面没有学习安排）</span><span class="jh-tr-y">⑳</span></li>
          </ul>
          <div class="jh-red-line"><b>两种都不满足 → 仍不可通话，这个框也不该勾。</b><span class="jh-tr-y">⑳</span></div>
        </div>
      </div>
      <label class="j-check">
        <input type="checkbox" id="affairsDone" />
        自身事务已处理完毕
      </label>
      <label class="j-check j-check-defer">
        <input type="checkbox" id="followDeferRule" />
        <span class="j-defer-main">是否遵循「置后定则」？
          <!-- ★ v1.67.0（用户 2026.10.18）：原来挂一行 #9ca3af 灰小字，等于没写 ——
               这条问题决定了整张判定卡怎么走，必须一眼能看见。
               改成独立一行的琥珀色药丸（深色「先问」小片 + 高对比描边），
               且单独占一行（.j-defer-main 竖排），不与「是否遵循…」挤同一行被截断。 -->
          <span class="j-defer-q">（先问：本大块中后续是否还有学习等正事安排？）</span>
        </span>
      </label>
      <!-- ★ v1.51.0（用户 2026.10.17 指定）：置后定则就地展开说明。
           取舍：**不跳页**（接电话时跳走会打断判断，回来还得重新定位），
           也不常驻三段（判定卡已有 7 个自检项，再加一段说明会拖长扫读）。
           → 默认收起成一行小字，点开给「三步判断」，任一步答「是」即置后。 -->
      <div class="j-help">
        <button type="button" class="j-help-btn" id="deferHelpBtn" aria-expanded="${deferHelpOpen ? "true" : "false"}" aria-controls="deferHelpBody">
          置后定则是什么 · 点开三步判断 ${deferHelpOpen ? "▴" : "▾"}
        </button>
        <div class="j-help-body" id="deferHelpBody"${deferHelpOpen ? "" : " hidden"}>
          <div class="jh-lead">不是「尽量晚点接」，是 <b>能推就先推、且必须推到收尾段</b>。<b>三步里任意一步答「是」，就直接置后并挂断。</b></div>
          <!-- ★ v1.69.0（用户 2026.10.18 再次指定取消）：删除「先判对象」前置条。
               历史上：v1.65.0 加 → v1.67.0 取消 → v1.68.0 按定稿恢复 → v1.69.0 再次取消。
               以最近一次指令为准；.jh-pre 样式一并删除，不留死规则。
               ⚠️ 注释里不要写反引号：这里在模板字符串内，反引号会提前闭合字符串（踩过一次）。 -->
          <ol class="jh-steps">
            <li><b>能不能改用文字？</b><span>能 → 请他发文字，你之后看到再回（⑭：文字解释 = 语音解释，效力相同）。</span></li>
            <li><b>能不能推到本大块末尾、之后不再排学习的收尾段？</b><span>能 → 约到 <b class="jh-win">${deferWinTxt || "今日收尾段"}</b>（饭前 / 睡前 / 出发前）或<b class="jh-win">已知的垃圾时间或并行利用时间</b>。<br>
              ${deferWinTxt ? "" : "找不到就如实说：今日推不出合格窗口 → 只剩「改文字」或「改约明天」两条路。"}</span></li>
            <li><b>30 分钟内能不能收口？</b><span>能 → 说「我 30 分钟后还有事，现在只说 3 句」，说完就挂。<br>
              <b class="jh-cau">⚠️ 这一步的 30 分钟必须仍落在收尾段内</b>；若 30 分钟后后面还排着学习，
              这不算置后，回到第 2 步（9.27：置后定则优先于垃圾 / 休息时间并行利用）。</span></li>
          </ol>
          <!-- ★ v1.69.0 排版重做：原来三句用 <br> 硬挤在一个琥珀块里，年份混在括号中，
               读起来是一坨。改为「主句 + 三条依据（年份做右侧标签）+ 独立红线块」三层。 -->
          <div class="jh-tail">
            <div class="jh-tail-main">三步全是「否」（确实只有此刻能说、必须语音、10 分钟内说得完，
              <b>并且本大块后面没有学习</b>），才允许不置后。</div>
            <ul class="jh-tail-rules">
              <li><span class="jh-tr-t">置后不是取消</span><span class="jh-tr-y">7.2</span></li>
              <li><span class="jh-tr-t">置后定则 ＞ 垃圾 / 休息时间并行利用</span><span class="jh-tr-y">9.27</span></li>
              <li><span class="jh-tr-t">00:00 后即使仍排着学习任务，也不得接通</span><span class="jh-tr-y">10.17</span></li>
            </ul>
            <div class="jh-red-line"><b>⚠️ 若此刻已在 00:00–07:00：上面三步全部作废，直接不接。</b><span class="jh-tr-y">⑦</span></div>
          </div>
        </div>
      </div>
      <label class="j-check">
        <input type="checkbox" id="impactStudy" />
        本次通话会影响正常学习进度<small style="margin-left:6px;color:#b91c1c;font-weight:600">（勾选即拒接）</small>
      </label>
      <label class="j-check">
        <input type="checkbox" id="isInvitation" />
        这是邀约类来电<small style="margin-left:6px;color:#b91c1c;font-weight:600">（只能文字回复）</small>
      </label>
    `;
    ["currentlyFocused", "garbageTime", "affairsDone", "followDeferRule", "impactStudy", "isInvitation"].forEach(id => {
      const cb = document.getElementById(id);
      if (!cb) return;
      /* 还原重绘前的勾选状态（disabled 的「正在专注」由学习计时驱动，不还原） */
      if (!cb.disabled && Object.prototype.hasOwnProperty.call(prevChecks, id)) cb.checked = prevChecks[id];
      cb.addEventListener("change", refreshCallDecision);
    });
    bindAdvBox();   // ★ v1.70.0 建议清单里的「绕过 / 撤销」按钮
    /* ★ v1.51.0 置后定则说明的展开/收起。
     * ⚠️ 按钮必须放在 label **外面**：塞进 <label class="j-check"> 里的话，
     *    点展开会顺带把复选框勾上（label 的默认行为），等于替用户做了判断。 */
    const deferBtn = document.getElementById("deferHelpBtn");
    const deferBody = document.getElementById("deferHelpBody");
    if (deferBtn && deferBody) {
      deferBtn.addEventListener("click", () => {
        deferHelpOpen = !deferHelpOpen;
        deferBody.hidden = !deferHelpOpen;
        deferBtn.setAttribute("aria-expanded", deferHelpOpen ? "true" : "false");
        deferBtn.textContent = `置后定则是什么 · 点开三步判断 ${deferHelpOpen ? "▴" : "▾"}`;
      });
    }
    /* ★ v1.97.0「跑 AI 两例外」的展开/收起（用户 2026-10-25 要求折叠）。
     * 与上面同一套 .j-help 折叠件；唯一差别是按钮里有个红色 span，
     * 所以只能重建 innerHTML，不能用 textContent（会连同 span 一起抹掉）。 */
    const aiBtn = document.getElementById("aiHelpBtn");
    const aiBody = document.getElementById("aiHelpBody");
    if (aiBtn && aiBody) {
      aiBtn.addEventListener("click", () => {
        aiHelpOpen = !aiHelpOpen;
        aiBody.hidden = !aiHelpOpen;
        aiBtn.setAttribute("aria-expanded", aiHelpOpen ? "true" : "false");
        aiBtn.innerHTML = '<span class="j-ai-warn">⚠️ 跑 AI 期间不能通话</span> · 点开看两种例外 ' +
          (aiHelpOpen ? "▴" : "▾");
      });
    }
    refreshCallDecision();
  }

  function refreshCallDecision() {
    const d = evaluateCallDecision();
    /* ★ v1.55.0：把本次「来电结论」落缓存，供**主站计时器**的通话边界入口取色（跨页联动）。
     *   只写三个展示字段，不含任何通话内容/姓名；30 分钟有效期，过期自动回落 quickVerdict。
     * ★ v1.104.0：TTL 改 5 分钟，并记录**判定时的时段 key**（verdictNow 会校验）。 */
    try {
      const si1 = d.slotInfo;
      const slot1 = (si1 && si1.slot) ? (si1.slot.start + "-" + si1.slot.end) : "";
      localStorage.setItem(VERDICT_CACHE_KEY, JSON.stringify({
        verdict: d.verdict, color: d.color, allowed: !!d.allowed, ts: Date.now(), slot: slot1
      }));
    } catch (e) {}
    renderAlarmLabels();   // ★ v1.26.3 双闹钟阈值标签随配置刷新
    const verdict = document.querySelector("#judgeDecision .j-verdict");
    const advice = document.getElementById("judgeAdvice");
    const timerAction = document.getElementById("allowedTimerAction");
    /* ★ v1.71.0：页尾那张「规则看完了，回主站计时」大卡只在**允许通话**时出现
     *   （含已申请到豁免的情形，两者都由 evaluateCallDecision().allowed 表达）。
     *   不可接时常驻会误导 —— 它存在的意义是"去开表"，不可接时没有表要开。 */
    const bttCard = document.getElementById("backToTimerCard");
    if (bttCard) bttCard.style.display = d.allowed ? "" : "none";
    if (verdict) { verdict.textContent = d.verdict; verdict.style.color = d.color; }
    /* ★ v1.70.0：advice 现在可能带 <b> 强调（建议清单 / 绕过提示），必须用 innerHTML；
     *   文案全部是本模块自己拼的，不含外部输入。 */
    if (advice) advice.innerHTML = d.advice;
    paintAdvBox(d);   // ★ v1.70.0 勾选变化也要刷新建议清单（不重建整卡，勾选状态不丢）
    if (timerAction) timerAction.hidden = !d.allowed;
    updateJudgeHint();
    renderScenarios();
    renderWeeklyInfo();
    renderControlFlash();   // ★ v1.37.0 管控闪卡随每次重判刷新三态
    if (document.getElementById("quotaModal")?.classList.contains("show")) syncOverrideGrantState("quota_extra");
    if (document.getElementById("necessaryModal")?.classList.contains("show")) syncOverrideGrantState("necessary");
  }

  function updateJudgeHint() {
    // 复选框提示摘要：3 项未勾选 → 顶部强调
    const a = document.getElementById("affairsDone");
    const d = document.getElementById("followDeferRule");
    const i = document.getElementById("impactStudy");
    const g = document.getElementById("garbageTime");
    const f = document.getElementById("currentlyFocused");
    const invite = document.getElementById("isInvitation");
    if (!a || !d || !i || !g || !f || !invite) return;
    const items = [];
    if (f.checked) items.push("【正在专注→必须拒接】");
    if (!g.checked) items.push("【未确认垃圾时间】");
    if (!a.checked) items.push("【自身事务处理】");
    if (!d.checked) items.push("【置后定则】");
    if (i.checked) items.push("【将打断学习→拒接】");
    if (invite.checked) items.push("【邀约→仅文字回复】");
    const box = document.getElementById("checklistHint");
    if (!box) return;
    if (items.length === 0) {
      box.innerHTML = `<div class="judge-hint ok">✅ 联系规则自检通过，可进入限时通话流程</div>`;
      box.style.display = "";
    } else {
      box.innerHTML = `<div class="judge-hint bad">⚠️ 当前阻断项：${items.join(" · ")}</div>`;
      box.style.display = "";
    }
  }

  let scenarioExpanded = false;   // 「更多话术」展开态（重渲染时保持）

  /* ---------- ★ v1.43.0 当日借口（话术 {say} 占位的来源）----------
   * ⚠️ 这三个函数随「今日通讯录名」一并删过一次，必须补回来，原因：
   *   它们是话术正文里 {say} 的**唯一来源**。删掉之后 fill() 拿到空串，
   *   excuseSayText 走兜底 → **所有话术会长成同一句**（v1.39.0 真实事故：借口池
   *   键名对不上时就是这个现象，肉眼很难发现，但话术质量当场归零）。
   * 口径沿用旧的自动分支：从 D.contactExcuses 池**按日期稳定抽取**（每天不同、当天不变）。
   * ★ 变更点：不再区分 reject / limited 子集——那是配合 specialPlan 的 capMin 做的分类，
   *   specialPlan 停用后失去依据；现在全池通用。 */
  function contactExcusePool(want) {
    const pool = D.contactExcuses || [];
    const texts = pool.map(e => typeof e === "string" ? { text: e, fit: "any" } : e);
    const hit = texts.filter(e => !e.fit || e.fit === "any" || e.fit === (want || "any"));
    return (hit.length ? hit : texts).map(e => e.text);
  }
  /* ★ v1.44.0 时段适配：带 slot 的条目只在对应时段出现（day = 06:00–22:00，night = 其余）。
   *   目的：池子扩到 52 条后，若不看时段，可能下午三点抽到「在值夜班」/「刚睡下补觉」，
   *   照着念一戳就破。某时段可用条目不足 3 条时退回全池——宁可不精确，也不只剩一两条反复出现。 */
  function excuseEntries(slot) {
    const pool = (D.contactExcuses || []).map(e => typeof e === "string" ? { text: e } : e);
    if (!slot) return pool;
    const hit = pool.filter(e => !e.slot || e.slot === slot);
    return hit.length >= 3 ? hit : pool;
  }
  function excuseSlotNow() {
    const h = Math.floor(nowSecBJ() / 3600) % 24;
    return (h >= 6 && h < 22) ? "day" : "night";
  }
  /* 「🎲 换一批」的轮次：存 localStorage，跨刷新保持（否则一刷新就跳回原组合，等于没换）。 */
  const EXC_SEED_KEY = "kaoyan:excuse_seed";
  function excuseSeed() {
    try { return Number(localStorage.getItem(EXC_SEED_KEY)) || 0; } catch (e) { return 0; }
  }
  function bumpExcuseSeed() {
    const v = (excuseSeed() + 1) % 997;
    try { localStorage.setItem(EXC_SEED_KEY, String(v)); } catch (e) { }
    return v;
  }
  /* 按「日期 + 轮次 + 第几条」哈希稳定抽取——同一天任何设备、任何时刻都是同一句。
   * ★ n 是 v1.44.0 的关键：原来一天只抽一个借口、**整组 7 条话术共用同一句 {say}**，
   *   读起来自然「理由单一」；现在按条错开（每条 +7 的偏移），一组里句句不同。 */
  function dailyExcuse(dateKey, n) {
    const pool = excuseEntries(excuseSlotNow()).map(e => e.text);
    if (!pool.length) return "";
    let h = 0;
    const s = String(dateKey || "") + "|" + excuseSeed() + "|" + (Number(n) || 0) * 7;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return pool[h % pool.length];
  }
  /* 借口 → 口语短语（话术里自然带出；不在表内则兜底）。
   * ⚠️ 键必须与 call-data.js contactExcuses 的 text **逐字一致**——
   *   键对不上时这里返回兜底值，于是所有话术会长得一模一样。
   * ⚠️ 兜底词不用「在忙」——「我这会儿在忙，电话接不了」读起来像敷衍；
   *   「手头有事」中性且真实。 */
  function excuseSayText(excuse) {
    /* ★ v1.44.0：随 contactExcuses 扩容 18 → 52 条同步补全（键必须逐字一致）。
     *   口语短语是**嵌进话术模板**的（如「我这会儿{say}，电话实在接不了」），
     *   所以这里写的是能直接接在「我这会儿」后面的短语，不是标题本身。 */
    const map = {
      // ① 临床 / 实习
      "今日值班": "在值班", "科室加班": "在科室加班", "值夜班": "在值夜班", "在查房": "在查房",
      "跟台手术": "在跟台手术", "急诊手术": "在手术台上", "参与抢救": "在抢救",
      "急诊在岗": "在急诊", "被老师叫走": "在跟老师处理事情", "在赶材料": "在赶材料",
      "在门诊跟诊": "在门诊跟诊", "正在交班": "正在交班", "科室开会学习": "在科室开会学习",
      "技能操作考核": "在技能操作考核",
      // ② 考试 / 考核
      "正在考试": "正在考试", "在模考": "在模考", "在答辩": "在答辩",
      // ③ 学习备考
      "备考自习": "在自习备考", "在上课": "在上课", "在图书馆": "在图书馆", "在听网课": "在听网课",
      "在刷题": "在刷题", "在背单词": "在背单词", "在整理笔记": "在整理笔记",
      "在赶病历": "在赶病历", "在写病历": "在写病历", "刚交完班": "刚交完班",
      // ④ 生活日常
      "在吃饭": "正在吃饭", "在通勤路上": "在路上", "在地铁上": "在地铁上", "在洗澡": "在洗澡",
      "刚睡下补觉": "刚睡下补觉", "下夜班补觉": "刚下夜班补觉", "在运动": "在运动",
      "在外面办事": "在外面办事", "在排队办事": "在排队办事", "在理发": "在理发",
      // ⑤ 家里与事务
      "家中有事": "在处理家里的事", "家里来客": "家里来了客人", "在办手续": "在办手续",
      "在收拾屋子": "在收拾屋子", "帮家里干活": "在帮家里干活", "陪家人看病": "在陪家人看病",
      "在陪家人": "在陪家人",
      /* ★ v1.93.0：键必须逐字对应 contactExcuses 的 text，否则 {say} 会退化成
       *   兜底词「手头有事」（v1.39.0 同款事故）——加时自习的说法就没了。 */
      "在加时自习": "在加时自习",
      // ⑥ 设备与环境
      "手机快没电": "手机快没电了", "手机在充电": "手机在充电", "在电梯里": "在电梯里信号不好",
      "这儿信号差": "这儿信号特别差", "周围太吵": "周围太吵", "在开会": "在开会",
      "手机不在手边": "手机不在手边",
      // ⑦ 身体状态
      "有点不舒服": "有点不舒服", "嗓子哑了": "嗓子哑了", "头疼在休息": "头疼在休息"
    };
    return map[excuse] || "手头有事";
  }

  /* ==================== ★ v1.39.0 今日局面（话术速查顶部的定盘星）====================
   * 用户 2026.10.07：「无法匹配是"今日拒绝日"使用的"改日再聊"话术，还是限制通话日的"短暂延迟"话术」。
   * 根因：话术组其实一直随判定自动切换，但界面**从不明说今天属于哪种局面**，
   *       用户只能逐条读正文去猜。这里把它显式写出来——先定局面，再给话。
   * kind 决定展示哪几组；quotaOnly / limited 等细节供提示文案使用。 */
  function situationInfo(j) {
    const wk = D.weeklyRule || {};
    /* ① 周/日额度类：优先级最高——额度用尽时今天整体作废 */
    /* ★ v1.93.0：奇偶日那半段判定作废；日闸（单日封顶）保留并解耦。
     *   另：连续通话链 / 今日不聊天导致的封禁由下方 `!j.allowed` 分支接住（kind=blocked）。 */
    const wkOver = j.weeklyCallCount >= weeklyCountCap() ||
      (wk.maxMinPerWeek > 0 && j.weeklyCallMinSec > wk.maxMinPerWeek * 60) ||
      (j.dayCapMin > 0 && j.curDayMin >= j.dayCapMin);
    // ★ 图标名必须是 assets/icons 里真实存在的（缺文件只能 console.warn，肉眼查不出）
    if (wkOver) return { kind: "quota", icon: "smartphone-off", title: "本周通话额度已用完", desc: "今天整体不接；对外只说「最近忙」，绝不提额度。" };
    /* ③ 时段窗 / 临时的「此刻不能接」——含 ★ v1.43.0 晚自习核心时间（18:30–23:00）硬阻断。
     * ★ 原「② 今日是特殊管理日」分支随该功能一并删除：逐日 capMin 上限制度已于
     *   2026-10-12 停用（见 call-data.js specialPlan 注释），这里不再有「今日限 N 分」的局面。 */
    if (!j.allowed) return { kind: "blocked", icon: "smartphone-off", title: "此刻不能接", desc: escStrip(j.verdict || "") };
    /* ④ 常规日 */
    return { kind: "normal", icon: "check", title: "今日常规 · 可以接", desc: "仍建议先框时长，别让通话无上限。" };
  }
  function escStrip(s) { return String(s || "").replace(/<[^>]*>/g, ""); }

  function scenarioItems(j) {
    /* ★ v1.39.0：数据由「纯字符串」改为 {use, cb, text} —— use 是「对方此刻什么情况」的语义标签
     *   （取代原先看不出名堂的「拒接 3/7」编号），cb 标记「承诺今天/近期会主动回联」。
     *   {say} 占位替换为当日借口的口语短语；仍按情境分组返回。 */
    const SC = D.scenarioScripts || {};
    const todayKey = j.dateStr;
    /* ★ v1.43.0：特殊管理日停用后，当日借口改由 dailyExcuse() 直接从 contactExcuses 池
     *   按日期抽取，不再依赖 specialPlan。⚠️ 不改这条路的话 excuseSayText 会走兜底，
     *   所有话术退化成同一句（v1.39.0 真实事故）。 */
    /* ★ v1.44.0：{say} 逐条错开（base 让组与组之间也不撞车），不再整组共用一句。 */
    const sayOf = (n) => excuseSayText(dailyExcuse(todayKey, n));
    const sit = situationInfo(j);
    /* ★ v1.43.0 全天拒接日：specialPlan 停用后，「今日整体不能接」唯一的来源是
     *   周/日额度用尽（kind === "quota"）。⚠️ 晚自习窗**不算**全天拒接日——
     *   它只是 18:30–23:40 这五个多小时不可接，窗外照样能聊，
     *   若把它算进来，白天那半段的 defer 话术会被误过滤掉。 */
    const fullRejectDay = sit.kind === "quota";
    /* ★ weeklyReject / poolOpen 这类池子仍是「纯字符串」，scenarioScripts 已升级为对象，
     *   两个形状必须都能吃——否则对象取 .text 会拿到空串，整组话术变成空白块（肉眼几乎看不出）。 */
    const pack = (pool, base) => (pool || []).map((it, i) => {
      const raw = typeof it === "string" ? it : ((it && it.text) || "");
      const say = sayOf((base || 0) + i);
      return { use: (it && it.use) || "", cb: !!(it && it.cb), text: String(raw).split("{say}").join(say) };
    });
    const keep = (list) => fullRejectDay ? list.filter(x => !x.cb) : list;
    const groups = [];
    if (sit.kind === "quota") {
      groups.push({ key: "reject", title: "现在不能接 · 直接回绝", hint: "语气肯定但不生硬，别给对方「再等等」的期待。", items: pack(SC.reject, 0) });
      groups.push({ key: "quota", title: "周额度已用完", hint: "最近聊得够多了；对外口径一律是「最近事多」，不提额度。", items: pack(D.weeklyReject || [], 20).map(x => ({ ...x, use: x.use || "通用" })) });
      return groups;
    }
    if (!j.allowed) {
      groups.push({ key: "reject", title: "现在不能接 · 直接回绝", hint: "对方已经打来了，用这组明确收掉。", items: pack(SC.reject, 0) });
      const deferItems = keep(pack(SC.defer, 10));
      if (deferItems.length) {
        groups.push({
          key: "defer", title: fullRejectDay ? "把话头往后挪（已隐去承诺回拨的句子）" : "往后挪 · 不当面说死",
          hint: fullRejectDay ? "今天是全天拒接日，「等我回头打给你」这类承诺已自动屏蔽。" : "今天稍后或改天还有机会时用。",
          items: deferItems
        });
      }
      return groups;
    }
    /* 可以接：开场 + 收尾成对给，这是「限制通话日」要用的那一组。
     * ★ hint 跟着局面走——常规日也写「限时通话日专用」会让人以为今天被限了。 */
    const limitHint = sit.kind === "limited"
      ? "今天有上限：一开口就钉死时长，后面才收得住。"
      : "今天没有硬上限，但照样先钉个时长，免得收不住。";
    const closeHint = sit.kind === "limited"
      ? "别留「再聊五分钟」的口子，说完就走。"
      : "聊到差不多就收；说好的时间到了更要干脆。";
    groups.push({ key: "open", title: "接通第一句 · 先把时间框住", hint: limitHint, items: pack(SC.open, 30) });
    groups.push({ key: "close", title: "到点了 · 收尾", hint: closeHint, items: pack(SC.close, 40) });
    return groups;
  }
  function renderScenarios() {
    const box = document.getElementById("callScenarios");
    if (!box) return;
    const j = evaluateCallDecision();
    const sit = situationInfo(j);
    const groups = scenarioItems(j);
    const all = groups.reduce((s, g) => s + g.items.length, 0);
    /* ★ v1.39.0 默认只给每组前 2 条（够用就不堆），点「展开」才给全部——原是一次性铺 16 条 */
    let shownCount = 0;
    const body = groups.map(g => {
      const list = scenarioExpanded ? g.items : g.items.slice(0, 2);
      shownCount += list.length;
      if (!list.length) return "";
      return `<div class="sc-group">
        <div class="sc-g-title">${esc(g.title)}</div>
        <div class="sc-g-hint">${esc(g.hint || "")}</div>
        ${list.map(s => `
          <div class="scenario-item" data-copy="${esc(s.text)}" role="button" tabindex="0" title="点整行复制">
            <div class="s-label">${esc(s.use)}</div>
            <div class="s-text">${esc(s.text)}</div>
          </div>`).join("")}
      </div>`;
    }).join("");
    const hidden = all - shownCount;
    /* ★ v1.44.0「换一批理由」：只在**真的带 {say}** 的组（reject 拒接 / defer 缓）出现时给——
     *   open（开场）/ close（收尾）两句不含借口占位符，给了按钮点了没变化，反而像坏了。 */
    const hasSay = groups.some(g => g.key === "reject" || g.key === "defer");
    const reroll = hasSay ? `
      <div class="sc-reroll">
        <button type="button" id="sRerollBtn" class="s-reroll">🎲 换一批理由</button>
        <small>同一天保持同一批，换了会记住；不合适的借口换掉即可</small>
      </div>` : "";
    box.innerHTML = `
      <div class="sit-bar sit-${esc(sit.kind)}">
        <span class="sit-ico"><span data-icon="${esc(sit.icon)}"></span></span>
        <span class="sit-body"><b>${esc(sit.title)}</b><small>${esc(sit.desc)}</small></span>
      </div>` + reroll + body +
      (all > 2 ? `<button type="button" id="sMoreBtn" class="s-more">${scenarioExpanded ? "收起话术 ▲" : "展开全部（还有 " + hidden + " 条）▼"}</button>` : "");
    /* ★ 整行可复制：原先只有一个小「复制」按钮，手机上要点准（公共逻辑见 bindRowCopy） */
    bindRowCopy(box);
    const more = document.getElementById("sMoreBtn");
    if (more) more.addEventListener("click", () => { scenarioExpanded = !scenarioExpanded; renderScenarios(); });
    const rrBtn = document.getElementById("sRerollBtn");
    if (rrBtn) rrBtn.addEventListener("click", () => {
      bumpExcuseSeed();          // 轮次 +1 → 哈希变 → 换一批；存 localStorage 跨刷新保持
      renderScenarios();
      if (window.UI && window.UI.showAlert) window.UI.showAlert("已换一批理由", 1600);
    });
    if (window.Icon) window.Icon.inject(box);
  }

  /* ★ v1.59.0：原「窗口日话术」独立卡片**已并入话术中心**（renderGenericScripts）。
   *   原因（用户 2026.10.18 指出）：它和通用话术一上一下、彼此割裂，读起来是两块。
   *   窗口日两组的**数据不动** —— poolOpen / poolClose 仍是字符串池，其它消费方照旧，
   *   只是在话术中心的渲染层被包装成同构的场景组（见 genericGroups 里的 winOpen / winClose）。 */

  /* ★ v1.48.0 通用话术渲染（数据来源 call-data.js genericScripts）。
   * 与上方「话术速查」完全解耦：不过滤今日局面、不套当日借口，任何时候都能抄；
   * 渲染形状与 scenario-item 一致，故整行复制、图标注入全部直接复用。
   * 「此刻推荐」只是按钟点给一行提示，纯展示，不参与任何判定。 */
  function genericRecommendedKey() {
    const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
    /* ★ v1.56.0 三级优先级（新增两组话术后，得让「此刻推荐」跟上真实局面）：
     *   1) 正在通话（主站计时器 kind=call）→ 推「到点挂断」组（⑬）——通话中最需要它的是挂断话术；
     *   2) 00:00–07:00 → 推「00:00 后还有安排」组（⑦/⑫ 睡眠段 + 学习安排口径）；
     *   3) 23:30–24:00 → 推临睡前拒接组（已上床/准备睡，但还没到睡眠段）。
     *   ★ v1.94.0：②③ 的钟点随睡眠段起点后移 —— ② 由 23:40 改 00:00，
     *     ③ 由 23:30–23:40 改 23:30–24:00（延展段延长到 24:00，这一小时仍归晚自习）。
     *   其余不给推荐，免得天天挂着一行徽标。
     *   ⚠️ Store 在非通话场景（如 verify 的 DOM 桩）可能不存在 → try/catch 兜住，不能因为取不到就整卡空白。 */
    try {
      const at = window.Store && window.Store.getActiveTimer && window.Store.getActiveTimer();
      if (at && at.kind === "call") return "hangupDeadline";
    } catch (e) { /* 取不到就按钟点走 */ }
    /* ★ v1.94.0：lateStudy 的钟点边界与**睡眠段真实窗口**对齐 —— 睡眠段是 00:00–07:00，
     *   故判 `m < 7*60`（00:00–06:59）。原写法 `m < 6*60` 漏掉 06:00–06:59 那一小时，
     *   那一小时仍在睡眠段内却不推睡眠段话术，属于"推荐跟不上真实局面"。
     * ★ v1.106.0：睡眠段起点后移到 00:30，但这里**故意仍从 00:00 起算** ——
     *   00:00–00:30 虽归延展段，仍是深夜、仍可能排着学习任务，推「深夜·学习」比推
     *   「临睡前来电」更贴切（后者是已经上床的口径，前置期用它在 23:30 才开始）。
     *   判定侧不受影响：这一段由 nightStudySoftBlocking 按延展段处理。 */
    if (m < 7 * 60) return "lateStudy";
    if (m >= 23 * 60 + 30) return "preSleep";
    return "";
  }
  /* ★ v1.59.0 场景元信息：色 / 图标 / 短标记 / 排序。
   *   排序按**一次通话的流程**走：拒接 → 转文字 → 开口 → 通话中 → 收尾 → 留言，
   *   这样从上往下扫就是在走一遍流程，而不是按添加时间堆着。
   *   ⚠️ 图标必须是 assets/icons 里真实存在的文件（踩过 phone-off 不存在的坑）。 */
  const SCENE_META = {
    todayOff:       { order: 1,  color: "#2563eb", icon: "calendar",       tag: "全天" },
    notNextDay:     { order: 2,  color: "#0891b2", icon: "clock",          tag: "此刻" },
    /* ★ v1.90.0「家人在旁·此刻不方便」：插在「非隔天」之后 —— 同属婉拒大类，
     *   但理由从「我在忙」换成「家里的实际情况」：家人在场/在陪家人/家里有安排。
     *   对方的自然解读是「他家有情况」，而不是「他不想跟我聊」。
     *   order 用 2.5（小数）：sort 按数值走，不必把后面 9 组的 order 全部重排。
     *   图标 home.svg 在 assets/icons 里真实存在。 */
    familyAround:   { order: 3,  color: "#c026d3", icon: "home",           tag: "家人" },
    preSleep:       { order: 4,  color: "#4f46e5", icon: "moon",           tag: "深夜" },
    lateStudy:      { order: 5,  color: "#dc2626", icon: "book-open",      tag: "深夜·学习" },
    textInstead:    { order: 6,  color: "#16a34a", icon: "pencil",         tag: "转文字" },
    winOpen:        { order: 7,  color: "#0d9488", icon: "phone",          tag: "开口" },
    hangupDeadline: { order: 8,  color: "#b91c1c", icon: "stop-circle",    tag: "通话中" },
    /* ★ v1.82.1：排在「到点挂断」之后、「异常挂断」之前 —— 它也属于"通话中"，
     *   只是触发点从"时间到"换成"我已经说了要睡"。图标用 timer（assets 里真实存在）。 */
    afterReason:    { order: 9,  color: "#0f766e", icon: "timer",          tag: "拖延中" },
    silentCall:     { order: 10,  color: "#d97706", icon: "volume-x",       tag: "异常" },
    winClose:       { order: 11, color: "#7c3aed", icon: "circle-stop",    tag: "收尾" },
    missedCall:     { order: 12, color: "#64748b", icon: "smartphone-off", tag: "留言" }
  };

  /* ★ v1.59.0 话术中心的全部场景 = 通用话术 8 组 + 窗口日 2 组（开场/收尾）。
   *   窗口日两组在这里被包装成同构的 {key,title,hint,items}，数据源仍是 D.poolOpen/poolClose。 */
  function genericGroups() {
    const base = (D.genericScripts || []).map(g => ({ ...g, ...(SCENE_META[g.key] || {}) }));
    const win = [
      { key: "winOpen", title: "接通开场", hint: "窗口日能接的时候，一开口先把时长框住。",
        items: (D.poolOpen || []).map((t, i) => ({ use: `开场 ${i + 1}`, text: t })) },
      { key: "winClose", title: "到点收尾", hint: "说完就走，别留「再聊两分钟」的口子。",
        items: (D.poolClose || []).map((t, i) => ({ use: `收尾 ${i + 1}`, text: t })) }
    ].filter(g => g.items.length).map(g => ({ ...g, ...(SCENE_META[g.key] || {}) }));
    return base.concat(win).sort((a, b) => (a.order || 99) - (b.order || 99));
  }

  /* 推荐理由（给顶部那行提示用，让「为什么推荐它」看得见） */
  function genericRecReason(k) {
    if (k === "hangupDeadline") return "正在通话中";
    /* ★ v1.106.0：钟点不再写死（睡眠段起点已两次后移），直接取配置，改配置这里自动跟。 */
    if (k === "lateStudy") return ((D.nightStudy && D.nightStudy.sleepFrom) || "00:30") + " 后（睡眠段 / 仍有安排）";
    if (k === "preSleep") return "已接近睡眠时段";
    return "";
  }
  /* 次推荐：主推荐之外「顺手可能也要用」的场景 */
  function genericSecondaryKeys() {
    const p = genericRecommendedKey();
    /* ★ v1.82.1：正在通话中 → 除了"到点收尾"，也把"说完理由他还拖"一起亮出来
     *   （那是通话里最常见的第二次卡点，原来只给了收尾与转文字）。 */
    if (p === "hangupDeadline") return ["winClose", "afterReason", "textInstead"];
    if (p === "lateStudy") return ["preSleep", "textInstead"];
    if (p === "preSleep") return ["lateStudy"];
    return [];
  }

  let genericOpenKey = null;   // null = 停留在「选场景」层；否则 = 当前展开的场景 key
  function openGenericGroup(key) { genericOpenKey = key || null; renderGenericScripts(); }

  function renderGenericScripts() {
    const box = document.getElementById("genericScenarios");
    if (!box) return;
    const groups = genericGroups();
    if (!groups.length) { box.innerHTML = ""; return; }
    const rec = genericRecommendedKey();
    const sec = genericSecondaryKeys();
    const openG = genericOpenKey ? groups.find(g => g.key === genericOpenKey) : null;

    if (openG) {
      /* ---- 第二层：一个场景的全部话术 ---- */
      box.innerHTML = `<div class="sc-detail">
        <button type="button" class="sc-back" id="gBackBtn"><span data-icon="grid-3x3"></span>全部场景</button>
        <div class="sc-g-title" style="color:${esc(openG.color || "#0f172a")}">${esc(openG.title)}</div>
        <div class="sc-g-hint">${esc(openG.hint || "")}</div>
        ${(openG.items || []).map(s => `
          <div class="scenario-item" data-copy="${esc(s.text)}" role="button" tabindex="0" title="点整行复制">
            <div class="s-label">${esc(s.use || "")}</div>
            <div class="s-text">${esc(s.text)}</div>
          </div>`).join("")}
      </div>`;
    } else {
      /* ---- 第一层：先选场景 ---- */
      const rank = g => (g.key === rec ? 0 : (sec.indexOf(g.key) >= 0 ? 1 : 99));
      const list = groups.slice().sort((a, b) => (rank(a) - rank(b)) || ((a.order || 99) - (b.order || 99)));
      const recTitle = (groups.find(g => g.key === rec) || {}).title || "";
      const secTitles = sec.map(k => (groups.find(g => g.key === k) || {}).title).filter(Boolean);
      const tip = rec ? `<div class="sc-tip"><span data-icon="sparkles"></span>此刻是<b>${esc(genericRecReason(rec))}</b> → 先看「${esc(recTitle)}」${secTitles.length ? `，其次「${secTitles.join("」「")}」` : ""}</div>` : "";
      box.innerHTML = tip + `<div class="sc-picker">` + list.map(g => `
        <div class="sc-pick${g.key === rec ? " rec" : (sec.indexOf(g.key) >= 0 ? " sec" : "")}"
             data-key="${esc(g.key)}" role="button" tabindex="0" style="--pc:${esc(g.color || "#64748b")}">
          <div class="sp-top">
            <span class="sp-ico" data-icon="${esc(g.icon || "list")}"></span>
            <span class="sp-tag">${esc(g.tag || "")}</span>
          </div>
          <div class="sp-title">${esc(g.title)}</div>
          <div class="sp-meta">${(g.items || []).length} 条 · 点击展开</div>
          ${g.key === rec ? '<span class="sp-badge">此刻推荐</span>' : ""}
        </div>`).join("") + `</div>`;
    }

    bindRowCopy(box);
    /* 场景卡：整卡可点 / 可回车进入（手机上更好按，也不容易点错） */
    box.querySelectorAll(".sc-pick[data-key]").forEach(el => {
      const go = () => openGenericGroup(el.dataset.key);
      el.addEventListener("click", go);
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    const back = document.getElementById("gBackBtn");
    if (back) back.addEventListener("click", () => openGenericGroup(null));
    if (window.Icon) window.Icon.inject(box);
  }

  /* ★ v1.39.0 抽出来的公共绑定：整行可点/可回车复制，复制后给 1.2s 视觉反馈 */
  function bindRowCopy(box) {
    box.querySelectorAll(".scenario-item[data-copy]").forEach(row => {
      const copy = () => {
        copyText(row.dataset.copy);
        row.classList.add("copied");
        setTimeout(() => row.classList.remove("copied"), 1200);
      };
      row.addEventListener("click", copy);
      row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(); } });
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
      const isHostCall = at.kind === "call";
      const tagClass = isHostCall ? "host-call" :
        (at.kind === "study" && at.status === "running" ? "host-study" : "host-other");
      card.style.display = "";
      status.innerHTML = `<span class="host-tag ${tagClass}">正在${cm.label} ${mins}分${secs}秒${statusTxt}</span> <span class="host-label">${label}</span>`;
      if (isHostCall) {
        /* ★ v1.26.3 阶段提示读配置（原先硬编码 15/25） */
        const wMin = (D.rules && D.rules.warnMinutes) || 15;
        const mMin = (D.rules && D.rules.callMaxMinutes) || 25;
        let stage;
        if (at.status === "paused") {
          stage = "主站通话计时已暂停；如果电话仍未结束，请立即恢复计时或直接挂断，不能让通话脱离记录。";
        } else if (elapsed < wMin * 60) {
          stage = `距离 ${wMin} 分钟预警还有 ${fmtRemain(Math.ceil((wMin * 60 - elapsed) / 60))}；现在就控制话题，只处理必要事项。`;
        } else if (elapsed < mMin * 60) {
          /* ★ v1.76.0（用户 2026.10.19 选定）：原措辞是「已进入**强硬**收尾阶段」，
           *   与新增的「柔性收尾 · 7 天练习」模块气质冲突（一个说强硬、一个说温柔）。
           *   这里只把「强硬」二字删掉，改成中性的「收尾阶段」——
           *   阈值、计时、时限、规则逻辑一行未动。 */
          stage = `已进入收尾阶段，距离 ${mMin} 分钟终极时限还有 ${fmtRemain(Math.ceil((mMin * 60 - elapsed) / 60))}。`;
        } else {
          stage = `已超过 ${mMin} 分钟终极时限 ${fmtRemain(Math.ceil((elapsed - mMin * 60) / 60))}：不要继续解释，立即挂断。`;
        }
        hint.innerHTML = `<div class="host-call-guidance"><b>📞 主站确认：正在通话</b><span>${stage}</span>` +
          `<span>规则提醒：宁可少打，不拖延；感到消耗或时间到，执行“过渡 3 分钟定则”收尾。</span>` +
          `<span>★ 垃圾时间一结束、或你发现此刻能学 / 想学 → <b>3 分钟内挂断</b>，不必等到约定时间（2026.10.25）。</span>` +
          `<span>除 3 小时以上完整时间块外不得挂机；与对方要求冲突时，3 分钟内解释完并回到自己的事。</span></div>`;
      } else if (at.kind === "study") {
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
    const j = evaluateCallDecision();
    const rule = D.weeklyRule;
    /* ★ v1.26.2 双闸同步展示：次数 + 时长（任一超限都标红），与判定/快照/核验表口径一致 */
    const minCap = rule.maxMinPerWeek || 0;
    const usedMin = Math.round(j.weeklyCallMinSec / 60);
    const minOver = minCap > 0 && usedMin > minCap;
    /* ★ v1.37.0：次数闸已取消（weeklyCountCap()=Infinity → 该行整体隐去）；
     * 新增「单日上限」与「奇数日/偶数日」两行，随时切换新旧规则口径。 */
    const countRow = weeklyCountCap() === Infinity ? "" :
      /* ★ v1.93.0：口径由「次」改「天」——每周 4 个**通话日**（当天接通总时长 >5min 才计入） */
      `<div class="wf-row"><span>本周通话日额度</span><span class="wf-count ${j.weeklyCallCount >= weeklyCountCap() ? 'over' : ''}">${j.weeklyCallCount} / ${weeklyCountCap()} 天</span></div>`;
    /* ★ v1.93.0：日闸与奇偶日解耦 —— 原写法 `j.oddEvenOn && ...` 在奇偶日取消后会让
     *   「今日通话上限」整行消失（单日封顶是独立闸口，用户从未要求取消）。 */
    const dayRow = (j.dayCapMin > 0)
      ? `<div class="wf-row"><span>今日通话上限</span><span class="wf-count ${j.curDayMin >= j.dayCapMin ? 'over' : ''}">${j.curDayMin} / ${j.dayCapMin} 分钟</span></div>` : "";
    /* ★ v1.93.0：奇偶日策略作废（用户 2026-10-25 拍板）。
     *   原先这行把旧奇偶日建议写死在 `!j.oddEvenOn` 分支里——奇偶日一取消它就变成永真分支，
     *   把一个**已废止的旧策略**当成规则部建议长期展示在面板上。
     *   现在换成真正决定「今天能不能接」的属性：**连续通话链**。 */
    const streakRow = (function () {
      if (j.bannedByStreak) {
        return `<div class="wf-row"><span>今日属性</span><span style="color:#dc2626">连续 ${j.streakLen} 天通话${j.streakHasManual ? " · 含补记" : ""} · 今日严禁</span></div>`;
      }
      if (j.yesterdayCalled) {
        return `<div class="wf-row"><span>今日属性</span><span style="color:#d97706">昨日已通话 · 今日强烈不建议</span></div>`;
      }
      return `<div class="wf-row"><span>今日属性</span><span style="color:#15803d">昨日未通话 · 连续链已断</span></div>`;
    })();
    el.innerHTML = `
      ${countRow}
      <div class="wf-row"><span>本周接通总时长</span><span class="wf-count ${minOver ? 'over' : ''}">${usedMin} / ${minCap} 分钟</span></div>
      ${dayRow}
      ${streakRow}
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
    /* ★ v1.45.0：此刻快照两类豁免（见 callOverrideSnapshot 声明处的说明） */
    try {
      const ovs = getOverrides();
      callOverrideSnapshot = {
        quota_extra: ovs.quota_extra ? { ...ovs.quota_extra } : null,
        necessary: ovs.necessary ? { ...ovs.necessary } : null
      };
    } catch (e) { callOverrideSnapshot = null; }
    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "";

    /* ★ v1.26.3 双闹钟时长改读配置（原先硬编码 15/25——用户改 call-data.js 的
     * rules.warnMinutes / callMaxMinutes 后计时器不跟随，属同类"展示未同步"隐患） */
    const warnMin = (D.rules && D.rules.warnMinutes) || 15;
    const maxMin = (D.rules && D.rules.callMaxMinutes) || 25;

    // 预警
    warnTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(1);
        window.UI.showAlert(`⏰ 还有 ${maxMin - warnMin} 分钟，准备收尾`, 5000);
        window.UI.notify("⏰ 预警", `通话 ${warnMin} 分钟了，还有 ${maxMin - warnMin} 分钟到终极`);
      }
    }, warnMin * 60 * 1000);

    // 终极
    finalTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(3);
        window.UI.buzz();
        window.UI.showAlert("到点了，刚性挂断！", 5000);
        window.UI.notify("⏰ 通话结束", `${maxMin} 分钟到了，请挂断`);
      }
      endCall(true);
    }, maxMin * 60 * 1000);

    // 通话时长刷新
    callTickId = setInterval(updateCallDisplay, 1000);
    updateCallDisplay();

    if (window.UI) window.UI.showAlert("通话开始，双闹钟已启动（15min预警 / 25min终极）", 3000);
  }

  /* ★ v1.26.3 双闹钟阈值标签从配置渲染（原先 HTML 硬编码 15/25 且 warnTime/finalTime
   * 从未被任何 JS 写入——改配置后页面不跟随，属"展示未同步"隐患） */
  function renderAlarmLabels() {
    const wMin = (D.rules && D.rules.warnMinutes) || 15;
    const mMin = (D.rules && D.rules.callMaxMinutes) || 25;
    const wl = document.getElementById("warnLabel");
    if (wl) wl.textContent = `${wMin} 分钟预警`;
    const wt = document.getElementById("warnTime");
    if (wt) wt.textContent = `${p(wMin)}:00`;
    const fl = document.getElementById("finalLabel");
    if (fl) fl.textContent = `${mMin} 分钟终极`;
    const ft = document.getElementById("finalTime");
    if (ft) ft.textContent = `${p(mMin)}:00`;
  }

  function updateCallDisplay() {
    if (!callStartAt) return;
    const elapsed = Math.floor((Date.now() - callStartAt) / 1000);
    const em = Math.floor(elapsed / 60), es = elapsed % 60;
    const el = document.getElementById("callElapsed");
    if (el) el.textContent = `${p(em)}:${p(es)}`;

    /* ★ v1.26.3 倒计时余量也读配置 */
    const wMin = (D.rules && D.rules.warnMinutes) || 15;
    const mMin = (D.rules && D.rules.callMaxMinutes) || 25;
    const warnRemain = Math.max(0, wMin * 60 - elapsed);
    const wr = document.getElementById("warnRemain");
    if (wr) wr.textContent = `${p(Math.floor(warnRemain/60))}:${p(warnRemain%60)}`;

    const finalRemain = Math.max(0, mMin * 60 - elapsed);
    const fr = document.getElementById("finalRemain");
    if (fr) fr.textContent = `${p(Math.floor(finalRemain/60))}:${p(finalRemain%60)}`;

    /* ★ v1.101.0：通话进行中「今日已通话」跟着走字（原来只在结束时才更新一次）。
     *   好处有两个：① 一眼看到"今天累计到哪了"，不用等挂断；
     *   ② 通话跨过凌晨 4 点时，数字会**平滑地**只把 04:00 之后那段算给新的一天。 */
    renderTodayCall();
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
    /* ★ v1.45.0：以**开始通话时的快照**为准（快照缺失时回落当前状态，属异常兜底）。
     * 旧实现在此处现读 getOverrides()：豁免窗口若在通话中途到期，
     * 到期项已被自动清除 → 写出的记录丢掉豁免标记，复盘看不出这是豁免通话。 */
    const ovs = callOverrideSnapshot || getOverrides();
    const activeOvs = [ovs.quota_extra, ovs.necessary].filter(Boolean);
    const tags = ["边界管控", "通话"];
    if (inStudySlot) tags.push("学习区间通话");
    if (ovs.quota_extra) tags.push("周额度豁免");
    if (ovs.necessary) tags.push("正经时间必要豁免");
    /* 回填台账：这次豁免是否真的产生了通话 */
    activeOvs.forEach(ov => markOverrideUsed(ov.type, Math.round((dur || 0) / 60)));
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
            activeOvs.map(ov => `｜🔓 ${overrideTypeLabel(ov)}（已报规则部）：${ov.reason}`).join(""),
      created_at: new Date().toISOString()
    };
    Store.addTimeRecord(rec);
    renderTodayCall();

    if (window.UI) {
      window.UI.showAlert(
        `通话结束，时长 ${Math.floor(dur/60)}分${dur%60}秒，已记入时间账本` +
        (inStudySlot ? (ovs.necessary ? "（学习区间·已报规则部）" : "（学习区间通话，已标记）") : ""), 3000);
    }

    // 刷新周频率
    renderWeeklyInfo();
    /* ★ v1.45.0：本次通话已记账，快照使命完成，清空等待下一次通话 */
    callOverrideSnapshot = null;
    renderOverrideLedger();
  }

  /* ---------- 周频率检查 ---------- */
  function checkWeekly() {
    const j = judgeToday();
    const rule = D.weeklyRule;
    /* ★ v1.37.0：次数闸取消，改为「周时长 + 单日上限」双闸（12 日起日闸生效） */
    const minCap = rule.maxMinPerWeek || 0;
    const usedMin = Math.round(j.weeklyCallMinSec / 60);
    const timesOver = j.weeklyCallCount >= weeklyCountCap();
    const minOver = minCap > 0 && usedMin > minCap;
    /* ★ v1.93.0：解耦奇偶日（否则日超额弹窗永远不触发） */
    const dayOver = j.dayCapMin > 0 && j.curDayMin > j.dayCapMin;
    if (timesOver || minOver || dayOver) {
      if (window.UI) {
        window.UI.showAlert(dayOver
          ? `今日通话已达上限（${j.curDayMin}/${j.dayCapMin} 分钟），今天不能再聊了，建议返回学习`
          : `本周通话已达上限（${weeklyCountSlot(j.weeklyCallCount)}${usedMin}/${minCap} 分钟），建议返回学习`, 5000);
        setTimeout(() => {
          const ok = confirm("本周已超额，继续畅聊将违反边界管控。\n\n选择：\n确定 = 继续畅聊（违规）\n取消 = 返回学习");
          if (ok) {
            if (window.UI) window.UI.showAlert("已标记为违规，请自觉遵守边界", 3000);
          }
        }, 100);
      }
    } else {
      if (window.UI) {
        window.UI.showAlert(`本周已用 ${weeklyCountSlot(j.weeklyCallCount)}${usedMin}/${minCap} 分钟，剩余 ${Math.max(0, minCap - usedMin)} 分钟` +
          (j.dayCapMin > 0 ? ` ｜ 今日还剩 ${Math.max(0, j.dayCapMin - j.curDayMin)} 分钟` : ""), 3000);
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
    renderControlFlash();   // ★ v1.37.0 管控闪卡（置顶，最先渲染）
    renderNowSlot();
    renderTodayCall();
    renderJudge();
    updateJudgeHint();       // 初始化复选框摘要提示
    renderScenarios();
    renderGenericScripts();  // ★ v1.48.0 通用话术；★ v1.59.0 起＝话术中心（含原窗口日话术），阶梯式两级
    renderHostStatus();
    renderWeeklyInfo();

    // 每 30 秒刷新时段卡与豁免倒计时；跨过时段边界/豁免到期时同步刷新判定
    let lastSlotKey = (currentSlotInfo() && currentSlotInfo().slot) ? currentSlotInfo().slot.start : "none";
    let lastOvState = overrideStateKey();
    /* ★ v1.56.0「此刻推荐」跟随局面变化（通话开始/结束、跨 00:00）：
     *   只在推荐组真的变了才重渲染，避免每 30 秒重建一次 DOM（会打断复制反馈）。 */
    let lastGenericRec = genericRecommendedKey();
    /* ★ v1.101.0「跨天翻篇」：凌晨 4 点一过就是另一个业务日，
     *   「今日已通话 / 周额度 / 连续链 / 今日状态 / 台账分组」全部要按新的一天重算。
     *   旧实现只盯时段与豁免，**没有盯业务日**——页面通宵开着，第二天早上看到的
     *   还是昨天的账（这正是"跨天机制没改好"的另一半）。 */
    let lastBizKey = todayBizKey();
    setInterval(() => {
      renderNowSlot();
      renderControlFlash();   // ★ v1.37.0 闪卡倒计时/生效态跟随真实时间跳变
      renderTodayCall();      // ★ v1.101.0 通话进行中也要走字（且跨 04:00 自动归到新的一天）
      const bk = todayBizKey();
      if (bk !== lastBizKey) {
        lastBizKey = bk;
        renderJudge(); updateJudgeHint(); renderWeeklyInfo();
        if (typeof renderRecentCalls === "function") renderRecentCalls();
        if (typeof renderTodayMode === "function") renderTodayMode();
      }
      /* ⚠️ 已经点进某个场景（第二层）时不要重渲染：会打断复制反馈、也可能把人弹回第一层 */
      const gRec = genericRecommendedKey();
      if (gRec !== lastGenericRec && !genericOpenKey) { lastGenericRec = gRec; renderGenericScripts(); }
      const si = currentSlotInfo();
      const key = (si && si.slot) ? si.slot.start : "none";
      const ovState = overrideStateKey();
      if (key !== lastSlotKey || ovState !== lastOvState) {
        lastSlotKey = key;
        lastOvState = ovState;
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
      const decision = evaluateCallDecision();
      if (!decision.allowed) {
        if (window.UI) window.UI.showAlert(`规则部规定：请你直接挂断。${decision.advice}`, 5000);
        return;
      }
      /* ★ v1.61.0（用户 2026.10.18 指定）：双闹钟**不再接管主站计时器**。
       *   原实现会先弹 confirm「主站「XX」将结束 → 进入通话 · 双闹钟」，确认后调
       *   `window.Timer.stopSilent()` 把主站正在跑的计时**写账并终止** —— 这就是即时计时联动。
       *   用户口径：双闹钟保留在通话边界管理系统里的**独立存在**，但**不与主计时器联动**；
       *   后续若要恢复即时联动，须用户另行同意（此类联动需非常谨慎）。
       *   ⚠️ 只解除「接管/终止主站计时」；通话结束后的记账（`Store.addTimeRecord`）
       *   与周额度统计仍依赖它，本次不动 —— 若要一并断开，需先确认周额度改走哪套数据。 */
      startDualAlarm();
    });

    const btnEnd = document.getElementById("btnEnd");
    if (btnEnd) btnEnd.addEventListener("click", () => endCall(false));

    // 底部按钮 → 打开"选择窗口"；窗口内二选一（不豁免 / 申报豁免）
    const btnQuota = document.getElementById("btnQuotaOverride");
    if (btnQuota) btnQuota.addEventListener("click", () => {
      if (getOverride("quota_extra")) {
        clearOverride("quota_extra");
        renderOverride();
        refreshCallDecision();
        if (window.UI) window.UI.showAlert("已结束周额度豁免，恢复本周 120 分钟时长限制", 2200);
        return;
      }
      openOverrideDialog("quota_extra");
    });
    const btnNecessary = document.getElementById("btnNecessaryOverride");
    if (btnNecessary) btnNecessary.addEventListener("click", () => {
      if (getOverride("necessary")) {
        clearOverride("necessary");
        renderOverride();
        refreshCallDecision();
        if (window.UI) window.UI.showAlert("已结束正经时间豁免，恢复垃圾时间限制", 2200);
        return;
      }
      openOverrideDialog("necessary");
    });

    [
      ["quotaClose", "quota_extra"], ["quotaCancel", "quota_extra"],
      ["necessaryClose", "necessary"], ["necessaryCancel", "necessary"]
    ].forEach(([id, type]) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => closeOverrideDialog(type));
    });
    const quotaMask = document.getElementById("quotaMask");
    if (quotaMask) quotaMask.addEventListener("click", () => closeOverrideDialog("quota_extra"));
    const necessaryMask = document.getElementById("necessaryMask");
    if (necessaryMask) necessaryMask.addEventListener("click", () => closeOverrideDialog("necessary"));

    /* ★ v1.70.0 绕过建议指标的二次判断页 */
    const bypClose = document.getElementById("bypassClose");
    if (bypClose) bypClose.addEventListener("click", closeBypassDialog);
    const bypMask = document.getElementById("bypassMask");
    if (bypMask) bypMask.addEventListener("click", closeBypassDialog);
    const bypConfirm = document.getElementById("bypassConfirm");
    if (bypConfirm) bypConfirm.addEventListener("click", confirmBypass);
    syncBypassFromCloud();   // 换设备后把当日已用次数并进来（护栏不能靠清缓存绕过）

    /* 窗口 A：只为「本周 120 分钟额度已用尽、但此刻确属垃圾时间」放行一次。
     * ★ v1.45.0 口径修正：原注释写“周次数已用尽”，次数闸已于 v1.37.0 取消。 */
    const quotaGrant = document.getElementById("quotaGrant");
    if (quotaGrant) quotaGrant.addEventListener("click", () => {
      if (!overrideChecksPassed("quota_extra")) {
        if (window.UI) window.UI.showAlert("4 项人工承诺必须全部勾选（系统核验项已自动判定）", 3500);
        return;
      }
      const input = document.getElementById("quotaReasonInput");
      const reason = String((input && input.value) || "").trim();
      if (!reason) {
        if (window.UI) window.UI.showAlert("请写明为什么需要增加本周额度", 3000);
        return;
      }
      const j = judgeToday();
      /* ★ v1.37.0 次数闸取消 → 改判周时长：未超 120 分钟就不必申请额度豁免。 */
      const wkCap = (D.weeklyRule && D.weeklyRule.maxMinPerWeek) || 0;
      const wkUsed = Math.round(j.weeklyCallMinSec / 60);
      if (wkCap > 0 && wkUsed < wkCap) {
        if (window.UI) window.UI.showAlert(`本周通话 ${wkUsed}/${wkCap} 分钟，额度尚未用尽，无需增加`, 3500);
        return;
      }
      if (!overrideSystemEligible("quota_extra")) {
        if (window.UI) window.UI.showAlert("周额度豁免只适用于已确认的垃圾时间；专注、睡眠、影响进度或邀约时不可使用", 4200);
        return;
      }
      pushReasonHistory("quota_extra", reason);
      const mins = overrideMinutes();
      setOverride(reason, mins, "quota_extra");
      closeOverrideDialog("quota_extra");
      renderOverride();
      refreshCallDecision();
      if (window.UI) window.UI.showAlert(`🔓 周额度已放行（本周 120 分钟上限对本通话失效）｜仅在当前垃圾时间内有效 ${mins} 分钟｜${reason}`, 4200);
    });

    // 窗口 B：正经时间特殊豁免；“正在专注”仍绝对禁止，并须说明现实损失。
    const necessaryGrant = document.getElementById("necessaryGrant");
    if (necessaryGrant) necessaryGrant.addEventListener("click", () => {
      if (!overrideChecksPassed("necessary")) {
        if (window.UI) window.UI.showAlert("6 项人工核验必须全部勾选（系统核验项已自动判定）", 3500);
        return;
      }
      const input = document.getElementById("necessaryReasonInput");
      const reason = String((input && input.value) || "").trim();
      if (reason.length < 6) {
        if (window.UI) window.UI.showAlert("请具体写明：为什么确实不得不现在通话（至少 6 个字）", 3500);
        return;
      }
      if (!overrideSystemEligible("necessary")) {
        if (window.UI) window.UI.showAlert("系统仍检测到专注、睡眠、影响进度或邀约等硬阻断，本入口不能覆盖", 5000);
        return;
      }
      if (!confirm("⚠️ 正经时间特殊豁免\n\n请再次确认：\n· 文字、延后回拨、10 分钟短答等替代方案均不可行\n· 这件事确实不得不现在处理\n· 通话仍须双闹钟并进入每日复盘\n\n确认 = 申报特殊豁免\n取消 = 收手，继续原计划")) return;
      pushReasonHistory("necessary", reason);
      const mins = overrideMinutes();
      setOverride(reason, mins, "necessary");
      closeOverrideDialog("necessary");
      renderOverride();
      refreshCallDecision();
      if (window.UI) window.UI.showAlert(`🟠 已申报“确实不得不”特殊豁免 ${mins} 分钟｜${reason}（已留痕）`, 4200);
    });

    // 今日通话分钟 + 补记（★ v1.27.4：prompt×2 → 内联弹窗表单）
    let mfMin = null;      // 选中的分钟数（null = 未选）
    let mfTimeMode = "now"; // "now" | "-30" | "-60" | "-120" | "custom"
    function openManualForm() {
      mfMin = null; mfTimeMode = "now";
      const min = document.getElementById("mfMin"), tm = document.getElementById("mfTime");
      if (min) min.value = "";
      if (tm) tm.value = "";
      document.getElementById("manualMask").classList.add("show");
      document.getElementById("manualModal").classList.add("show");
    }
    function closeManualForm() {
      document.getElementById("manualMask").classList.remove("show");
      document.getElementById("manualModal").classList.remove("show");
    }
    function saveManualForm() {
      const minInput = document.getElementById("mfMin");
      const mins = Math.round(parseFloat(minInput && minInput.value));
      if (!isFinite(mins) || mins <= 0) {
        if (window.UI) window.UI.showAlert("请先选择或输入有效的分钟数", 2800);
        return;
      }
      const tm = document.getElementById("mfTime");
      let startAt = Date.now() - mins * 60000;   // 默认「刚才」
      let backfilled = false;
      // 快捷粒（now/-30/-60/-120）优先；time 输入框有值则覆盖
      if (mfTimeMode !== "now" && mfTimeMode.startsWith("-")) {
        startAt = Date.now() + Number(mfTimeMode) * 60000;
        backfilled = true;
      }
      if (tm && tm.value) {
        const m = tm.value.match(/^(d{1,2}):(d{2})$/);
        if (m && +m[1] <= 23 && +m[2] <= 59) {
          const local = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), +m[1], +m[2]);
          if (local.getTime() > Date.now()) {
            if (window.UI) window.UI.showAlert("发生时间在未来，已按「刚才」记录", 3200);
          } else { startAt = local.getTime(); backfilled = true; }
        } else if (window.UI) window.UI.showAlert("时间格式不对，已按「刚才」记录", 3200);
      }
      const endAt = startAt + mins * 60000;
      const noteBase = "手动补记（未开双闹钟）｜只进通话页账本，不进主站时间记录";
      Store.addTimeRecord({
        id: uid(), user_id: C.USER_ID,
        category: "call", sub_category: "linyuchen",
        label: "通话（补记）", tags: ["边界管控", "通话", "手动补记"],
        started_at: new Date(startAt).toISOString(),
        ended_at: new Date(endAt).toISOString(),
        duration_sec: mins * 60,
        source: "call_manual",   // ★ 主站不联动：见 today-records.js 的 source 白名单说明
        note: backfilled ? noteBase + "｜发生时刻 " + (window.Blocks ? window.Blocks.beijing(new Date(startAt)).toTimeString().slice(0, 5) : new Date(startAt).toTimeString().slice(0, 5)) : noteBase,
        created_at: new Date().toISOString()
      });
      renderTodayCall();
      renderWeeklyInfo();
      closeManualForm();
      const wTxt = backfilled ? (window.Blocks ? window.Blocks.beijing(new Date(startAt)).toTimeString().slice(0, 5) : new Date(startAt).toTimeString().slice(0, 5)) + " 起" : "";
      if (window.UI) window.UI.showAlert(`✅ 已补记 ${mins} 分钟通话${wTxt}（计入本周额度；不进主站时间记录）`, 3000);
    }
    const btnManual = document.getElementById("btnManualCall");
    if (btnManual) btnManual.addEventListener("click", openManualForm);
    ["manualClose", "manualCancel", "manualMask"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", closeManualForm);
    });
    const mSave = document.getElementById("manualSave");
    if (mSave) mSave.addEventListener("click", saveManualForm);
    // 快捷粒：分钟数
    document.querySelectorAll(".mf-chip[data-min]").forEach(ch => {
      ch.addEventListener("click", () => {
        const min = document.getElementById("mfMin");
        if (min) min.value = ch.dataset.min;
      });
    });
    // 快捷粒：时间（选中时清 time 输入框，避免覆盖）
    document.querySelectorAll(".mf-chip[data-time]").forEach(ch => {
      ch.addEventListener("click", () => {
        mfTimeMode = ch.dataset.time;
        const tm = document.getElementById("mfTime");
        if (tm) tm.value = "";
        document.querySelectorAll(".mf-chip[data-time]").forEach(x => x.style.outline = x === ch ? "2px solid #2563eb" : "");
      });
    });
    const tmInput = document.getElementById("mfTime");
    if (tmInput) tmInput.addEventListener("input", () => {
      mfTimeMode = "custom";
      document.querySelectorAll(".mf-chip[data-time]").forEach(x => x.style.outline = "");
    });

    // 周频率检查
    const btnWeekly = document.getElementById("btnWeeklyCheck");
    if (btnWeekly) btnWeekly.addEventListener("click", checkWeekly);

    /* ★ v1.93.0 今日状态两个按钮：按下即切换（再按一次取消），当天生效、凌晨 4 点自动重置。 */
    const btnES = document.getElementById("btnExtraStudy");
    const btnNC = document.getElementById("btnNoChat");
    if (btnES) btnES.addEventListener("click", () => {
      const m = todayMode();
      setTodayMode({ extraStudy: !m.extraStudy });
    });
    if (btnNC) btnNC.addEventListener("click", () => {
      const m = todayMode();
      setTodayMode({ noChat: !m.noChat });
    });
    renderTodayMode();

    /* ★ v1.98.0 近期通话记录台账：删除用**事件委托**绑一次。
     *   每行 DOM 会被 renderRecentCalls 反复重建，逐行 addEventListener 会在重渲染后失效
     *   （点了没反应——典型的静默失败）。委托在容器上，重建多少遍都还在。
     *   删除本身走 Store.deleteTimeRecord：Outbox 同步删云端是既有机制，这里不重写。 */
    const rcBox = document.getElementById("recentCallsBody");
    if (rcBox) rcBox.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-rc-del]") : null;
      if (!btn) return;
      const id = btn.dataset.rcDel;
      const hit = recentCallRows().filter(x => x.r.id === id)[0];
      const what = hit
        ? rcDayLabel(hit.bkey) + " " + rcHM(hit.r.started_at) + " → " + rcHM(hit.r.ended_at) +
          " · " + fmtDuration(hit.sec) + "（" + (hit.r.source === "call_manual" ? "手动补记" : "双闹钟计时") + "）"
        : "这条通话记录";
      if (!confirm("确定删除这条通话记录吗？\n\n" + what +
        "\n\n· 删除后本页「今日已通话 / 周额度」会自动重算\n" +
        "· 云端副本同步删除（多端一致）\n" +
        "· 不会影响主站时间账本——两者本来就分开记，这条本就不在主站里")) return;
      Store.deleteTimeRecord(id);
      if (window.UI) window.UI.showAlert("🗑 已删除通话记录", 2600);
    });
    renderRecentCalls();
    /* ★ v1.97.0：今日状态的多端同步入口。
     *   events 表里 `tm-<业务日>` 行是权威源 —— 别的设备按下/取消后，本机订阅到变更
     *   就立刻以云端为准重算（_tmApplyRemote 内部会跳过"自己刚写的那一次"）。
     *   ⚠️ 这里重新订阅 events，与 v1.43.0 断掉的「通讯录名 cx-* 那一路」不冲突：
     *     断的是借口指派，不是整张表；签到 ck-* / 违规 viol-* / 今日状态 tm-* 都要读它。 */
    if (Store.subscribeEvents) Store.subscribeEvents(_tmApplyRemote);
    /* 给 call-verdict.js（弹层）读的只读出口。它在本文件之后加载，
     * 但 init 是 DOM ready 后才跑的，那时这里已经挂好了。
     * ⚠️ 只暴露 get，不暴露 set：写入口留在本文件，避免第二套写入路径。 */
    window.CALL_TODAYMODE = { get: () => todayMode(), rowId: () => _tmRowId(todayBizKey()) };
    /* ★ v1.101.0：把「今日已通话秒数」也开一个只读出口给 call-verdict.js（弹层）。
     *   两套判定引擎必须同口径——否则通话进行中点开裁定，主判定（含进行中这段）
     *   与弹层（只算已结束的）会给出两个不同的「今日还剩多少分钟」。
     *   call-verdict 取不到时回落到它自己按记录算的值，不会因本文件未加载而崩。 */
    window.CALL_TODAY_CALL_SEC = todayCallSec;

    // 订阅主站状态变化
    Store.subscribeActiveTimer(() => { _judgeInvalidate(); renderHostStatus(); renderJudge(); _ensureHostTick(); });
    // 任务同步到达后重新执行自动门禁，但不重建复选框，保留用户当前人工判断。
    if (Store.subscribeTasks) Store.subscribeTasks(() => { _judgeInvalidate(); refreshCallDecision(); });
    /* ★ v1.43.0 取消「今日通讯录名」的多端同步（用户 2026.10.12 指定）。
     *   原实现：借口指派写进 events 表的 `cx-<date>` 行，走 Store.setEvents 整表推送，
     *   任一设备改动都同步到所有设备。
     * 现状：通讯录名卡下线，call.js **不再读写任何 cx- 行**。
     * ★ v1.97.0：本页重新订阅 events（见上方 _tmApplyRemote）——只为今日状态 tm- 行，
     *   不是 cx- 那一路复活；护栏 test-rest-sync.js 也已按此口径更新。
     * ⚠️ events 表本身照常同步（签到 ck-*、违规 viol-*、今日状态 tm-* 仍多端共享），
     *    不要顺手把 events 从同步表清单里摘掉。 */
    /* ★ v1.26.3 通话记录（time_records）到达即刷新：周频率卡/判定/话术速查都依赖它
     * ——其他设备记的通话、补记保存后，本页原先要等时段边界才更新，属"功能未同步"隐患 */
    if (Store.subscribeTimeRecords) Store.subscribeTimeRecords(() => {
      _judgeInvalidate();          // ★ v1.104.0：额度/连续链的数据源刚变了，1 秒缓存必须作废
      refreshCallDecision(); renderTodayCall();
      /* 补记保存 / 真实通话结束 / 别端同步到达 → 台账都要跟着翻（否则删了还挂在页面上） */
      renderRecentCalls();
    });

    // M1 修复：运行中秒级自刷新（Store 不会每秒 emit，call 页自己 tick）
    _ensureHostTick();

    // 图标注入
    if (window.Icon) {
      window.Icon.inject(document.getElementById("callScenarios"));
      window.Icon.inject(document.getElementById("genericScenarios"));   // ★ v1.59.0 原 windowScenarios 已并入
      window.Icon.inject(document.querySelector(".call-actions"));
    }
  }

  /* ★ v1.55.0 供**主站计时器**取「此刻口径」的颜色（跨页联动，见 quickVerdict 注释）。
   *   只导出这三个：一个取色入口 + 缓存键（便于断言/排查）。 */
  /* ★ v1.60.0：deferWindow / nextDeferWindow 一并导出——置后定则的「出口」既要给人看，
   *   也要能被测（断言脚本用固定「现在」跑真代码，不是复刻一遍逻辑）。 */
  window.CallJudge = { verdictNow, quickVerdict, cacheKey: VERDICT_CACHE_KEY,
                       /* ★ v1.104.0：把豁免读取也交出去 —— call-verdict.js 与主判定
                        *   **必须**读到同一份豁免状态，否则「已申请到 necessary、主判定卡放行、
                        *   速查页仍 deny」这种两页打架会一直挂着。 */
                       override: getOverride,
                       deferWindow: deferWindowText, nextDeferWindow,
                       /* ★ v1.70.0：判定与「建议指标绕过」对外出口（断言要跑真代码，
                        *   主站计时器将来若需要展示建议清单也走这里）。 */
                       evaluate: () => evaluateCallDecision(),
                       bypass: { state: bypassState, grant: grantBypass, revoke: revokeBypass,
                                 left: bypassLeftToday, max: BYPASS_MAX_PER_DAY } };

  /* ---------- ★ v1.107.0 卡片折叠（用户 2026-10-31 指定）----------
   * 问题：call.html 越堆越长，那些「只在特定情况才用」的板块（话术 / 撞车解释 / SOP /
   *      到达时间分析 / 随机借口 / 联系规则 / 执行铁律）把每天都要看的入口顶到很远。
   * 做法：卡片上打 `data-fold`，这里把它重组成原生 <details> —— 键盘可达、无 JS 也能开，
   *      省掉一套自造的开关状态管理。展开状态记在 localStorage，下次还展开。
   * 🔒 边界（绝不折，见 call.html 与 theme.css 注释）：两张闪卡、#nowSlotCard、
   *    「双闹钟倒计时」（补记按钮 + 今日已通话分钟）、#recentCallsCard（通话账本）。
   * ⚠️ 动态卡片（missedCard / callTimingCard / sopCard）是整块 `box.innerHTML = ...` 重建的，
   *    重建会把 details 结构整个冲掉 —— 所以必须在那之后重新 apply()，
   *    否则折叠会在某次刷新后**静默消失**（本项目最易复发的病）。 */
  const FOLD_KEY = "kaoyan:call_folds";
  let _foldState = (function () {
    try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") || {}; } catch (e) { return {}; }
  })();
  function foldOne(card) {
    const id = card.getAttribute("data-fold");
    if (!id) return;
    if (card.querySelector(":scope > details.fold-wrap")) return;   // 已折好 → 幂等，别重复包
    const h2 = card.querySelector("h2");
    if (!h2) return;                                                // 还没渲染出标题，等下次
    const det = document.createElement("details");
    det.className = "fold-wrap";
    det.open = !!_foldState[id];
    const sum = document.createElement("summary");
    sum.className = "fold-sum";
    const meta = document.createElement("span");
    meta.className = "fold-meta";
    meta.textContent = card.getAttribute("data-fold-meta") || "";
    const arrow = document.createElement("span");
    arrow.className = "fold-arrow";
    h2.parentNode.removeChild(h2);
    sum.appendChild(h2);
    if (meta.textContent) sum.appendChild(meta);
    sum.appendChild(arrow);
    const body = document.createElement("div");
    body.className = "fold-body";
    while (card.firstChild) body.appendChild(card.firstChild);
    det.appendChild(sum);
    det.appendChild(body);
    card.appendChild(det);
    card.classList.add("is-foldable");
    det.addEventListener("toggle", function () {
      _foldState[id] = det.open;
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(_foldState)); } catch (e) {}
    });
  }
  function applyCardFolds() {
    document.querySelectorAll(".card[data-fold]").forEach(foldOne);
  }
  function initCardFolds() {
    applyCardFolds();
    /* 只观察这 3 个会整体重渲染的容器，**不观察整个 body** ——
     * 页面上有秒级刷新的计时器，全页 subtree 观察会被高频触发，白烧 CPU。 */
    ["missedCard", "callTimingCard", "sopCard"].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el || el.dataset.foldWatched === "1") return;
      el.dataset.foldWatched = "1";
      new MutationObserver(function () { foldOne(el); }).observe(el, { childList: true });
    });
  }
  /* ★ v1.107.0：别的板块要「滚到某张卡」时，得先把它的折叠打开。
   *   否则 scrollIntoView 滚过去只看到一行标题 —— 点了没反应，也不报错（静默失败）。
   *   调用方：call-verdict.js 的 jumpScene（速查页「去挑一句」→ 话术中心）、
   *          call-sop.js 的「查看 7 天过渡计划」。
   *   ⚠️ 必须两种情况都处理：传进来的既可能是**折叠卡本身**（`#sopCard`、`#genericScenarios`
   *      所在的 .card —— details 是它的子节点），也可能是卡**内部**的元素（details 是祖先）。
   *      只写向上遍历会让「卡本身」这种情况静默失效。 */
  function openFoldFor(el) {
    if (!el) return false;
    const inner = el.querySelector ? el.querySelector(":scope > details.fold-wrap") : null;
    if (inner) { if (!inner.open) inner.open = true; return true; }
    let node = el.parentNode;
    while (node && node !== document.body) {
      if (node.tagName === "DETAILS" && node.classList && node.classList.contains("fold-wrap")) {
        if (!node.open) node.open = true;   // 触发 toggle → 展开状态照样落盘
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }
  window.CallFolds = { apply: applyCardFolds, init: initCardFolds, openFor: openFoldFor };

  document.addEventListener("DOMContentLoaded", () => {
    /* ★ v1.55.0：call.js 现在也被**主站计时页**（timer.html）引入 —— 只为拿 CallJudge 取色。
     *   那里没有通话页的容器，跑 init 会去绑一堆 null。
     *   ⚠️ 判据用**静态容器** `#todayJudge`，不能用 #judgeDecision（那是 renderJudge 动态生成的，
     *      通话页在 init 之前它也不存在，会把自己也拦掉）。 */
    if (!document.getElementById("todayJudge")) return;
    if (window.Blocks && window.Clock) {
      init();
    } else {
      setTimeout(() => { if (window.Blocks) init(); }, 300);
    }
  });
})();

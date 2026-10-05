/* =====================================================================
 *  violation.js —— 违规记录模块（v1.34.0 · 完全独立，用户 2026.10.05 指定）
 *  ---------------------------------------------------------------------
 *  · 以【自然日】人工判定违规：登记 = 记录判定日期+时间，违规内容可选填
 *  · 惩罚：违规当日 + 次日不得进行下列三类内容；一日多次违规或违规期内
 *    再犯，一次违规 +1 日惩罚；违规日晚于当前惩罚期末 → 新一轮（当日+次日）
 *      ① 奖励行为：外出吃大餐 / 喝奶茶 / 长时间听音乐
 *      ② 娱乐活动：外出聚餐 / 打游戏（所有）/ 观看长视频
 *      ③ 通话
 *  · 惩罚期间 → 首页最底震撼闪卡 + 任务页独立卡（页面内布局推挤，不发系统通知）
 *  · 完全独立：不与通话边界/任务/计时/统计联动（不写 tasks/time_records/active_timer）
 *  · 多端轻量同步：events 表行 { id: "viol-<时间戳ms>", date, title: "violation", note, time }
 *  · v1.34.0 新增：禁项文案单一来源渲染、登记快捷标签、本月统计、记录可改日期/时刻/内容
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const EV_PREFIX = "viol-";

  /* ★ v1.34.0 惩罚期禁止内容（唯一事实源）：三类并列，渲染进 HTML 容器，
   *   避免「闪卡 / 任务页卡片 / JS 常量」三处各写一份导致不同步（旧版即此问题）。 */
  const RULES = [
    { name: "奖励行为", items: ["外出吃大餐", "喝奶茶", "长时间听音乐"] },
    { name: "娱乐活动", items: ["外出聚餐", "打游戏（所有）", "观看长视频"] },
    { name: "通话",     items: ["通话"] }
  ];
  /* 派生值：保留旧 API 名 FORBIDDEN（对外只读；不再手写，避免与 RULES 分叉） */
  const FORBIDDEN = RULES.reduce((a, r) => a.concat(r.items), []);
  /* 类别名串联：「奖励行为 · 娱乐活动 · 通话」 */
  const RULE_NAMES = RULES.map(r => r.name).join(" · ");
  /* 登记/编辑用的快捷标签（第四项「其他」= 不加类别前缀，等同纯自由文本） */
  const TAGS = ["奖励行为", "娱乐活动", "通话", "其他"];

  let addTag = "";        // 登记行当前选中的快捷标签
  let editTag = "";       // 编辑弹窗当前选中的快捷标签
  let editingId = null;   // 编辑弹窗正在编辑的行 id

  function bjNow() {
    return window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
  }
  function dateKey(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function plusDays(k, n) {
    const d = new Date(k + "T00:00:00");
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }
  function todayKey() { return dateKey(bjNow()); }
  function monthKey() {
    const d = bjNow();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  /* ★ v1.34.0 两处修正：
   *   ① 补回 time（旧版映射丢掉了 time → 列表永不显示时刻、编辑拿不到原值）；
   *   ② 排序改按 date（旧版按 id 时间戳 → 事后补登过去日期会被排在末尾，
   *      被误判成「惩罚期内再犯」，把期末往后顶；按日期排序才是正确结算顺序）。 */
  function violations() {
    return (Store.getEvents() || [])
      .filter(e => e && e.id && String(e.id).startsWith(EV_PREFIX))
      .map(e => ({
        id: e.id,
        date: e.date || "",
        time: e.time || "",
        note: e.note || "",
        ts: Number(String(e.id).slice(EV_PREFIX.length)) || 0
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.ts - b.ts));
  }

  /* 惩罚算法（v1.32.0，v1.34.0 未改行为）：按登记顺序（现按日期）逐条结算——
   *  首条/晚于当前期末的条目 = 新一轮（当日+次日，即期末 = 违规日+1）；
   *  同日多次或违规期内再犯 = 期末 +1 日。 */
  function penaltyIntervals() {
    const out = [];
    let start = null, end = null;
    for (const v of violations()) {
      if (!v.date) continue;
      if (end === null || v.date > end) {
        if (start !== null) out.push([start, end]);
        start = v.date;
        end = plusDays(v.date, 1);          // 新一轮：当日 + 次日
      } else {
        end = plusDays(end, 1);             // 同日/期内再犯：+1 日
      }
    }
    if (start !== null) out.push([start, end]);
    return out;
  }
  /* 返回惩罚期末的日期 key（无违规 → null）——行为与 v1.32.0 完全一致 */
  function penaltyEndKey() {
    const iv = penaltyIntervals();
    return iv.length ? iv[iv.length - 1][1] : null;
  }
  /* 当前是否处于违规惩罚期：今日 ≤ 惩罚期末 */
  function inPenalty() {
    const end = penaltyEndKey();
    return !!end && todayKey() <= end;
  }
  /* 剩余惩罚天数（含今天） */
  function remainDays() {
    const end = penaltyEndKey();
    if (!end) return 0;
    const t = new Date(todayKey() + "T00:00:00"), e = new Date(end + "T00:00:00");
    return Math.max(0, Math.round((e - t) / 86400000) + 1);
  }
  /* ★ v1.34.0 本月统计：
   *   条数 = 判定日期落在本月的违规条数；
   *   累计惩罚天数 = 各惩罚区间与「本月月初~月末」的日历交集天数之和（含端点）。
   *   口径说明：惩罚期可跨月，只计落在本月的那些天（10-31 违规 → 10 月计 1 天、11 月计 1 天）。 */
  function monthlyStats() {
    const mk = monthKey();
    const first = mk + "-01";
    const last = dateKey(new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0)); // 下月 0 日 = 本月末
    const count = violations().filter(v => String(v.date).slice(0, 7) === mk).length;
    let days = 0;
    for (const [s, e] of penaltyIntervals()) {
      const lo = s > first ? s : first;
      const hi = e < last ? e : last;
      if (lo <= hi) days += Math.round((new Date(hi + "T00:00:00") - new Date(lo + "T00:00:00")) / 86400000) + 1;
    }
    return { month: mk, count, penaltyDays: days };
  }

  /* 标签 + 自由文本 → 单字段 note（"奖励行为：吃了火锅"；无标签则纯文本） */
  function composeNote(tag, text) {
    const t = (text || "").trim();
    const g = tag && tag !== "其他" ? tag : "";
    if (!g) return t;
    return t ? g + "：" + t : g;
  }
  /* 反向拆解（编辑回填）：note 以某类名 + "：" 开头 → 该类 + 剩余文本 */
  function splitNote(note) {
    const s = String(note || "");
    for (const t of TAGS) {
      if (t !== "其他" && s.indexOf(t + "：") === 0) return { tag: t, text: s.slice(t.length + 1) };
    }
    return { tag: "", text: s };
  }

  /* 登记：判定时刻 = 现在（opts 可指定 date/time，供补登/回填）；内容可选填 */
  function register(note, opts) {
    const d = bjNow();
    const p = (n) => String(n).padStart(2, "0");
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    const id = EV_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    events.push({
      id, user_id: C.USER_ID,
      date: (opts && opts.date) || todayKey(),
      title: "violation",
      note: (note || "").trim(),
      time: (opts && opts.time) || `${p(d.getHours())}:${p(d.getMinutes())}`
    });
    Store.setEvents(events);
    return id;
  }
  /* 删除（误登记兜底）：显式推删云端行 */
  function remove(id) {
    if (!String(id || "").startsWith(EV_PREFIX)) return false;
    Store.deleteEventRow(id);
    return true;
  }
  /* ★ v1.34.0 修改已登记记录（日期 / 时刻 / 内容）：现读全表 → 只改该 id → 整表回写。
   *   events 走 upsert（按 id），只增改不删除 → 不会抹掉其他设备新增的行；
   *   唯一风险是两端同时改同一行（后写覆盖，可接受）。改完 render() 即重算惩罚期。 */
  function update(id, patch) {
    if (!String(id || "").startsWith(EV_PREFIX)) return false;
    const arr = (Store.getEvents() || []).filter(e => e && e.id);
    const i = arr.findIndex(e => e.id === id);
    if (i < 0) return false;
    const next = { ...arr[i] };
    if (patch && patch.date) next.date = patch.date;
    if (patch && patch.time !== undefined) next.time = String(patch.time || "");
    if (patch && patch.note !== undefined) next.note = String(patch.note || "").trim();
    arr[i] = next;
    Store.setEvents(arr);
    return true;
  }

  function alertMsg(msg) {
    if (window.UI && window.UI.showAlert) window.UI.showAlert(msg, 2200);
  }

  /* 日期 key → 中文短格式（2026-10-07 → 10月7日） */
  function fmtCn(k) {
    const parts = String(k || "").split("-");
    return `${Number(parts[1])}月${Number(parts[2])}日`;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* —— 禁项文案单一来源渲染（任务页摘要 + 首页闪卡 + 本月统计）—— */
  function renderRules() {
    const sum = document.getElementById("violationSummary");
    if (sum) sum.textContent = `当日+次日不得「${RULE_NAMES}」· 再犯 +1 日`;
    const rule = document.getElementById("violationBannerRule");
    if (rule) {
      /* 单条类目（如「通话」）只渲染类目名，避免出现「通话：通话」的赘述 */
      rule.innerHTML = RULES.map((r, i) => {
        const body = (r.items.length === 1 && r.items[0] === r.name)
          ? escapeHtml(r.name)
          : `${escapeHtml(r.name)}：${r.items.map(escapeHtml).join(" / ")}`;
        return `<span class="vb-rule-line"><em>${i + 1}</em>${body}</span>`;
      }).join("");
    }
    const st = monthlyStats();
    const c = document.getElementById("violMonthCount");
    if (c) c.textContent = String(st.count);
    const d = document.getElementById("violPenaltyDays");
    if (d) d.textContent = String(st.penaltyDays);
  }

  /* —— 快捷标签芯片（登记行；只切选中态，不写数据）—— */
  function tagChipsHtml(active) {
    return TAGS.map(t =>
      `<button type="button" class="viol-tag${t === active ? " active" : ""}" data-viol-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    ).join("");
  }
  function renderTags() {
    const box = document.getElementById("violationTags");
    if (box) box.innerHTML = tagChipsHtml(addTag);
    const ebox = document.getElementById("violEditTags");
    if (ebox) ebox.innerHTML = tagChipsHtml(editTag);
  }

  function render() {
    renderRules();
    renderTags();
    const penal = inPenalty();
    const end = penaltyEndKey();
    // 震撼横幅（违规中才显示；页面内布局推挤，不发系统通知）
    const banner = document.getElementById("violationBanner");
    if (banner) {
      banner.style.display = penal ? "" : "none";
      if (penal) {
        const range = document.getElementById("violationBannerRange");
        if (range) range.textContent = `人工判定违规 · 自动累计（再犯 +1 日/次）`;
        const endEl = document.getElementById("violationBannerEnd");
        if (endEl) endEl.textContent = fmtCn(end);
        const leftEl = document.getElementById("violationBannerLeft");
        if (leftEl) leftEl.textContent = `剩 ${remainDays()} 天`;
        if (window.Icon) window.Icon.inject(banner);
      }
    }
    // 底部独立卡
    const card = document.getElementById("violationCard");
    if (card) card.classList.toggle("penal", penal);
    const st = document.getElementById("violationState");
    if (st) {
      st.textContent = penal ? `违规中 · 剩 ${remainDays()} 天` : "正常";
      st.className = "ck-state " + (penal ? "bad" : "ok");
    }
    // 记录列表（最近在前）
    const list = document.getElementById("violationList");
    if (list) {
      const vs = violations().slice().reverse();
      list.innerHTML = vs.length ? vs.map(v => `
        <div class="viol-row">
          <span class="viol-dot"></span>
          <span class="viol-main"><b>${fmtCn(v.date)}${v.time ? " " + v.time : ""}</b>${v.note ? `<i>${escapeHtml(v.note)}</i>` : ""}</span>
          <button type="button" class="viol-edit" data-viol-edit="${v.id}">修改</button>
          <button type="button" class="viol-del" data-viol-del="${v.id}">删除</button>
        </div>`).join("") : '<div class="viol-empty">暂无违规记录</div>';
    }
  }

  /* —— 修改记录弹窗（模块自建 DOM，单一来源；懒加载）——
   *   为什么不做事内编辑：render() 会被 subscribeEvents + 60s 定时器反复重建
   *   #violationList，行内输入会被重渲染打断。弹窗在列表之外，不被 render 触碰。 */
  function ensureEditDom() {
    if (document.getElementById("violEditModal")) return;
    const wrap = document.createElement("div");
    wrap.id = "violEditWrap";
    wrap.innerHTML = `
      <div class="choice-mask" id="violEditMask"></div>
      <div class="choice-modal" id="violEditModal" role="dialog" aria-modal="true">
        <div class="cm-head">
          <div class="cm-title">修改违规记录</div>
          <button type="button" class="cm-close" id="violEditClose" aria-label="关闭">×</button>
        </div>
        <div class="viol-edit-sec"><label>判定日期</label><input type="date" id="violEditDate" /></div>
        <div class="viol-edit-sec"><label>判定时刻</label><input type="time" id="violEditTime" /></div>
        <div class="viol-edit-sec"><label>违规内容（可选填）</label>
          <div class="viol-tags" id="violEditTags"></div>
          <input type="text" id="violEditNote" maxlength="200" placeholder="补充说明（可选）" />
        </div>
        <div class="viol-edit-actions">
          <button type="button" class="btn ghost block" id="violEditCancel">取消</button>
          <button type="button" class="btn primary block" id="violEditSave">保存修改</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    document.getElementById("violEditMask").addEventListener("click", closeEdit);
    document.getElementById("violEditClose").addEventListener("click", closeEdit);
    document.getElementById("violEditCancel").addEventListener("click", closeEdit);
    document.getElementById("violEditTags").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-viol-tag]");
      if (!chip) return;
      const t = chip.dataset.violTag;
      editTag = editTag === t ? "" : t;
      renderTags();
    });
    document.getElementById("violEditSave").addEventListener("click", saveEdit);
  }
  function openEdit(id) {
    const v = violations().find(x => x.id === id);
    if (!v) return;
    ensureEditDom();
    editingId = id;
    const sp = splitNote(v.note);
    editTag = sp.tag;
    const dEl = document.getElementById("violEditDate");
    const tEl = document.getElementById("violEditTime");
    const nEl = document.getElementById("violEditNote");
    if (dEl) dEl.value = v.date || todayKey();
    if (tEl) tEl.value = v.time || "";
    if (nEl) nEl.value = sp.text || "";
    renderTags();
    document.getElementById("violEditMask").classList.add("show");
    document.getElementById("violEditModal").classList.add("show");
  }
  function closeEdit() {
    const m = document.getElementById("violEditMask"), d = document.getElementById("violEditModal");
    if (m) m.classList.remove("show");
    if (d) d.classList.remove("show");
    editingId = null;
  }
  function saveEdit() {
    if (!editingId) return;
    const dEl = document.getElementById("violEditDate");
    const tEl = document.getElementById("violEditTime");
    const nEl = document.getElementById("violEditNote");
    const date = dEl ? dEl.value : "";
    if (!date) { alertMsg("请填写判定日期"); return; }
    const note = composeNote(editTag, nEl ? nEl.value : "");
    const okUp = update(editingId, { date, time: tEl ? tEl.value : "", note });
    closeEdit();
    render();
    alertMsg(okUp ? "✅ 已保存修改（惩罚期已重算）" : "修改失败：记录不存在");
  }

  function bind() {
    const btn = document.getElementById("violationAddBtn");
    const noteEl = document.getElementById("violationNote");
    if (btn) btn.addEventListener("click", () => {
      const text = noteEl ? noteEl.value : "";
      register(composeNote(addTag, text));
      if (noteEl) noteEl.value = "";
      addTag = "";
      render();
      alertMsg("⛔ 已登记违规（惩罚期自动计算）");
    });
    // 快捷标签（登记行）：只切选中态
    const tags = document.getElementById("violationTags");
    if (tags) tags.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-viol-tag]");
      if (!chip) return;
      const t = chip.dataset.violTag;
      addTag = addTag === t ? "" : t;
      renderTags();
    });
    // 列表：修改 / 删除 一次委托（替代逐次绑定）
    const list = document.getElementById("violationList");
    if (list) list.addEventListener("click", (e) => {
      const del = e.target.closest("[data-viol-del]");
      if (del) {
        if (remove(del.dataset.violDel)) { render(); alertMsg("已删除该条违规记录"); }
        return;
      }
      const ed = e.target.closest("[data-viol-edit]");
      if (ed) openEdit(ed.dataset.violEdit);
    });
    // 其他设备登记/删除 → events 同步落地 → 本页即时跟随
    if (Store.subscribeEvents) Store.subscribeEvents(() => render());
    setInterval(render, 60000);
  }

  function init() { bind(); render(); }

  window.VIOLATION = { init, render, bind, violations, penaltyIntervals, penaltyEndKey, inPenalty, remainDays, monthlyStats, register, remove, update, openEdit, closeEdit, saveEdit, RULES, RULE_NAMES, FORBIDDEN, TAGS, composeNote, splitNote };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

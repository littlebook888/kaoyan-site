/* =====================================================================
 *  rec-edit.js —— 时间记录编辑抽屉（全站唯一实现，v1.22.9）
 *  ---------------------------------------------------------------
 *  为什么抽出来：这个抽屉原来长在 home.js 里、DOM 写死在 index.html 里，
 *  于是**只有首页的「今日活动构成」能改记录**——而首页只列今天的记录，
 *  往日记录（复盘页能看到、但点不了）就成了改不了的历史。
 *  现在：抽屉连带 DOM 一起搬到这里，任何页面只要引入本文件即可
 *      window.RecEdit.open(recId, { onViewInClock })   // 改一条已有记录
 *      window.RecEdit.openForRange(sSec, eSec, opts)   // 在某段空白里补记一条
 *      window.RecEdit.bind()                            // 绑定事件（幂等，页面 init 调一次）
 *  使用页面：index.html（今日列表/时间轴点击）、stats.html（每日复盘记录行点击）
 *  数据走 Store.updateTimeRecord / deleteTimeRecord（含三端同步）
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;

  /* ---------- 抽屉 DOM：由本模块自建 ----------
   * 单一份来源：页面 HTML 里不再写这段标记（两处维护必然漂移）。 */
  const DRAWER_HTML = `
  <div class="tag-drawer-mask" id="recEditMask"></div>
  <div class="tag-drawer" id="recEditDrawer">
    <div class="td-handle"></div>
    <div class="td-header">
      <div class="td-title">
        <span class="td-time" id="reDurLabel">00:00</span>
        <span class="td-cat-badge" id="reCatBadge">无分类</span>
      </div>
      <button class="td-close" id="reCloseBtn">×</button>
    </div>
    <div class="td-section">
      <div class="td-sec-title">开始时间</div>
      <div class="re-time-row"><input type="datetime-local" id="reStart" /></div>
    </div>
    <div class="td-section">
      <div class="td-sec-title">结束时间 <small style="color:#9ca3af">（时长随时间自动重算）</small></div>
      <div class="re-time-row"><input type="datetime-local" id="reEnd" /></div>
      <div class="re-hint" id="reTimeHint"></div>
    </div>
    <div class="td-section">
      <div class="td-sec-title">选择分类</div>
      <div class="td-cat-grid" id="reCatGrid"></div>
    </div>
    <div class="td-section" id="reSubCatSection" style="display:none">
      <div class="td-sec-title">细分</div>
      <div class="td-sub-cats" id="reSubCats"></div>
    </div>
    <div class="td-section">
      <div class="td-sec-title">标签</div>
      <div class="td-tags" id="reTags"></div>
      <div class="tag-input-row">
        <input type="text" id="reTagInput" placeholder="自定义标签，回车添加" maxlength="20" />
      </div>
    </div>
    <div class="td-section">
      <div class="td-sec-title">备注</div>
      <textarea class="td-note" id="reNote" rows="2" maxlength="5000" placeholder="备注…"></textarea>
    </div>
    <div class="td-actions">
      <button class="btn ghost block" id="reViewClockBtn">在时钟中查看</button>
      <button class="btn danger block" id="reDeleteBtn">删除此记录</button>
      <button class="btn primary block" id="reSaveBtn">保存修改</button>
    </div>`;

  function q(id) { return document.getElementById(id); }
  function ensureDom() {
    if (q("recEditDrawer")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = DRAWER_HTML;
    while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);
  }

  /* ---------- 分类元数据：一级 key 或二级 key → 分类对象（二级带 parent） ---------- */
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

  /* 时间戳 → datetime-local 字符串（本地时区） */
  function toLocalDT(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let recId = null;
  let isCreate = false;      // true = 补记模式（创建新记录，预填时段）
  let tags = [];
  let category = "";         // 一级或二级 key（二级在保存时换算为 category+sub_category）
  let lastUsedCategory = "study"; // 补记时的默认分类（记住上一次的选择）
  let bound = false;
  let hooks = {};            // { onViewInClock }（页面能力不同的部分由调用方注入）

  /* ---------- 打开：编辑一条已有记录 ---------- */
  function open(id, opts) {
    // 用原始记录（getTodayRecords 是裁剪副本，跨天记录的真实起止在原表里）
    const raw = (Store.getTimeRecords() || []).find(r => r.id === id);
    if (!raw) return false;
    ensureDom(); bind();
    hooks = opts || {};
    recId = id;
    isCreate = false;
    tags = Array.isArray(raw.tags) ? [...raw.tags] : [];
    category = raw.sub_category || raw.category || "study";
    lastUsedCategory = category;

    q("reStart").value = toLocalDT(new Date(raw.started_at).getTime());
    q("reEnd").value = toLocalDT(new Date(raw.ended_at || Date.now()).getTime());
    q("reNote").value = raw.note || "";
    q("reTimeHint").style.display = "none";
    q("reDeleteBtn").style.display = "";
    // 「在时钟中查看」只有首页能提供（那里才有时钟视图）→ 别的页面直接隐藏
    q("reViewClockBtn").style.display = hooks.onViewInClock ? "" : "none";
    renderCat();
    renderTags();
    updateDur();
    q("recEditMask").classList.add("show");
    q("recEditDrawer").classList.add("show");
    if (window.Icon) window.Icon.inject(q("recEditDrawer"));
    return true;
  }

  /* ---------- 打开：按一段「未记录」的时间窗补记（起点=选择的分类） ----------
   * 参数为当日秒数（0..86400，列表 gap 行 data-s/data-e），换算成今天对应时刻 */
  function openForRange(sSec, eSec, opts) {
    const mkToday = (sec) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setTime(d.getTime() + sec * 1000);
      return d.getTime();
    };
    ensureDom(); bind();
    hooks = opts || {};
    recId = null;
    isCreate = true;
    tags = [];
    category = lastUsedCategory || "study";
    q("reStart").value = toLocalDT(mkToday(sSec));
    q("reEnd").value = toLocalDT(mkToday(eSec));
    q("reNote").value = "";
    q("reTimeHint").style.display = "none";
    q("reDeleteBtn").style.display = "none";     // 新记录没有可删对象
    q("reViewClockBtn").style.display = "none";  // 保存后才能在时钟中查看
    renderCat();
    renderTags();
    updateDur();
    q("recEditMask").classList.add("show");
    q("recEditDrawer").classList.add("show");
    if (window.Icon) window.Icon.inject(q("recEditDrawer"));
    return true;
  }

  function close() {
    ensureDom();
    q("recEditMask").classList.remove("show");
    q("recEditDrawer").classList.remove("show");
    recId = null;
    isCreate = false;
  }
  function isOpen() {
    const d = q("recEditDrawer");
    return !!(d && d.classList.contains("show"));
  }

  /* 分段合计秒数（暂停/跨天记录的真实专注量） */
  function segSumSec(segs) {
    if (!Array.isArray(segs) || !segs.length) return null;
    let sec = 0;
    for (const sg of segs) {
      if (!sg) continue;
      const a = new Date(sg.start).getTime();
      const b = sg.end == null ? Date.now() : new Date(sg.end).getTime();
      if (isFinite(a) && isFinite(b) && b > a) sec += (b - a) / 1000;
    }
    return Math.round(sec);
  }

  function updateDur() {
    const s = new Date(q("reStart").value).getTime();
    const e = new Date(q("reEnd").value).getTime();
    const durEl = q("reDurLabel");
    if (!durEl) return;
    if (!(isFinite(s) && isFinite(e) && e > s)) { durEl.textContent = "--"; return; }
    const spanSec = Math.round((e - s) / 1000);
    /* v1.22.9：跨天/带分段的记录，起止跨度 ≠ 真实专注量（暂停不算）。
     * 时间没动过时按分段合计显示，免得出现"5 天的记录显示 120 小时"这种误导。
     * ⚠️ 输入框是分钟精度（秒被截掉），所以用 60 秒容差比较，不能用严格相等。 */
    const raw = recId ? (Store.getTimeRecords() || []).find(r => r.id === recId) : null;
    const unchanged = raw &&
      Math.abs(new Date(raw.started_at).getTime() - s) < 60000 &&
      Math.abs(new Date(raw.ended_at || 0).getTime() - e) < 60000;
    const segSec = raw ? segSumSec(raw.segments) : null;
    const fmt = window.UI ? window.UI.fmtDur : (x) => Math.round(x) + "秒";
    durEl.textContent = (unchanged && segSec != null && Math.abs(spanSec - segSec) > 60)
      ? fmt(segSec) + "（按分段合计）"
      : fmt(spanSec);
  }

  function renderCat() {
    const cats = C.TIME_CATEGORIES || [];
    const grid = q("reCatGrid");
    const meta = getCategoryMeta(category);
    const activeParent = meta && meta.parent ? meta.parent : category;
    grid.innerHTML = cats.map(c => `
      <button type="button" class="td-cat-chip ${c.key === activeParent ? "active" : ""}" data-cat="${c.key}">
        <span class="chip-dot" style="color:${c.color}"></span>${c.label}
      </button>`).join("");
    grid.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => {
      category = b.dataset.cat;
      renderCat();
    }));
    // 二级
    const sec = q("reSubCatSection");
    const box = q("reSubCats");
    const parent = cats.find(c => c.key === activeParent);
    const subs = parent && parent.subs ? parent.subs : [];
    if (!subs.length) { sec.style.display = "none"; }
    else {
      sec.style.display = "block";
      box.innerHTML = subs.map(s => `
        <button type="button" class="td-sub-cat ${s.key === category ? "active" : ""}" data-sub="${s.key}">${s.label}</button>`).join("");
      box.querySelectorAll("[data-sub]").forEach(b => b.addEventListener("click", () => {
        category = b.dataset.sub;
        renderCat();
      }));
    }
    const badge = q("reCatBadge");
    const m = getCategoryMeta(category);
    if (m) {
      badge.textContent = m.label;
      badge.style.background = m.color + "20";
      badge.style.color = m.color;
    }
  }

  function renderTags() {
    const box = q("reTags");
    const common = C.COMMON_TAGS || [];
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    box.innerHTML = common.map(t => `
      <button type="button" class="td-tag ${tags.includes(t) ? "active" : ""}" data-tag="${t}">${t}</button>`).join("")
      + tags.filter(t => !common.includes(t)).map(t => `
      <button type="button" class="td-tag active" data-tag="${esc(t)}">${esc(t)} ✕</button>`).join("");
    box.querySelectorAll("[data-tag]").forEach(b => b.addEventListener("click", () => {
      const t = b.dataset.tag;
      tags = tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t];
      renderTags();
    }));
  }

  function save() {
    if (!recId && !isCreate) return;
    const hint = q("reTimeHint");
    const s = new Date(q("reStart").value).getTime();
    const e = new Date(q("reEnd").value).getTime();
    if (!isFinite(s) || !isFinite(e)) {
      hint.textContent = "时间格式无效，请重新选择"; hint.style.display = "block"; return;
    }
    if (e <= s) {
      hint.textContent = "结束时间必须晚于开始时间"; hint.style.display = "block"; return;
    }

    // —— 补记模式：创建一条新记录 ——
    if (!recId) {
      const m = getCategoryMeta(category);
      let finalCat = category, finalSub = "";
      if (m && m.parent) { finalSub = category; finalCat = m.parent; }
      lastUsedCategory = category;
      Store.addTimeRecord({
        id: "manual_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        user_id: C.USER_ID,
        category: finalCat,
        sub_category: finalSub,
        label: m ? m.label : "补记",
        tags: [...tags],
        note: q("reNote").value,
        started_at: new Date(s).toISOString(),
        ended_at: new Date(e).toISOString(),
        duration_sec: Math.round((e - s) / 1000),
        source: "manual_backfill",
        block: window.Blocks ? window.Blocks.blockOf(new Date(s)) : "",
        segments: null,
        created_at: new Date().toISOString()
      });
      close();
      if (window.UI && window.UI.showAlert) window.UI.showAlert("✅ 已补记这段时间（三端同步）", 2200);
      return;
    }

    // —— 编辑模式 ——
    const raw = (Store.getTimeRecords() || []).find(r => r.id === recId);
    if (!raw) { close(); return; }
    // 分类换算：二级 key → category(一级) + sub_category(二级)。只改时间/标签时不动 label
    let finalCat = category, finalSub = "";
    const m = getCategoryMeta(category);
    if (m && m.parent) { finalSub = category; finalCat = m.parent; }
    const catChanged = finalCat !== raw.category || finalSub !== (raw.sub_category || "");
    const timeChanged = Math.abs(new Date(raw.started_at).getTime() - s) > 60000 ||
      Math.abs(new Date(raw.ended_at || 0).getTime() - e) > 60000;
    const patch = {
      category: finalCat,
      sub_category: finalSub,
      tags: [...tags],
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
    /* ★ 时间没动 + 记录带分段（暂停/跨天）→ 不要用"起止跨度"覆盖 duration_sec：
     *   否则 5 天前暂停、只专注 30 分钟的记录会被写成 120 小时。分段口径下展示仍按分段，
     *   但 duration_sec 是 CSV/旧接口的取数来源，污染了很麻烦。 */
    if (!timeChanged && raw.segments && raw.segments.length) delete patch.duration_sec;
    Store.updateTimeRecord(recId, patch);
    const savedId = recId;
    close();
    if (window.UI && window.UI.showAlert) window.UI.showAlert("✅ 记录已更新（三端同步）", 2000);
    if (typeof hooks.onSaved === "function") { try { hooks.onSaved(savedId); } catch (err) {} }
  }

  function del() {
    if (!recId) return;
    if (!confirm("确定删除这条时间记录？删除后三端同步，不可恢复。")) return;
    const goneId = recId;
    Store.deleteTimeRecord(recId);
    close();
    if (window.UI && window.UI.showAlert) window.UI.showAlert("🗑 记录已删除（三端同步）", 2000);
    if (typeof hooks.onDeleted === "function") { try { hooks.onDeleted(goneId); } catch (err) {} }
  }

  /* ---------- 事件绑定（幂等；页面 init 调用一次即可） ---------- */
  function bind() {
    ensureDom();
    if (bound) return;
    bound = true;
    q("recEditMask").addEventListener("click", close);
    q("reCloseBtn").addEventListener("click", close);
    q("reSaveBtn").addEventListener("click", save);
    q("reDeleteBtn").addEventListener("click", del);
    const viewClockBtn = q("reViewClockBtn");
    if (viewClockBtn) viewClockBtn.addEventListener("click", () => {
      const id = recId;
      if (!id) return;
      if (typeof hooks.onViewInClock === "function") {
        close();
        try { hooks.onViewInClock(id); } catch (err) {}
      }
    });
    q("reStart").addEventListener("input", updateDur);
    q("reEnd").addEventListener("input", updateDur);
    const tagInput = q("reTagInput");
    if (tagInput) tagInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val && !tags.includes(val)) { tags = [...tags, val]; renderTags(); }
      tagInput.value = "";
    });
  }

  window.RecEdit = { open, openForRange, close, bind, isOpen, getCategoryMeta };
})();

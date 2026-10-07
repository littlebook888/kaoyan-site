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
      <div class="re-time-row"><input type="datetime-local" id="reStart" step="1" /></div>
      <!-- ★ v1.36.0 上尾衔接：把开始时间直接顶到「上一条记录的结束时刻」，时长不变 → 无缝衔接、不产生重叠 -->
      <div class="re-time-row-btn" style="margin-top:8px">
        <button type="button" class="btn small ghost" id="reTailBtn" title="把开始时间顶到上一条记录的结束时刻（时长保持不变）">接上一条的尾巴</button>
        <span class="re-tail-hint" id="reTailHint" style="font-size:12px;color:var(--ink-3)"></span>
      </div>
    </div>
    <div class="td-section">
      <div class="td-sec-title">结束时间 <small style="color:#9ca3af">（时长随时间自动重算）</small></div>
      <div class="re-time-row"><input type="datetime-local" id="reEnd" step="1" /></div>
      <div class="re-hint" id="reTimeHint"></div>
      <div id="reTrimWarn"></div>
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
  /* HTML 转义（模块级，供预告区复用） */
  const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
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

  /* 时间戳 → datetime-local 字符串（本地时区）
   * ★ v1.29.8 带上秒：计时落盘的时间带秒（如 11:14:18.861），输入框只有分钟精度时
   *   ① 亚分钟时段显示成同一分钟（30 秒的空隙两端都显示 05:23，校验还报"结束必须晚于开始"）；
   *   ② 补记起点只能落在整分（11:14:00），与相邻计时记录（11:14:18 结束）产生看不见的重叠。 */
  function toLocalDT(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
   * ⚠️ 基准陷阱（2026-10-07 定位并根治）：
   *   本函数把 sSec/eSec 当作「**本地零点 00:00** 起算的秒数」，
   *   而首页列表（home.js → buildLoveTimeSlots）确实传这种秒数；
   *   但每日复盘（day-review.js → buildWindowSlots）传的是
   *   「**业务日 04:00** 起算的秒数」（Blocks.bizDayWindow）。
   *   两者相差 4 小时（14400s），直接沿用会让补记抽屉整体错位 4 小时，
   *   并连带触发假的「与已有记录重叠」提示（补记 13:47–17:44 → 实际压到已有段）。
   *   对策：调用方必须用 opts.base 声明自己传的是哪种基准，这里据此换算，
   *        绝不靠猜。opts.base = "midnight"（默认，本地零点起算）| "bizday"（业务日 04:00 起算）。
   *   另提供 opts.startMs：直接给绝对毫秒（如复盘页已有 win.startMs），优先级最高、零歧义。 */
  function openForRange(sSec, eSec, opts) {
    hooks = opts || {};
    let sMs, eMs;
    if (isFinite(hooks.startMs) && isFinite(hooks.endMs)) {
      // ① 调用方给了绝对毫秒 → 直接用（最可靠）
      sMs = Number(hooks.startMs);
      eMs = Number(hooks.endMs);
    } else {
      // ② 按声明的基准换算成本地零点的毫秒
      const mkLocalMidnight = (sec) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime() + sec * 1000;
      };
      let offSec = 0;
      if (hooks.base === "bizday") {
        // 业务日 04:00 起算 → 换成"距本地零点"的秒数（Blocks.BIZ_START_HOUR = 4）
        offSec = 4 * 3600;
      }
      sMs = mkLocalMidnight(Number(sSec) + offSec);
      eMs = mkLocalMidnight(Number(eSec) + offSec);
    }
    if (!(isFinite(sMs) && isFinite(eMs) && eMs > sMs)) return false;

    ensureDom(); bind();
    recId = null;
    isCreate = true;
    tags = [];
    category = lastUsedCategory || "study";
    q("reStart").value = toLocalDT(sMs);
    q("reEnd").value = toLocalDT(eMs);
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

  /* ★ v1.35.0 重叠预告（用户 2026-10-06 要求：保存前就告知会裁掉哪条）。
   * 取数层已改为「后开始者覆盖前一条的重叠段」，所以补记一段时间时，
   * 它可能挤掉已有记录的**头部**。这里实时模拟一遍，把结果告诉用户：
   *   「与【副业】重叠 6 分，保存后【副业】将改为 11:53:37–13:53:49（缩短 6 分）」。
   * 不阻塞保存——用户可能本来就想改，只是需要知情。 */
  function renderTrimWarn() {
    const box = q("reTrimWarn");
    if (!box) return;
    const s = new Date(q("reStart").value).getTime();
    const e = new Date(q("reEnd").value).getTime();
    if (!(isFinite(s) && isFinite(e) && e > s)) { box.innerHTML = ""; return; }

    const all = (Store.getTimeRecords() || []).filter(r => r && r.id && r.id !== recId
      && r.source !== "call_manual");
    const EPS = 1000;
    const hhmm = (ms) => {
      const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + (d.getSeconds() ? ":" + p(d.getSeconds()) : "");
    };
    /* 已有记录按开始时间排序，逐条扣掉被「更晚开始的记录」盖住的前缀（与取数层同规则） */
    const mine = { sMs: s, eMs: e };
    const allSorted = all.map(r => {
      const rs = new Date(r.started_at).getTime();
      const re = r.ended_at ? new Date(r.ended_at).getTime() : Date.now();
      return { r, sMs: rs, eMs: re };
    }).filter(x => isFinite(x.sMs) && x.eMs > x.sMs);
    allSorted.push({ r: { id: "__new__", label: "" }, sMs: mine.sMs, eMs: mine.eMs });
    allSorted.sort((a, b) => a.sMs - b.sMs);

    let coveredTo = -Infinity;
    const affected = [];
    for (const c of allSorted) {
      const effS = Math.max(c.sMs, coveredTo);
      const isNew = c.r.id === "__new__";
      if (isNew) {
        /* 本条会盖掉已有记录的哪些头部 */
        for (const o of allSorted) {
          if (o === c || o.sMs <= effS) continue;
          if (o.eMs > effS) {
            const cut = Math.min(o.eMs, c.eMs) - Math.max(o.sMs, effS);
            if (cut > EPS) affected.push({ o, cutSec: Math.round(cut / 1000) });
          }
        }
      } else if (c.eMs - effS > EPS) {
        coveredTo = Math.max(coveredTo, c.eMs);
      } else {
        coveredTo = Math.max(coveredTo, c.eMs);
      }
    }
    if (!affected.length) { box.innerHTML = ""; return; }
    const myCut = Math.max(0, Math.round((e - Math.max(s, firstEndBefore(allSorted, s))) / 1000));
    box.innerHTML = '<div style="margin-top:10px;padding:10px 12px;border-radius:10px;'
      + 'background:#fff8ed;border:1px solid #f0d9b5;font-size:12.5px;line-height:1.65;color:#8a6a3f">'
      + '<b>⚠ 与已有记录重叠，保存后会自动裁剪</b><br>'
      + affected.map(a => {
        const nm = escHtml((a.o.r && (a.o.r.label || a.o.r.category)) || "未命名记录");
        const mins = Math.round(a.cutSec / 60);
        return `· 与【${nm}】重叠 <b>${mins} 分</b>，保存后【${nm}】将缩短为 ${hhmm(Math.max(a.o.sMs, s))}–${hhmm(a.o.eMs)}`;
      }).join("<br>")
      + (myCut > 60 ? `<br>· 本条有 <b>${Math.round(myCut / 60)} 分</b> 落在已有记录之后，会完整保留` : "")
      + '<br><span style="color:#b08a5e">规则：重叠部分归「更晚开始」的那条，不重叠的部分一分不少地保留。</span>'
      + "</div>";
  }
  /* 我的起点之前、已有记录占用的最远时刻（= 我的头部会被谁盖住） */
  function firstEndBefore(sorted, sMs) {
    let m = -Infinity;
    sorted.forEach(x => { if (x.eMs <= sMs && x.eMs > m) m = x.eMs; });
    return m;
  }

  /* ★ v1.36.0 「接上尾」：找到本条**之前最近的一条**记录（= 时间上紧邻的上一段），
   * 把开始时间顶到它的结束时刻；结束时间 = 新开始 + 原时长 → 时长不变、无缝衔接。
   * 语义说明（用户 2026-10-06 追加要求）：
   *   补记常发生在「上一段活动刚结束」的当下，手动敲结束时间极易差几分钟 → 产生本不该有的重叠。
   *   本按钮把"衔接"这一步变成一键：开始 = 上一条的 end，**只接上尾，不动时长**。
   *
   * 「上一条」的判定（两段，缺一不可）：
   *   ① **前驱**（常态）：所有其它记录中结束时刻 ≤ 本条开始时刻者，取结束最晚的
   *      —— 这是"时间轴上紧邻的前一段"，空档场景用它。
   *   ② **覆盖者**（补记落在已有记录内部时的兜底）：若没有任何前驱，但存在
   *      「结束时刻 > 本条开始」的记录，说明本条**插在别人中间**。
   *      此时取其中**结束最早**的那条，把开始顶到它的结束 → 顺带消除本次重叠。
   *      （这正是用户最初报的场景：补记 13:53 与副业 11:53–13:59 重叠，手动改起点极易再错）
   * ⚠️ 一律用**已裁剪后**的结束时刻做衔接判断——被更晚记录盖住的那段已经不算自己的了，
   *    直接拿原始 ended_at 会把尾巴接进别人的地盘。 */
  function prevTail() {
    const sEl = q("reStart"), eEl = q("reEnd");
    if (!sEl) return null;
    const s = new Date(sEl.value).getTime();
    const e = eEl ? new Date(eEl.value).getTime() : NaN;
    if (!isFinite(s)) return null;
    const all = (Store.getTimeRecords() || []).filter(r => r && r.id && r.id !== recId
      && r.source !== "call_manual");
    /* 与取数层同语义：有效结束 = 裁剪后区间的 end（被更晚记录盖住的部分不算） */
    const effEndOf = (r) => {
      const raw = r.ended_at ? new Date(r.ended_at).getTime() : NaN;
      if (!isFinite(raw)) return null;
      if (typeof window.TodayRecords !== "undefined" && window.TodayRecords.getTodayRecords) {
        const hit = (window.TodayRecords.getTodayRecords() || []).find(x => x.id === r.id);
        if (hit) {
          const e2 = Date.parse(hit.ended_at);
          if (isFinite(e2)) return e2;
        }
      }
      return raw;
    };
    let pre = null, cov = null;
    for (const r of all) {
      const effE = effEndOf(r);
      if (effE == null) continue;
      const st = new Date(r.started_at).getTime();
      if (effE <= s) {
        /* ① 前驱：结束在本条开始之前（或恰好相接）→ 取结束最晚的那条 = 时间轴上紧邻的前一段 */
        if (!pre || effE > pre.effE) pre = { rec: r, effE, kind: "pre" };
      } else if (isFinite(st) && isFinite(e) && st < e) {
        /* ② 覆盖者兜底：**仅当真的与本条相交**（st < 本条 end）。
         *     ⚠️ 关键：**只在完全没有前驱时**才用它；否则补记 12:30–13:30（午休 12:00–13:00
         *     相交）会因"存在相交记录"而误选更早的前驱（晨读 10:00），把尾巴接错地方。 */
        if (!cov || effE < cov.effE) cov = { rec: r, effE, kind: "cover" };
      }
    }
    return pre || cov;   // 前驱优先；没有前驱才用覆盖者兜底
  }

  function applyTail() {
    const sEl = q("reStart"), eEl = q("reEnd");
    if (!sEl || !eEl) return false;
    const s = new Date(sEl.value).getTime();
    const e = new Date(eEl.value).getTime();
    if (!(isFinite(s) && isFinite(e) && e > s)) return false;
    const t = prevTail();
    if (!t) return false;
    const dur = e - s;                 // 时长保持不变
    const newEnd = t.effE + dur;
    sEl.value = toLocalDT(t.effE);
    eEl.value = toLocalDT(newEnd);
    updateDur();
    return true;
  }

  function renderTailHint() {
    const btn = q("reTailBtn"), hint = q("reTailHint");
    if (!btn || !hint) return;
    const t = prevTail();
    const durEl = q("reDurLabel");
    if (!t) {
      btn.disabled = true;
      btn.style.opacity = ".45";
      btn.title = "本条之前没有可衔接的记录（当天第一段）";
      hint.textContent = "";
      return;
    }
    const s = new Date(q("reStart").value).getTime();
    const e = new Date(q("reEnd").value).getTime();
    const gap = isFinite(s) ? Math.round((s - t.effE) / 1000) : 0;
    btn.disabled = false;
    btn.style.opacity = "";
    const hhmm = (ms) => { const d = new Date(ms); const p = n => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()); };
    const name = (t.rec.label || t.rec.category || "上一条");
    btn.title = "开始时间 → " + hhmm(t.effE) + "（" + name + " 的结束），时长不变";
    if (t.kind === "cover") {
      /* 补记插在别人中间 → 点一下把尾巴让开 */
      hint.textContent = "「" + name + "」到 " + hhmm(t.effE) + " 才结束，当前与之重叠 "
        + Math.round((t.effE - s) / 60000) + " 分，点一下可消除";
    } else if (gap === 0) {
      hint.textContent = "已与「" + name + "」无缝衔接";
    } else if (gap > 0) {
      hint.textContent = "「" + name + "」结束于 " + hhmm(t.effE) + "，当前空出 " + Math.round(gap / 60) + " 分";
    } else {
      hint.textContent = "当前与之重叠 " + Math.round(-gap / 60) + " 分，点一下可消除";
    }
  }

  function updateDur() {
    /* ★ v1.36.0 起止时间一变就刷新「接上尾」可用性与提示 */
    try { renderTailHint(); } catch (e) { /* 提示失败不阻塞保存 */ }
    /* ★ v1.35.0 起止时间一变就重算重叠预告（补记/改时间都会触发） */
    try { renderTrimWarn(); } catch (e) { /* 预告失败不阻塞保存 */ }
    const s = new Date(q("reStart").value).getTime();
    const e = new Date(q("reEnd").value).getTime();
    const durEl = q("reDurLabel");
    if (!durEl) return;
    if (!(isFinite(s) && isFinite(e) && e > s)) { durEl.textContent = "--"; return; }
    const spanSec = Math.round((e - s) / 1000);
    /* v1.22.9：跨天/带分段的记录，起止跨度 ≠ 真实专注量（暂停不算）。
     * 时间没动过时按分段合计显示，免得出现"5 天的记录显示 120 小时"这种误导。
     * ★ v1.29.8 输入框已带秒（step=1），容差从 60 秒收紧到 1.5 秒——否则把结束时间从
     *   11:14:18 改到 11:14:30 这种秒级修正会被 60 秒容差吞掉（segments 不清/时长不重算）。 */
    const raw = recId ? (Store.getTimeRecords() || []).find(r => r.id === recId) : null;
    const unchanged = raw &&
      Math.abs(new Date(raw.started_at).getTime() - s) < 1500 &&
      Math.abs(new Date(raw.ended_at || 0).getTime() - e) < 1500;
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
    /* ★ v1.29.8 容差 60 秒 → 1.5 秒（输入框带秒后，秒级修正必须算"时间改了"） */
    const timeChanged = Math.abs(new Date(raw.started_at).getTime() - s) > 1500 ||
      Math.abs(new Date(raw.ended_at || 0).getTime() - e) > 1500;
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
    /* ★ v1.36.0 接上尾：开始时间顶到上一条的结束时刻（时长不变） */
    const tailBtn = q("reTailBtn");
    if (tailBtn) tailBtn.addEventListener("click", () => {
      if (applyTail() && window.UI && window.UI.showAlert) {
        window.UI.showAlert("已接上上一条的尾巴（时长不变）", 1800);
      }
    });
    const tagInput = q("reTagInput");
    if (tagInput) tagInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val && !tags.includes(val)) { tags = [...tags, val]; renderTags(); }
      tagInput.value = "";
    });
  }

  /* ★ v1.28.3 通用成员列表弹层：标题 + 行 HTML；onEdit/onDel 由调用方提供。
   * 供首页重叠徽标点击后就地查看与处理（不用跳复盘页）。复用编辑抽屉容器。 */
  function showMemberList(title, rowsHtml, onEdit, onDel) {
    ensureDom();
    q("recEditMask").classList.add("show");
    q("recEditDrawer").classList.add("show");
    const drawer = q("recEditDrawer");
    const mlId = "reMlBox";
    let box = document.getElementById(mlId);
    if (!box) {
      box = document.createElement("div");
      box.id = mlId;
      box.style.cssText = "padding:18px 20px 20px;max-height:70vh;overflow:auto";
      drawer.appendChild(box);
    }
    box.innerHTML = '<div style="font-size:15px;font-weight:900;color:var(--ink-1);margin-bottom:12px">' + title + '</div>' +
      '<div id="reMlRows">' + rowsHtml + '</div>' +
      '<button type="button" class="btn ghost block" id="reMlClose" style="margin-top:14px">关闭</button>';
    box.querySelectorAll(".ovm-edit").forEach(b => b.addEventListener("click", () => { close(); box.remove(); onEdit && onEdit(b.dataset.edit); }));
    box.querySelectorAll(".ovm-del").forEach(b => b.addEventListener("click", () => { box.remove(); onDel && onDel(b.dataset.del); }));
    const c = document.getElementById("reMlClose");
    if (c) c.addEventListener("click", () => { box.remove(); close(); });
  }

  window.RecEdit = { open, showMemberList, openForRange, close, bind, isOpen, getCategoryMeta };
})();

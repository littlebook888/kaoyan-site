/* =====================================================================
 *  checkin.js —— 每日签到提醒（v1.32.0 · 完全独立，分项切日版）
 *  ---------------------------------------------------------------------
 *  · v1.34.2：取消「chase 签到」项（用户 2026.10.06 指定），签到项 5 → 4。
 *  · 四项签到的 APP 刷新时间不同（用户 2026.10.05 指定）：
 *      ima 知识库双账号 / workbuddy 主号 / workbuddy 小号 → 每日凌晨 0 点刷新（自然日）
 *      不背单词 App                                      → 每日凌晨 4 点刷新
 *    → 0:00~3:59 期间给不背单词签到，签的是【前一天】的到。
 *  · 数据：events 表每项独立一行 { id: "ck-ima-<D>" / "ck-wb-<D>" / "ck-trae-<D>" / "ck-bb-<D>" }
 *      （D = 各项锚点日 = dateOf(now − 锚点小时)，ima/wb/trae −0h、bb −4h）
 *    旧版合并行 ck-<D> 兼容读取 = 四项在该自然日均已完成（best-effort）。
 *  · ★ v1.126.0（用户 2026.11.14 指定）：原「trae 签到」改为「workbuddy 小号签到（选做）」，
 *    原「workbuddy 签到」改为「workbuddy 主号签到」，避免主号/小号并排分不清。
 *    ⚠️ 内部 key 仍是 "trae"、云端行仍是 ck-trae-<D>：**刻意不改**——
 *       Supabase 已有历史签到行，改键会让历史数据断档；历史护栏也钉死 key 序列。
 *       key 只是内部标识与 events 行前缀，不外露；对外显示一律以 ITEMS.label 为准。
 *    ★「选做」是真语义，不是一行字样：optional:true 的项不进 pendingItems / allDone /
 *      doneCount / 18 点气泡 / 15 点预热 / 45 分钟到期通知，
 *      也不再由 0 点组按钮一键代签；必做项分母 = REQUIRED.length（3），不硬编码。
 *      但选做项仍可单项点击签到/取消、仍写同一张 events 表并三端同步、
 *      仍被「撤销今日」覆盖（撤销全部就是全部，不该漏掉它）。
 *  · ★ v1.141.0（用户 2026.11.18 指定）：「workbuddy 小号签到（选做）」改为
 *    **只在每日 23:35 之后提醒**（原先是完全不提醒）。
 *    ⚠️ 这是一条**独立通道**，不是把选做项塞回必做链：
 *       pendingItems / allDone / doneCount / 15 点预热 / 18 点气泡 / 45 分钟 snooze
 *       **一行都没动**，小号仍不挡「今日已完成」、仍不被组按钮代签。
 *       新通道只做一件事：23:35–24:00 这 25 分钟里，如果小号还没签，
 *       给卡片提示行 + 跨页顶条 + 一次系统通知（每天最多一次）。
 *    ⚠️ 时间口径：23:35 是**自然日**的钟点（小号 anchorHours:0，锚点日 = 自然日），
 *       不是「学习日」（04:00 换天）。过了 0 点就是新的一天，要等次日 23:35 才再提醒。
 *    ⚠️ 不受 snooze 影响：45 分钟延后会直接跨天，对小号毫无意义，故该通道不提供延后。
 *  · 「一键完成」/ 组按钮只补当前锚点日未完成的**必做**项；「撤销今日」删全部
 *    四项（含选做的小号）当前锚点日的行 + 今日旧合并行（误触兜底）。
 *  · 18 点后存在未完成项 → 气泡列出未完成项；无系统通知。
 *  · v1.34.0：点条目本身可单独签到 / 再点取消该项（事件委托）；组按钮仍为「一键整组」。
 *  · v1.34.1：提醒下沉——15 点自动展开卡片 + 预热行；18 点气泡加「稍后提醒」；
 *    卡片从页面最底上移到单词卡上方（用户 2026-10-05 指定），文案与配色同步降调。
 *  · 完全独立：不写 tasks/time_records/active_timer，不引用 Timer。
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const ITEMS = [
    { key: "ima", label: "ima 知识库 · 双账号签到", anchorHours: 0, group: "zero" },
    { key: "wb", label: "workbuddy 主号签到", anchorHours: 0, group: "zero" },
    /* key "trae" 为历史内部标识（对应云端 ck-trae-* 行），改为小号后**刻意保留**，见文件头。 */
    { key: "trae", label: "workbuddy 小号签到（选做）", anchorHours: 0, group: "zero", optional: true },
    { key: "bb", label: "不背单词 App 签到", anchorHours: 4, group: "four" }
  ];
  /* ★ v1.126.0 必做项：选做的小号不参与提醒与完成判定，但仍留在 ITEMS 里可单独签。 */
  const REQUIRED = ITEMS.filter(i => !i.optional);
  /* ★ v1.32.1 两个按钮分开管两组切日逻辑（用户指定）：
   *   zero 组（凌晨 0 点刷新）= ima + workbuddy 主号；four 组（凌晨 4 点刷新）= 不背单词。
   *   ★ v1.126.0：组按钮只管必做项——选做的小号不再被「一键整组」代签。 */
  const GROUPS = [
    { key: "zero", items: ITEMS.filter(i => i.group === "zero" && !i.optional) },
    { key: "four", items: ITEMS.filter(i => i.group === "four" && !i.optional) }
  ];

  function bjNow() {
    return window.Blocks ? window.Blocks.beijing(new Date()) : new Date();
  }
  function dateKey(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  /* 某项的锚点日：now − anchorHours 后的自然日（bb 在 0~4 点 = 前一天） */
  function anchorKey(item) {
    const d = new Date(bjNow().getTime() - item.anchorHours * 3600 * 1000);
    return dateKey(d);
  }
  function rowId(item) { return "ck-" + item.key + "-" + anchorKey(item); }
  /* 旧行兼容：ck-<D> = 四项在自然日 D 均已完成 */
  function legacyDone(dateKeyStr) {
    return (Store.getEvents() || []).some(e => e && e.id === "ck-" + dateKeyStr);
  }
  function isItemDone(item) {
    const events = Store.getEvents() || [];
    return events.some(e => e && e.id === rowId(item)) || legacyDone(anchorKey(item));
  }
  /* ★ v1.126.0：以下三个出口一律只认必做项（REQUIRED）。
   *   18 点气泡 / 15 点预热 / 跨页顶条 / 45 分钟到期通知都挂在它们上面，
   *   所以选做的小号不签也不会再催、不会挡住「今日签到已完成」。 */
  function pendingItems() { return REQUIRED.filter(it => !isItemDone(it)); }
  function allDone() { return pendingItems().length === 0; }
  function doneCount() { return REQUIRED.length - pendingItems().length; }
  /* 是否已过今日 18 点（北京时间） */
  function after1800() { return bjNow().getHours() >= 18; }
  function bubbleVisible() { return !allDone() && after1800(); }

  /* ★ v1.141.0 选做小号的夜间提醒窗口（唯一提醒时机）
   * ------------------------------------------------------------------
   * 用户 2026.11.18：「workbuddy 小号签到（选做）改为仅每日 23 点 35 分后进行提醒」。
   * 设计取舍（为什么不是「23:35 后把它塞进 18 点气泡」）：
   *   ① 两者紧迫性不同：必做大不了今天没签，小号是**跨天就断**，
   *      所以它要一个「最后 25 分钟」的专属窗口，而不是跟必做项一起从 18 点吵到 24 点。
   *   ② 一旦塞进 pendingItems，小号就会重新挡住「今日已完成」，
   *      等于把 v1.126.0 的「选做」语义废掉。故新建独立通道，判定链一行不动。
   * 窗口 = [23:35, 24:00)。00:00 起是新的一天（anchorHours:0），要等次日 23:35。
   * ⚠️ 分钟粒度：23:34:59 → getMinutes()=34 → 1414 < 1415，不提醒（正确）。
   * ⚠️ 不接 snooze：45 分钟延后必然跨天，对小号毫无意义。 */
  const OPT_CUTOFF_MIN = 23 * 60 + 35;                  // 1415 = 23:35
  const LS_OPT_NOTIFY = "kaoyan:checkin_opt_notify";    // 一天只弹一次系统通知
  const LS_OPTOPEN = "kaoyan:checkin_opt_open";         // 23:35 后自动展开，一天一次
  function optionalItem() { return ITEMS.find(i => i.optional) || null; }
  function afterOptCutoff() {
    const d = bjNow();
    return d.getHours() * 60 + d.getMinutes() >= OPT_CUTOFF_MIN;
  }
  /* 距自然日结束还有多少分钟（23:35 → 25，23:59 → 1） */
  function optionalLeftMin() {
    const d = bjNow();
    return Math.max(0, 24 * 60 - (d.getHours() * 60 + d.getMinutes()));
  }
  /* ★ 唯一判定出口：卡片提示行 / 跨页顶条 / 系统通知都必须读它，
   *   禁止各写一套条件（本项目最易复发的病就是"改了一处忘另一处"）。 */
  function optionalNudgeActive() {
    const it = optionalItem();
    return !!it && !isItemDone(it) && afterOptCutoff();
  }
  /* 本次会话内已弹过通知的**日期**（不是布尔 —— 用布尔的话，PWA 页面长开跨天后，
   * 次日的 23:35 会因为标记还是 true 而永远不再弹，等于这个通道只生效一次）。 */
  let _optFiredOn = "";
  function maybeNotifyOptional() {
    if (!optionalNudgeActive()) return;
    const today = todayKey();
    if (_optFiredOn === today) return;
    _optFiredOn = today;                    // 先置位：即使没权限也绝不反复请求
    let last = "";
    try { last = localStorage.getItem(LS_OPT_NOTIFY) || ""; } catch (e) {}
    if (last === today) return;             // 今天已经弹过（跨刷新去重）
    try { localStorage.setItem(LS_OPT_NOTIFY, today); } catch (e) {}
    if (window.UI && window.UI.notify) {
      window.UI.notify("⏰ 小号签到还剩 " + optionalLeftMin() + " 分钟",
        "workbuddy 小号签到（选做）今天还没签，过了 0 点就断，今天这一次就空了。");
    }
  }

  /* ★ v1.34.1 提醒下沉（用户 2026-10-05 要求"提醒要醒目但不吵"）：
   *   15 点 → 卡片自动展开 + 预热行（极轻，不弹窗不通知）；
   *   18 点 → 页面内提醒气泡（列出未完成项 + 「稍后提醒」静默至次日）。
   *   两者都只是"页面内"表达，零系统通知。 */
  const NUDGE_HOUR = 15;
  const LS_SNOOZE = "kaoyan:checkin_snooze";
  function afterNudge() { return bjNow().getHours() >= NUDGE_HOUR; }
  /* 已展开标记按天存（避免每次 render 重复 setAttribute 打断用户手动折叠） */
  const LS_AUTOOPEN = "kaoyan:checkin_autoopen";

  /* ---------- v1.41.0「稍后提醒」改为「45 分钟后再提醒」（用户 2026-10-08 指定）----------
   * 旧实现（v1.34.1）：LS_SNOOZE 存当天日期 key → 按「稍后」即**静默到次日**，
   *   等于按一次就彻底没人管（实测这正是「提醒形同虚设」的根因之一）。
   * 新实现：存**到期时间戳**而非日期 → 到点自动恢复提醒。
   *   · 每次按「稍后提醒」再顺延 45 分钟（不封顶，避免真被无限推迟）；
   *   · 跨天不失效（时间戳语义，天然跨日）；
   *   · 额外：再次进入页面时会检查是否已到期并主动弹一次系统通知，
   *     这样「45 分钟到了」即使你没盯着这个页面也能被告知。 */
  const SNOOZE_MIN = 45;
  function snoozeUntil() {
    try { return Number(localStorage.getItem(LS_SNOOZE)) || 0; } catch (e) { return 0; }
  }
  function snoozed() { return snoozeUntil() > Date.now(); }
  /* 距下次提醒还有多少分钟（<=0 表示该提醒了） */
  function snoozeLeftMin() {
    const left = snoozeUntil() - Date.now();
    return left > 0 ? Math.ceil(left / 60000) : 0;
  }
  function snooze() {
    try { localStorage.setItem(LS_SNOOZE, String(Date.now() + SNOOZE_MIN * 60000)); } catch (e) {}
  }
  function clearSnooze() { try { localStorage.removeItem(LS_SNOOZE); } catch (e) {} }
  /* 本次会话内是否已就「到期提醒」弹过系统通知（避免每次 render 重复弹） */
  let _snoozeFired = false;
  function nudgeVisible() { return !allDone() && afterNudge() && !after1800(); }

  /* 组内完成：为该组当前锚点日未完成的项建行；记录本次创建的行 id 集（供撤销） */
  function completeGroup(items) {
    const created = [];
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    for (const item of items) {
      if (isItemDone(item)) continue;
      const id = rowId(item);
      if (!events.some(e => e.id === id)) { events.push({ id, user_id: C.USER_ID, date: anchorKey(item), title: "daily-checkin", note: item.key }); created.push(id); }
    }
    if (created.length) Store.setEvents(events);
    return created;
  }
  function todayKey() { return dateKey(bjNow()); }
  /* ★ v1.33.0 取消某组签到（toggle 的取消侧）：删本组各项目前锚点日的行（显式推删）。
   * 旧合并行 ck-<D> 如存在则不在此处理——用「撤销今日」整体回退（跨组边界太细不值得）。 */
  function cancelGroup(items) {
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    const targets = items.map(item => rowId(item)).filter(id => events.some(e => e.id === id));
    if (!targets.length) return false;
    targets.forEach(id => Store.deleteEventRow(id));
    return true;
  }

  /* ★ v1.34.0 单项开关：点条目本身即签到 / 再点取消该项（用户 2026.10.05 指定）。
   *   复用 completeGroup([item]) / cancelGroup([item]) 两条既有写入路径，不新增写数据方式；
   *   组按钮仍是「一键整组」，两者互不影响（委托挂在 .ck-list 上，按钮不在其内）。 */
  function toggleItem(item) {
    if (!item) return false;
    if (isItemDone(item)) {
      cancelGroup([item]);
      render();
      alertMsg("↩ 已取消「" + item.label + "」");
      return true;
    }
    const created = completeGroup([item]);
    render();
    if (created.length) alertMsg(`✅ 已记录「${item.label}」（三端同步）`);
    return created.length > 0;
  }

  /* ★ v1.32.2 撤销今日签到（误触兜底，可反复按）：删除四项目前锚点日的行 + 今日旧合并行，
   *   全部走 deleteEventRow 显式推删云端（防拉回复活）。撤销后卡片回到未完成、按钮回场；
   *   若已过 18 点且仍有未完成项，气泡按条件重现。 */
  function undoToday() {
    const events = (Store.getEvents() || []).filter(e => e && e.id);
    const targets = ITEMS.map(item => rowId(item));
    targets.push("ck-" + todayKey());   // 旧版合并行（如有）
    const hit = targets.filter(id => events.some(e => e.id === id));
    if (!hit.length) return false;
    hit.forEach(id => Store.deleteEventRow(id));
    return true;
  }
  /* 旧行迁移：读到旧合并行 ck-<今日> 时，一键完成视为全项完成（无需迁移写入） */

  function alertMsg(msg) {
    if (window.UI && window.UI.showAlert) window.UI.showAlert(msg, 2200);
  }

  function render() {
    // 分项勾圈：各自锚点日完成态
    const card = document.getElementById("checkinCard");
    if (card) card.classList.toggle("done", allDone());
    ITEMS.forEach(item => {
      const el = document.querySelector(`[data-ck-item="${item.key}"]`);
      if (el) el.classList.toggle("ok", isItemDone(item));
    });
    // 日期副行
    const dateEl = document.getElementById("checkinDate");
    if (dateEl) {
      const d = bjNow();
      dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 · 周${"日一二三四五六"[d.getDay()]}`;
    }
    // ★ v1.126.0 状态胶囊：已完成 N/3（必做项分母；选做的小号不计入）
    const doneN = doneCount();
    const st = document.getElementById("checkinState");
    if (st) {
      st.textContent = allDone() ? "今日已完成 ✓" : `已完成 ${doneN}/${REQUIRED.length}`;
      st.className = "ck-state " + (allDone() ? "ok" : "todo");
    }
    // ★ v1.33.0 两个组按钮 = 独立开关：未全完成 → 「已完成…」（签到+打勾）；
    //   全完成 → 变「取消本组签到」（取消）。两组互不影响。
    GROUPS.forEach(g => {
      const b = document.getElementById(g.key === "zero" ? "checkinDoneBtn0" : "checkinDoneBtn4");
      if (!b) return;
      const groupDone = g.items.every(it => isItemDone(it));
      b.style.display = "";
      b.classList.toggle("is-cancel", groupDone);
      if (g.key === "zero") {
        /* ★ v1.126.0：组按钮只代签必做两项，文案不再列出选做的小号。 */
        b.textContent = groupDone ? "✕ 取消 ima / workbuddy 主号签到" : "已完成 ima / workbuddy 主号签到";
      } else {
        b.textContent = groupDone ? "✕ 取消不背单词签到" : "已完成不背单词签到";
      }
    });
    const doneRow = document.getElementById("checkinDoneRow");
    if (doneRow) doneRow.style.display = allDone() ? "flex" : "none";
    // ★ v1.34.1 15 点预热行（轻提示；18 点后交给气泡，不再重复出现）
    const nudge = document.getElementById("checkinNudge");
    if (nudge) {
      const showNudge = nudgeVisible();
      nudge.style.display = showNudge ? "flex" : "none";
      if (showNudge) {
        const tEl = document.getElementById("checkinNudgeText");
        if (tEl) tEl.textContent = `今天还差 ${pendingItems().length} 项没签（${pendingItems().map(it => it.label).join(" / ")}）`;
      }
    }
    // ★ v1.141.0 选做小号：只在 23:35 后亮一行（独立通道，不进 18 点气泡）
    const optNudge = document.getElementById("checkinOptNudge");
    if (optNudge) {
      const showOpt = optionalNudgeActive();
      optNudge.style.display = showOpt ? "flex" : "none";
      if (showOpt) {
        const ot = document.getElementById("checkinOptNudgeText");
        if (ot) ot.textContent = "小号签到今天还没签 · 还剩 " + optionalLeftMin() + " 分钟跨天（点这行直接签）";
      }
    }
    // ★ v1.34.1 15 点后卡片自动展开一次（当天只自动一次；用户手动折叠后不再打扰）
    if (afterNudge() && !allDone() && card && !card.open) {
      let opened = "";
      try { opened = localStorage.getItem(LS_AUTOOPEN) || ""; } catch (e) {}
      if (opened !== todayKey()) {
        card.open = true;
        try { localStorage.setItem(LS_AUTOOPEN, todayKey()); } catch (e) {}
      }
    }
    /* ★ v1.141.0 23:35 后同样自动展开一次（独立 key）——
     *   否则提示行被折叠在卡片里，等于没提醒。一天只展开一次，不跟 15 点那次抢 key。 */
    if (optionalNudgeActive() && card && !card.open) {
      let openedOpt = "";
      try { openedOpt = localStorage.getItem(LS_OPTOPEN) || ""; } catch (e) {}
      if (openedOpt !== todayKey()) {
        card.open = true;
        try { localStorage.setItem(LS_OPTOPEN, todayKey()); } catch (e) {}
      }
    }
    // ★ v1.141.0 系统通知：23:35 后首次判定成立时弹一次（一天只一次，见 maybeNotifyOptional）
    maybeNotifyOptional();
    // 18 点后未完成项 → 提醒气泡（列出具体未完成项；「稍后提醒」=45 分钟后再提醒）
    const bubble = document.getElementById("checkinBubble");
    if (bubble) {
      /* v1.41.0：45 分钟到期 → 自动清掉静默并主动弹系统通知。
       * 旧版按「稍后」= 静默到次日，等于永久静音；现在到点必回到提醒状态，
       * 且用系统通知把"到点了"这件事送到眼前，而不只是页面里悄悄变回可提醒。 */
      const left = snoozeLeftMin();
      if (!left && snoozeUntil() && !_snoozeFired && !allDone()) {
        _snoozeFired = true;
        clearSnooze();
        const pend = pendingItems();
        if (window.UI && window.UI.notify) {
          window.UI.notify("⏰ 该签到了",
            "45 分钟前你点的「稍后提醒」到时间了，还有 " + pend.length + " 项未完成：" +
            pend.map(i => i.label).join(" / "));
        }
      }
      const show = bubbleVisible() && !snoozed();
      bubble.style.display = show ? "" : "none";
      if (show) {
        const pend = pendingItems();
        const list = document.getElementById("checkinBubbleItems");
        if (list) list.textContent = "未完成：" + pend.map(it => it.label).join(" / ");
        const bb = document.getElementById("checkinBubbleDone");
        if (bb) bb.disabled = false;
        /* v1.41.0：按钮文案带剩余分钟数，让人知道"多久后会再提醒"而不是以为被静音了 */
        const bl = document.getElementById("checkinBubbleLater");
        if (bl) {
          const l2 = snoozeLeftMin();
          bl.textContent = l2 > 0 ? ("已推迟· " + l2 + "分后提醒") : "稍后提醒（45分钟后）";
          bl.disabled = l2 > 0;
        }
        if (window.Icon) window.Icon.inject(bubble);
      } else {
        /* 静默中：气泡虽隐藏，但给出恢复入口的提示（免得以为被永久静音） */
        const bl = document.getElementById("checkinBubbleLater");
        if (bl) bl.disabled = true;
      }
      /* v1.41.0 顶部横条：气泡只在 tasks.html 的特定位置，跨页面就看不见了。
       * 横条挂在 document.body 上，随页面切换一直在，且显示剩余分钟数。 */
      renderTopBar();
    }
  }

  /* ---------- v1.41.0 跨页面顶部强提醒条 ----------
   * 用户反馈「提示不明显」。症结：原实现只有 tasks.html 里一个页面内气泡，
   * 人一换页（首页/计时/统计）就完全看不到。
   * 本条挂在 body 上 → 只要装了 checkin.js 的页面都在（当前仍是 tasks.html，
   * 但结构上任何页面引入即可生效），且带脉冲动画 + 未完成数量。 */
  function renderTopBar() {
    let bar = document.getElementById("ckTopBar");
    /* ★ v1.141.0：顶条现在有两个来源 —— 必做项未完成（原逻辑）与
     *   选做小号的 23:35 窗口。两者同时成立时**只报必做项**（更紧急），
     *   小号的提示仍在卡片里那行，不丢。 */
    const reqNeed = bubbleVisible() && !snoozed();
    const optNeed = optionalNudgeActive();
    const need = reqNeed || optNeed;
    if (!need) { if (bar) bar.style.display = "none"; return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ckTopBar";
      bar.className = "ck-topbar";
      document.body.appendChild(bar);
      bar.addEventListener("click", function () {
        const card = document.querySelector(".checkin-card");
        if (card) { card.open = true; card.scrollIntoView({ behavior: "smooth", block: "center" }); }
      });
    }
    if (reqNeed) {
      const pend = pendingItems();
      const l2 = snoozeLeftMin();
      bar.innerHTML =
        '<span class="cktb-ico">🔔</span>' +
        '<span class="cktb-txt"><b>每日签到还有 ' + pend.length + ' 项没完成</b>' +
        '<small>' + escapeHtml(pend.map(i => i.label).join(" / ")) + '</small></span>' +
        (l2 > 0 ? '<span class="cktb-later">' + l2 + ' 分后再提醒</span>' : '') +
        '<button type="button" class="cktb-btn">立即查看</button>';
    } else {
      /* 必做项全签、只差选做小号 → 顶条也走这条，文案改成"还剩 N 分钟"。
       * 不显示 cktb-later：该通道不接 snooze（45 分钟必然跨天）。 */
      bar.innerHTML =
        '<span class="cktb-ico">⏰</span>' +
        '<span class="cktb-txt"><b>小号签到还剩 ' + optionalLeftMin() + ' 分钟</b>' +
        '<small>' + escapeHtml((optionalItem() || {}).label || "选做") + ' · 过了 0 点就断</small></span>' +
        '<button type="button" class="cktb-btn">现在签</button>';
    }
    bar.style.display = "";
    bar.classList.add("ck-topbar-pulse");
    if (window.Icon) window.Icon.inject(bar);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function bind() {
    const press = (items) => {
      const created = completeGroup(items);
      render();
      if (created.length) alertMsg(`✅ 已记录 ${created.length} 项签到（三端同步）`);
    };
    const undo = () => {
      if (undoToday()) { render(); alertMsg("↩ 已撤销今日全部签到，可重新记录"); }
      else alertMsg("今天还没有可撤销的签到记录", 1800);
    };
    const toggle = (g) => {
      if (g.items.every(it => isItemDone(it))) { cancelGroup(g.items); render(); alertMsg("↩ 已取消本组签到"); }
      else { const n = completeGroup(g.items).length; render(); if (n) alertMsg(`✅ 已记录 ${n} 项签到（三端同步）`); }
    };
    const b0 = document.getElementById("checkinDoneBtn0");
    if (b0) b0.addEventListener("click", () => toggle(GROUPS[0]));
    const b4 = document.getElementById("checkinDoneBtn4");
    if (b4) b4.addEventListener("click", () => toggle(GROUPS[1]));
    const bb = document.getElementById("checkinBubbleDone");
    if (bb) bb.addEventListener("click", () => press(pendingItems()));
    /* ★ v1.41.0 「稍后提醒」：**45 分钟后再提醒**（用户 2026-10-08 指定）。
     *   旧版是「静默到次日 0 点」——按一次就等于当天不再管，实际把提醒功能废掉了。
     *   现在存到期时间戳，到点自动恢复 + 弹系统通知；连按则每次顺延 45 分钟。 */
    const bl = document.getElementById("checkinBubbleLater");
    if (bl) bl.addEventListener("click", () => {
      snooze();
      render();
      alertMsg("🫧 45 分钟后再提醒你（剩余 " + snoozeLeftMin() + " 分钟）", 2200);
    });
    const undoBtn = document.getElementById("checkinUndo");
    if (undoBtn) undoBtn.addEventListener("click", undo);
    /* ★ v1.141.0：点小号夜间提示行 = 直接签（复用 toggleItem，不新增写数据方式）。
     *   该行只在 23:35 后可见，是"最后 25 分钟"的快捷入口，多点一次成本很低。 */
    const optN = document.getElementById("checkinOptNudge");
    if (optN) optN.addEventListener("click", () => {
      const it = optionalItem();
      if (it) toggleItem(it);
    });
    /* ★ v1.34.0 单项点击（事件委托挂一次、永不失效）：只认 [data-ck-item]；
     *   .ck-item 位于 .ck-body 内（不在 summary 里）→ 不会触发 <details> 折叠；
     *   两个组按钮在 .ck-list 之外 → 不会互相误触发。 */
    const list = document.querySelector(".checkin-card .ck-list");
    if (list) list.addEventListener("click", (e) => {
      const node = e.target.closest("[data-ck-item]");
      if (!node) return;
      const item = ITEMS.find(i => i.key === node.dataset.ckItem);
      if (item) toggleItem(item);
    });
    if (Store.subscribeEvents) Store.subscribeEvents(() => render());
    setInterval(render, 60000);
  }

  function init() {
    bind(); render();
    /* ---------- v1.41.0 浏览器系统通知（用户 2026-10-08 选 A + 系统通知）----------
     * 「45 分钟到了」这件事必须能在**你没盯着这个页面**时被告知，
     * 所以要用系统通知。但 Notification.requestPermission() 必须由用户手势触发
     * （浏览器规定），所以不能上来就调——挂到「首次点击」上，一次性。
     * 若已授权/已拒绝则什么都不做（拒绝后不再反复弹权限框，避免烦人）。 */
    if ("Notification" in window && Notification.permission === "default") {
      const ask = () => {
        try { Notification.requestPermission(); } catch (_) {}
        window.removeEventListener("pointerdown", ask);
        window.removeEventListener("keydown", ask);
      };
      window.addEventListener("pointerdown", ask, { once: true });
      window.addEventListener("keydown", ask, { once: true });
    }
  }

  window.CHECKIN = { init, render, bind, ITEMS, REQUIRED, GROUPS, isItemDone, pendingItems, allDone, doneCount, completeGroup, cancelGroup, toggleItem, undoToday, bubbleVisible, nudgeVisible, afterNudge, snoozed, snooze, snoozeLeftMin, clearSnooze, NUDGE_HOUR, SNOOZE_MIN, anchorKey, todayKey,
    /* ★ v1.141.0 选做小号夜间通道（供护栏与外部只读查询） */
    optionalItem, optionalNudgeActive, optionalLeftMin, afterOptCutoff, OPT_CUTOFF_MIN };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* =====================================================================
 *  store.js —— 数据层 / 三端同步底座
 *  设计：
 *   - 本地：localStorage（离线可用、立即生效）
 *   - 同浏览器多标签：BroadcastChannel（即时）
 *   - 跨设备（手机/电脑/平板）：Supabase Realtime（填了 key 才启用）
 *  任意一端写入，其余端（同浏览器或跨设备）都会收到并刷新。
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const LS_PREFIX = "kaoyan:";

  // 订阅者登记表：event -> [cb]
  const subscribers = {};
  function on(event, cb) {
    (subscribers[event] = subscribers[event] || []).push(cb);
    return () => {
      subscribers[event] = (subscribers[event] || []).filter((f) => f !== cb);
    };
  }
  function emit(event, payload) {
    (subscribers[event] || []).forEach((cb) => {
      try { cb(payload); } catch (e) { console.error(e); }
    });
  }

  // ---- 同浏览器多标签通道 ----
  let bc = null;
  try { bc = new BroadcastChannel(C.SYNC_CHANNEL); } catch (e) { bc = null; }
  if (bc) {
    bc.onmessage = (ev) => {
      const { key, value } = ev.data || {};
      if (key) {
        if (value === null) localStorage.removeItem(LS_PREFIX + key);
        else localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
        emit("change:" + key, value);
        emit("change", { key, value });
      }
    };
  }
  // storage 事件作为 BroadcastChannel 的兜底（其他标签页）
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith(LS_PREFIX)) {
      const key = e.key.slice(LS_PREFIX.length);
      let value = null;
      try { value = e.newValue ? JSON.parse(e.newValue) : null; } catch (_) {}
      emit("change:" + key, value);
      emit("change", { key, value });
    }
  });

  // ---- Supabase（可选，跨设备）----
  let sb = null;          // supabase client
  let sbReady = false;
  async function initSupabase() {
    if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) return false;
    if (typeof window.supabase === "undefined" || !window.supabase.createClient) {
      console.warn("Supabase JS 未加载（需在 HTML 引入 CDN）");
      return false;
    }
    try {
      sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
      sbReady = true;
      // 订阅各表变更（跨设备）
      subscribeTable("active_timer");
      subscribeTable("time_records");
      subscribeTable("study_sessions");
      subscribeTable("tasks");
      subscribeTable("events");
      subscribeTable("goals");

      // —— 关键修复：initSupabase 之前，autoImport/setLocal 发生时 sbReady=false，
      // 那些任务/数据从未被推到 Supabase。连接成功后主动补推一次。
      for (const t of ["active_timer", "time_records", "study_sessions", "tasks", "events", "goals"]) {
        const v = getLocal(t, null);
        if (t === "active_timer") {
          pushToSupabase(t, v);
        } else if (Array.isArray(v) && v.length > 0) {
          pushToSupabase(t, v);
        }
      }
      // 启动轮询兜底（Realimate 不可靠时仍能同步 active_timer）
      startTimerPoll();
      return true;
    } catch (e) {
      console.error("Supabase 初始化失败", e);
      return false;
    }
  }
  function subscribeTable(table) {
    sb.channel(table + "-rt")
      .on("postgres_changes",
        { event: "*", schema: "public", table, filter: `user_id=eq.${C.USER_ID}` },
        (payload) => {
          // 用 payload 刷新本地对应集合
          refreshFromSupabase(table);
        })
      .subscribe();
  }
  // 轮询兜底：即使 Realtime 没配/没触发，也能 3 秒内检测到 active_timer 变化
  let _lastTimerJson = null;
  let _pollTimer = null;
  function startTimerPoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (!sbReady) return;
      try {
        const { data, error } = await sb.from("active_timer")
          .select("*").eq("user_id", C.USER_ID).limit(1);
        if (error) return;
        const row = data && data[0] ? data[0] : null;
        const json = JSON.stringify(row);
        if (json !== _lastTimerJson) {
          _lastTimerJson = json;
          const local = getLocal("active_timer", null);
          const localJson = JSON.stringify(local);
          if (json === localJson) return; // 完全一致，不触发
          if (row) {
            // 远端有值且和本地不同 → 应用远端
            setLocal("active_timer", row, false, true);
          } else if (local) {
            // 远端空但本地有 → 判断本地是否近期改过
            const age = Date.now() - (local.updated_at || 0);
            if (age < 5000) {
              // 本地近期改过，推上去（可能是 push 失败的补偿）
              pushToSupabase("active_timer", local);
            } else {
              // 本地很久没改 + 远端空 = 另一端停止了
              setLocal("active_timer", null, false, true);
            }
          }
        }
      } catch (e) { /* 网络波动静默 */ }
    }, 3000);
  }

  async function refreshFromSupabase(table) {
    try {
      const { data, error } = await sb.from(table).select("*").eq("user_id", C.USER_ID);
      if (error) throw error;

      if (table === "active_timer") {
        const row = data && data[0] ? data[0] : null;
        const local = getLocal("active_timer", null);

        if (row) {
          // 远端有数据 → 应用远端（另一端的开始/暂停/继续会同步过来）
          setLocal("active_timer", row, false, true);
        } else if (local) {
          // 远端空但本地有计时器 → 两种情况：
          //   a) push 失败导致本地有但远端没有 → 把本地推上去（不丢计时器）
          //   b) 另一端停止了计时器 → 但本地最近 5 秒内还改过 → 推上去
          // 用 updated_at 判断：本地 5 秒内改过 = 本地优先，否则尊重远端空
          const age = Date.now() - (local.updated_at || 0);
          if (age < 5000) {
            console.log("[store] active_timer 远端空但本地近期有改动，推送本地到远端");
            pushToSupabase("active_timer", local);
          } else {
            // 本地计时器是很久以前的 + 远端空 = 另一端已停止 → 清除本地
            console.log("[store] active_timer 远端空且本地过期，清除本地计时器");
            setLocal("active_timer", null, false, true);
          }
        }
        return;
      }

      // 其他数组表：空数据时保护本地已有数据（防止移动端网络波动导致数据丢失）
      if (!data || data.length === 0) {
        const localData = getLocal(table, null);
        if (localData && (Array.isArray(localData) ? localData.length > 0 : true)) {
          console.log(`[store] Supabase 返回空，保留本地 ${table} 数据`);
          return;
        }
      }
      setLocal(table, data || [], false, true);
    } catch (e) { console.error("refresh failed", table, e); }
  }

  /* ---- 旧数据迁移：study_sessions → time_records（一次性，静默执行）---- */
  function migrateOldSessions() {
    const old = getLocal("study_sessions", null);
    if (!old || !Array.isArray(old) || old.length === 0) return;
    const existing = getLocal("time_records", []);
    if (existing.length > 0) return; // 已迁移过或已有新数据
    const migrated = old.map(s => ({
      id: s.id,
      user_id: s.user_id || C.USER_ID,
      category: s.kind || "study",
      sub_category: "",
      label: s.label || (s.kind === "study" ? "学习" : s.kind === "break" ? "休息" : "自由"),
      tags: [],
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_sec: s.duration_sec || 0,
      source: s.type ? ("migrated_" + s.type) : "migrated",
      block: "",
      note: "",
      created_at: s.started_at || new Date().toISOString()
    }));
    setLocal("time_records", migrated, false);
    console.log(`[store] 已迁移 ${migrated.length} 条旧学习记录 → time_records`);
  }

  // ---- 本地读写 ----
  function getLocal(key, fallback) {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  /* 任务人类可读 ID：日期-科目-板块-序号
   * 例：2026-08-27-xizong-course-01
   * 无日期的临时任务用 created 当天日期；序号取同前缀已有数量+1，确保唯一 */
  function genTaskRefId(t, arr) {
    const SUBJ = { xizong: "xizong", english: "english", politics: "politics", other: "other", study: "study" };
    const TYPE = { course: "course", review: "review", problem: "problem", other: "other" };
    // 日期：优先取任务的 date（日历视图），否则取创建当天
    let dateStr = "";
    if (t.date && typeof t.date === "string") {
      // date 形如 "Wed Aug 26 2026" → 标准化为 YYYY-MM-DD
      const d = new Date(t.date);
      if (!isNaN(d.getTime())) dateStr = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    }
    if (!dateStr) {
      const now = new Date();
      dateStr = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    }
    const subj = SUBJ[t.subject] || "other";
    const type = TYPE[t.task_type] || "other";
    const prefix = `${dateStr}-${subj}-${type}-`;
    const count = (arr || []).filter(x => x.ref_id && x.ref_id.startsWith(prefix)).length;
    const seq = String(count + 1).padStart(2, "0");
    return prefix + seq;
  }
  function setLocal(key, value, broadcast = true, skipPush = false) {
    if (value === null || value === undefined) localStorage.removeItem(LS_PREFIX + key);
    else localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    if (broadcast && bc) bc.postMessage({ key, value });
    emit("change:" + key, value);
    emit("change", { key, value });
    // 跨设备上行（refreshFromSupabase 回写本地时须跳过，避免 Realtime 回环）
    if (sbReady && !skipPush) pushToSupabase(key, value);
  }
  async function pushToSupabase(key, value) {
    if (!sbReady) return;
    try {
      if (key === "active_timer") {
        if (!value) {
          await sb.from("active_timer").delete().eq("user_id", C.USER_ID);
        } else {
          // 必须指定 onConflict: 'user_id'，否则 Supabase 不知道用哪列做冲突判定
          const { error } = await sb.from("active_timer")
            .upsert({ ...value, user_id: C.USER_ID }, { onConflict: 'user_id' });
          if (error) console.error("[store] active_timer upsert error:", error.message);
        }
      } else if (Array.isArray(value)) {
        // 批量 upsert：以 id 为冲突键，更新已存在行，插入新行
        // 比 delete-then-insert 更安全（网络中断时不会丢失数据）、更省 API 次数
        if (value.length) {
          try {
            await sb.from(key).upsert(value.map(v => ({ ...v, user_id: C.USER_ID })), { onConflict: 'id', ignoreDuplicates: false });
          } catch (e2) {
            // upsert 失败（如缺少唯一约束），回退单行逐条 upsert
            for (const row of value) {
              await sb.from(key).upsert({ ...row, user_id: C.USER_ID });
            }
          }
        }
      }
    } catch (e) { console.error("push failed", key, e); }
  }

  // 拉取一次远端（首次进入时）
  let _pulled = false;
  async function pullOnce() {
    if (!sbReady || _pulled) return;
    _pulled = true;
    for (const t of ["active_timer", "time_records", "study_sessions", "tasks", "events", "goals"]) {
      await refreshFromSupabase(t);
    }
  }

  /* ========================= 对外 API ========================= */

  // —— 活动计时会话（三端同跑同控的核心单行）——
  const Store = {
    on,
    initSupabase,
    pullOnce,
    isCloud: () => sbReady,
    getLocal,
    setLocal,

    getActiveTimer: () => getLocal("active_timer", null),
    setActiveTimer: (obj) => setLocal("active_timer", obj),
    subscribeActiveTimer: (cb) => on("change:active_timer", cb),

    // —— 学习记录（旧表，兼容保留）——
    getSessions: () => getLocal("study_sessions", []),
    addSession: (s) => {
      const arr = getLocal("study_sessions", []);
      arr.push(s);
      setLocal("study_sessions", arr);
    },
    subscribeSessions: (cb) => on("change:study_sessions", cb),

    // —— ⭐ 时间记录系统（新主线表，time_records）——
    getTimeRecords: () => { migrateOldSessions(); return getLocal("time_records", []); },
    addTimeRecord: (rec) => {
      const arr = getLocal("time_records", []);
      // 自动补 block（按开始时间归块）
      if (!rec.block && window.Blocks && rec.started_at) {
        rec.block = window.Blocks.blockOf(new Date(rec.started_at));
      }
      if (!rec.user_id) rec.user_id = C.USER_ID;
      if (!rec.created_at) rec.created_at = new Date().toISOString();
      if (!rec.tags) rec.tags = [];
      arr.push(rec);
      setLocal("time_records", arr);
      // 同时兼容写入旧表（仅学习/休息类，保持旧统计不挂）
      if (rec.category === "study" || rec.category === "break") {
        const oldArr = getLocal("study_sessions", []);
        oldArr.push({
          id: rec.id, user_id: rec.user_id, type: rec.source,
          kind: rec.category, duration_sec: rec.duration_sec,
          label: rec.label, started_at: rec.started_at, ended_at: rec.ended_at
        });
        setLocal("study_sessions", oldArr, false); // 不重复广播
      }
    },
    updateTimeRecord: (id, patch) => {
      const arr = getLocal("time_records", []).map(r =>
        r.id === id ? { ...r, ...patch } : r
      );
      setLocal("time_records", arr);
    },
    deleteTimeRecord: (id) => {
      const arr = getLocal("time_records", []).filter(r => r.id !== id);
      setLocal("time_records", arr);
    },
    subscribeTimeRecords: (cb) => on("change:time_records", cb),

    // —— 任务打卡（番茄ToDo 风格，关联时间记录）——
    getTasks: () => getLocal("tasks", []),
    addTask: (t) => {
      const arr = getLocal("tasks", []);
      if (!t.user_id) t.user_id = C.USER_ID;
      if (!t.created_at) t.created_at = new Date().toISOString();
      if (!t.subject) t.subject = "other";
      if (!t.task_type) t.task_type = "other";
      if (t.estimated_min === undefined) t.estimated_min = null;
      if (t.remind_on_estimate === undefined) t.remind_on_estimate = true;
      if (!t.total_focus_sec) t.total_focus_sec = 0;
      if (!t.status) t.status = t.done ? "done" : "todo";
      if (!t.time_record_ids) t.time_record_ids = [];
      // 人类可读 ref_id：日期-科目-板块-序号（新增任务才生成，历史任务保留）
      // 如 2026-08-27-xizong-course-01
      if (!t.ref_id) t.ref_id = genTaskRefId(t, arr);
      arr.push(t);
      setLocal("tasks", arr);
    },
    updateTask: (id, patch) => {
      const arr = getLocal("tasks", []).map(t => {
        if (t.id !== id) return t;
        const updated = { ...t, ...patch };
        if (patch.done !== undefined) updated.status = patch.done ? "done" : (updated.status === "running" || updated.status === "paused" ? updated.status : "todo");
        return updated;
      });
      setLocal("tasks", arr);
    },
    deleteTask: (id) => {
      const arr = getLocal("tasks", []).filter(t => t.id !== id);
      setLocal("tasks", arr);
    },
    addFocusToTask: (taskId, focusSec, timeRecordId) => {
      const arr = getLocal("tasks", []).map(t => {
        if (t.id !== taskId) return t;
        const ids = t.time_record_ids || [];
        if (timeRecordId && !ids.includes(timeRecordId)) ids.push(timeRecordId);
        return { ...t, total_focus_sec: (t.total_focus_sec || 0) + focusSec, time_record_ids: ids };
      });
      setLocal("tasks", arr);
    },
    subscribeTasks: (cb) => on("change:tasks", cb),

    // —— 日程 / 倒计时节点 ——
    getEvents: () => getLocal("events", []),
    addEvent: (e) => {
      const arr = getLocal("events", []);
      arr.push(e);
      setLocal("events", arr);
    },
    subscribeEvents: (cb) => on("change:events", cb),

    // —— 目标（考研目标 → 每日时长）——
    getGoals: () => getLocal("goals", []),
    setGoals: (arr) => setLocal("goals", arr),
    subscribeGoals: (cb) => on("change:goals", cb),

    // —— 调试日志（更新 debug 面板日志行）——
    setLog: (msg) => {
      document.querySelectorAll("#dbgLog").forEach(el => {
        el.textContent = `← ${msg}`;
      });
    },
  };

  window.Store = Store;

  // 自动初始化：页面加载后尝试连接 Supabase 并拉取远端数据
  // 这样所有页面（首页/计时/任务/统计/通话）自动获得云端同步能力
  setTimeout(() => {
    Store.initSupabase().then(ok => {
      if (ok) {
        document.querySelectorAll(".sync-badge .sb-txt").forEach(el => el.textContent = "云端同步中");
        document.querySelectorAll(".sync-badge").forEach(el => el.classList.add("cloud"));
        Store.setLog("Supabase 已连接");
        return Store.pullOnce().then(() => Store.setLog("数据同步完成"));
      } else {
        Store.setLog("Supabase 不可用，本地存储");
      }
    }).catch(() => { Store.setLog("同步失败，请检查网络"); });
  }, 50);
})();

/* =====================================================================
 *  store.js —— 数据层 / 三端同步底座（v2 架构）
 *  v2 架构（对照 Todoist / 滴答清单 Outbox Pattern）：
 *   1) 操作串行化：_writeLock 队列保证同一时刻只有一个 active_timer 写入
 *   2) 写确认 + 乐观回滚：写入 Supabase 成功 → ACK 出队；失败 → 回滚 UI
 *   3) 本地操作锁：_syncingUntil（写入中按钮 disabled，用户无法反复点）
 *   4) Version 冲突检测：以 version（单调递增）为准，不匹配则放弃写入 + 拉远端
 *   5) Supabase Broadcast 操作广播：其他设备毫秒级收到操作，不等轮询
 *   - 本地：localStorage（离线可用、立即生效）
 *   - 同浏览器多标签：BroadcastChannel（即时）
 *   - 跨设备（手机/电脑/平板）：Supabase Realtime（填了 key 才启用）
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const LS_PREFIX = "kaoyan:";

  /* ============================================================
   * ① 发布订阅系统
   * ============================================================ */
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

  /* ============================================================
   * ② 同浏览器多标签通道
   * ============================================================ */
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
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith(LS_PREFIX)) {
      const key = e.key.slice(LS_PREFIX.length);
      let value = null;
      try { value = e.newValue ? JSON.parse(e.newValue) : null; } catch (_) {}
      emit("change:" + key, value);
      emit("change", { key, value });
    }
  });

  /* ============================================================
   * ③ Supabase / 设备基础
   * ============================================================ */
  let sb = null;          // supabase client
  let sbReady = false;
  let _syncBroadcastCh = null; // Supabase Broadcast Channel（操作广播通道）

  function getDeviceId() {
    let id = localStorage.getItem("kaoyan:device_id");
    if (!id) {
      id = "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      localStorage.setItem("kaoyan:device_id", id);
    }
    return id;
  }

  /* ============================================================
   * ④ v2 核心同步机制
   * ============================================================ */

  // v2-1: 写入串行化（Outbox Lock）—— Promise 链保证同一时刻只有 1 个 active_timer 写入
  let _writeChain = Promise.resolve();

  // v2-2: UI 同步状态锁 —— 写入中 + 3 秒保护窗，按钮 disabled 防止反复点
  //   对照 Todoist：写入中顶部徽标显示"同步中…"，按钮灰显
  let _syncingUntil = 0;
  function isSyncing() { return Date.now() < _syncingUntil; }
  function setSyncingLock(durationMs = 3000) {
    _syncingUntil = Math.max(_syncingUntil, Date.now() + durationMs);
    emit("sync_status", { syncing: true, locked: isSyncing() });
  }
  function clearSyncingLock() {
    _syncingUntil = 0;
    emit("sync_status", { syncing: false, locked: false });
  }

  // v2-3: 心跳 & 停止保护（保持与 v1 兼容）
  const HB_KEY = "active_timer_heartbeat";
  let _stopGuardUntil = 0;
  function isInStopGuard() { return Date.now() < _stopGuardUntil; }
  function setStopGuard() { _stopGuardUntil = Date.now() + 10000; }
  function clearStopGuard() { _stopGuardUntil = 0; }

  // v2-4: 跨设备停止墓碑（H2 修复）
  //   收到远端 STOP 广播 → 设标记，轮询/refresh 见远端空时不盲推
  //   本设备 START/RESUME → 清标记
  let _stoppedByRemote = false;
  // v2-5: 初始推送未确认计数（防"初次推还没到→远端空→误清"）
  //   本设备刚启动推送后，远端可能暂时为空，允许有限重试
  let _remoteEmptyRetryCount = 0;
  const MAX_REMOTE_EMPTY_RETRY = 3;
  function writeHeartbeat(obj) {
    try {
      if (obj) localStorage.setItem(LS_PREFIX + HB_KEY, JSON.stringify(obj));
      else localStorage.removeItem(LS_PREFIX + HB_KEY);
    } catch (e) {}
  }
  function readHeartbeat() {
    try {
      const raw = localStorage.getItem(LS_PREFIX + HB_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  async function initSupabase() {
    if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) return false;
    if (typeof window.supabase === "undefined" || !window.supabase.createClient) {
      console.warn("Supabase JS 未加载（需在 HTML 引入 CDN）");
      return false;
    }
    try {
      sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
      sbReady = true;

      /* === v2-1: Supabase Broadcast 操作广播通道 ===
       *  对照 Forest/番茄ToDo：客户端之间直接发操作命令（START/PAUSE/STOP），
       *  不等 Postgres CDC（逻辑复制通常延迟 200–800ms）。
       *  发送：applyOp 成功后 send；接收：立即在本设备应用远端操作（本地已 serial 化） */
      try {
        _syncBroadcastCh = sb.channel("kaoyan-timer-ops:" + C.USER_ID, {
          config: { broadcast: { self: false } } // 不收自己发的
        });
        _syncBroadcastCh
          .on("broadcast", { event: "timer-op" }, ({ payload }) => {
            // 收到另一设备的操作命令 → 直接应用到本端（走串行化队列）
            console.log("[store] Broadcast收到远端操作:", payload?.op);
            _applyRemoteBroadcastOp(payload);
          })
          .subscribe();
      } catch (e) {
        console.warn("[store] Broadcast初始化失败（继续用Realtime+轮询兜底）:", e.message);
      }

      // Postgres CDC（Postgres Changes）作为 Broadcast 的兜底
      subscribeTable("active_timer");
      subscribeTable("time_records");
      subscribeTable("tasks");

      // 心跳兜底
      let at = getLocal("active_timer", null);
      if (!at && !isInStopGuard()) {
        const hb = readHeartbeat();
        if (hb && (hb.status === "running" || hb.status === "paused")) {
          console.log("[store] 心跳兜底：从 active_timer_heartbeat 恢复本地计时器");
          setLocal("active_timer", hb, false, true);
          at = hb;
        }
      }

      if (at) {
        at.device_id = getDeviceId();
        at.updated_at = Date.now();
        // 初始化用串行化写入（v2 方式）
        _enqueueActiveTimerWrite(at, true).catch(() => {});
        writeHeartbeat(at);
      }
      for (const t of ["time_records", "study_sessions", "tasks", "events", "goals"]) {
        const v = getLocal(t, null);
        if (Array.isArray(v) && v.length > 0) {
          pushToSupabase(t, v);
        }
      }

      startTimerPoll();
      startDataPoll();
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
        (payload) => { refreshFromSupabase(table); })
      .subscribe();
  }

  /* ============================================================
   * v2-核心操作：applyOp —— 所有 setActiveTimer 统一走这条线
   *  对外 API：Store.setActiveTimer(obj) 只调 applyOp，不再直接写 setLocal
   * ============================================================ */
  const _APPLIED_OPS_LS = "kaoyan:applied_ops_ids"; // 去重：已 ack 的 op_id 集合
  function _getAppliedIds() {
    try { return JSON.parse(localStorage.getItem(_APPLIED_OPS_LS) || "[]"); }
    catch (e) { return []; }
  }
  function _markAppliedId(opId) {
    const ids = _getAppliedIds();
    if (ids.includes(opId)) return;
    ids.push(opId);
    // 只留最近 100 条，避免无限膨胀
    while (ids.length > 100) ids.shift();
    try { localStorage.setItem(_APPLIED_OPS_LS, JSON.stringify(ids)); } catch (e) {}
  }

  /**
   * 核心：写 active_timer + 串行化 + 确认 + 回滚
   * @param {Object|null} newState - 新的 active_timer 状态（null 表示停止）
   * @param {boolean} isInit - 是否是初始化恢复（不加 syncing 锁）
   */
  function _enqueueActiveTimerWrite(newState, isInit = false) {
    // 串行化 Promise 链：前一条完成才开始下一条（防止并发写入冲突）
    const task = _writeChain.then(async () => {
      if (!sbReady) {
        // 没有云同步 → 只写本地
        setLocalInternal(newState);
        return;
      }
      const opId = "op_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const opType = newState ?
        (newState.status === "paused" ? "PAUSE" :
         newState.status === "running" ? "START" : "SET") : "STOP";
      const snapshotBefore = getLocal("active_timer", null); // 用于失败回滚

      if (!isInit) setSyncingLock(3000); // 写中 UI 锁 3 秒（防止用户反复点）

      // 1) 先写入本地 + 广播给其他标签（乐观更新，UI 立即响应）
      setLocalInternal(newState);

      // 2) 计算版本号：如果已有旧状态取旧 version，否则取 0
      const baseVersion = snapshotBefore && typeof snapshotBefore.version === "number"
        ? snapshotBefore.version
        : (getLocal("active_timer", null)?.version || 0);
      const nextVersion = baseVersion + 1;
      // 准备要推的数据
      const toWrite = newState ? { ...newState } : null;
      if (toWrite) {
        toWrite.version = nextVersion;
        toWrite.last_op_id = opId;
        toWrite.updated_at = Date.now();
      }

      // 3) 发送 Broadcast（毫秒级通知其他设备 —— 不等 DB CDC）
      try {
        if (_syncBroadcastCh) {
          _syncBroadcastCh.send({
            type: "broadcast",
            event: "timer-op",
            payload: {
              op: opType, op_id: opId, device_id: getDeviceId(),
              created_at: Date.now(),
              state: toWrite, // 直接发完整新状态（简化版，不用算增量）
              version: nextVersion
            }
          });
        }
      } catch (e) { /* Broadcast 不稳定则用 Postgres Changes 兜底 */ }

      // 4) 持久化到 DB（active_timer 表 + sync_ops 操作日志）
      let ok = false;
      try {
        // 4a) 写 sync_ops（幂等：op_id 为 PK，重复 upsert 不报错 = 去重）
        try {
          await sb.from("sync_ops").upsert({
            op_id: opId, user_id: C.USER_ID, device_id: getDeviceId(),
            op_type: opType,
            payload: toWrite ? JSON.parse(JSON.stringify(toWrite)) : null,
            created_at: Date.now(),
            applied: false
          }, { onConflict: "op_id" });
        } catch (e) {
          // M6 修复：schema 不存在才静默降级，其他真实错误必须报错
          const msg = (e?.message || "").toLowerCase();
          if (msg.includes("does not exist") || msg.includes("relation") ||
              msg.includes("could not find") || msg.includes("schema")) {
            // sync_ops 表未创建 → 静默跳过（用户未执行 schema.sql）
          } else {
            console.error("[store] sync_ops upsert 失败（非schema问题）:", e.message);
          }
        }

        // 4b) 写 active_timer
        await pushToSupabaseRawActiveTimer(toWrite, baseVersion);
        ok = true;
        _markAppliedId(opId); // 写入 ack
      } catch (e) {
        console.error("[store] active_timer 推送失败:", e.message);
        // === 乐观回滚：恢复 snapshotBefore（用户的"停止"没真的同步成功）===
        console.log("[store] ⚠️ 推送失败，回滚到推送前状态");
        setLocalInternal(snapshotBefore);
        if (!isInit) clearSyncingLock();
        throw e;
      }

      if (!isInit) clearSyncingLock();
    }).catch(e => { /* 链式上一个任务已处理异常 */ });

    _writeChain = task;
    return task;
  }

  /** 仅写 localStorage + emit（不触发 push）—— 供同步队列内部使用 */
  function setLocalInternal(value) {
    if (value === null || value === undefined) localStorage.removeItem(LS_PREFIX + "active_timer");
    else localStorage.setItem(LS_PREFIX + "active_timer", JSON.stringify(value));
    // BroadcastChannel 广播给其他同浏览器标签
    try {
      if (bc) bc.postMessage({ key: "active_timer", value });
    } catch (e) {}
    writeHeartbeat(value);
    emit("change:active_timer", value);
    emit("change", { key: "active_timer", value });
  }

  /** 收到其他设备发来的 Broadcast 操作 → 应用到本端 */
  function _applyRemoteBroadcastOp(payload) {
    if (!payload || !payload.op_id) return;
    // 幂等去重：已应用过的 op_id 跳过
    if (_getAppliedIds().includes(payload.op_id)) return;
    const remoteVersion = payload.version || 0;
    const local = getLocal("active_timer", null);
    const localVersion = local && typeof local.version === "number" ? local.version : 0;
    // 版本号判断：远端版本必须 ≥ 本端（防止旧操作覆盖新数据）
    if (remoteVersion < localVersion) {
      console.log("[store] Broadcast 版本落后，丢弃（local=" + localVersion + " remote=" + remoteVersion + "）");
      return;
    }
    console.log("[store] 应用远端Broadcast操作:", payload.op, "version=", remoteVersion);
    // ★ H2 修复：STOP 操作 → 设置跨设备停止墓碑
    if (payload.op === "STOP") {
      _stoppedByRemote = true;
      setStopGuard();  // 也设本地保护窗
    } else {
      _stoppedByRemote = false;  // 其他操作清除墓碑
    }
    setLocalInternal(payload.state || null);
    _markAppliedId(payload.op_id);
  }

  /** H1 修复：轮询/refresh 专用的轻量推送（走 _writeChain 串行化 + version）
   *  不做乐观更新（数据已在本地），不设 sync 锁（后台同步） */
  function _syncPushActiveTimer(local) {
    if (!sbReady || !local) return Promise.resolve();
    const task = _writeChain.then(async () => {
      const baseVersion = typeof local.version === "number" ? local.version : 0;
      const nextVersion = baseVersion + 1;
      const toWrite = { ...local, version: nextVersion, updated_at: Date.now() };
      try {
        await pushToSupabaseRawActiveTimer(toWrite, baseVersion);
        // 推送成功 → 更新本地 version（保持一致）
        local.version = nextVersion;
        _remoteEmptyRetryCount = 0;  // 重置重试计数
      } catch (e) {
        console.error("[store] _syncPushActiveTimer 失败:", e.message);
      }
    }).catch(() => {});
    _writeChain = task;
    return task;
  }

  /** pushToSupabase active_timer：先做版本检查冲突，用串行 API 写 */
  async function pushToSupabaseRawActiveTimer(value, expectedVersion) {
    if (!value) {
      // 删除
      const { error } = await sb.from("active_timer").delete().eq("user_id", C.USER_ID);
      if (error) throw error;
      return;
    }
    const { device_id, ...rest } = value;
    // 旧 schema 可能没有 version 列 —— 先试完整字段
    const row = { ...rest };
    // 确保 user_id 存在
    row.user_id = C.USER_ID;
    const { error } = await sb.from("active_timer")
      .upsert(row, { onConflict: "user_id" });
    if (error) {
      // schema 没 version/last_op_id 列时降级用白名单（兼容旧表）
      const { device_id: _d, version: _v, last_op_id: _lo,
        sub_category: _s, tags: _t, segments: _sg,
        first_started_at: _fs, task_id: _ti, note: _n, ...core } = rest;
      const coreRow = { user_id: C.USER_ID, ...core };
      const { error: err2 } = await sb.from("active_timer")
        .upsert(coreRow, { onConflict: "user_id" });
      if (err2) throw err2;
      console.warn("[store] active_timer 仅推送核心字段（schema 缺列，请执行 sql/schema.sql）");
    }
  }
  // 轮询兜底 + 心跳补偿：确保本地计时器和远端始终一致
  let _lastTimerJson = null;
  let _pollTimer = null;
  let _timerPushDirty = false;
  let _heartbeatCounter = 0;

  function startTimerPoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (!sbReady) return;
      _heartbeatCounter++;
      try {
        // ★ 停止保护窗内：跳过整个轮询，让 delete 完成
        //   防止 delete 的 await 期间心跳补偿把本地数据重推回云端
        if (isInStopGuard()) {
          console.log("[store] 停止保护窗内，跳过本轮轮询");
          return;
        }

        let local = getLocal("active_timer", null);

        // ★ 心跳兜底：本地空但心跳有 → 从心跳恢复（防止刷新/误清丢失计时器）
        //   注意：停止保护窗内不会走到这里（上面已 return）
        if (!local) {
          const hb = readHeartbeat();
          if (hb) {
            const age = Date.now() - (hb.updated_at || 0);
            const canRestore = hb.status === "paused" || (hb.status === "running" && age < 60000);
            if (canRestore) {
              console.log("[store] 轮询心跳兜底：从 active_timer_heartbeat 恢复本地计时器");
              setLocal("active_timer", hb, false, true);
              local = hb;
            }
          }
        }

        // —— 心跳：每 10 秒推送运行中的计时器，保持远端新鲜 ——
        // ★ H1 修复：走 _syncPushActiveTimer（串行化 + version），不再裸调 pushToSupabase
        if (_heartbeatCounter % 5 === 0 && local && local.status === "running") {
          local.updated_at = Date.now();
          local.device_id = getDeviceId();
          writeHeartbeat(local);
          _syncPushActiveTimer(local);
        }

        // —— 心跳补偿：上次 push 失败则重推 ——
        if (_timerPushDirty && local) {
          console.log("[store] 心跳补偿：重推 active_timer");
          local.updated_at = Date.now();
          _syncPushActiveTimer(local);
          return;
        }

        const { data, error } = await sb.from("active_timer")
          .select("*").eq("user_id", C.USER_ID).limit(1);
        if (error) return;

        // ★ 关键修复：await 之后重新检查保护窗 + 重新获取 local
        //   场景：await 期间用户点击了停止，setActiveTimer(null) 清空了本地
        //   但本回调的 local 变量仍是旧值，会错误地从 Supabase 恢复数据
        if (isInStopGuard()) {
          console.log("[store] await 后检测到停止保护窗，跳过恢复");
          return;
        }
        // 重新获取 local（可能已被 setActiveTimer(null) 清空）
        local = getLocal("active_timer", null);

        const row = data && data[0] ? data[0] : null;
        const json = JSON.stringify(row);

        if (json === _lastTimerJson) return;
        _lastTimerJson = json;

        if (row) {
          // 远端有计时器
          if (!local) {
            // 本地没有 → 直接应用远端，并同步心跳
            writeHeartbeat(row);
            setLocal("active_timer", row, false, true);
          } else {
            // 本地和远端都有 → 用 updated_at 比较，新的赢
            const remoteTs = row.updated_at || 0;
            const localTs = local.updated_at || 0;
            if (remoteTs > localTs) {
              // 远端更新 → 应用远端（另一端操作了开始/暂停/继续）
              writeHeartbeat(row);
              setLocal("active_timer", row, false, true);
            }
            // 本地更新或相同 → 什么都不做，本地心跳会推上去
          }
        } else if (local) {
          // ★ H2 修复：远端空但本地有计时器 → 判断是"另一设备停止"还是"推送未到"
          if (local.status === "running") {
            if (_stoppedByRemote) {
              // 收到过远端 STOP 广播 → 另一设备已停止，本端同步清除
              console.log("[store] 远端空 + 收到过STOP墓碑 → 同步清除本地运行计时器");
              _stoppedByRemote = false;
              writeHeartbeat(null);
              setLocal("active_timer", null, false, true);
            } else if (_remoteEmptyRetryCount < MAX_REMOTE_EMPTY_RETRY) {
              // 未收到 STOP，可能是推送延迟 → 有限重试
              _remoteEmptyRetryCount++;
              console.log("[store] 远端空但本地运行中，重试推送 (" + _remoteEmptyRetryCount + "/" + MAX_REMOTE_EMPTY_RETRY + ")");
              local.updated_at = Date.now();
              _syncPushActiveTimer(local);
            } else {
              // 重试耗尽仍远端空 → 视为另一设备停止，清除本地
              console.log("[store] 远端空 + 重试耗尽 → 清除本地运行计时器");
              _remoteEmptyRetryCount = 0;
              writeHeartbeat(null);
              setLocal("active_timer", null, false, true);
            }
          } else if (local.status === "paused") {
            const age = Date.now() - (local.updated_at || 0);
            if (age < 300000 && !_stoppedByRemote) {
              _syncPushActiveTimer(local);
            } else {
              console.log("[store] 暂停计时器超时或远端停止 → 清除");
              writeHeartbeat(null);
              setLocal("active_timer", null, false, true);
            }
          } else {
            writeHeartbeat(null);
            setLocal("active_timer", null, false, true);
          }
        }
      } catch (e) { /* 网络波动静默 */ }
    }, 2000); // 2 秒轮询
  }

  // 慢速轮询：tasks / time_records（10 秒一次，不影响计时器的高频轮询）
  let _dataPollTimer = null;
  let _lastDataJson = {};
  function startDataPoll() {
    if (_dataPollTimer) return;
    _dataPollTimer = setInterval(async () => {
      if (!sbReady) return;
      for (const t of ["tasks", "time_records"]) {
        try {
          const { data, error } = await sb.from(t).select("*").eq("user_id", C.USER_ID);
          if (error) continue;
          const json = JSON.stringify(data || []);
          if (json === _lastDataJson[t]) continue;
          _lastDataJson[t] = json;
          // 空数据保护
          if ((!data || data.length === 0)) {
            const localData = getLocal(t, null);
            if (localData && Array.isArray(localData) && localData.length > 0) continue;
          }
          setLocal(t, data || [], false, true);
        } catch (e) { /* 静默 */ }
      }
    }, 10000); // 10 秒
  }

  async function refreshFromSupabase(table) {
    try {
      const { data, error } = await sb.from(table).select("*").eq("user_id", C.USER_ID);
      if (error) throw error;

      if (table === "active_timer") {
        // ★ 停止保护窗内：跳过 active_timer 恢复（用户刚点了停止，让 delete 完成）
        if (isInStopGuard()) {
          console.log("[store] refresh: 停止保护窗内，跳过 active_timer 恢复");
          return;
        }

        const row = data && data[0] ? data[0] : null;
        let local = getLocal("active_timer", null);

        // ★ 心跳兜底：本地空但心跳有 → 先恢复（远端拉取竞态保护）
        if (!local) {
          const hb = readHeartbeat();
          if (hb) {
            const age = Date.now() - (hb.updated_at || 0);
            const canRestore = hb.status === "paused" || (hb.status === "running" && age < 60000);
            if (canRestore) {
              console.log("[store] refresh: 从 active_timer_heartbeat 恢复本地计时器");
              setLocal("active_timer", hb, false, true);
              local = hb;
            }
          }
        }

        if (row) {
          // 远端有计时器
          if (!local) {
            writeHeartbeat(row);
            setLocal("active_timer", row, false, true);
          } else {
            // 用 updated_at 比较，新的赢
            const remoteTs = row.updated_at || 0;
            const localTs = local.updated_at || 0;
            if (remoteTs > localTs) {
              writeHeartbeat(row);
              setLocal("active_timer", row, false, true);
            }
          }
        } else if (local) {
          // ★ H2 修复：同 startTimerPoll 逻辑
          if (local.status === "running") {
            if (_stoppedByRemote) {
              console.log("[store] refresh: STOP墓碑 → 清除本地");
              _stoppedByRemote = false;
              writeHeartbeat(null);
              setLocal("active_timer", null, false, true);
            } else if (_remoteEmptyRetryCount < MAX_REMOTE_EMPTY_RETRY) {
              _remoteEmptyRetryCount++;
              console.log("[store] refresh: 远端空，重试推送 (" + _remoteEmptyRetryCount + "/" + MAX_REMOTE_EMPTY_RETRY + ")");
              local.updated_at = Date.now();
              _syncPushActiveTimer(local);
            } else {
              console.log("[store] refresh: 重试耗尽 → 清除本地");
              _remoteEmptyRetryCount = 0;
              writeHeartbeat(null);
              setLocal("active_timer", null, false, true);
            }
          } else if (local.status === "paused") {
            const age = Date.now() - (local.updated_at || 0);
            if (age < 300000 && !_stoppedByRemote) {
              _syncPushActiveTimer(local);
            } else {
              writeHeartbeat(null);
              setLocal("active_timer", null, false, true);
            }
          } else {
            writeHeartbeat(null);
            setLocal("active_timer", null, false, true);
          }
        }
        return;
      }

      // 其他数组表：空数据时保护本地已有数据
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
    /* v2：active_timer 的云端写入只走 _enqueueActiveTimerWrite（串行化 + 回滚 + version）
     *  此处不得再 push，否则会并发写入冲突（setLocalInternal 也绕过这里）。
     *  其他数组表（tasks/time_records等）继续走 pushToSupabase 原有路径 */
    if (sbReady && !skipPush && key !== "active_timer") pushToSupabase(key, value);
  }
  // active_timer 推送字段白名单
  // 旧 schema 只有 9 个核心字段；新 schema 扩展了 6 个字段（sub_category/tags/segments 等）
  // 先尝试推送全部字段，失败则降级为白名单（兼容旧 schema 不报错）
  const AT_CORE_FIELDS = ["mode","kind","label","status","started_at","duration_sec","elapsed_sec","updated_at"];
  function buildActiveTimerRow(value, coreOnly) {
    const { device_id, ...rest } = value;
    if (coreOnly) {
      const o = {};
      AT_CORE_FIELDS.forEach(k => { if (rest[k] !== undefined) o[k] = rest[k]; });
      return o;
    }
    return rest; // 完整字段（schema 升级后所有字段都存在）
  }
  async function pushToSupabase(key, value) {
    if (!sbReady) return;
    try {
      if (key === "active_timer") {
        if (!value) {
          await sb.from("active_timer").delete().eq("user_id", C.USER_ID);
        } else {
          // 1) 先尝试推送完整字段（schema 已升级时所有字段都存在）
          const row = buildActiveTimerRow(value, false);
          const { error } = await sb.from("active_timer")
            .upsert({ ...row, user_id: C.USER_ID }, { onConflict: 'user_id' });
          if (error) {
            // 2) 降级：用核心字段白名单重试（兼容旧 schema：sub_category/tags 等列不存在）
            const core = buildActiveTimerRow(value, true);
            const { error: err2 } = await sb.from("active_timer")
              .upsert({ ...core, user_id: C.USER_ID }, { onConflict: 'user_id' });
            if (err2) {
              console.error("[store] active_timer upsert 失败（完整+核心都失败）:", err2.message);
              _timerPushDirty = true;
            } else {
              // 降级成功：核心字段至少同步了 mode/kind/status 等
              console.warn("[store] active_timer 仅推送核心字段（旧 schema，请执行 sql/schema.sql 升级）");
              _timerPushDirty = false;
            }
          } else {
            _timerPushDirty = false;
          }
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
    /**
     * v2 入口：setActiveTimer（统一走操作队列）
     * - 写入串行化（Promise 链）：防止用户反复点击 start/stop/start 产生竞态写入
     * - 乐观更新：UI 立即响应，后台推送
     * - 推送失败：自动回滚到推送前状态（UI 显示"恢复"，不会丢数据）
     * - sync_status 事件：timer.js 监听，按钮在同步中 disabled
     */
    setActiveTimer: (obj) => {
      if (obj) {
        obj.device_id = getDeviceId();
        obj.updated_at = Date.now();
        clearStopGuard();
        _stoppedByRemote = false;  // ★ H2: 本设备开始/继续 → 清除远端停止墓碑
      } else {
        setStopGuard();
      }
      _enqueueActiveTimerWrite(obj, false).catch(() => {});
    },
    // 同步状态：timer.js 订阅此事件，写入中让按钮 disabled
    isSyncing: isSyncing,
    subscribeSyncStatus: (cb) => on("sync_status", cb),
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
      // 去重：同 id 的记录不重复插入（防止同步产生重复）
      if (rec.id && arr.some(r => r.id === rec.id)) {
        console.log("[store] 跳过重复 time_record:", rec.id);
        return;
      }
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

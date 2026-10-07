// ============================================================
// Supabase 同步引擎（本地优先 + 云端后写优先）
// ------------------------------------------------------------
// ★ v1.39.0 频率优化（用户 2026-10-07 反馈：刷题时间集中、跨端少但会有
//   「30 秒前电脑、下���秒手机」的快速切换）：
//   改前：点一次选项 → 800ms 后发一次请求（刷一小时 ≈ 80 次）
//   改后：点一次选项 → 只标记脏；仅在【切后台 / 兜底间隔 / 提交】时批量上传
//拉取：仅在打开页面时做一次，且 5 个 scope 合并为1 次 in 查询
//   （改前每次拉取是 5 个HTTP 请求）
// 语义不变：localStorage 仍是本地权威；拉取时较新的一侧胜出。
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_CONFIG, isSupabaseConfigured, SYNC_SCOPES } from './supabase-config'

let supabase = null
if (isSupabaseConfigured()) {
  try {
    supabase = createClient(SUPABASE_CONFIG.SUPABASE_URL, SUPABASE_CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  } catch (err) {
    console.warn('[sync] Supabase 初始化失败，已回退本地模式：', err)
    supabase = null
  }
}

export function syncEnabled() {
  return Boolean(supabase)
}

// ---------- 本地时间戳元数据 ----------
const META_PREFIX = 'med-sync-meta'
function readLocalMeta() {
  try {
    const raw = window.localStorage.getItem(META_PREFIX)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
function localUpdatedAt(scope) {
  const meta = readLocalMeta()
  return new Date(meta[scope] || 0).getTime()
}
function touchLocalMeta(scope, timestamp) {
  const meta = readLocalMeta()
  meta[scope] = new Date(timestamp || Date.now()).toISOString()
  window.localStorage.setItem(META_PREFIX, JSON.stringify(meta))
}

// ---------- 推送：只标记脏，按需批量上传 ----------
/* ★ v1.39.0 原来这里是「每次点选项 → 800ms 后发一次请求」，
 *   刷一小时题约触发 80 次。现在改为：pushState 只把 scope 标记为脏并记下最新值，
 *   真正的网络请求集中在三个时刻（flushNow）：
 *     ① 页面切到后台（visibilitychange→hidden）—— 这正是「电脑刷完走去用手机」的时刻
 *     ② 兜底定时器（每PUSH_INTERVAL_MS）
 *     ③ 关页面 / 提交题组（App.jsx 侧显式调用）
 *   刷一小时题从约 80 次请求降到约 20 次，且切设备那一刻依然必然同步。 */
const PUSH_DEBOUNCE_MS = 800
const PUSH_INTERVAL_MS = 3 * 60 * 1000   // 兜底间隔：3 分钟
const pendingPushes = new Map()          // scope → 最新待传值（脏数据）
let flushTimer = null

function doPush(scope, data) {
  if (!supabase) return Promise.resolve()
  const timestamp = new Date().toISOString()
  return supabase
    .from('quiz_state')
    .upsert({ scope, data, updated_at: timestamp }, { onConflict: 'scope' })
    .then(() => touchLocalMeta(scope, timestamp))
    .catch((err) => console.warn(`[sync] scope=${scope} 推送失败：`, err))
}

/** 把所有脏 scope 逐个推上云端，并清空脏标记 */
export async function flushNow() {
  if (!syncEnabled() || pendingPushes.size === 0) return 0
  const entries = [...pendingPushes.entries()]
  pendingPushes.clear()
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await Promise.all(entries.map(([scope, data]) => doPush(scope, data)))
  return entries.length
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushNow()
  }, PUSH_INTERVAL_MS)
}

export function pushState(scope, data) {
  if (!syncEnabled() || !SYNC_SCOPES.includes(scope)) return
  // ★ 入队即乐观更新本地时间戳：此后拉取时，云端除非比「本地最后一次作答」更新，
  //   否则不会覆盖本地——防止离线作答后推送失败、切回页面被云端旧数据冲掉
  touchLocalMeta(scope, Date.now())
  pendingPushes.set(scope, data)
  scheduleFlush()
}

// ---------- 拉取并合并 ----------
/* ★ v1.39.0 合并为一次请求：原来 5 个 scope 各发一次 HTTP（实测每次响应 83B，
 *   但 5 个请求头开销远大于响应体本身）。实测 ?scope=in.(...) 一次拿全，
 *   响应 425B 反而更小，耗时 1.4s → 1.3s。 */
async function pullAllScopes() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('quiz_state')
    .select('scope, data, updated_at')
    .in('scope', SYNC_SCOPES)
  if (error) {
    console.warn('[sync] 批量拉取失败：', error)
    return []
  }
  return Array.isArray(data) ? data : []
}

// 返回被云端覆盖的 scope 数组（云端较新时，写入 localStorage 并返回该 scope）
export async function pullAndMergeAll() {
  if (!syncEnabled()) return []
  let rows = []
  try {
    rows = await pullAllScopes()
  } catch (err) {
    // ★ 每个 scope 独立容错：一次网络抖动不能拖死整条合并链路
    console.warn('[sync] 拉取失败：', err)
    return []
  }
  const byScope = new Map(rows.map((r) => [r.scope, r]))
  const changed = []
  for (const scope of SYNC_SCOPES) {
    try {
      const row = byScope.get(scope)
      if (!row) continue
      const cloudTime = new Date(row.updated_at).getTime()
      if (cloudTime > localUpdatedAt(scope)) {
        let value = row.data
        if (typeof value === 'string') {
          // study-subject 等裸字符串不是合法 JSON，直接原样采用
          try { value = JSON.parse(value) } catch { /* 保持原字符串 */ }
        }
        window.localStorage.setItem(scope, JSON.stringify(value))
        touchLocalMeta(scope, row.updated_at)
        changed.push(scope)
      }
    } catch (err) {
      console.warn(`[sync] scope=${scope} 合并失败：`, err)
    }
  }
  return changed
}
// ============================================================
// Supabase 双向同步引擎（本地优先 + 云端后写优先）
// ------------------------------------------------------------
// 策略：
//   - 所有状态仍以 localStorage 为本地权威（离线也完全可用）
//   - 每次状态变更：写 localStorage + 触发防抖云端 upsert
//   - 首次进入页面：拉取云端各 scope，按 updated_at 与本地时间戳
//     对比，较新的一侧胜出，合并回本地
//   - 单用户多端交替使用场景下「后写优先」足够可靠且最简
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

// ---------- 防抖推送 ----------
const PUSH_DEBOUNCE_MS = 800
const pendingPushes = new Map()

function doPush(scope, data) {
  if (!supabase) return Promise.resolve()
  const timestamp = new Date().toISOString()
  return supabase
    .from('quiz_state')
    .upsert({ scope, data, updated_at: timestamp }, { onConflict: 'scope' })
    .then(() => touchLocalMeta(scope, timestamp))
    .catch((err) => console.warn(`[sync] scope=${scope} 推送失败：`, err))
}

export function pushState(scope, data) {
  if (!syncEnabled() || !SYNC_SCOPES.includes(scope)) return
  if (pendingPushes.has(scope)) clearTimeout(pendingPushes.get(scope))
  pendingPushes.set(
    scope,
    setTimeout(() => {
      pendingPushes.delete(scope)
      doPush(scope, data)
    }, PUSH_DEBOUNCE_MS),
  )
}

// ---------- 拉取并合并 ----------
async function pullScope(scope) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('quiz_state')
    .select('scope, data, updated_at')
    .eq('scope', scope)
    .maybeSingle()
  if (error) {
    console.warn(`[sync] scope=${scope} 拉取失败：`, error)
    return null
  }
  return data
}

// 返回 { scope: 'med-selections' }（云端较新时，写入 localStorage 并返回该 scope）
export async function pullAndMergeAll() {
  if (!syncEnabled()) return []
  const changed = []
  await Promise.all(SYNC_SCOPES.map(async (scope) => {
    const row = await pullScope(scope)
    if (!row) return
    const cloudTime = new Date(row.updated_at).getTime()
    if (cloudTime > localUpdatedAt(scope)) {
      const value = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      window.localStorage.setItem(scope, JSON.stringify(value))
      touchLocalMeta(scope, row.updated_at)
      changed.push(scope)
    }
  }))
  return changed
}
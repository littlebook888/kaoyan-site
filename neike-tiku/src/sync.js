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
  // ★ 入队即乐观更新本地时间戳：此后拉取时，云端除非比「本地最后一次作答」更新，
  //   否则不会覆盖本地——防止离线作答后推送失败、切回页面被云端旧数据冲掉
  touchLocalMeta(scope, Date.now())
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
  // ★ 每个 scope 独立容错：一个失败不能拖死其他 scope 的合并
  //   （此前 study-subject 推送的是裸字符串，拉回后 JSON.parse 抛 SyntaxError，
  //    Promise.all 整体 reject → 全部 scope 的云端合并被静默跳过，拉取方向从未生效）
  const changed = await Promise.all(SYNC_SCOPES.map(async (scope) => {
    try {
      const row = await pullScope(scope)
      if (!row) return null
      const cloudTime = new Date(row.updated_at).getTime()
      if (cloudTime > localUpdatedAt(scope)) {
        let value = row.data
        if (typeof value === 'string') {
          // study-subject 等裸字符串不是合法 JSON，直接原样采用
          try { value = JSON.parse(value) } catch { /* 保持原字符串 */ }
        }
        window.localStorage.setItem(scope, JSON.stringify(value))
        touchLocalMeta(scope, row.updated_at)
        return scope
      }
      return null
    } catch (err) {
      console.warn(`[sync] scope=${scope} 合并失败：`, err)
      return null
    }
  }))
  return changed.filter(Boolean)
}
// ============================================================
// Supabase 云同步配置（多端同步引擎）
// ------------------------------------------------------------
// 使用步骤：
//   1. 打开 https://supabase.com 注册并创建项目（免费版即可）
//   2. 在项目后台 SQL Editor 里执行 SUPABASE_SETUP.md 中的建表 SQL
//   3. 把下面的 URL 和 anon key 填进来（在项目 Settings → API 获取）
//   4. 重新构建并部署，即可实现多端互相备份与同步
//
// 若留空，则自动进入「纯本地模式」，不影响本地刷题功能。
// ============================================================

export const SUPABASE_CONFIG = {
  SUPABASE_URL: 'https://nkwwtlgpfvhzetjsssvj.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rd3d0bGdwZnZoemV0anNzc3ZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDI2MDUsImV4cCI6MjEwMzMxODYwNX0.UCXhEKqe08d4h74w9hExZe9XGKjIzZVQXQFHLYcddS8',
}

export function isSupabaseConfigured() {
  return Boolean(
    typeof window !== 'undefined'
    && SUPABASE_CONFIG.SUPABASE_URL
    && SUPABASE_CONFIG.SUPABASE_ANON_KEY
    && SUPABASE_CONFIG.SUPABASE_URL.startsWith('https://')
    && SUPABASE_CONFIG.SUPABASE_URL.includes('.supabase.co'),
  )
}

// 需要云端同步的状态作用域（与 localStorage 的键一一对应）
/* ★ v1.39.0 存储/同步按科目分片
 * 起因（用户 2026.10.07）：同一设备可能同时开两个副站标签页（如内科 + 外科），
 *   原实现三个键把五科混在一份，两个标签页各自整份上传会**互相覆盖**。
 * 改法：三个键按科目加后缀（`med:med-selections` / `pathology:med-selections` …），
 *   各标签页只传自己那科。
 * 这里要给出「全部合法 scope」清单给 sync.js 做 in 查询与 push 校验——
 * 由 SUBJECT_KEYS × SHARDED 交叉生成，避免手写漏项。 */
export const SUBJECT_KEYS = ['med', 'pathology', 'surgery', 'physiology', 'biochemistry']

/** 需要按科目分片的三个键（其余为全局键，所有标签页共用） */
export const SHARDED_KEYS = ['med-selections', 'med-submitted', 'med-notes']

/** 全局键：不按科目切，任何标签页改动都会同步（收藏本身是跨科的聚合列表） */
export const GLOBAL_KEYS = ['med-favorites', 'study-subject']

/** 全部合法 scope = 全局键 + 各科的分片键 */
export const SYNC_SCOPES = [
  ...GLOBAL_KEYS,
  ...SUBJECT_KEYS.flatMap((subject) => SHARDED_KEYS.map((key) => `${subject}:${key}`)),
]
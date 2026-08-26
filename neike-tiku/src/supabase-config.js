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
export const SYNC_SCOPES = [
  'med-selections', // 各题组的选择
  'med-submitted',  // 各题组的已提交标记
  'med-favorites',  // 收藏（数组）
  'med-notes',      // 各题组的笔记
  'study-subject',  // 上次使用的科目
]
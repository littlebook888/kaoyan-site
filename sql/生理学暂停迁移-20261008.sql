-- =============================================================================
-- 生理学·人可研梦滚动复习 —— 暂停迁移（2026-10-08，用户指定）
-- -----------------------------------------------------------------------------
-- 目的：把生理学系列的 43 条任务从 `tasks` 表**移出**，存入轻量表
--   `rolling_reviews_paused`，以降低云端同步量与首屏渲染开销。
--   ⚠️ **数据一行不丢**：先复制到新表，再从 tasks 删除；随时可原样搬回。
--
-- 为什么必须建新表（而不是只隐藏 UI）：
--   同步量由 `tasks` 表**行数**决定。隐藏卡片只是不渲染，
--   43 行任务依然每次全量上传/下载 → 同步量一点没降。
--
-- 执行方式：Supabase 后台 → SQL Editor → 粘贴以下整段 → Run
-- 说明：幂等（IF NOT EXISTS / ON CONFLICT DO NOTHING），可重复执行。
--
-- ⚠️ 2026-10-08 修订：本文件原先在第 2 段报 `column t.rr_note does not exist`
--   —— rr_note（v1.42.0 新增的滚动复习笔记列）没在云端 tasks 表里。
--   现已在下方第 0 段自动补列，直接跑本文件即可，无需先跑单独的补列文件。
-- =============================================================================

-- ---------- 0. 前置：确保 tasks 表有 rr_note 列（v1.42.0 笔记字段）----------
-- 缺列后果比报错更隐蔽：store.js 的"缺列自愈"会自动剥离该列继续 upsert，
--   表面上推送成功，但笔记只存本机、换设备看不到，且下次拉取被云端空值覆盖。
alter table public.tasks add column if not exists rr_note text;

-- ---------- 1. 建轻量表（只存重启所需的字段，不含时间记录数组等重字段）----------
create table if not exists public.rolling_reviews_paused (
  id              text primary key,
  user_id         text,
  title           text,
  day_label       text,                -- DAY 标记
  day_num         integer,             -- DAY 号（便于按序搬回）
  done            boolean default false,
  total_focus_sec integer default 0,   -- 累计专注秒数（重启后要恢复，否则进度白丢）
  note            text,                -- 系统说明（二期/三期日期等）
  rr_note         text,                -- ★ 用户笔记（v1.42.0 新增，重启后必须保留）
  source          text,                -- 保留 physio_rolling，便于搬回时身份识别
  saved_at        timestamptz not null default now()
);

-- RLS：与主站其他表一致，单人自用、公开读写
alter table public.rolling_reviews_paused enable row level security;

drop policy if exists "rolling_reviews_paused read"   on public.rolling_reviews_paused;
drop policy if exists "rolling_reviews_paused insert" on public.rolling_reviews_paused;
drop policy if exists "rolling_reviews_paused update" on public.rolling_reviews_paused;
drop policy if exists "rolling_reviews_paused delete" on public.rolling_reviews_paused;
create policy "rolling_reviews_paused read"   on public.rolling_reviews_paused for select using (true);
create policy "rolling_reviews_paused insert" on public.rolling_reviews_paused for insert with check (true);
create policy "rolling_reviews_paused update" on public.rolling_reviews_paused for update using (true) with check (true);
-- ⚠️ 必须有 delete 策略：缺了会被 PostgREST 静默拦截（返回 204 但影响 0 行，
--    本项目已在 koujue_state 上踩过一次，见 docs/全站体检报告.md）
create policy "rolling_reviews_paused delete" on public.rolling_reviews_paused for delete using (true);

-- ---------- 2. 先复制（幂等：ON CONFLICT DO NOTHING 避免重复）----------
insert into public.rolling_reviews_paused
  (id, user_id, title, day_label, day_num, done, total_focus_sec, note, rr_note, source)
select
  t.id, t.user_id, t.title, t.day_label,
  coalesce(substring(t.day_label from '\d+')::integer,
           substring(t.title from 'DAY\s*(\d+)')::integer,
           substring(coalesce(t.note,'') from '第\s*(\d+)\s*天')::integer) as day_num,
  t.done, t.total_focus_sec, t.note, t.rr_note, 'physio_rolling'
from public.tasks t
where t.source = 'physio_rolling'
   or t.title like '%人可研梦滚动复习%'
   -- ⚠️ 排除新系列「内科+病理」——它的标题同样含"人可研梦滚动复习"，
   --    但用户 2026-10-08 明确要求**只暂停生理学**。
   --    靠"source=physio_rolling"作主判据；仅当 source 为空（老数据缺列）时才用标题兜底，
   --    且必须排除含"内科"的标题。
   and t.title not like '%内科%'
on conflict (id) do nothing;

-- ---------- 3. 回读校验：确认复制到多少行（应为 43）----------
select count(*) as paused_rows,
       count(*) filter (where done) as done_rows,
       sum(total_focus_sec) as total_focus_sec
from public.rolling_reviews_paused;

-- ---------- 4. 确认无误后再从 tasks 删除 ----------
-- ⚠️ 建议先把上面第 3 步的结果记下来，确认行数与 tasks 里的生理学行数一致再执行。
--    这里的 WHERE 必须与第 2 步**逐字相同**，否则可能误删内科+病理。
-- 核查用（先看，不删）：
-- select count(*) from public.tasks
--  where source = 'physio_rolling' or (title like '%人可研梦滚动复习%' and title not like '%内科%');

delete from public.tasks
where source = 'physio_rolling'
   or (title like '%人可研梦滚动复习%' and title not like '%内科%');

-- ---------- 5. 重启用（1 个月后）：把生理学搬回 tasks ----------
-- 说明：rr_note 也在搬回范围内 → **这一个月里写在笔记框里的内容不会丢**。
-- insert into public.tasks
--   (id, user_id, title, done, date, category, slot, block, subject, task_type,
--    estimated_min, remind_on_estimate, total_focus_sec, status, time_record_ids,
--    source, day_label, note, created_at)
-- select p.id, p.user_id, p.title, p.done, '' as date, 'general', null, null,
--        'xizong', 'review', null, true, p.total_focus_sec, 'todo', '{}',
--        'physio_rolling', p.day_label, p.note, now()
-- from public.rolling_reviews_paused p
-- order by p.day_num;
-- 然后删掉 localStorage 标记（让前端重新按计划对齐）：
--   localStorage.removeItem('xizong_physio_imported_v2')  ← 不需要，因为 tasks 里已有行，
--   autoImportPhysioPlan 的守卫 `Store.getTasks().some(isPhysioTask)` 会跳过重复导入。
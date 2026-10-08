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

-- ---------- 2. 先复制 ----------
-- ⚠️⚠️ 2026-10-08 修订：**`on conflict (id) do nothing` 在这里是不够的**。
--   幂等只在「同一 id 已存在」时生效。但历史上 autoImportPhysioPlan 在守卫失效时
--   被跑过多次，tasks 表一度存在 **3 份不同 id 的同一 DAY** → 按 id 去重不去三份
--   不同 id → 实测把 paused 表灌成了 129 行（DAY1-43 各 3 份），见
--   sql/清理paused重复行-20261008.sql。
--   → 现在改为**按 day_num 去重**：同一 DAY 只搬「专注时长最多、其次 id 最小」
--     的那一行（这个选择规则保证真正的进度不会在去重中丢失）。
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
   --但用户 2026-10-08 明确要求**只暂停生理学**。
   --    靠"source=physio_rolling"作主判据；仅当 source 为空（老数据缺列）时才用标题兜底，
   --    且必须排除含"内科"的标题。
   and t.title not like '%内科%'
  -- ★ 同一 DAY 只留一行（防重复导入灌进暂停表）：专注多的优先，其次 id 小的优先
  and not exists (
    select 1 from public.tasks t2
    where coalesce(substring(t2.day_label from '\d+')::integer,
                   substring(t2.title from 'DAY\s*(\d+)')::integer,
                   substring(coalesce(t2.note,'') from '第\s*(\d+)\s*天')::integer)
        = coalesce(substring(t.day_label from '\d+')::integer,
                   substring(t.title from 'DAY\s*(\d+)')::integer,
                   substring(coalesce(t.note,'') from '第\s*(\d+)\s*天')::integer)
      and (coalesce(t2.total_focus_sec,0), t2.id) > (coalesce(t.total_focus_sec,0), t.id)
  -- ★★ 必须同时保留 on conflict (id) do nothing（2026-10-09 修复回归）
  --   上面那个 not exists 只解决「tasks 表内部同一 DAY 有多份」，
  --   **完全不管「这行的 id 已经躺在 paused 表里了」**。
  --   我在 v1.42.1 修订时把原有的 on conflict (id) do nothing 一起删掉了，
  --   于是迁移脚本**第二次执行必然报**：
  --     ERROR: 23505 duplicate key value violates unique constraint
  --             "rolling_reviews_paused_pkey"
  --     DETAIL: Key (id)=(...) already exists.
  --   （实测 2026-10-09 用户第二次跑迁移时真的报了这个，整个脚本中断，
  --     第 3~6 段全部没执行 → 生理学数据没搬走、暂停标记也没写。）
  --
  --   两个去重机制是**互补**的，缺一不可、都必须留着：
  --     · not exists (按 day_num) → 防「不同 id 的同一 DAY」（历史重复导入，129 行那次）
  --     · on conflict (id)        → 防「同一 id 重复执行」（脚本重跑幂等）
  on conflict (id) do nothing;

-- ---------- 3. 回读校验：确认复制到多少行（应为 43）----------
-- ⚠️ 若 paused_rows ≠ 43 → **不要执行第 4 段删除**！
--   多于 43 = 有重复 DAY 被搬进来了（参见 sql/清理paused重复行-20261008.sql）。
select count(*) as paused_rows,
       count(distinct day_num) as distinct_days,   -- 应与 paused_rows 相等
       count(*) filter (where done) as done_rows,
       sum(total_focus_sec) as total_focus_sec
from public.rolling_reviews_paused
where source = 'physio_rolling';

-- 报警查询：只要有 DAY 出现多于1 次就列出来（期望返回 0 行）
select day_num, count(*) as copies
from public.rolling_reviews_paused
where source = 'physio_rolling'
group by day_num
having count(*) > 1;

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
-- ⚠️ 执行顺序：**先清第 6 段的暂停标记，再执行这里**。反了会继续被判为暂停。
-- 🔴 v1.42.1 修正：原版 select列表**漏了 rr_note** → 这个月写在笔记框里的
--   内容会随 paused 表残留而不再同步回tasks（表面上"任务回来了，笔记空了"）。
--   搬运列表必须与第 2 段的搬运字段**完全对齐**。
-- insert into public.tasks
--   (id, user_id, title, done, date, category, slot, block, subject, task_type,
--    estimated_min, remind_on_estimate, total_focus_sec, status, time_record_ids,
--    source, day_label, note, rr_note, created_at)
-- select p.id, p.user_id, p.title, p.done, '' as date, 'general', null, null,
--        'xizong', 'review', null, true, p.total_focus_sec, 'todo', '{}',
--        'physio_rolling', p.day_label, p.note, p.rr_note, now()
-- from public.rolling_reviews_paused p
-- where p.source = 'physio_rolling'          -- ★ 必须过滤：清理后表里可能混入其他系列
-- order by p.day_num;
-- 回读：应恰好 43 行
-- select count(*) from public.tasks where source = 'physio_rolling';
-- 然后删掉暂停标记（前端 hydratePhysioPausedFlag 读到未暂停会自动清 localStorage）：
--   update public.koujue_state set data = '{"v":""}'::jsonb, updated_at = now()
--    where scope = 'physio_rolling_paused';
-- ---------- 6. ★ 写入「暂停」跨设备标记（v1.42.1，务必执行）----------
-- ⚠️ 不写这一段，暂停会被**推翻**：
--   tasks 里已无 physio 行 → autoImportPhysioPlan 的守卫
--   `if (Store.getTasks().some(isPhysioTask)) return;` 判定为「从未导入」
--   → **立刻把 43 行重新灌回 tasks**，同步量照旧，暂停形同虚设；
--   且每台新设备都会重灌一遍（历史上 129 行重复就是这么来的）。
-- 用 koujue_state 的独立 scope（该表 scope 是主键，天然命名空间隔离），
-- 跨设备生效；不与口令页的 'xk.v2' 冲突。只需 insert/update，不需要 delete 策略。
insert into public.koujue_state (scope, data, updated_at)
values ('physio_rolling_paused', '{"v":"1","at":"2026-10-08"}'::jsonb, now())
on conflict (scope) do update
  set data = excluded.data, updated_at = excluded.updated_at;

-- 回读：应返回 1 行、data 里 v="1"
select scope, data from public.koujue_state where scope = 'physio_rolling_paused';

-- ⛔ 同时请在**每台设备**的浏览器控制台执行一次（localStorage 兜底，防离线时守卫失效）：
--    localStorage.setItem('xizong_physio_paused', '1')
-- ⛔ 1 个月后重启时：把上面这条 upsert 的值改成 ''（或删掉这一行），
--    并在每台设备执行 localStorage.removeItem('xizong_physio_paused')，
--    然后执行第 5 段的搬回 SQL。完整顺序见 docs/生理学暂停与重启说明.md。

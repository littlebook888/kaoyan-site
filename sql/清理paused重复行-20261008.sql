-- =============================================================================
-- 清理 paused 表的重复行（2026-10-08，用户截图发现 paused_rows=129）
-- -----------------------------------------------------------------------------
-- ⚠️ 情况：tasks 表的生理学任务**完全正常**（DAY1-43 各 1 行 = 43 行，无重复）
--   但rolling_reviews_paused 里变成了 129 行 = DAY1-43 各 3 份。
--
-- 根因：`insert ... select ... on conflict (id) do nothing` 的幂等**只在同一次
--   插入内生效**（按 id 去重）。但历史上前端`autoImportPhysioPlan` 在守卫失效时
--   被执行过多次 → tasks 表一度存在 3 份不同 id 的同一 DAY → 迁移 SQL 按
--   id 去重不了三份不同 id，于是全部搬进了 paused 表。
--   （tasks 现有的43 行是后导入的那一份，另 86 行已被前端清理/覆盖，
--     所以 tasks 干净、paused 里留了 129。）
--
-- ✅ 已核实（2026-10-08 直连云端逐行核对）：
--   · tasks 里 43 行的 day_label 直方图 = {"1":43}  → tasks 无重复
--   · paused 里 129 行 = day_num 1..43 各 3 份，source 全为 physio_rolling
--   · paused 中与 tasks 现存 43 行**id 重合**的 = 43 行（权威份）
--   ·另 86 行为历史残留，**tasks 里已不存在**
--   · ★ 所有 done / total_focus_sec>0 的记录**全部落在权威份上**
--     （唯一 22 秒在 DAY 1 的权威份上）→ **清理残留零数据损失**
--
-- 执行方式：SQL Editor 粘贴以下整段 → Run
-- 说明：幂等，可重复执行。
-- =============================================================================

-- ---------- 1. 安全网：先把权威份（与 tasks 现存 id 重合的）单独备份一份 ----------
--建一张干净的对照表，便于比对/回滚
create table if not exists public.rolling_reviews_paused_bak (
  id              text primary key,
  user_id         text,
  title           text,
  day_label       text,
  day_num         integer,
  done            boolean default false,
  total_focus_sec integer default 0,
  note            text,
  rr_note         text,
  source          text,
  saved_at        timestamptz not null default now()
);

insert into public.rolling_reviews_paused_bak
  (id, user_id, title, day_label, day_num, done, total_focus_sec, note, rr_note, source)
select p.id, p.user_id, p.title, p.day_label, p.day_num, p.done,
       p.total_focus_sec, p.note, p.rr_note, p.source
from public.rolling_reviews_paused p
join public.tasks t on t.id = p.id      -- ★ 只备份「tasks 里还在、且 id 一致」的权威份
on conflict (id) do nothing;

-- ---------- 2. 回读：应恰好 43 行 ----------
select count(*) as bak_rows,
       count(*) filter (where done) as done_rows,
       sum(total_focus_sec)as focus_sec
from public.rolling_reviews_paused_bak;

-- ⚠️ 期望值：bak_rows = 43，done_rows = 0，focus_sec = 22
--   若 bak_rows ≠ 43 → **停在这里，不要执行第 3 段**，把结果发我。

-- ---------- 3. 删掉 paused 表里的历史残留（保留 tasks 现存 id 对应的 43 行）----------
delete from public.rolling_reviews_paused p
where not exists (select 1 from public.tasks t where t.id = p.id);

-- ---------- 4. 终检：应恰好 43 行、day_num 1..43 各1 行 ----------
select count(*) as paused_rows,
       count(distinct day_num) as distinct_days,
       count(*) filter (where done) as done_rows,
       sum(total_focus_sec) as focus_sec
from public.rolling_reviews_paused;

-- ⚠️ 期望值：paused_rows = 43、distinct_days = 43、done_rows = 0、focus_sec = 22
--   完全吻合 → 可以执行「sql/生理学暂停迁移-20261008.sql」的第 4 段删除，
--   把physio 从 tasks 移出。

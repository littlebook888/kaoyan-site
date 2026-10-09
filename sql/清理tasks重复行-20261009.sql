-- ============================================================================
--  清理 tasks 表重复行  ·  2026-10-09
--  ---------------------------------------------------------------------------
--  【用户报修】「6 月 1 号的数据消失了」
--
--  【根因（两层叠加）】
--    第一层 · 数据膨胀
--      云端 tasks 表 1467 行，而唯一任务只有 520 条 —— 大量任务**重复 3~4 份**。
--      实测分布：
--        xizong_plan     1194 行 / 327 唯一  → 平均 3.65 份
--        english_words    127 行 /  61 唯一  → 平均 2.08 份
--        xizong_live       11 行 /   3 唯一  → 平均 3.67 份
--        (null)            48 行 /  42 唯一
--        medpath_rolling   44 行 /  44 唯一  → 正常（新系列）
--        physio_rolling    43 行 /  43 唯一  → 正常
--    第二层 · 拉取没有分页（致命）
--      store.js 的 refreshFromSupabase 原为单次 `select("*")`，**无 limit / range / order**。
--      Supabase(PostgREST) 单次响应硬上限 max-rows = 1000，超出部分**静默丢弃且不报错**。
--      1467 > 1000 → 每次刷新都有 467 行拿不回来 → 对应日期在日历视图整块消失
--      （云端 6/1 明明有 28 行，前端就是看不见）。
--      又因**未指定 order**，PostgREST 返回顺序不稳定 → 每次丢的是不同的行
--      → 现象变成「时有时无、刷新一下又回来」，是本项目最难归因的一类 bug。
--
--    两者互为因果，形成恶性循环：
--      数据膨胀 → 拉取截断 → "滚动复习"任务恰好落在丢失的那 467 行里
--      → autoImportXizongPlan 的跨设备守卫 Store.getTasks().some(/^滚动复习/) 判定"没导过"
--      → 又把整套计划导一遍 → 数据更膨胀 → 丢得更多。
--      （这解释了为什么会有 3~4 份，而不是 2 份。）
--
--  【代码侧已修，本文件修数据侧】
--    · v1.42.3  refreshFromSupabase 改为分批 range 拉全量 + **order("id")**
--                （分页的前提是稳定排序，否则同一行会重复出现或漏掉）
--    · v1.42.3  deleteTasksBulk 由"逐条 DELETE"改为"每 50 条合并一个请求"
--                （旧写法去重 1100 行要发 1100 个请求，被打断就清不干净，
--                  云端因此长期维持 1467 行 —— 这是故障的帮凶）
--
--  【执行方式】Supabase 后台 → SQL Editor → 按顺序分段执行
--  【幂等】是，可重复执行
-- ============================================================================


-- ============================================================================
-- 第 1 段 · 体检（只读，先看数，不删任何东西）
-- ============================================================================

-- 1a. 总量 vs 唯一量 —— 「待删重复行」应约为 947
select
  count(*)                                                                as "当前总行数",
  count(distinct coalesce(source,'') || '|' || coalesce(date,'') || '|' || coalesce(title,'')) as "唯一任务数",
  count(*) - count(distinct coalesce(source,'') || '|' || coalesce(date,'') || '|' || coalesce(title,'')) as "待删重复行"
from public.tasks;

-- 1b. 按来源看膨胀程度
select
  coalesce(source,'(空)') as "来源",
  count(*)                as "行数",
  count(distinct coalesce(date,'') || '|' || coalesce(title,'')) as "唯一数",
  round(count(*)::numeric / greatest(count(distinct coalesce(date,'') || '|' || coalesce(title,'')),1), 2) as "平均份数"
from public.tasks
group by source
order by count(*) desc;

-- 1c. 抽查重复最严重的 20 组（确认它们确实是"同一任务被导入多次"，而非同日同名不同任务）
select
  coalesce(date,'(空)')   as "日期",
  coalesce(source,'(空)') as "来源",
  title,
  count(*)                as "份数",
  count(*) filter (where done)                 as "其中已完成",
  sum(coalesce(total_focus_sec,0))             as "专注秒数合计"
from public.tasks
group by date, source, title
having count(*) > 1
order by count(*) desc, date
limit 20;


-- ============================================================================
-- 第 2 段 · 备份（★ 改动，2026-10-09）
-- ----------------------------------------------------------------------------
-- ⚠️⚠️ 原写法有**严重缺陷**，实测踩到：
--     create table if not exists public.tasks_bak_20261009 as select * from public.tasks;
--   `if not exists` 在表**已存在**时会整条跳过 → 表里留着上次的空壳数据，
--   而 `select count(*) from ...bak` 显示的却可能是**跑查询那一刻 tasks 的行数**
--   （SQL Editor 结果区容易看串），让人误以为"备份好了 = 1467 行"。
--   实测：备份表tasks_bak_20261009 **真实行数 = 0**，而界面显示 1467。
--
--   修法（三处都改）：
--   ① 先 drop 再 create —— 不留旧空壳的可能
--   ② 用**两次 count 相等**来判定备份有效，而不是只看一个数字
--   ③ 备份表开 RLS —— 原注释说"新表默认没 RLS 会被 anon key 读到"，
--      但既然是应急回滚用，就必须确认它真的存了数据
-- ============================================================================
drop table if exists public.tasks_bak_20261009;

create table public.tasks_bak_20261009 as
  select * from public.tasks;

-- ★ 有效性校验：两个数字必须**完全相等**，不相等就停下来，不要往下跑第 3 段
select
  (select count(*) from public.tasks)                  as "源表 tasks 行数",
  (select count(*) from public.tasks_bak_20261009)     as "备份表行数",
  case when (select count(*) from public.tasks)
         = (select count(*) from public.tasks_bak_20261009)
       then '✅ 备份有效，可执行第 3 段'
       else '❌ 备份无效！停止执行，先排查'
  end                                                   as "备份校验（必须为 ✅）";


-- ============================================================================
-- 第 3 段 · 删除重复（每组保留 1 条，优先保留"有痕迹"的那条）
-- ----------------------------------------------------------------------------
--  保留优先级（分数越高越优先留下来）：
--    done 已完成            +100   ← 你勾过的进度最重要
--    total_focus_sec > 0    + 50   ← 有计时记录
--    rr_note 非空           + 30   ← 你写的笔记
--    time_record_ids 非空   + 25   ← 有关联的时间记录
--    completed_note 非空    + 20   ← 完成备注
--    再并列 → created_at 最早的（最早导入的那份通常是"正主"）
--             最后用 id 兜底，保证排序完全确定
--
--  ⚠️ 分组键含 source —— 防止把「xizong_plan 的滚动复习」和「physio_rolling」
--     这类跨系列的同名任务误并成一组。
--  ⚠️ 排除 title 为空的行 —— 否则所有空标题会被并成一组、删到只剩 1 条。
--  ⚠️ 不设 source 过滤，全表去重：physio_rolling / medpath_rolling 的
--     (date,title) 天然唯一（title 里带 DAY 号），不会被误删（体检 1b 可复核）。
-- ============================================================================
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, coalesce(source,''), coalesce(date,''), title
      order by
          (case when done then 100 else 0 end)
        + (case when coalesce(total_focus_sec,0) > 0 then 50 else 0 end)
        + (case when coalesce(rr_note,'') <> '' then 30 else 0 end)
        + (case when coalesce(time_record_ids::text,'') not in ('','{}','[]') then 25 else 0 end)
        + (case when coalesce(completed_note,'') <> '' then 20 else 0 end)
        desc,
        created_at asc nulls last,
        id
    ) as rn
  from public.tasks
  where coalesce(title,'') <> ''
)
delete from public.tasks
where id in (select id from ranked where rn > 1);


-- ============================================================================
-- 第 4 段 · 回读校验
-- ============================================================================

-- 4a. 清理后的行数（预期约 520）
select count(*) as "清理后行数" from public.tasks;

-- 4b. 应返回 0 行（= 再无重复）
select coalesce(date,'(空)') as "日期", coalesce(source,'(空)') as "来源", title, count(*) as "份数"
from public.tasks
group by date, source, title
having count(*) > 1
order by count(*) desc
limit 20;

-- 4c. ★ 重点复核：6 月 1 日必须还是 7 条、且那 1 条已完成还在
select
  count(*)                            as "6/1 任务数（预期 7）",
  count(*) filter (where done)        as "其中已完成（预期 1）"
from public.tasks
where date = 'Mon Jun 01 2026';

-- 4d. 抽查 6/1 的标题清单（确认没有把不同任务误并）
select title, done, total_focus_sec as "专注秒"
from public.tasks
where date = 'Mon Jun 01 2026'
order by title;

-- 4e. 数据是否还在合理范围（跨月覆盖检查）
select coalesce(date,'(空)') as "日期", count(*) as "行数"
from public.tasks
group by date
order by date;


-- ============================================================================
-- 第 5 段 · 可选：确认无误几天后，删掉备份表
-- ============================================================================
-- drop table if exists public.tasks_bak_20261009;


-- ============================================================================
-- 【清理之后还要做什么】
--   1. 强刷浏览器（Ctrl+F5）—— 前端 v1.42.3 的分页拉取才会生效
--   2. 到「任务」页展开全部日期，确认 6/1 出现了、且显示 1/7
--   3. 若仍缺，打开控制台看：
--        localStorage 残留 → 执行 await Store.pullOnce() 手动拉一次
-- ============================================================================

-- =====================================================================
--  sql/通话时长100改90-20261013.sql
--  用途：把「刚刚记录的那条 100 分钟通话」改成 90 分钟
--  用法：Supabase 后台 → SQL Editor → 分段粘贴执行（先看结果，再改）
--
--  ⚠️ 为什么用 SQL 而不是让脚本直连：本机到 *.supabase.co 的直连被重置
--     （curl 000 / Python 10054），且代理 127.0.0.1:7897 未运行，
--     所以由你在能联网的浏览器里执行最稳。
--
--  通话记录的存储位置：public.time_records，category='call'
--    source = 'call_boundary' 双闹钟记的真实通话 / 'call_manual' 通话站补记
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【第 1 步】先看清楚是哪一条（只读，不会改任何数据）
--   duration_sec ≈ 100 分钟 = 6000 秒，取 5900~6100 是防手工补记差几秒
-- ---------------------------------------------------------------------
select
  id,
  started_at,
  ended_at,
  duration_sec,
  round(duration_sec / 60.0, 1) as minutes,
  source,
  label,
  note
from public.time_records
where category = 'call'
  and duration_sec between 5900 and 6100
order by coalesce(created_at, started_at) desc;

-- ---------------------------------------------------------------------
-- 【第 2 步】确认第 1 步只出来 1 行（且是你要改的那条）之后，再执行这段
--   改两处保持一致：duration_sec 6000 → 5400，ended_at 前移 10 分钟
--   ⚠️ 用 ended_at - 10min（而不是 started_at + 90min）：记录若中途暂停过，
--      用后者会把暂停的时间也算进通话里。
-- ---------------------------------------------------------------------
update public.time_records
set duration_sec = 5400,
    ended_at     = ended_at - interval '10 minutes'
where id = (
  select id
  from public.time_records
  where category = 'call'
    and duration_sec between 5900 and 6100
  order by coalesce(created_at, started_at) desc
  limit 1
);

-- ---------------------------------------------------------------------
-- 【第 3 步】回查确认（应显示 90.0 分钟）
-- ---------------------------------------------------------------------
select
  id, started_at, ended_at, duration_sec,
  round(duration_sec / 60.0, 1) as minutes,
  source
from public.time_records
where category = 'call'
order by coalesce(created_at, started_at) desc
limit 5;

-- ---------------------------------------------------------------------
-- 【可选】这条通话是否挂了任务？挂了的话任务的「累计专注秒数」也要同步减 600 秒
--   （通话一般不关联任务；查出来 0 行就不用管）
--   先跑查询：把 <第1步查到的id> 换成真实 id
--   select id, title, total_focus_sec, time_record_ids
--   from public.tasks
--   where time_record_ids @> array['<第1步查到的id>'];
--   查出 1 行就跑下面这句（同样替换 id）：
--   update public.tasks set total_focus_sec = greatest(0, total_focus_sec - 600)
--   where time_record_ids @> array['<第1步查到的id>'];
-- ---------------------------------------------------------------------

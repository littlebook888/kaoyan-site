-- =====================================================================
--  sql/schema.sql —— Supabase 建表（免费 Postgres）
--  用途：手机/电脑/平板「跨设备」实时同步。
--  用法：登录 Supabase → 选你的 project → SQL Editor → 粘贴本文件 → Run。
--  之后在 static/js/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。
--  注意：本 schema 为演示用，已放宽 RLS 便于单用户自用；
--        若多人共用请自行加行级安全策略。
-- =====================================================================

-- 活动计时会话（单行/单用户，三端同跑同控）
create table if not exists active_timer (
  user_id       text primary key,
  mode          text,                 -- countup | countdown
  kind          text,                 -- study | break | free
  label         text,
  status        text,                 -- running | paused | stopped
  started_at    bigint,               -- 开始时间戳(ms)
  duration_sec  integer,              -- 倒计时设定时长
  elapsed_sec   numeric default 0,    -- 暂停时累计
  updated_at    bigint
);

-- 学习记录（旧表，兼容保留）
create table if not exists study_sessions (
  id            text primary key,
  user_id       text,
  type          text,
  kind          text,
  duration_sec  integer,
  label         text,
  started_at    timestamptz,
  ended_at      timestamptz
);

-- ⭐ 时间记录系统（新主线表，对标爱时间/时间日志）
-- 所有时间块的唯一真相来源，计时器/吃饭按钮等都写入这里
create table if not exists time_records (
  id              text primary key,
  user_id         text,
  category        text default 'study',    -- study | break | meal | sleep | commute | free | other
  sub_category    text,                     -- 二级分类/细项（如 西综/英语/午饭）
  label           text,                     -- 显示名称
  tags            text[] default '{}',      -- 标签数组（对标时间日志）
  started_at      timestamptz,              -- 开始时间
  ended_at        timestamptz,              -- 结束时间
  duration_sec    integer,                  -- 持续秒数
  source          text,                     -- 来源：timer_countup | timer_countdown | meal_button | manual
  block           text,                     -- 归属大块：morning | afternoon | evening（自动判定）
  note            text,                     -- 备注
  task_id         text,                     -- 关联的任务 ID
  created_at      timestamptz
);
-- 已存在旧表时补列
alter table time_records add column if not exists category text default 'study';
alter table time_records add column if not exists sub_category text;
alter table time_records add column if not exists tags text[] default '{}';
alter table time_records add column if not exists source text;
alter table time_records add column if not exists block text;
alter table time_records add column if not exists note text;
alter table time_records add column if not exists created_at timestamptz;
alter table time_records add column if not exists segments jsonb;
alter table time_records add column if not exists task_id text;

-- 任务打卡
create table if not exists tasks (
  id                  text primary key,
  user_id             text,
  title               text,
  done                boolean default false,
  date                text,
  category            text default 'general',   -- general | course | internship | block
  slot                text,                      -- 课程表排课：星期-节次，如 "1-3"（周一第3节）
  block               text,                      -- 归属学习大块：morning | afternoon | evening
  subject             text default 'other',     -- 科目：xizong | english | politics | other
  task_type           text default 'other',     -- 类型：course(听课) | review(复习) | problem(刷题) | other
  estimated_min       integer,                   -- 预估时长（分钟），仅提醒不自动停止
  remind_on_estimate  boolean default true,     -- 预估时间到了是否提醒
  total_focus_sec     integer default 0,        -- 累计专注秒数（多次计时累加，跨天保留）
  status              text default 'todo',      -- todo | running | paused | done
  time_record_ids     text[] default '{}',      -- 关联的时间记录 ID 数组
  created_at          timestamptz
);
-- 已存在旧表时补列（新项目直接走上面的 create，不会重复）
alter table tasks add column if not exists category text default 'general';
alter table tasks add column if not exists slot text;
alter table tasks add column if not exists block text;
alter table tasks add column if not exists subject text default 'other';
alter table tasks add column if not exists task_type text default 'other';
alter table tasks add column if not exists estimated_min integer;
alter table tasks add column if not exists remind_on_estimate boolean default true;
alter table tasks add column if not exists total_focus_sec integer default 0;
alter table tasks add column if not exists status text default 'todo';
alter table tasks add column if not exists time_record_ids text[] default '{}';

-- 日程 / 倒计时节点
create table if not exists events (
  id           text primary key,
  user_id      text,
  title        text,
  date         text
);

-- 目标（考研目标 → 每日时长）
create table if not exists goals (
  id            text primary key,
  user_id       text,
  name          text,
  target_hours  numeric,
  deadline      text
);

-- 为 Realtime 订阅放开权限（演示用，单用户）
alter table active_timer enable row level security;
alter table time_records enable row level security;
alter table study_sessions enable row level security;
alter table tasks enable row level security;
alter table events enable row level security;
alter table goals enable row level security;

-- 匿名 key 可读写（仅演示；生产请细化）
create policy "anon_all_active_timer" on active_timer for all using (true) with check (true);
create policy "anon_all_time_records" on time_records for all using (true) with check (true);
create policy "anon_all_study_sessions" on study_sessions for all using (true) with check (true);
create policy "anon_all_tasks" on tasks for all using (true) with check (true);
create policy "anon_all_events" on events for all using (true) with check (true);
create policy "anon_all_goals" on goals for all using (true) with check (true);

-- 开启 Realtime（监听这些表）
alter publication supabase_realtime add table active_timer;
alter publication supabase_realtime add table time_records;
alter publication supabase_realtime add table study_sessions;
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table goals;

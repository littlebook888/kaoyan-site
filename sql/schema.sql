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
  kind          text,                 -- study | break | free（一级分类 key）
  label         text,                 -- 显示名称
  status        text,                 -- running | paused | stopped
  started_at    bigint,               -- 当前段开始时间戳(ms)；暂停时为 null
  duration_sec  integer,              -- 倒计时设定时长（countup 时为 null）
  elapsed_sec   numeric default 0,    -- 暂停时累计的已过秒数
  updated_at    bigint,               -- 最后一次写更新的时间戳（ms），用于辅助排序
  -- ⭐ 冲突检测：单调递增版本号（比时间戳靠谱，LWW-Register 标准实现）
  --   写入规则：期望 version = local.last_version，若远端 version 不匹配 → 放弃写入，拉远端最新
  version         bigint default 0,
  -- 产生本次状态变更的最后一次操作 ID（用于 ack 确认）
  last_op_id      text,
  -- ↓ 扩展字段（跨设备同步 UI 状态 / 任务关联 / 暂停段所需）
  sub_category      text,             -- 二级分类 key（如 xizong / english / long_sleep）
  tags              text[] default '{}', -- 标签数组
  segments          jsonb,            -- 暂停/继续分段记录：[{start,end}, ...]
  first_started_at  bigint,           -- 首次开始时间戳(ms)，用于跨暂停的"总专注时长"基准
  task_id           text,             -- 关联任务 ID（任务模式计时用）
  note              text              -- 备注（如任务标题、进入状态说明）
);
-- 已存在旧表时补列（已有 active_timer 表的旧用户执行本段不会报错）
alter table active_timer add column if not exists version          bigint default 0;
alter table active_timer add column if not exists last_op_id       text;
alter table active_timer add column if not exists sub_category     text;
alter table active_timer add column if not exists tags            text[] default '{}';
alter table active_timer add column if not exists segments         jsonb;
alter table active_timer add column if not exists first_started_at bigint;
alter table active_timer add column if not exists task_id          text;
alter table active_timer add column if not exists note             text;

-- ⭐ 操作同步日志（Outbox Pattern，对照 Todoist / 滴答清单）
-- 所有用户操作（START/PAUSE/STOP/RESUME）都先入本地队列，写入远端 + ack 后才出队
-- 用途：1) 离线重连后自动重放操作 2) 幂等去重（按 op_id）3) 冲突检测
create table if not exists sync_ops (
  op_id       text primary key,        -- 客户端生成的唯一 ID（UUID），用于幂等去重
  user_id     text not null,           -- 所属用户
  device_id   text not null,           -- 发起操作的设备 ID
  op_type     text not null,           -- START | PAUSE | RESUME | STOP | SET（覆盖写入）
  payload     jsonb,                   -- 操作参数（新的 active_timer 状态）
  created_at  bigint not null,         -- 客户端发起时间戳(ms)，用于排序
  applied     boolean default false    -- 是否已被应用到 active_timer（服务端已处理）
);
create index if not exists idx_sync_ops_user_created on sync_ops(user_id, created_at);

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
alter table sync_ops enable row level security;

-- 匿名 key 可读写（仅演示；生产请细化）
create policy "anon_all_active_timer" on active_timer for all using (true) with check (true);
create policy "anon_all_time_records" on time_records for all using (true) with check (true);
create policy "anon_all_study_sessions" on study_sessions for all using (true) with check (true);
create policy "anon_all_tasks" on tasks for all using (true) with check (true);
create policy "anon_all_events" on events for all using (true) with check (true);
create policy "anon_all_goals" on goals for all using (true) with check (true);
create policy "anon_all_sync_ops" on sync_ops for all using (true) with check (true);

-- 开启 Realtime（监听这些表）
alter publication supabase_realtime add table active_timer;
alter publication supabase_realtime add table time_records;
alter publication supabase_realtime add table study_sessions;
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table goals;
alter publication supabase_realtime add table sync_ops;

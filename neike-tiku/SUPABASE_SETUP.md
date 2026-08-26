# 题库多端同步 · Supabase 建库与接入指南

> 说明：原「天天师兄学成选择题」题库前端是单机版（数据只存浏览器 localStorage）。
> 我们要把它升级为「本地 + Supabase 云端双写」，从而多端（手机/电脑/平板）进度互通。
> 下面是你需要按步骤完成的云端部分。

---

## 第 1 步 · 注册并创建 Supabase 项目（免费）

1. 打开 https://supabase.com （用 GitHub 或邮箱注册，免费版够用，无需绑卡）
2. 点击 **New project**
3. 填：
   - **Name**：如 `kaoyan-quiz`
   - **Database Password**：设一个，记下来
   - **Region**：选离你近的（可选 `ap-northeast-1` 东京 / `ap-southeast-1` 新加坡）
4. 点 **Create new project**，等 1~2 分钟初始化

## 第 2 步 · 获取连接凭据

项目建好后，左侧栏点 **Project Settings → API**（或首页快捷入口）：

复制两个值给我们（我用来配置题库的 `config`）：

| 名称 | 在哪 | 形如 |
|---|---|---|
| **Project URL** | `Project URL` 一栏 | `https://xxxxxxxx.supabase.co` |
| **anon public key** | `anon` / `publishable` 一栏 | `eyJhbGciOiJIUzI1NiIs...` |

> 抄给开发者即可。游戏较个人，key 属公开可读、无写敏感权限的表不影响。

## 第 3 步 · 建数据表

左侧栏点 **SQL Editor**，粘贴下面 SQL，点 **Run**（一次跑完全部）：

```sql
-- 题库多端同步：一张表存所有需要云端备份的状态
-- scope 与前端 localStorage 键一一对应（med-selections / med-submitted
-- / med-favorites / med-notes / study-subject），按 updated_at 后写优先合并
create table if not exists public.quiz_state (
  scope       text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- 开启行级安全（默认挡住匿名访问，下一步再放开读/写）
alter table public.quiz_state enable row level security;
```

> 若弹「RLS 会挡住匿名增删改」属正常，执行第 4 步即可。

## 第 4 步 · 允许匿名读/写（个人使用，先连通用）

SQL Editor 再跑一次：

```sql
create policy "anon select" on public.quiz_state for select using (true);
create policy "anon upsert" on public.quiz_state for insert with check (true);
create policy "anon update" on public.quiz_state for update using (true) with check (true);
```

> 说明：这是「单库单用户」个人用途配置——谁持有本项目、用这套 anon key 访问，就共享这套题库进度。若日后要多人隔离，可给每行加 `user_id` 字段并按用户过滤，但个人备考场景不建议提前加复杂度。

---

## 完成后

把 **Project URL** 和 **anon key** 发给我，我把它写进题库的配置文件，本地验证同步（改一题 → 手机上能看到），再考虑部署到可公网访问的地址（GitHub Pages / Cloudflare Pages）。
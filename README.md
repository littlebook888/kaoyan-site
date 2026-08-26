# 考研个人网站 · 项目维护文档（交接版）

> 本文档面向**接手维护的开发者 / AI**。请先完整阅读本文档再动代码。
> 它记录了项目全貌、技术决策、已实现功能、待办事项与维护约定。
> 文档更新日期：2026-08-25

> ⚠️ **重要**：本文档为早期维护版，**部分信息已过时**（时间块边界、分类体系等已升级）。
> 接管编辑前请**务必先读根目录的《交接文档.md》**（2026-08-26 最新需求基线），本文档仅作架构底子补充。

---

## 0. TL;DR（30 秒速览）

- **这是什么**：用户（福建医科大学大四放射医学，考研备战中）的个人考研网站——**三套系统架构**：时间记录系统（主线）+ 计时器系统（正计/倒计）+ 三块展示系统（早中晚）。带三端（手机/电脑/平板）同步，纯免费。
- **技术形态**：**纯静态 HTML/CSS/JS，零构建、零框架、零依赖**（刻意为之，用户日后要自己改）。
- **当前状态**：功能完备，本地可跑（`127.0.0.1:8099` 预览中）；**未部署线上**，**跨设备同步尚未启用**（等用户提供 Supabase key）。
- **视觉**：苹果官网风格卡片 UI + 洛天依蓝（#66ccff）点缀。
- **三套系统关系**：① 时间记录系统（time_records = 主线/账本，对标爱时间/时间日志）② 计时器（正计=打点/倒计时=工具，写入时间记录）③ 三块系统（仅展示 +「开始吃饭」按钮 → 写入吃饭记录）。
- **个性化**：三餐切分的「早块/午块/晚块」大块学习体系（用户的核心心智模型）+ 隐藏的「浪前」成长知识角落 + 7 分类时间轴 + 标签系统。
- **接手第一件事**：读第 5 节（同步层）、第 6 节（三套系统数据模型）和第 10 节（待办），其余按需查阅。

---

## 1. 快速上手（本地运行）

```bash
cd "D:/Agentwork/workbuddy/考研个人网站管理系统"
python -m http.server 8099 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8099/index.html
```

- 必须是 HTTP 服务器方式访问（`file://` 直开会导致 fetch/sw/BroadcastChannel 异常）。
- 四个页面：`index.html`（首页）/ `timer.html`（计时器）/ `tasks.html`（任务）/ `stats.html`（统计）。
- 页面间通过底部胶囊导航跳转；右上角悬浮「静音 / 图书馆模式」按钮、顶部同步徽标由 `ui.js` 注入。

---

## 2. 技术栈与设计原则（不可违背）

| 原则 | 说明 |
|---|---|
| **纯静态、零构建** | 无 npm/webpack/vite/framework。新增任何依赖都须先评估：能否本地化、是否零构建 |
| **全免费（¥0）** | 托管走 GitHub Pages / Vercel 免费档，同步走 Supabase 免费档，图标走 Lucide（MIT）本地化 |
| **洛天依只做风格致敬** | 只允许 #66ccff 主色 + **原创** SVG（音波/缎带/歌姬剪影）。**严禁搬运官方立绘、歌曲、版权图** |
| **浪前只放原创占位** | `langqian/` 内是原创的成长方法论占位内容，标注「可替换」，不复制课程原文 |
| **用户能自己改** | 所有可调参数集中在 `static/js/config.js`（作息、目标、主题色），日常改这里即可 |
| **北京时间统一** | 全站时间判定统一经 `clock.js`（实时时钟）与 `blocks.js`（大块判定），**禁止各模块自行取本地时间**（否则跨设备不同时区会判定不一致） |

---

## 3. 目录结构（全部文件）

```
考研个人网站管理系统/
├── README.md                  ← 本文档
├── index.html                 首页：考研倒计时 + 实时时钟 + 今日三块 + 时间安排饼图 + 快速计时入口
├── timer.html                 计时器页：正/倒计时、手机风数字键盘、拖动/滚轮调节、快速芯片、大块芯片
├── tasks.html                 任务页：列表/方格/课程表三视图、类目、归属大块、块筛选
├── stats.html                 统计页：热力图、核心数据、学霸指数、导出
├── manifest.webmanifest       PWA 清单（图标/名称/主题色/独立窗口）
├── sw.js                      Service Worker：离线缓存应用外壳（当前缓存版本 kaoyan-v4）
├── sql/
│   └── schema.sql             Supabase 建表 SQL（含补列语句，直接执行即可）
├── assets/
│   ├── icon.svg               站标（原创 66ccff 音波风）
│   └── icons/                 54 个 Lucide 线性图标（本地化 SVG，用 currentColor 跟随主题）
├── langqian/
│   └── langqian.js            浪前「成长角落」：原创方法论占位 + 隐藏入口（页脚折叠/侧滑抽屉/左下角微光）
└── static/
    ├── css/
    │   └── theme.css          全部样式：苹果风卡片、玻璃拟态、洛天依蓝、三块卡片、时钟、饼图、课程表…
    └── js/
        ├── config.js          ⭐ 全局配置中心（Supabase key、初试日期、作息边界、目标时长、主题色）
        ├── clock.js           实时北京时间时钟 + 当日进度条（四页顶部 #liveClock）
        ├── blocks.js          三餐大块判定：blockOf/currentKey/remainingSeconds/blockDurationSec
        ├── store.js           ⭐ 同步层核心（localStorage + BroadcastChannel + Supabase Realtime 三层）
        ├── ui.js              共享 UI：静音/图书馆模式、同步徽标、浪前抽屉、alert
        ├── icon.js            Lucide 图标注入器（data-icon → 本地 SVG）
        ├── reveal.js          滚动入场动画（IntersectionObserver + CSS，零依赖）
        ├── home.js            首页逻辑（倒计时/三块/饼图/快速计时）
        ├── timer.js           计时器逻辑（数字模型/正倒切换/闹钟/三端活动会话）
        ├── tasks.js           任务逻辑（三视图/类目/块筛选/排课）
        └── stats.js           统计逻辑（热力图/学霸指数/导出）
```

**页面脚本加载顺序**（四页一致，勿乱）：`config.js` → `clock.js`（首页/计时/任务/统计）→ `blocks.js`（首页/计时）→ `store.js` → `ui.js` → `icon.js` → `reveal.js` → 各页业务 js。`sw.js` 在 HTML 末尾注册。

---

## 4. 已实现功能清单（三套系统）

### 🎯 第一套：时间记录系统（主线 / 核心）
- **`time_records` 表** = 所有时间块的唯一真相来源（对标爱时间/时间日志）。
- **7 大分类**：学习 🟦 / 休息 🟩 / 吃饭 🍚 / 睡觉 😴 / 通勤 🚗 / 自由 🟠 / 其他 ⬜（颜色/图标可配置）。
- **标签系统**：每条记录可打多个标签（高效/低效/西综/英语...），支持常用标签快速选择 + 自定义输入。
- **首页饼图 + 时间轴双视图**：可切换查看当日时间分布（环形饼图 / 横向时间轴，对标爱时间）。
- **统计页**：热力图（仅学习）+ 今日分类明细 + 全量 CSV 导出。
- **旧数据自动迁移**：`study_sessions` 表数据静默迁移到 `time_records`，无感知升级。

### 4.1 第二套：计时器系统
- **正计时 = 打点计时模式**：开始=打卡上班，停止=打卡下班，自动写入时间记录。开始前可选分类和标签。
- **倒计时**：独立工具，学/休/自由类结束后默认写入时间记录。
- **手机风输入**：倒计时大屏 `HH:MM:SS` 数字键盘直接输入 + 拖动/滚轮微调 + 快速芯片 + 大块芯片。
- **闹钟**：计时结束 → 站内响铃（Web Audio 合成音）+ Notification 通知；洛天依风提示。
- **三端活动会话**：开始/暂停/停止经 `active_timer` 单行同步，任意一端控制全端同跑同控。

### 4.2 第三套：三块展示系统（早/午/晚）
- **纯展示**：早块/午块/晚块三张卡片，显示时间窗、各块已学时长、目标进度条；当前块高亮标「现在」+ 剩余时间。
- **学习进度**：从时间记录系统按 `category=study` 统计，不反向修改时间记录。
- **「开始吃饭」按钮**（唯一操作）：点击后写入一条 `meal` 类时间记录（默认 30 分钟，可配置，分度值 5 分钟）。早块→午饭、午块→晚饭。
- 凌晨 0:00–起床时间归为晚块夜学。

### 4.3 任务页 `tasks.html`
- **三视图切换**：列表 / 方格 / 课程表（7 天 × 12 节周网格）。
- **类目**：普通 / 课程 / 实习 / 大块学习；非普通类可排「星期-节次」落进课程表。
- **归属大块**：任务可选归属 早/午/晚 块；顶部按块筛选。
- **与时间记录系统的关系**：默认独立不关联，配置项 `TASKS_LINK_TO_TIME_RECORDS` 预留开关。

### 4.4 全局能力
- **全局静音** + **图书馆模式**（静音/振动/闪光，防图书馆外放；由 `ui.js` 控制）。
- **PWA**：manifest + sw.js 离线缓存应用外壳（当前 v5），手机「添加到主屏幕」即变 App。
- **浪前成长角落**：原创占位内容藏在页脚折叠、侧滑抽屉、左下角微光 hover 处。

---

## 5. 同步层设计（核心，接手必读）

`store.js` 是唯一数据出入口，三层写入，**任何功能读写数据必须走 Store API，禁止直读 localStorage**：

```
写入路径：  业务代码 → setLocal(key, value)
            ├─ ① localStorage（本机持久化，兜底）
            ├─ ② BroadcastChannel + storage 事件（同浏览器多标签实时）
            └─ ③ Supabase Realtime（跨设备，仅当 SUPABASE_URL 已配置；整表覆盖式同步）
读取路径：  getLocal(key) → ① 有 Supabase 则先 pullOnce 拉远端 → ② 返回本地
```

**Store 公开 API**（`window.Store`）：

| API | 说明 |
|---|---|
| `isCloud()` | 是否已配置 Supabase 并连上（决定同步徽标显示云端/本机） |
| `pullOnce()` | 首次进入拉一次远端全量数据 |
| `getActiveTimer() / setActiveTimer(obj) / subscribeActiveTimer(cb)` | **活动计时单行**（三端同跑同控核心） |
| `getTimeRecords() / addTimeRecord(rec) / updateTimeRecord(id,patch) / deleteTimeRecord(id) / subscribeTimeRecords(cb)` | ⭐ **时间记录（主线表）** |
| `getSessions() / addSession(s) / subscribeSessions(cb)` | 学习记录（旧表，兼容保留，自动双写） |
| `getTasks() / addTask(t) / updateTask(id, patch) / subscribeTasks(cb)` | 任务打卡 |
| `getEvents() / addEvent(e) / subscribeEvents(cb)` | 日程/倒计时节点 |
| `getGoals() / setGoals(arr) / subscribeGoals(cb)` | 目标 |

**数据键**：`active_timer`(单行对象) / **`time_records`(数组，主线)** / `study_sessions`(旧表，兼容) / `tasks`(数组) / `events`(数组) / `goals`(数组)。

**⚠️ 易错点**：
- 时间记录是**整对象数组**同步：给对象加新字段时，**必须同步给 Supabase 表补列**（`sql/schema.sql`），否则跨设备会丢字段。
- `active_timer` 停止时应**删除行**而非留空（`store.js` 已处理 delete 分支，改动时勿破坏）。
- Supabase 未配置时一切照常工作（只本机 + 同浏览器多标签），全站不报错。
- 旧数据迁移：首次读取 `time_records` 时自动从 `study_sessions` 迁移，老用户无感知。

---

## 6. 数据模型（三套系统 · Supabase 表，见 `sql/schema.sql`）

### 6.1 时间记录系统（主线表 time_records）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text | 唯一 ID |
| `user_id` | text | 用户 ID（同步用） |
| `category` | text | 一级分类：`study` / `break` / `meal` / `sleep` / `commute` / `free` / `other` |
| `sub_category` | text | 二级分类/细项（如 西综/午饭） |
| `label` | text | 显示名称 |
| `tags` | text[] | 标签数组（对标时间日志） |
| `started_at` | timestamptz | 开始时间 |
| `ended_at` | timestamptz | 结束时间 |
| `duration_sec` | integer | 持续秒数 |
| `source` | text | 来源：`timer_countup` / `timer_countdown` / `meal_button` / `manual` |
| `block` | text | 归属大块：`morning` / `afternoon` / `evening`（按开始时间自动判定） |
| `note` | text | 备注 |
| `created_at` | timestamptz | 创建时间 |

**分类颜色体系**（`config.js` 的 `TIME_CATEGORIES` 可配置）：
- 🟦 学习 `#66ccff` · 🟩 休息 `#22c79a` · 🍚 吃饭 `#f5a623` · 😴 睡觉 `#9b8cff` · 🚗 通勤 `#ff7eb9` · 🟠 自由 `#ff9f43` · ⬜ 其他 `#b0b7c3`

### 6.2 其他表

| 表 | 关键列 | 说明 |
|---|---|---|
| `active_timer` | user_id, mode, started_at, duration_sec, label, status | 单行活动计时（三端同跑同控） |
| `study_sessions` | user_id, type, kind, duration_sec, started_at, ended_at | 旧学习记录表（兼容保留，自动双写） |
| `tasks` | user_id, title, done, date, **category**, **slot**, **block** | 任务打卡（独立系统，预留关联开关） |
| `events` | user_id, title, date | 日程/倒计时节点 |
| `goals` | user_id, name, target_hours, deadline | 目标 |

> 已存在的表会自动补列（`alter table ... add column if not exists`），直接整段执行 schema.sql 即可。

---

## 7. 配置中心（`static/js/config.js`）

用户日常只改这一个文件：

| 配置 | 当前值 | 说明 |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | `""`（**待填**） | 填了才能跨设备同步 |
| `USER_ID` | `"kaoyan_user_default"` | 跨设备填同一字符串即共享数据 |
| `EXAM_DATE` | `"2026-12-19"`（**占位待改**） | 真实考研初试日期 |
| `DAILY_GOAL_HOURS` | `8` | 每日目标学习小时数 |
| `TIME_BLOCKS` | wake 08:00 / lunch 12:00 / dinner 17:30 / sleep 23:40 | 三餐边界，用户已敲定；23:40 后进入加时自习（详见《交接文档.md》） |
| `BLOCK_GOAL_HOURS` | morning 3 / afternoon 2.5 / evening 2.5 | 各块目标时长 |
| `THEME_COLOR` | `#66ccff` / `#3399ee` | 洛天依蓝 |
| `TIME_CATEGORIES` | 7 分类（学/休/饭/睡/通勤/自由/其他） | 时间记录分类体系，可改颜色图标 |
| `COMMON_TAGS` | 高效/低效/专注/摸鱼/西综/英语/政治/刷题/背书/听课 | 常用标签快捷选择 |
| `MEAL_DEFAULT_MINUTES` | `30` | 「开始吃饭」默认时长（分钟） |
| `MEAL_STEP_MINUTES` | `5` | 吃饭时长分度值（暂未做加减调整 UI） |
| `TASKS_LINK_TO_TIME_RECORDS` | `false` | 任务与时间记录是否关联（默认关，任务独立） |

---

## 8. 已知限制与决策记录（避免接手者重复踩坑）

| 决策 / 限制 | 原因与结论 |
|---|---|
| **不能调手机原生「时钟 App」** | 浏览器安全限制，任何网站都做不到。折中：PWA 站内闹钟（Notification + Web Audio 响铃）+ iOS「引导式访问」锁屏保活（`guided-access-pomodoro` 思路） |
| **蓝牙耳机检测做不到** | 网页无法可靠读取系统音频路由。防外放底线 = 全局静音 + 图书馆模式（静音/振动/闪光） |
| **同步不用 OneDrive** | 需 Azure 注册、无实时推送（只能轮询）、冲突合并复杂。Supabase 免费版（Realtime 实时推送）最契合"免费 + 三端实时同跑计时" |
| **滚动动画不引库（murphyjs 被否）** | 其 dist 是 ESM 构建产物，不适合零构建站点。改用自写 `reveal.js`（IntersectionObserver + CSS） |
| **图标本地化（Lucide, MIT）** | 54 个 SVG 存在 `assets/icons/`，`icon.js` 按 `data-icon` 注入；**禁止运行时引 CDN**（离线/PWA 友好） |
| **fork 调研** | 曾调研 study-timer / FocusTide / guided-access-pomodoro，最终**全部自写**（更贴需求、无构建、好改），仅借鉴思路 |
| **大块判定统一北京时间** | 设备本地时间 → 换算北京时间再判定，保证不同时区设备判定一致（已用 TZ=Asia/Shanghai vs TZ=UTC 实测验证） |
| **新增 JS 须进 sw.js 缓存** | SHELL 列表 + `CACHE` 版本号 +1（曾漏 clock.js，已补为 v4；三套系统改造升 v5） |
| **三套系统架构** | 时间记录系统（time_records 主线）+ 计时器（正计=打点/倒计=工具）+ 三块系统（展示+吃饭）。对标爱时间/时间日志的时间轴思路，融合番茄ToDo 的打点模式，保持用户的「三餐大块」心智模型。数据写入统一走 time_records，展示层各自独立。 |
| **任务与时间记录解耦** | 用户明确任务是独立打卡系统，预留 `TASKS_LINK_TO_TIME_RECORDS` 开关，默认关。避免过度设计，保持简单。 |

---

## 9. 待办 / 下一步

1. **用户提供 Supabase URL + anon key**（`config.js`）→ 在 Supabase SQL Editor 执行 `sql/schema.sql` → 跨设备同步即生效。
2. **用户确认真实初试日期**（现占位 2026-12-19）与**起床/睡觉时间**（现假设 06:30/23:30）。
3. **部署上线**：推到 GitHub `littlebook888/kaoyan-site` → 开 GitHub Pages（或 Vercel，需 HTTPS 供 PWA 使用）→ 给用户线上地址 → 手机「添加到主屏幕」装 PWA。
4. **时间记录系统完善**（对标爱时间/时间日志）：
   - 时间轴支持拖拽调整、补记、删除单条记录
   - 吃饭时长可在 UI 上加减调整（目前只有默认 30min）
   - 统计页增加周/月维度分类对比图
5. **任务-时间记录联动**：打开 `TASKS_LINK_TO_TIME_RECORDS` 开关后，完成任务可关联计时。
6. 可选优化：课程表节次换成用户学校/医院真实作息；原创虚拟歌姬风插画；深色模式（洛天依深蓝夜景）。

---

## 10. 维护约定（硬规则）

1. **保持纯静态零构建**——新增任何库前先自问：用户以后能直接改吗？离线能用吗？
2. **时间判定只走 `clock.js` / `blocks.js`**（北京时间），业务代码不得自行 `new Date().getHours()` 判块。
3. **读写数据只走 `window.Store` API**，不直读 localStorage。
4. **给时间记录加字段** → 同步改 `sql/schema.sql` 补列（`time_records` 是主线表，优先级最高）。
5. **新增静态资源**（js/css/图标）→ 加进 `sw.js` SHELL 并升 `CACHE` 版本号。
6. **新图标**：优先从 `assets/icons/` 现成 59 个里选；缺的从 Lucide 官方仓库下载 SVG 放进去，用 `data-icon` 注入。
7. **改动后必做验证**：`node --check` 全部 JS + 本地服务器路由 200 + 关键功能标记 grep（参考历史做法）。
8. **不搬运任何版权素材**：洛天依官方立绘/歌曲、浪前课程原文，一律用原创/占位。
9. **三套系统边界不可乱**：① 时间记录系统 = 主线（time_records）② 计时器 = 工具（写入主线）③ 三块系统 = 展示 + 吃饭按钮（写入主线 meal 类）。三块系统**不得**直接修改计时器状态或时间记录的非 meal 类数据。
10. **用户偏好**：简体中文、结构化（表格/清单）、苹果风卡片视觉、接受直白反馈。

---

## 11. 交接备忘（给接手 AI 的上下文）

- **用户**：福建医科大学 五年制放射医学 大四（22 级，学号 3220139025），考研备战中，主跟「天天师兄」306 西综，目标 2026-12-19~21 初试。性格倾向"危机驱动+社交责任驱动"，偏好把计划改造成打卡式/强制触发器式执行工具。
- **历史演进**：从"番茄钟+笔记"方案 → 用户砍掉番茄钟 → 定制学休时长+快速计时+正倒双模 → 对标「爱时间/时间日志」→ 手机风数字键盘输入 → 三餐切分大块体系 → 实时北京时间时钟（取消点块自动开计时）。**每次迭代都沿这条线：更贴用户的真实学习方式，而不是更复杂。**
- **用户已明确拒绝/取消**：番茄钟（"多半用不上"）、点块直接开计时、OneDrive 作为同步主方案。
- **交互方式**：用户在 WorkBuddy 里开发，习惯边预览边提修改意见；本地预览服务 `127.0.0.1:8099` 曾长期开着。

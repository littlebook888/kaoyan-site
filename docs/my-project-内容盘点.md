# `D:\my project` 内容盘点报告

> 生成时间：2026-08-29 · 盘点方式：只读扫描，未改动其中任何文件
> 你说的"两个版本"已确认：**本地版 = `HTML_new_local\`，云端版 = `deploy\`（已部署）**

---

## 一、打印站（小本子打印服务）—— 你要区分的两个版本

| | 云端版（已部署 Vercel） | 本地版（未部署） |
|---|---|---|
| 位置 | `deploy\` | `HTML_new_local\` |
| 性质 | **git 仓库**，remote 有两个：GitHub `littlebook888/printer-station` + Gitee `a-little-notebook/printer-station` | 普通文件夹（不是 git 仓库） |
| 内容 | `index.html` + `HTML_1\`（二维码图片）+ README | `index.html` + `HTML_1\`（只有二维码）+ `飞书文档二维码.png` |
| 版本关系 | 内容与 `HTML\html-printer.html` **完全相同** | `index.html` 与云端版**内容不同**（本地有修改还没发布，或云端较新） |
| 最近动态 | git log 显示一直在迭代（"Sync with Feishu doc: update notices, pricing, guide text"） | 待确认哪个新 |

⭐ **建议（我没有执行）**：`HTML_new_local\index.html` 和 `deploy\index.html` 内容不同，建议你自己 diff 一下确认哪份是最新的，把旧的删掉/合并，统一用 `deploy\` 这个 git 仓库管理，避免两边改乱。打印站内容源头似乎是**飞书文档**（deploy 仓库的提交信息 + 飞书文档二维码可证）。

### 打印站的相关散件
- `HTML\html-printer.html` —— 云端版的一份拷贝（内容与 deploy/index.html 相同）
- `HTML\html  printrer\` —— 素材目录：两张云印小程序二维码（刺猬云印/小猴云印）+ html-printer.html 拷贝 + .vscode
- 两份内容用途：页面是一个打印服务指引页（价格表、使用指南），实际打印靠「刺猬云印」「小猴云印」两个微信小程序

## 二、quiz-app —— 另一个网页项目（医学刷题站）

- 位置：`quiz-app\`（index.html + style.css + script.js + questions.json）
- 内容：**医学题库刷题网页**（questions.json 里是产科/超声等医学选择题，附答案和解析）
- **根目录散装的 `index.html / questions.json / script.js / style.css` 四个文件是 quiz-app 的旧拷贝（内容完全相同）——这是"混乱感"的主要来源之一，可删可留**
- 部署：文件夹里有《Vercel超详细部署步骤.md》《Netlify部署超详细步骤.md》《部署说明.md》三份教程，说明当时打算部署到 Vercel 或 Netlify（是否真部署了本地无痕迹，配置都在云端）

## 三、claw —— 背单词爬虫工具

- AIM Read 网站（aim-read.top）的单词数据爬虫：抓音标/释义/例句/记忆技巧/词链，可导出 Obsidian
- 有 playwright / curl 两个版本 + 一键运行 .bat

## 四、Python 学习 / 课程目录（与网站无关）

| 目录 | 内容 |
|---|---|
| `01\` | Python 函数编程（上）课程代码：hello world、函数定义、参数、列表、字典… |
| `05_函数编程_下（上课笔记\` | 函数编程（下）笔记代码：作用域、闭包、装饰器、迭代器、推导式… |
| `day01teacher\` | 老师 demo / exercise 练习代码 |
| `周二选修课\` | 选修课作业（day1~3 + 作业） |
| `蓝桥杯\` | 蓝桥杯练习（001.py 起） |
| `011\` | 只有一个 `重命名.py`（批量改名脚本之类） |
| `HTML\2. TM（实例源码+习题答案）\`、`HTML\HTML_1\` | HTML/前端教程源码与杂项（hello html.html、浪前6.1.html、混镜之地.py、蓝桥杯.py、微信二维码）——旧学习素材 |

## 五、"混乱"的根源（建议，未执行）

1. 同一站存在 **3 份拷贝**：`deploy\`（权威）≈ `HTML\html-printer.html` ≈ `HTML_new_local\`（内容有差异，需要你定哪份新）。
2. quiz-app 在根目录有一套**散装旧拷贝**（4 个文件）。
3. 学习代码、教程素材、网站项目混在同一层。建议日后按 `print-station / quiz-app / 学习资料` 三个子文件夹归类（动手前先确认 HTML_new_local 与 deploy 哪份新）。

*本报告由 AI 只读扫描生成，`D:\my project` 内所有文件保持原样。*

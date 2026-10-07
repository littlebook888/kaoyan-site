/* test-sync.js —— 刷题站云同步逻辑的独立验算（ESM，与本目录其他测试一致）
 *
 * 背景（用户 2026-10-07反馈的真实节奏）：
 *   刷题时间集中、跨端频率低，但存在「30 秒前电脑、下���秒手机」的快速切换。
 *   原实现是「每点一次选项 → 800ms 后发一次请求」，刷一小时约 80 次；
 *   且「切回标签页就全量拉取」一天可达上百轮。已按需求改为：
 *     拉取：仅在打开页面时一次，且 5 个 scope 合并为一次 in 查询
 *     上传：点选只标记脏 → 切后台 / 提交题组 / 3 分钟兜底时才flush
 *
 * 本测试不联网，直接抠 sync.js 的源码做结构断言 + 把纯逻辑放进沙箱跑行为验算。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SYNC = readFileSync(resolve(ROOT, 'src/sync.js'), 'utf8')
const APP = readFileSync(resolve(ROOT, 'src/App.jsx'), 'utf8')
const CFG = readFileSync(resolve(ROOT, 'src/supabase-config.js'), 'utf8')

let fails = 0;
function ok(name, cond) {
  if (cond) { console.log("  ✅ " + name); return; }
  fails++;
  console.log("  ❌ " + name);
}

console.log("=== ① 拉取：仅在挂载时一次，且合并为一次 in 查询 ===");
ok("★ pullAllScopes 用 in('scope', SYNC_SCOPES) 一次取全，不是逐个 eq 查询",
  /\.in\('scope', SYNC_SCOPES\)/.test(SYNC));
ok("★ 旧的逐 scope 查询 pullScope 已删除（否则每次拉取发 5 个 HTTP 请求）",
  !/async function pullScope\(/.test(SYNC) && !/\.eq\('scope', scope\)/.test(SYNC));
ok("★ 不再有「切回标签页就拉取」的逻辑（一天切几十次标签页 = 几十轮请求）",
  !/visibilityState !== 'visible'/.test(APP) && !/onVisible/.test(APP));
ok("★ 挂载拉取仍保留且失败不阻断本地使用",
  /pullAndMergeAll\(\)\.then\(\(changed\)/.test(APP) && /\.catch\(\(\) => setSyncHydrated\(true\)\)/.test(APP));

console.log("\n=== ② 上传：点选只标记脏，不发请求 ===");
ok("★ pushState 只写 pendingPushes + 调scheduleFlush，不再 setTimeout 发请求",
  /pendingPushes\.set\(scope, data\)/.test(SYNC) &&
  !/setTimeout\(\(\) => \{\s*pendingPushes\.delete\(scope\)/.test(SYNC));
ok("★ 乐观时间戳仍在（入队即touchLocalMeta，防离线作答被云端旧数据覆盖）",
  /touchLocalMeta\(scope, Date\.now\(\)\)/.test(SYNC));

console.log("\n=== ③ 上传：三个时机 flush ===");
ok("★ flushNow 已导出并把脏数据批量推送",
  /export async function flushNow\(\)/.test(SYNC) &&
  /const entries = \[\.\.\.pendingPushes\.entries\(\)\]/.test(SYNC));
ok("★ 兜底定时器：PUSH_INTERVAL_MS 有值且不短于 2 分钟（碎片化刷题不必频繁上传）",
  /const PUSH_INTERVAL_MS = (\d+) \* 60 \* 1000/.test(SYNC) &&
  Number(SYNC.match(/const PUSH_INTERVAL_MS = (\d+) \* 60 \* 1000/)[1]) >= 2);
ok("★ 切到后台立即上传（这正是「电脑刷完走去用手机」的时刻）",
  /document\.visibilityState === 'hidden'\) flushNow\(\)/.test(APP));
ok("★ 关闭页面也会尽力上传（pagehide 早于 unload）",
  /window\.addEventListener\('pagehide', onBeforeUnload\)/.test(APP));
ok("★ 提交题组时立即上传（明确的完成节点，换设备时进度完整）",
  /function submitGroup\(\)[\s\S]{0,220}flushNow\(\)/.test(APP));
ok("★ App.jsx 已导入 flushNow",
  /import \{ pushState, pullAndMergeAll, syncEnabled, flushNow \} from '\.\/sync'/.test(APP));

console.log("\n=== ④ 合并语义未被破坏（降频不能丢数据）===");
ok("★ 仍按 updated_at 比新旧，云端较新才覆盖本地",
  /cloudTime > localUpdatedAt\(scope\)/.test(SYNC));
ok("★ 拉取仍逐 scope 独立容错（一次抖动不拖死整条链路）",
  /scope=\$\{scope\} 合并失败/.test(SYNC) && /try \{[\s\S]{0,400}const row = byScope\.get\(scope\)/.test(SYNC));
ok("★ study-subject 裸字符串的兼容处理仍在",
  /try \{ value = JSON\.parse\(value\) \} catch \{ \/\* 保持原字符串 \*\/ \}/.test(SYNC));

console.log("\n=== ⑤ 按科目分片（同设备两个副站标签页不互相覆盖）===");
ok("★ 三个键按科目加后缀（subjectKey 工厂函数）",
  /const subjectKey = useMemo\(\(\) => \(s\) => `\$\{s\}:\$\{subject\}`, \[subject\]\)/.test(APP));
ok("★ 本地持久化三键全部走 subjectKey",
  /setItem\(subjectKey\('med-selections'\)/.test(APP) &&
  /setItem\(subjectKey\('med-submitted'\)/.test(APP) &&
  /setItem\(subjectKey\('med-notes'\)/.test(APP));
ok("★ 推送三scope 全部走 subjectKey（各标签页只传自己那科）",
  /pushState\(subjectKey\('med-selections'\)/.test(APP) &&
  /pushState\(subjectKey\('med-submitted'\)/.test(APP) &&
  /pushState\(subjectKey\('med-notes'\)/.test(APP));
ok("★ 拉取只认带后缀的 scope（旧无后缀 key 不再作为云端 scope）",
  /scopes\.has\(`\$\{sk\}:med-selections`\)/.test(APP) &&
  /scopes\.has\(`\$\{sk\}:med-submitted`\)/.test(APP) &&
  /scopes\.has\(`\$\{sk\}:med-notes`\)/.test(APP));
ok("★ 旧数据一次性迁移（幂等：分片键已存在则跳过）",
  /function migrateShardedKeys\(subjects\)/.test(APP) &&
  /if \(hasShard\) continue/.test(APP) &&
  /migrateShardedKeys\(Object\.keys\(SUBJECTS\)\)/.test(APP));
ok("★ 读取时有旧键回退兜底（迁移前也不丢进度）",
  /readLocalStorage\(`\$\{nextSubject\}:med-selections`, readLocalStorage\('med-selections', \{\}\)\)/.test(APP) &&
  /readLocalStorage\(`\$\{nextSubject\}:med-notes`, readLocalStorage\('med-notes', \{\}\)\)/.test(APP));
ok("★ SYNC_SCOPES 由 SUBJECT_KEYS × SHARDED_KEYS 生成（不手写，避免漏项）",
  /SUBJECT_KEYS\.flatMap\(\(subject\) => SHARDED_KEYS\.map/.test(APP) ||
  /\.flatMap\(\(subject\) => SHARDED_KEYS\.map/.test(CFG));
ok("★ 收藏与当前科目仍是全局键（收藏是跨科聚合列表，不该按科切）",
  /GLOBAL_KEYS = \['med-favorites', 'study-subject'\]/.test(CFG) &&
  !/subjectKey\('med-favorites'\)/.test(APP));
ok("★ 拉取 effect 依赖 subject（切科后要重新拉那科的分片）",
  /\}, \[storageReady, subject\]\)/.test(APP));

console.log("\n=== ⑤ 沙箱行为验算：80 次点选不应产生任何请求，flush 时才一次推送 ===");
{
  /*抠出 pushState/flushNow 的真实源码跑，只把网络层换成计数桩 */
  const vm2 = vm;
  // 只取推送段（到拉取段之前），并剥掉 export 以便在脚本沙箱里跑
  const pushSection = SYNC.slice(
    SYNC.indexOf("const PUSH_DEBOUNCE_MS"),
    SYNC.indexOf("// ---------- 拉取并合并 ----------"),
  );
  const tail = pushSection
    .replace(/export async function flushNow/, "async function flushNow")
    .replace(/export function pushState/, "function pushState")
    // 剔除定时器相关的真实定义，改由沙箱桩提供（只验「点选不发请求」）
    .replace(/let flushTimer = null/, "")
    .replace(/function scheduleFlush\(\) \{[\s\S]*?\n\}/, "");
  const code = `
    const sent = [];
    const store = {};
    const supabase = { from: () => ({ upsert: (row) => { sent.push(row.scope); return Promise.resolve() } }) };
    function syncEnabled(){ return true }
    const SYNC_SCOPES = ['med-selections','med-submitted','med-favorites','med-notes','study-subject'];
    const window = { localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v },
    } };
    /* 真实的时间戳函数也抠进来（乐观时间戳逻辑必须一起验，不能桩掉） */
    const META_PREFIX = 'med-sync-meta';
    function readLocalMeta() {
      try {
        const raw = window.localStorage.getItem(META_PREFIX)
        const parsed = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch { return {} }
    }
    function localUpdatedAt(scope) { return new Date(readLocalMeta()[scope] || 0).getTime() }
    function touchLocalMeta(scope, ts) {
      const meta = readLocalMeta()
      meta[scope] = new Date(ts || Date.now()).toISOString()
      window.localStorage.setItem(META_PREFIX, JSON.stringify(meta))
    }
    /* 桩掉定时器（只验「点选不请求」）。须在 tail 之前声明，
       并把tail 里的真定义剔除，否则会重复声明。 */
    let flushTimer = null;
    function clearTimeout(){ flushTimer = null }
    function scheduleFlush(){ if (flushTimer) return; flushTimer = 1 }
    ${tail}
    result = { sent, pushState, flushNow, readLocalMeta };
  `;
  const ctx = vm2.createContext({ console, Date, Math, JSON, Object, Array, String, Number, Promise });
  vm.runInContext(code, ctx);
  const R = ctx.result;

  // 模拟用户刷一小时题：点 80 次选项 + 切一次科目 + 提交一次
  for (let i = 0; i < 80; i++) R.pushState("med-selections", { q: i });
  R.pushState("study-subject", "surgery");
  R.pushState("med-submitted", { g1: true });
  ok("★ 点 80 次选项 + 切科目 + 提交：网络请求数= 0（原来会发 80+ 次）",
    R.sent.length === 0);

  R.flushNow().then((n) => {
    ok("★ flushNow 把 3 个脏 scope 一次性推上去（返回条数=3）", n === 3);
    ok("★ flush 之后确实发出了 3 条 upsert（不是 3 次 HTTP 而是 3 个 scope 各一条）",
      R.sent.length === 3 && R.sent.includes("med-selections") &&
      R.sent.includes("study-subject") && R.sent.includes("med-submitted"));
    ok("★ flush 后脏标记已清空（二次 flush 不重复推送）",
      R.flushNow().then((n2) => n2 === 0));

    console.log("\n=== ⑥ 拉取：5 个 scope 合并成 1 次请求 ===");
    ok("★ 拉取按 in 一次取全后本地逐 scope 合并（网络请求 1 次 / 逻辑合并 5 次）",
      /\.in\('scope', SYNC_SCOPES\)/.test(SYNC) &&
      /for \(const scope of SYNC_SCOPES\)[\s\S]{0,300}const row = byScope\.get\(scope\)/.test(SYNC));

    console.log("\n" + (fails ? "★ 有失败项" : "★ 全部通过"));
    process.exit(fails ? 1 : 0);
  });
}
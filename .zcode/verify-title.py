# 临时校验（用完即删）：验证标题格式 + 迁移逻辑（含幂等性与进度保留）
import json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []
def chk(cond, msg):
    print(("  OK  " if cond else "  FAIL ") + msg)
    if not cond: fails.append(msg)

HARNESS = r"""
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=process.argv[1], mode=process.argv[2];
const els={};
const mk=(id)=>(els[id]={id,style:{},dataset:{},className:'',textContent:'',value:'',innerHTML:'',
  classList:{add(){},remove(){},contains(){return false},toggle(){}},
  addEventListener(){},setAttribute(){},getAttribute(){return null},
  querySelectorAll(){return[]},querySelector(){return null},appendChild(){},closest(){return null}});
['taskContainer','viewSwitch','subjectFilter','blockFilter','taskStats','addTask','importBtn',
 'importWebBtn','importFile','physioCard','wordCard','liveClock','dbgLog'].forEach(mk);
const store={};
// 预置"老版本已导入"的任务（标题为旧格式，含已完成与专注时长）
const seeded=[];
if(mode==='migrate'||mode==='idem'){
  const P=JSON.parse(process.argv[3]);
  P.forEach(p=>{
    seeded.push({id:'t'+p.day,source:'english_words',subject:'english',task_type:'word',
      title: mode==='idem' ? `背单词DAY ${p.day} ·${p.kind==='review'?'复习':'新词'} ${p.words}`
                            : `背单词 · ${p.kind==='review'?'复习':'新词'} ${p.words}`,
      day_label:p.label,date:p.dateStr,done:p.day<=2,
      total_focus_sec:p.day===1?1234:0,status:p.day<=2?'done':'todo',
      time_record_ids:p.day===1?['r1']:[],category:'general',slot:null,block:null,
      user_id:'u',created_at:'x',estimated_min:null,remind_on_estimate:true});
  });
  store['english_words_imported_v1']='1';
}
let setLocalCalls=0, added=0;
const sandbox={console,setInterval(){return 1},clearInterval(){},setTimeout(){},clearTimeout(){},
  Math,Date,JSON,Object,Array,String,Number,isFinite,parseFloat,parseInt,Promise,
  navigator:{userAgent:'Mozilla/5.0 (Windows NT 10.0)'}};
sandbox.window=sandbox;
sandbox.localStorage={getItem:k=>store[k]!==undefined?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
const domReady=[];
sandbox.document={readyState:'complete',getElementById:id=>els[id]||null,
  addEventListener:(ev,fn)=>{if(ev==='DOMContentLoaded')domReady.push(fn)},
  querySelectorAll(){return[]},querySelector(){return null},
  createElement:()=>mk('tmp'),body:{appendChild(){},removeChild(){}}};
vm.createContext(sandbox);
const load=(r)=>vm.runInContext(fs.readFileSync(path.join(ROOT,r),'utf8'),sandbox,{filename:r});
load('static/js/config.js'); load('static/js/blocks.js'); load('static/js/word-plan.js');
let tasks=seeded.slice();
sandbox.Store={
  getTasks:()=>tasks.slice(),
  addTask:(t)=>{added++;tasks.push(JSON.parse(JSON.stringify(t)))},
  updateTask:(id,p)=>{tasks=tasks.map(t=>t.id===id?{...t,...p}:t)},
  setLocal:(k,v)=>{setLocalCalls++; if(k==='tasks') tasks=JSON.parse(JSON.stringify(v))},
  getLocal:(k,f)=>f, subscribeTasks:()=>{}, subscribeTimeRecords:()=>{},
  isCloud:()=>false, setLog:()=>{}, initSupabase:()=>Promise.resolve(false), pullOnce:()=>Promise.resolve(),
};
sandbox.Timer={getState:()=>null,getLinkedTaskId:()=>null,startTask(){},pause(){},stopAndMarkDone(){}};
sandbox.UI={showAlert(){},beep(){},buzz(){},notify(){}};
sandbox.Icon={inject(){}}; sandbox.Reveal={};
load('static/js/tasks.js');
domReady.forEach(fn=>{try{fn()}catch(e){console.error('INIT_ERR',e.message)}});
const words=tasks.filter(t=>t.source==='english_words');
console.log('JSON_OUT'+JSON.stringify({
  added, setLocalCalls, total:words.length,
  d1:words.find(t=>t.day_label==='DAY 1'),
  d3:words.find(t=>t.day_label==='DAY 3'),
  d4:words.find(t=>t.day_label==='DAY 4'),
  d41:(words.find(t=>t.day_label==='DAY 41')||{}).title,
  oldLeft:words.filter(t=>/背单词 · /.test(t.title||'')).length
}));
"""

def run(mode, plan=None):
    args = ["node", "-e", HARNESS, str(ROOT), mode]
    if plan is not None: args.append(json.dumps(plan, ensure_ascii=False))
    out = subprocess.run(args, capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stderr[:800]); sys.exit(1)
    line = [l for l in out.stdout.splitlines() if l.startswith("JSON_OUT")][0]
    return json.loads(line[len("JSON_OUT"):])

# 生成计划（复刻 word-plan 规则）用于预置
import datetime
plan=[]
d0=datetime.date(2026,9,13)
for n in range(1,42):
    is_rev = n%4==0
    if is_rev:
        w=sum((plan[k-1]["words"]) for k in range(n-3,n))
    else:
        w=216 if n<=22 else 215
    plan.append({"day":n,"label":f"DAY {n}","dateStr":str(d0+datetime.timedelta(days=n-1)),"kind":"review" if is_rev else "new","words":w})

print("=== 1) 全新导入（无历史数据）===")
r1 = run("fresh")
print("  DAY1:", r1["d1"]["title"])
print("  DAY3:", r1["d3"]["title"])
print("  DAY4:", r1["d4"]["title"])
print("  DAY41:", r1["d41"])
chk(r1["d1"]["title"] == "背单词DAY 1 ·新词 216", "DAY1 = 背单词DAY 1 ·新词 216")
chk(r1["d3"]["title"] == "背单词DAY 3 ·新词 216", "DAY3 = 背单词DAY 3 ·新词 216")
chk(r1["d4"]["title"] == "背单词DAY 4 ·复习 648", "DAY4 = 背单词DAY 4 ·复习 648（复习日）")
chk(r1["d41"] == "背单词DAY 41 ·新词 215", f"DAY41 = 背单词DAY 41 ·新词 215（41÷4 余1 → 非复习日，实际 {r1['d41']}）")
chk(r1["total"] == 41, f"共 41 条（{r1['total']}）")

print("\n=== 2) 迁移：老格式任务被规范化 ===")
r2 = run("migrate", plan)
print("  DAY1:", r2["d1"]["title"], "| done:", r2["d1"]["done"], "| focus:", r2["d1"]["total_focus_sec"])
print("  批次推送次数:", r2["setLocalCalls"])
chk(r2["d1"]["title"] == "背单词DAY 1 ·新词 216", "旧标题已迁移为新格式")
chk(r2["oldLeft"] == 0, f"无残留旧格式标题（残留 {r2['oldLeft']}）")
chk(r2["total"] == 41, f"未重复导入（仍 41 条，实际 {r2['total']}）")
chk(r2["added"] == 0, "迁移模式下不新建任务")
chk(r2["setLocalCalls"] == 1, f"批量写入一次（{r2['setLocalCalls']} 次，避免 41 次全表推送）")
chk(r2["d1"]["done"] is True and r2["d1"]["total_focus_sec"] == 1234, "已完成状态与专注时长完整保留")
chk(r2["d1"]["time_record_ids"] == ["r1"], "关联的时间记录 ID 保留")

print("\n=== 3) 幂等：再次运行不应有变化 ===")
r3 = run("migrate", plan)
chk(r3["setLocalCalls"] == 0, f"第二次运行不再写入（{r3['setLocalCalls']} 次）")

print("\n" + ("全部通过" if not fails else f"{len(fails)} 项失败"))
sys.exit(0 if not fails else 1)

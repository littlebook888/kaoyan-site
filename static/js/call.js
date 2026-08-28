/* =====================================================================
 *  call.js —— 通话边界管控分站核心逻辑
 *  功能：今日判定 · 话术速查 · 随机借口 · 双闹钟 · 周频率 · 联动计时
 *  依赖：config.js / blocks.js / clock.js / store.js / ui.js / call-data.js / icon.js
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;
  const D = window.CALL_DATA;

  // ---- 状态 ----
  let callStartAt = null;      // 通话开始时间戳
  let warnTimerId = null;      // 15min 预警定时器
  let finalTimerId = null;     // 25min 终极定时器
  let callTickId = null;       // 通话时长刷新
  let weeklyCallCount = 0;    // 本周已用次数（从时间记录推算）

  function uid() { return Date.now().toString(36) + Math.random().toString(2, 7); }
  function p(n) { return String(Math.max(0, Math.floor(n))).padStart(2, "0"); }

  /* ---------- 今日判定 ---------- */
  function judgeToday() {
    const now = new Date();
    const beijing = window.Blocks ? window.Blocks.beijing(now) : now;
    const day = beijing.getDate();
    const isOdd = day % 2 === 1;
    const dayName = ["周日","周一","周二","周三","周四","周五","周六"][beijing.getDay()];
    const dateStr = `${beijing.getFullYear()}-${p(beijing.getMonth()+1)}-${p(day)}`;

    // 计算本周已用次数
    weeklyCallCount = calcWeeklyCallCount(beijing);

    let verdict, color, advice;
    if (!isOdd) {
      verdict = "拒接";
      color = "#ef4444";
      advice = "偶数日 → 直接挂断，用借口库推脱";
    } else {
      // 奇数日：需自身事务完毕（手动标记）
      // 当前默认显示"可接听（需自身事务完毕）"
      verdict = "可接听（需自身事务完毕）";
      color = "#22c55e";
      advice = "奇数日 → 自身事务完毕后可按需接听/回拨";
    }

    // 周频率检查
    const rule = D.weeklyRule;
    const maxCount = rule.maxPerWeek;
    if (weeklyCallCount >= maxCount) {
      advice += `｜本周已用 ${weeklyCallCount} 次，已达上限`;
    } else if (weeklyCallCount >= rule.defaultPerWeek) {
      advice += `｜本周已用 ${weeklyCallCount} 次，剩余 ${maxCount - weeklyCallCount} 次`;
    } else {
      advice += `｜本周已用 ${weeklyCallCount} 次`;
    }

    return { dateStr, dayName, day, isOdd, verdict, color, advice, weeklyCallCount };
  }

  function calcWeeklyCallCount(beijing) {
    // 从 time_records 统计本周通话次数
    const records = Store.getTimeRecords() || [];
    const rule = D.weeklyRule;
    let count = 0;
    records.forEach(r => {
      if (r.source !== "call_boundary") return;
      if (!r.started_at) return;
      const d = new Date(r.started_at);
      const b = window.Blocks.beijing(d);
      // 计算该记录所在周的周一
      const dow = b.getDay() || 7; // 周日=7
      const diffToMon = dow === 1 ? 0 : dow - 1;
      const mon = new Date(b);
      mon.setDate(mon.getDate() - diffToMon);
      mon.setHours(0, 0, 0, 0);
      // 当前周的周一
      const today = new Date(beijing);
      const todayDow = today.getDay() || 7;
      const todayMon = new Date(today);
      todayMon.setDate(todayMon.getDate() - (todayDow === 1 ? 0 : todayDow - 1));
      todayMon.setHours(0, 0, 0, 0);
      if (mon.getTime() === todayMon.getTime()) count++;
    });
    return count;
  }

  /* ---------- 渲染 ---------- */
  function renderJudge() {
    const el = document.getElementById("todayJudge");
    if (!el) return;
    const j = judgeToday();
    el.innerHTML = `
      <div class="j-row">
        <div class="j-date">${j.dateStr} · ${j.dayName} · 第${j.day}日</div>
        <div class="j-verdict" style="color:${j.color}">${j.verdict}</div>
      </div>
      <div class="j-advice">${j.advice}</div>
      <label class="j-check">
        <input type="checkbox" id="affairsDone" ${j.isOdd ? '' : 'disabled'} />
        自身事务已处理完毕
      </label>
      <label class="j-check">
        <input type="checkbox" id="followDeferRule" />
        是否遵循「置后定则」？<small style="margin-left:6px;color:var(--ink-3);font-weight:500">（通话前先问：我能否 XX 分钟后再处理？/ 回你电话？）</small>
      </label>
      <label class="j-check">
        <input type="checkbox" id="impactStudy" />
        是否会影响正常学习进度？<small style="margin-left:6px;color:#b91c1c;font-weight:600">（勾选 = 此项通话会打断学习，应拒接或设通话上限）</small>
      </label>
    `;
    const cb = document.getElementById("affairsDone");
    if (cb) cb.addEventListener("change", () => { renderHostStatus(); updateJudgeHint(); });
    const cb2 = document.getElementById("followDeferRule");
    if (cb2) cb2.addEventListener("change", () => { renderHostStatus(); updateJudgeHint(); });
    const cb3 = document.getElementById("impactStudy");
    if (cb3) cb3.addEventListener("change", () => { renderHostStatus(); updateJudgeHint(); });
  }

  function updateJudgeHint() {
    // 复选框提示摘要：3 项未勾选 → 顶部强调
    const a = document.getElementById("affairsDone");
    const d = document.getElementById("followDeferRule");
    const i = document.getElementById("impactStudy");
    if (!a || !d || !i) return;
    const items = [];
    if (a.disabled ? false : !a.checked) items.push("【自身事务处理】");
    if (!d.checked) items.push("【置后定则】");
    if (i.checked) items.push("【将打断学习→拒接】");
    const box = document.getElementById("checklistHint");
    if (!box) return;
    if (items.length === 0) {
      box.innerHTML = `<div style="padding:8px 12px;border-radius:8px;background:#dcfce7;color:#166534;font-size:12px;font-weight:700">✅ 三项自检通过，可进入「窗口可接」话术</div>`;
      box.style.display = "";
    } else {
      box.innerHTML = `<div style="padding:8px 12px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:12px;font-weight:700">⚠️ 未满足：${items.join(" · ")}</div>`;
      box.style.display = "";
    }
  }

  function renderScenarios() {
    const box = document.getElementById("callScenarios");
    if (!box) return;
    const j = judgeToday();
    const isOdd = j.isOdd;

    let items;
    if (!isOdd) {
      // 偶数日：必拒
      items = [
        { label: "偶数日必拒", text: "今天家里有事，急诊值班忙，改日再聊😊" },
        { label: "偶数日备选", text: "今天排班值班忙到很晚，没空看手机，改日哈😊" }
      ];
    } else {
      // 奇数日：自身事务未完毕 → 拒；完毕 → 可接
      items = [
        { label: "奇数日·非窗口", text: "今日急诊加班，回家后我回你电话" },
        { label: "奇数日·窗口可接", text: "刚忙完手头的事，找我啥？" }
      ];
    }

    box.innerHTML = items.map((s, i) => `
      <div class="scenario-item" data-idx="${i}">
        <div class="s-label">${s.label}</div>
        <div class="s-text">${s.text}</div>
        <button class="s-copy" data-copy="${s.text}">复制</button>
      </div>
    `).join("");

    box.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        copyText(text);
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    });
  }

  function renderWindowScenarios() {
    const box = document.getElementById("windowScenarios");
    if (!box) return;
    const openItems = D.poolOpen.map((t, i) => ({ label: `开场 #${i+1}`, text: t }));
    const closeItems = D.poolClose.map((t, i) => ({ label: `收尾 #${i+1}`, text: t }));
    const all = [...openItems, ...closeItems];
    box.innerHTML = all.map((s, i) => `
      <div class="scenario-item" data-idx="${i}">
        <div class="s-label">${s.label}</div>
        <div class="s-text">${s.text}</div>
        <button class="s-copy" data-copy="${s.text}">复制</button>
      </div>
    `).join("");
    box.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        copyText(text);
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    });
  }

  function renderHostStatus() {
    const at = Store.getActiveTimer();
    const card = document.getElementById("hostCard");
    const status = document.getElementById("hostStatus");
    const hint = document.getElementById("hostHint");
    if (!card || !status) return;

    if (at) {
      // v2：按 at.kind 显示分类（不硬编码为"正在学习"），paused 也显示状态
      const cats = window.APP_CONFIG.TIME_CATEGORIES || [];
      const cm = cats.find(c => c.key === at.kind) || { label: at.kind || "活动", color: "#94a3b8" };
      let elapsed = at.status === "running" ? Math.round(
          (at.elapsed_sec || 0) + (Date.now() - (at.started_at || Date.now())) / 1000
        ) : Math.round(at.elapsed_sec || 0);
      elapsed = Math.max(0, elapsed);
      const label = at.label || cm.label || "学习";
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const statusTxt = at.status === "paused" ? "（已暂停）" : "";
      const tagClass = at.kind === "study" && at.status === "running" ? "host-study" : "host-other";
      card.style.display = "";
      status.innerHTML = `<span class="host-tag ${tagClass}">正在${cm.label} ${mins}分${secs}秒${statusTxt}</span> <span class="host-label">${label}</span>`;
      if (at.kind === "study") {
        hint.textContent = at.status === "running"
          ? "通话将计入今日占用，强化边界意识"
          : "当前学习计时已暂停";
      } else {
        hint.textContent = "当前正处于「" + cm.label + "」状态";
      }
    } else {
      card.style.display = "";
      status.innerHTML = `<span class="host-tag host-idle">主站空闲</span>`;
      hint.textContent = "当前无进行中的计时";
    }
  }

  function renderWeeklyInfo() {
    const el = document.getElementById("weeklyInfo");
    if (!el) return;
    const j = judgeToday();
    const rule = D.weeklyRule;
    el.innerHTML = `
      <div class="wf-row"><span>本周已用</span><span class="wf-count ${j.weeklyCallCount >= rule.maxPerWeek ? 'over' : ''}">${j.weeklyCallCount} / ${rule.maxPerWeek}</span></div>
      <div class="wf-row"><span>默认主聊日</span><span>${rule.mainChat === 'sun' ? '周日' : rule.mainChat}</span></div>
      <div class="wf-row"><span>可选加次</span><span>${rule.addChat === 'thu' ? '周四' : rule.addChat}</span></div>
      <div class="wf-row"><span>当前判定</span><span style="color:${j.color}">${j.verdict}</span></div>
    `;
  }

  /* ---------- 操作 ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
    }
    if (window.UI) window.UI.showAlert("已复制到剪贴板", 1500);
  }

  function randomExcuse() {
    const arr = D.excuses;
    const idx = Math.floor(Math.random() * arr.length);
    const e = arr[idx];
    const typeEl = document.getElementById("excuseType");
    const textEl = document.getElementById("excuseText");
    if (typeEl) typeEl.textContent = `${e.label}（${idx+1}/${arr.length}）`;
    if (textEl) textEl.textContent = e.text;
  }

  function randomPool1730() {
    const arr = D.pool1730;
    const idx = Math.floor(Math.random() * arr.length);
    const el = document.getElementById("poolText");
    if (el) el.textContent = arr[idx];
  }

  function copyExcuse() {
    const t = document.getElementById("excuseText");
    if (t && t.textContent && t.textContent !== "点下方按钮抽一条随机借口") {
      copyText(t.textContent);
    }
  }

  function copyPool() {
    const t = document.getElementById("poolText");
    if (t && t.textContent && !t.textContent.startsWith("点")) {
      copyText(t.textContent);
    }
  }

  /* ---------- 双闹钟 ---------- */
  function startDualAlarm() {
    if (callStartAt) return;
    callStartAt = Date.now();
    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "";

    // 15min 预警
    warnTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(1);
        window.UI.showAlert("⏰ 还有 10 分钟，准备收尾", 5000);
        window.UI.notify("⏰ 预警", "通话 15 分钟了，还有 10 分钟到终极");
      }
    }, 15 * 60 * 1000);

    // 25min 终极
    finalTimerId = setTimeout(() => {
      if (window.UI) {
        window.UI.beep(3);
        window.UI.buzz();
        window.UI.showAlert("到点了，刚性挂断！", 5000);
        window.UI.notify("⏰ 通话结束", "25 分钟到了，请挂断");
      }
      endCall(true);
    }, 25 * 60 * 1000);

    // 通话时长刷新
    callTickId = setInterval(updateCallDisplay, 1000);
    updateCallDisplay();

    if (window.UI) window.UI.showAlert("通话开始，双闹钟已启动（15min预警 / 25min终极）", 3000);
  }

  function updateCallDisplay() {
    if (!callStartAt) return;
    const elapsed = Math.floor((Date.now() - callStartAt) / 1000);
    const em = Math.floor(elapsed / 60), es = elapsed % 60;
    const el = document.getElementById("callElapsed");
    if (el) el.textContent = `${p(em)}:${p(es)}`;

    const warnRemain = Math.max(0, 15 * 60 - elapsed);
    const wr = document.getElementById("warnRemain");
    if (wr) wr.textContent = `${p(Math.floor(warnRemain/60))}:${p(warnRemain%60)}`;

    const finalRemain = Math.max(0, 25 * 60 - elapsed);
    const fr = document.getElementById("finalRemain");
    if (fr) fr.textContent = `${p(Math.floor(finalRemain/60))}:${p(finalRemain%60)}`;
  }

  function endCall(forced) {
    if (!callStartAt) return;
    const dur = Math.floor((Date.now() - callStartAt) / 1000);
    const startedAt = callStartAt;
    const endedAt = Date.now();

    // 清除定时器
    if (warnTimerId) clearTimeout(warnTimerId);
    if (finalTimerId) clearTimeout(finalTimerId);
    if (callTickId) clearInterval(callTickId);
    callStartAt = null;

    const callTimer = document.getElementById("callTimer");
    if (callTimer) callTimer.style.display = "none";

    // 写入时间记录（上行联动）
    const rec = {
      id: uid(),
      user_id: C.USER_ID,
      category: "call",
      sub_category: "linyuchen",
      label: "与林宇晨通话",
      tags: ["边界管控", "与林宇晨通话"],
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_sec: dur,
      source: "call_boundary",
      note: forced ? "双闹钟超时·刚性挂断" : "正常挂断",
      created_at: new Date().toISOString()
    };
    Store.addTimeRecord(rec);

    if (window.UI) {
      window.UI.showAlert(`通话结束，时长 ${Math.floor(dur/60)}分${dur%60}秒，已记入时间账本`, 3000);
    }

    // 刷新周频率
    renderWeeklyInfo();
  }

  /* ---------- 周频率检查 ---------- */
  function checkWeekly() {
    const j = judgeToday();
    const rule = D.weeklyRule;
    if (j.weeklyCallCount >= rule.maxPerWeek) {
      if (window.UI) {
        window.UI.showAlert(`本周通话已达 ${rule.maxPerWeek} 次上限，建议返回学习`, 5000);
        setTimeout(() => {
          const ok = confirm("本周已超额，继续畅聊将违反边界管控。\n\n选择：\n确定 = 继续畅聊（违规）\n取消 = 返回学习");
          if (ok) {
            if (window.UI) window.UI.showAlert("已标记为违规，请自觉遵守边界", 3000);
          }
        }, 100);
      }
    } else if (j.weeklyCallCount >= rule.defaultPerWeek) {
      if (window.UI) {
        window.UI.showAlert(`本周已用 ${j.weeklyCallCount} 次，剩余 ${rule.maxPerWeek - j.weeklyCallCount} 次`, 4000);
      }
    } else {
      if (window.UI) {
        window.UI.showAlert(`本周已用 ${j.weeklyCallCount} 次，状态良好`, 2000);
      }
    }
  }

  /* ---------- 初始化 ---------- */
  // M1: call 页秒级 tick —— 计时器运行中时每秒刷新"正在学习 X分X秒"
  let _hostTickTimer = null;
  function _ensureHostTick() {
    const at = Store.getActiveTimer();
    const isRunning = at && at.status === "running";
    if (isRunning && !_hostTickTimer) {
      _hostTickTimer = setInterval(() => renderHostStatus(), 1000);
    } else if (!isRunning && _hostTickTimer) {
      clearInterval(_hostTickTimer);
      _hostTickTimer = null;
    }
  }

  function init() {
    renderJudge();
    updateJudgeHint();       // 初始化复选框摘要提示
    renderScenarios();
    renderWindowScenarios();
    renderHostStatus();
    renderWeeklyInfo();

    // 随机借口
    const btnExcuse = document.getElementById("btnExcuse");
    if (btnExcuse) btnExcuse.addEventListener("click", randomExcuse);
    const btnCopyExcuse = document.getElementById("btnCopyExcuse");
    if (btnCopyExcuse) btnCopyExcuse.addEventListener("click", copyExcuse);

    // 17:30 话术
    const btnPool = document.getElementById("btnPool1730");
    if (btnPool) btnPool.addEventListener("click", randomPool1730);
    const btnCopyPool = document.getElementById("btnCopyPool");
    if (btnCopyPool) btnCopyPool.addEventListener("click", copyPool);

    // 双闹钟
    const btnCall = document.getElementById("btnCall");
    if (btnCall) btnCall.addEventListener("click", () => {
      // 检查是否可以接听
      const j = judgeToday();
      if (!j.isOdd) {
        if (window.UI) window.UI.showAlert("偶数日不可接听", 3000);
        return;
      }
      const affairsDone = document.getElementById("affairsDone");
      if (!affairsDone || !affairsDone.checked) {
        if (window.UI) window.UI.showAlert("请先勾选「自身事务已处理完毕」", 3000);
        return;
      }
      // 周频率检查
      if (j.weeklyCallCount >= D.weeklyRule.maxPerWeek) {
        if (window.UI) {
          window.UI.showAlert("本周通话已达上限（2次），继续将违规", 5000);
          setTimeout(() => {
            if (confirm("确定要继续畅聊吗？（将违反边界管控）")) {
              startDualAlarm();
            }
          }, 100);
        }
        return;
      }
      startDualAlarm();
    });

    const btnEnd = document.getElementById("btnEnd");
    if (btnEnd) btnEnd.addEventListener("click", () => endCall(false));

    // 周频率检查
    const btnWeekly = document.getElementById("btnWeeklyCheck");
    if (btnWeekly) btnWeekly.addEventListener("click", checkWeekly);

    // 订阅主站状态变化
    Store.subscribeActiveTimer(() => { renderHostStatus(); _ensureHostTick(); });

    // M1 修复：运行中秒级自刷新（Store 不会每秒 emit，call 页自己 tick）
    _ensureHostTick();

    // 图标注入
    if (window.Icon) {
      window.Icon.inject(document.getElementById("callScenarios"));
      window.Icon.inject(document.getElementById("windowScenarios"));
      window.Icon.inject(document.querySelector(".call-actions"));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (window.Blocks && window.Clock) {
      init();
    } else {
      setTimeout(() => { if (window.Blocks) init(); }, 300);
    }
  });
})();

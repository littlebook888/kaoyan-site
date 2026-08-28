/* =====================================================================
 *  timer.js —— 计时器核心（正计=打点 / 倒计时 · 三端同跑同控）
 *  三套系统关系：
 *   1. 时间记录系统（time_records）= 主线，所有计时结果都写入这里
 *   2. 正计时 = 打点计时模式：开始=打卡、停止=下班，自动写入时间记录
 *   3. 倒计时 = 独立工具：学/休类结束后默认写入时间记录
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const Store = window.Store;
  let at = null;            // 当前活动计时会话
  let mode = "countdown";   // countdown | countup
  let digits = "004500";    // 倒计时设定（保留用于兼容）
  let touched = false;      // 是否已开始输入（首次数字键清空重新输入）
  let selected = "m";       // 选中的单位（拖动/滚轮作用对象）
  let finished = false;

  // 正计时：当前选中的分类和标签
  let countupCategory = "study";
  let countupSubCategory = "xizong";
  let countupTags = [];
  let countupLabel = "学西医综合";

  // 倒计时：当前选中的分类和标签
  let countdownCategory = "study";
  let countdownSubCategory = "xizong";
  let countdownTags = [];

  // 任务关联（番茄ToDo 风格）
  let linkedTaskId = null;    // 当前计时关联的任务 ID
  let estimateReminded = false; // 预估时间是否已提醒过

  // 进入状态模式（带音乐倒计时 → 自动正计时）
  let focusMode = false;       // 是否处于进入状态流程
  let focusCat = "study";      // 后续正计时的分类
  let focusTags = [];          // 后续正计时的标签
  let focusLabel = "学习";     // 后续正计时的名称
  let focusMusicAudio = null;  // 音乐 Audio 对象

  let displayEl, tagEl, startBtn, pauseBtn, stopBtn, restBtn;
  let setupPanel, runPanel, countdownSetup, countupNote, timeInputEl, numpadEl, modeToggleEl;
  let catChipsEl, tagChipsEl, tagInputEl;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // 分类元数据
  function catMeta(key) {
    const list = C.TIME_CATEGORIES || [];
    return list.find(c => c.key === key) || { label: key, color: "#999", icon: "layers" };
  }
  function kindLabel(k) { return catMeta(k).label; }
  // 优先用二级分类名，否则用一级分类名（保证名与颜色一致）
  function categoryLabelFor(kind, subKey) {
    if (subKey) {
      const m = getCategoryMeta(subKey);
      if (m) return m.label;
    }
    return kindLabel(kind);
  }

  /* ---------- 倒计时设定（三个独立 input，系统键盘输入）---------- */
  function getHMS() {
    const hEl = document.getElementById("tiH");
    const mEl = document.getElementById("tiM");
    const sEl = document.getElementById("tiS");
    const h = hEl ? (parseInt(hEl.value) || 0) : 0;
    const m = mEl ? (parseInt(mEl.value) || 0) : 0;
    const s = sEl ? (parseInt(sEl.value) || 0) : 0;
    return { h, m, s };
  }
  function setHMS(h, m, s) {
    const c = (v, max) => String(Math.max(0, Math.min(max, v))).padStart(2, "0");
    const hEl = document.getElementById("tiH");
    const mEl = document.getElementById("tiM");
    const sEl = document.getElementById("tiS");
    if (hEl) hEl.value = c(h, 99);
    if (mEl) mEl.value = c(m, 59);
    if (sEl) sEl.value = c(s, 59);
  }
  function totalSeconds() { const { h, m, s } = getHMS(); return h * 3600 + m * 60 + s; }

  // 倒计时记忆：记住上次设定的时/分/秒，下次打开沿用
  const CD_LS_KEY = "kaoyan:countdown_hms";
  function saveCountdownHMS() {
    const { h, m, s } = getHMS();
    try { localStorage.setItem(CD_LS_KEY, JSON.stringify({ h, m, s })); } catch (e) {}
  }
  function loadCountdownHMS() {
    try {
      const raw = localStorage.getItem(CD_LS_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (v && typeof v.h === "number" && typeof v.m === "number" && typeof v.s === "number") return v;
    } catch (e) {}
    return null;
  }

  function renderTimeInput() {
    // 现在直接用 input 的 value，不需要额外渲染
    // 保留函数引用避免报错
  }

  // ▲▼ 增减 + 滚轮步进（类似闹钟滑块，支持长按连发）
  function bindStepControls() {
    const fieldIds = { h: "tiH", m: "tiM", s: "tiS" };
    const maxes = { h: 99, m: 59, s: 59 };
    function step(fieldKey, dir) {
      const { h, m, s } = getHMS();
      let v = fieldKey === "h" ? h : fieldKey === "m" ? m : s;
      let nv = v + dir;
      if (nv > maxes[fieldKey]) nv = 0;
      if (nv < 0) nv = maxes[fieldKey];
      if (fieldKey === "h") setHMS(nv, m, s);
      else if (fieldKey === "m") setHMS(h, nv, s);
      else setHMS(h, m, nv);
    }
    // 滚轮（桌面）
    Object.keys(fieldIds).forEach(k => {
      const el = document.getElementById(fieldIds[k]);
      if (!el) return;
      el.addEventListener("wheel", e => {
        e.preventDefault();
        step(k, e.deltaY < 0 ? 1 : -1);
      }, { passive: false });
    });
    // 箭头按钮 + 长按连发
    const wrap = document.getElementById("timeInput");
    if (!wrap) return;
    wrap.addEventListener("click", e => {
      const b = e.target.closest(".ti-arrow");
      if (!b) return;
      step(b.dataset.step, parseInt(b.dataset.dir) || 1);
    });
    let repeatTimer = null;
    const stopRepeat = () => { if (repeatTimer) { clearTimeout(repeatTimer); clearInterval(repeatTimer); repeatTimer = null; } };
    wrap.addEventListener("pointerdown", e => {
      const b = e.target.closest(".ti-arrow");
      if (!b) return;
      const fire = () => step(b.dataset.step, parseInt(b.dataset.dir) || 1);
      repeatTimer = setTimeout(() => {
        repeatTimer = setInterval(fire, 130);
      }, 420);
    });
    wrap.addEventListener("pointerup", stopRepeat);
    wrap.addEventListener("pointercancel", stopRepeat);
    wrap.addEventListener("pointerleave", stopRepeat);
  }

  function bindTimeInputs() {
    const hEl = document.getElementById("tiH");
    const mEl = document.getElementById("tiM");
    const sEl = document.getElementById("tiS");
    const inputs = [hEl, mEl, sEl];
    const maxes = [99, 59, 59];

    inputs.forEach((el, idx) => {
      if (!el) return;
      // 聚焦时全选
      el.addEventListener("focus", () => {
        setTimeout(() => el.select(), 0);
      });
      // 输入校验：只保留数字，限制最大值
      el.addEventListener("input", () => {
        let val = el.value.replace(/[^0-9]/g, "");
        if (val === "") { el.value = ""; return; }
        let num = parseInt(val);
        if (num > maxes[idx]) num = maxes[idx];
        el.value = String(num);
      });
      // 失焦时补零
      el.addEventListener("blur", () => {
        let num = parseInt(el.value) || 0;
        if (num > maxes[idx]) num = maxes[idx];
        el.value = String(num).padStart(2, "0");
      });
      // 按回车跳到下一个或开始
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const dur = totalSeconds();
          if (dur < 1) {
            if (window.UI && window.UI.showAlert) {
              window.UI.showAlert("请先设置倒计时时长", 2000);
            }
            return;
          }
          startCountdown(countdownCategory, dur, kindLabel(countdownCategory), [...countdownTags], countdownSubCategory);
        } else if (e.key === "ArrowRight" || e.key === "Tab") {
          if (idx < inputs.length - 1 && inputs[idx + 1]) {
            e.preventDefault();
            inputs[idx + 1].focus();
            inputs[idx + 1].select();
          }
        } else if (e.key === "ArrowLeft") {
          if (idx > 0 && inputs[idx - 1]) {
            e.preventDefault();
            inputs[idx - 1].focus();
            inputs[idx - 1].select();
          }
        }
      });
    });
  }

  /* ---------- 分类 & 标签选择 UI（正计时模式）---------- */
  function renderCategoryPicker() {
    if (!catChipsEl) return;
    const cats = C.TIME_CATEGORIES || [];
    // 一级分类
    catChipsEl.innerHTML = cats.map(c => `
      <button type="button" class="cat-chip ${c.key === countupCategory ? "active" : ""}"
              data-cat="${c.key}" style="--cc:${c.color}">
        <span data-icon="${c.icon}"></span>${c.label}
      </button>
    `).join("");
    if (window.Icon) window.Icon.inject(catChipsEl);
    // 二级分类
    renderSubCatPicker("countup");
  }

  function renderSubCatPicker(mode) {
    const catKey = mode === "countup" ? countupCategory : countdownCategory;
    const subKey = mode === "countup" ? countupSubCategory : countdownSubCategory;
    const wrapId = mode === "countup" ? "countupSubCategory" : "countdownSubCategory";
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    const cat = (C.TIME_CATEGORIES || []).find(c => c.key === catKey);
    const subs = cat && cat.subs ? cat.subs : [];
    if (subs.length === 0) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    wrap.innerHTML = subs.map(s => `
      <button type="button" class="sub-cat-chip ${s.key === subKey ? "active" : ""}"
              data-sub="${s.key}" style="--sc:${s.color}">
        ${s.label}
      </button>
    `).join("");
  }

  function renderTagPicker() {
    if (!tagChipsEl) return;
    const common = C.COMMON_TAGS || [];
    tagChipsEl.innerHTML = common.map(t => `
      <button type="button" class="tag-chip ${countupTags.includes(t) ? "active" : ""}" data-tag="${t}">
        ${t}
      </button>
    `).join("");
  }

  /* ---------- 分类 & 标签选择 UI（倒计时模式）---------- */
  function renderCountdownCategoryPicker() {
    const el = document.getElementById("countdownCategory");
    if (!el) return;
    const cats = C.TIME_CATEGORIES || [];
    el.innerHTML = cats.map(c => `
      <button type="button" class="cat-chip ${c.key === countdownCategory ? "active" : ""}"
              data-cat="${c.key}" style="--cc:${c.color}">
        <span data-icon="${c.icon}"></span>${c.label}
      </button>
    `).join("");
    if (window.Icon) window.Icon.inject(el);
    // 二级分类
    renderSubCatPicker("countdown");
  }
  function renderCountdownTagPicker() {
    const el = document.getElementById("countdownTags");
    if (!el) return;
    const common = C.COMMON_TAGS || [];
    el.innerHTML = common.map(t => `
      <button type="button" class="tag-chip ${countdownTags.includes(t) ? "active" : ""}" data-tag="${t}">
        ${t}
      </button>
    `).join("");
  }

  /* ---------- 进入状态模式（音乐倒计时 → 自动正计时）---------- */
  // 音乐进度条同步：当前播放位置 / 总时长（可拖动 seek）
  function updateMusicSeek(force) {
    const seek = document.getElementById("musicSeek");
    const cur = document.getElementById("musicCur");
    const durEl = document.getElementById("musicDur");
    if (!seek) return;
    const audio = focusMusicAudio;
    if (!audio || !audio.duration || !isFinite(audio.duration)) {
      if (force) { seek.value = 0; if (cur) cur.textContent = "00:00"; if (durEl) durEl.textContent = "00:00"; }
      return;
    }
    if (!seek.dataset.dragging) {
      seek.max = audio.duration;
      seek.value = audio.currentTime;
    }
    if (cur) cur.textContent = fmtMusic(audio.currentTime);
    if (durEl) durEl.textContent = fmtMusic(audio.duration);
  }
  function fmtMusic(sec) {
    if (!isFinite(sec)) return "00:00";
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function bindMusicSeek() {
    const seek = document.getElementById("musicSeek");
    if (!seek || seek.dataset.bound) return;
    seek.dataset.bound = "1";
    seek.addEventListener("input", () => {
      if (!focusMusicAudio) return;
      // 拖动时不实时跳，避免抖动；松开时才 seek
      seek.dataset.pending = "1";
      const cur = document.getElementById("musicCur");
      if (cur) cur.textContent = fmtMusic(parseFloat(seek.value));
    });
    seek.addEventListener("change", () => {
      if (!focusMusicAudio) return;
      focusMusicAudio.currentTime = parseFloat(seek.value);
      delete seek.dataset.pending;
    });
    seek.addEventListener("pointerdown", () => { seek.dataset.dragging = "1"; });
    seek.addEventListener("pointerup", () => { delete seek.dataset.dragging; });
    seek.addEventListener("pointercancel", () => { delete seek.dataset.dragging; });
  }
  function playFocusMusic() {
    // 受静音/图书馆模式控制
    if (window.UI && (window.UI.isMuted() || window.UI.isLibrary())) {
      return null;
    }
    try {
      if (!focusMusicAudio) {
        focusMusicAudio = new Audio("assets/study_start.mp3");
        focusMusicAudio.loop = false;
      }
      focusMusicAudio.volume = musicVolume;
      focusMusicAudio.currentTime = 0;
      const p = focusMusicAudio.play();
      if (p && p.catch) p.catch(() => {}); // 浏览器自动播放限制时静默失败
      // 显示音乐控制（律动 + 音量）
      const mc = document.getElementById("musicControls");
      if (mc) mc.style.display = "";
      updateMusicSeek(true);
      focusMusicAudio.addEventListener("timeupdate", updateMusicSeek);
      focusMusicAudio.addEventListener("loadedmetadata", () => updateMusicSeek(true));
      // 律动可视化：开关开时启动
      if (beatEnabled) startBeatViz();
      return focusMusicAudio;
    } catch (e) {
      console.warn("播放音乐失败:", e);
      return null;
    }
  }

  function stopFocusMusic() {
    if (focusMusicAudio) {
      focusMusicAudio.pause();
      focusMusicAudio.currentTime = 0;
    }
    stopBeatViz();
    updateMusicSeek();
    const mc = document.getElementById("musicControls");
    if (mc) mc.style.display = "none";
  }
  // 暂停时随动暂停音乐（保留当前播放点）
  function pauseFocusMusic() {
    if (focusMusicAudio && !focusMusicAudio.paused) {
      focusMusicAudio.pause();
    }
    stopBeatViz();
  }
  // 恢复计时时继续播放（受全局静音/图书馆模式约束，且需律动开关重开）
  function resumeFocusMusic() {
    if (window.UI && (window.UI.isMuted() || window.UI.isLibrary())) return; // 静音则不恢复
    if (focusMusicAudio) {
      focusMusicAudio.volume = musicVolume;
      const p = focusMusicAudio.play();
      if (p && p.catch) p.catch(() => {});
      if (beatEnabled) startBeatViz();
    }
  }

  /* ---------- 音乐律动可视化（Web Audio API 频谱 + CSS fallback） ---------- */
  let beatCtx = null;          // AudioContext
  let beatAnalyser = null;     // AnalyserNode
  let beatSource = null;       // MediaElementAudioSourceNode
  let beatRafId = null;        // requestAnimationFrame ID
  let beatEnabled = false;     // 律动开关（持久化到 localStorage）
  let musicVolume = 0.7;       // 音量 0~1（持久化）

  // 初始化：从 localStorage 恢复开关和音量
  try {
    beatEnabled = localStorage.getItem("kaoyan:beat_on") === "1";
    const savedVol = localStorage.getItem("kaoyan:music_vol");
    if (savedVol) musicVolume = Math.max(0, Math.min(1, parseFloat(savedVol)));
  } catch (e) {}

  function ensureBeatGraph() {
    // 延迟创建 AudioContext（需用户交互后才能 resume）
    if (beatCtx) return;
    try {
      beatCtx = new (window.AudioContext || window.webkitAudioContext)();
      beatAnalyser = beatCtx.createAnalyser();
      beatAnalyser.fftSize = 64;
      beatAnalyser.smoothingTimeConstant = 0.75;
    } catch (e) {
      beatCtx = null; beatAnalyser = null;
    }
  }
  function connectBeatGraph() {
    if (!beatCtx || !focusMusicAudio || beatSource) return;
    try {
      beatSource = beatCtx.createMediaElementSource(focusMusicAudio);
      beatSource.connect(beatAnalyser);
      beatAnalyser.connect(beatCtx.destination);
    } catch (e) {
      // 已连接过或跨域限制，降级到 CSS 脉冲
      beatSource = null;
    }
  }
  function startBeatViz() {
    const viz = document.getElementById("beatViz");
    if (!viz) return;
    viz.style.display = "";
    const bars = viz.querySelectorAll("span");
    if (!bars.length) return;

    // 优先 Web Audio 频谱，降级 CSS 脉冲
    ensureBeatGraph();
    if (beatCtx && beatAnalyser) {
      connectBeatGraph();
      if (beatCtx.state === "suspended") beatCtx.resume().catch(() => {});
      const data = new Uint8Array(beatAnalyser.frequencyBinCount);
      // 平滑后的柱高（让律动更柔和、不"傻跳"）
      const cur = new Array(bars.length).fill(6);
      let last = performance.now();
      function loop(now) {
        const dt = Math.max(1, now - last); last = now;
        beatAnalyser.getByteFrequencyData(data);
        const step = Math.max(1, Math.floor(data.length / bars.length));
        bars.forEach((bar, i) => {
          // 整段频带取平均（比单点更稳）
          let sum = 0, n = 0;
          for (let k = 0; k < step && (i * step + k) < data.length; k++) {
            sum += data[i * step + k]; n++;
          }
          const v = n ? sum / n : 0;
          const target = 4 + (v / 255) * 32;   // 4~36px
          // 指数趋近 + 春季：向上快、回落慢，形成律动听感
          const kUp = Math.min(1, dt * 0.02), kDown = Math.min(1, dt * 0.008);
          const coef = target > cur[i] ? kUp : kDown;
          cur[i] = cur[i] + (target - cur[i]) * coef;
          bar.style.height = cur[i] + "px";
          bar.style.opacity = (0.45 + (cur[i] - 4) / 32 * 0.55).toFixed(2);
          bar.classList.toggle("pop", cur[i] > 26);
        });
        beatRafId = requestAnimationFrame(loop);
      }
      beatRafId = requestAnimationFrame(loop);
    } else {
      // 降级：CSS 脉冲动画
      viz.classList.add("css-pulse");
    }
  }
  function stopBeatViz() {
    if (beatRafId) { cancelAnimationFrame(beatRafId); beatRafId = null; }
    const viz = document.getElementById("beatViz");
    if (viz) {
      viz.style.display = "none";
      viz.classList.remove("css-pulse");
      viz.querySelectorAll("span").forEach(s => s.style.height = "");
    }
  }
  function syncBeatToggleUI() {
    const btn = document.getElementById("beatToggle");
    const viz = document.getElementById("beatViz");
    if (btn) btn.classList.toggle("on", beatEnabled);
    if (btn) btn.textContent = "";
    if (btn) btn.innerHTML = beatEnabled ? '<span data-icon="zap"></span> 律动 ON' : '<span data-icon="zap"></span> 律动';
    if (window.Icon && btn) window.Icon.inject(btn);
    // 律动开关只在音乐播放时才有视觉效果
    if (!beatEnabled) stopBeatViz();
  }

  function startFocusMode(cat, tags, label) {
    focusMode = true;
    focusCat = cat || "study";
    focusTags = tags || [];
    focusLabel = label || catMeta(focusCat).label;
    // 方案2：一键进入状态的倒计时分类 = 学习→进入学习状态（墨绿色）
    // 倒计时不写记录（focusMode 特殊流程），仅影响展示色与标签
    const focusCdTags = focusTags.length ? focusTags : ["进入状态"];
    mode = "countdown";
    syncModeUI();

    // 先加载音乐获取时长，倒计时时长 = 音乐时长
    const audio = playFocusMusic();
    if (audio) {
      if (audio.duration && isFinite(audio.duration)) {
        const dur = Math.ceil(audio.duration);
        startCountdown(cat, dur, "进入学习状态", focusCdTags, "enter_state");
      } else {
        // 音乐还在加载，等 loadedmetadata
        audio.addEventListener("loadedmetadata", () => {
          const dur = Math.ceil(audio.duration);
          startCountdown(cat, dur, "进入学习状态", focusCdTags, "enter_state");
        }, { once: true });
        // 兜底：如果加载失败，用 60 秒
        setTimeout(() => {
          if (!at) startCountdown(cat, 60, "进入学习状态", focusCdTags, "enter_state");
        }, 3000);
      }
    } else {
      // 静音/图书馆模式，音乐不播，用默认 60 秒倒计时，提示无音乐
      startCountdown(cat, 60, "进入学习状态", focusCdTags, "enter_state");
      const hint = document.getElementById("focusModeHint");
      if (hint) {
        const fhText = hint.querySelector(".fh-text");
        if (fhText) {
          const reason = window.UI && window.UI.isLibrary() ? "图书馆模式" : "静音模式";
          fhText.textContent = `进入状态中（${reason}，无音乐）`;
        }
      }
    }

    // 显示进入状态提示
    const hint = document.getElementById("focusModeHint");
    if (hint) hint.style.display = "flex";
    const replay = document.getElementById("replayMusicBtn");
    if (replay) replay.style.display = "none";
  }

  function focusModeReady() {
    // 用户点了"已进入状态"，提前结束进入状态倒计时，直接转正计时
    // 先记录本次「进入学习状态」到时间记录系统（独立二级标签，便于统计次数与耗时）
    recordFocusEntry();
    stopFocusMusic();
    // 停止当前倒计时（不记录到时间记录，因为还没正式开始）
    stop(false);
    focusMode = false;
    // 隐藏提示
    const hint = document.getElementById("focusModeHint");
    if (hint) hint.style.display = "none";
    // 直接开始正计时
    mode = "countup";
    syncModeUI();
    startCountup(focusCat, focusLabel, [...focusTags]);
  }

  function focusCountdownFinished() {
    // 进入状态倒计时自然结束
    // 先记录本次「进入学习状态」到时间记录系统（独立二级标签，便于统计次数与耗时）
    recordFocusEntry();
    stopFocusMusic();
    focusMode = false;
    // 隐藏提示
    const hint = document.getElementById("focusModeHint");
    if (hint) hint.style.display = "none";
    // 显示再次播放按钮
    const replay = document.getElementById("replayMusicBtn");
    if (replay) replay.style.display = "block";
    // 自动开始正计时
    mode = "countup";
    syncModeUI();
    startCountup(focusCat, focusLabel, [...focusTags]);
  }

  /* 记录「进入学习状态」到时间记录系统：
   * 一级分类 study（学习）下的独立二级标签 enter_state（进入学习状态）
   * 时长 = 进入状态实际用时（音乐倒计时实际流逝），便于统计次数与耗时 */
  function recordFocusEntry() {
    if (!at || at.mode !== "countdown") return;
    const el = currentElapsed();
    const now = Date.now();
    if (el <= 2) return; // 太短（如瞬间点掉）不记，避免垃圾记录
    const firstStart = at.first_started_at || (now - el * 1000);
    if (at.segments && at.segments.length > 0 && at.segments[at.segments.length - 1].end === null) {
      at.segments[at.segments.length - 1].end = now;
    }
    Store.addTimeRecord({
      id: uid(),
      user_id: C.USER_ID,
      category: "study",
      sub_category: "enter_state",
      label: "进入学习状态",
      tags: [...(at.tags || []), "进入状态"],
      started_at: new Date(firstStart).toISOString(),
      ended_at: new Date(now).toISOString(),
      duration_sec: Math.round(el),
      source: "focus_entry",
      segments: at.segments || null,
      task_id: null,
      note: "",
      created_at: new Date().toISOString()
    });
  }

  /* ---------- 计算当前已用秒数（共用 started_at 时间戳，天然同步）---------- */
  function currentElapsed() {
    if (!at) return 0;
    if (at.status === "running") {
      const base = at.elapsed_sec || 0;
      const started = at.started_at || Date.now();
      return base + (Date.now() - started) / 1000;
    }
    return at.elapsed_sec || 0;
  }

  /* ---------- 写入时间记录系统（主线表）---------- */
  function writeTimeRecord({ category, label, tags, startedAt, endedAt, durationSec, source, segments }) {
    const rec = {
      id: uid(),
      user_id: C.USER_ID,
      category: category || "study",
      sub_category: "",
      label: label || kindLabel(category),
      tags: tags || [],
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_sec: Math.round(durationSec),
      source: source || "timer",
      segments: segments || null,
      note: "",
      created_at: new Date().toISOString()
    };
    Store.addTimeRecord(rec);
  }

  /* ---------- 控制动作（写入 Store → 三端同步）---------- */
  function startCountdown(kind, durationSec, label, tags, subCategory) {
    at = {
      mode: "countdown", kind, label: label || kindLabel(kind),
      tags: tags || [],
      sub_category: subCategory || "",
      status: "running", started_at: Date.now(),
      duration_sec: durationSec, elapsed_sec: 0, updated_at: Date.now(),
      segments: [{ start: Date.now(), end: null }],
      first_started_at: Date.now()
    };
    Store.setActiveTimer(at);
    finished = false;
    window.UI.askNotifyOnce();
    // 正计时时显示再次播放音乐按钮
    const replay = document.getElementById("replayMusicBtn");
    if (replay && !focusMode) replay.style.display = "block";
    render();
  }

  function startCountup(category, label, tags, taskId, subCategory, note) {
    at = {
      mode: "countup", kind: category, label: label || kindLabel(category),
      tags: tags || [],
      sub_category: subCategory || "",
      status: "running", started_at: Date.now(),
      duration_sec: null, elapsed_sec: 0, updated_at: Date.now(),
      segments: [{ start: Date.now(), end: null }],
      first_started_at: Date.now(),
      task_id: taskId || null,
      note: note || ""
    };
    linkedTaskId = taskId || null;
    estimateReminded = false;
    if (taskId) {
      const t = Store.getTasks().find(x => x.id === taskId);
      if (t) Store.updateTask(taskId, { status: "running" });
    }
    Store.setActiveTimer(at);
    finished = false;
    window.UI.askNotifyOnce();
    render();
  }
  function pause() {
    if (!at || at.status !== "running") return;
    const now = Date.now();
    if (at.segments && at.segments.length > 0) {
      at.segments[at.segments.length - 1].end = now;
    }
    at = { ...at, status: "paused", elapsed_sec: currentElapsed(), started_at: null, updated_at: now };
    Store.setActiveTimer(at);
    pauseFocusMusic();   // 音乐随暂停而暂停
    render();
  }
  function resume() {
    if (!at || at.status !== "paused") return;
    const now = Date.now();
    if (at.segments) {
      at.segments.push({ start: now, end: null });
    } else {
      at.segments = [{ start: now, end: null }];
    }
    at = { ...at, status: "running", started_at: now, updated_at: now };
    Store.setActiveTimer(at);
    resumeFocusMusic();  // 恢复时继续播放
    render();
  }
  /* M5: 归一化 category —— 如果 kind 本身就是某个二级 key（如 "xizong"），
   *   查 TIME_CATEGORIES 找到其父级，用父级 key 作为 category。
   *   如果 kind 是合法一级 key（study/break/rest 等）直接用。 */
  function _normalizeCategory(kind, subCategory) {
    const cats = (window.APP_CONFIG && window.APP_CONFIG.TIME_CATEGORIES) || [];
    // 1) kind 是一级 key → 直接用
    if (cats.some(c => c.key === kind)) return kind;
    // 2) kind 是某个一级下的二级 key → 找父级
    for (const cat of cats) {
      if (cat.subs && cat.subs.some(s => s.key === kind)) return cat.key;
    }
    // 3) fallback：有 sub_category 则以 sub_category 所在父级为准
    if (subCategory) {
      for (const cat of cats) {
        if (cat.subs && cat.subs.some(s => s.key === subCategory)) return cat.key;
      }
    }
    // 4) 最终 fallback
    return kind || "other";
  }
  function stop(record = true, markDone = false, silent = false) {
    if (!at) return;
    const el = currentElapsed();
    const now = Date.now();
    let recId = null;
    if (record && el > 2) {
      const firstStart = at.first_started_at || at.started_at || (now - el * 1000);
      if (at.segments && at.segments.length > 0 && at.segments[at.segments.length - 1].end === null) {
        at.segments[at.segments.length - 1].end = now;
      }
      const dur = at.mode === "countdown" ? at.duration_sec : Math.round(el);
      // M5 修复：归一化 category 到一级分类 key（防止二级 key 落进 category）
      const catKey = _normalizeCategory(at.kind, at.sub_category);
      const rec = {
        id: uid(),
        user_id: C.USER_ID,
        category: catKey,
        sub_category: at.sub_category || "",
        label: at.label,
        tags: at.tags || [],
        started_at: new Date(firstStart).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_sec: dur,
        source: at.mode === "countup" ? "timer_countup" : "timer_countdown",
        segments: at.segments || null,
        task_id: at.task_id || null,
        note: at.note || "",
        created_at: new Date().toISOString()
      };
      Store.addTimeRecord(rec);
      recId = rec.id;
      // 关联任务：累加专注时长
      if (at.task_id && C.TASKS_LINK_TO_TIME_RECORDS !== false) {
        Store.addFocusToTask(at.task_id, dur, recId);
        if (markDone) {
          Store.updateTask(at.task_id, { status: "done", done: true });
        } else {
          Store.updateTask(at.task_id, { status: "todo" });
        }
      }
    }
    linkedTaskId = null;
    estimateReminded = false;
    // 停止时清理进入状态模式
    if (focusMode) {
      focusMode = false;
      stopFocusMusic();
      const hint = document.getElementById("focusModeHint");
      if (hint) hint.style.display = "none";
    }
    const replay = document.getElementById("replayMusicBtn");
    if (replay) replay.style.display = "none";

    // 记录刚结束的计时信息（用于结束后弹标签仪表盘）
    const lastRecord = record && el > 2 ? {
      id: recId,
      category: at.kind,
      subCategory: at.sub_category || "",
      label: at.label,
      tags: at.tags || [],
      note: at.note || "",
      duration_sec: Math.round(el),
      started_at: at.first_started_at || at.started_at
    } : null;

    at = null;
    Store.setActiveTimer(null);
    render();

    // 结束后：如果有记录且没有标签，自动弹出标签仪表盘（休息衔接等静默场景跳过）
    if (lastRecord && (!lastRecord.tags || lastRecord.tags.length === 0) && !focusMode && !silent) {
      setTimeout(() => {
        openTagDrawer({
          category: lastRecord.subCategory || lastRecord.category,
          tags: lastRecord.tags,
          note: lastRecord.note,
          onSave: (result) => {
            // 精确更新刚结束对应的时间记录
            if (lastRecord.id) {
              Store.updateTimeRecord(lastRecord.id, {
                category: result.category,
                sub_category: result.subCategory,
                label: result.label,
                tags: result.tags,
                note: result.note
              });
            }
          }
        });
      }, 200);
    }
  }

  /* ---------- 结束（倒计时归零）---------- */
  function finishCountdown() {
    if (finished) return;
    // 进入状态模式：走特殊流程（不记录时间，直接转正计时）
    if (focusMode) {
      focusCountdownFinished();
      return;
    }
    finished = true;
    const k = at.kind, lab = at.label;
    const now = Date.now();
    const firstStart = at.first_started_at || (now - at.duration_sec * 1000);
    if (at.segments && at.segments.length > 0 && at.segments[at.segments.length - 1].end === null) {
      at.segments[at.segments.length - 1].end = now;
    }
    // 倒计时结束默认写入时间记录（学习/休息/自由都写）
    const rec = {
      id: uid(), user_id: C.USER_ID,
      category: k, sub_category: at.sub_category || "", label: lab,
      tags: at.tags || [],
      started_at: new Date(firstStart).toISOString(),
      ended_at: new Date(now).toISOString(),
      duration_sec: at.duration_sec,
      source: "timer_countdown",
      segments: at.segments || null,
      task_id: at.task_id || null,
      note: at.note || "",
      created_at: new Date().toISOString()
    };
    Store.addTimeRecord(rec);
    if (at.task_id && C.TASKS_LINK_TO_TIME_RECORDS !== false) {
      Store.addFocusToTask(at.task_id, at.duration_sec, rec.id);
      Store.updateTask(at.task_id, { status: "todo" });
    }
    linkedTaskId = null;
    estimateReminded = false;

    // 记录刚结束的信息
    const cdLastRecId = rec.id;
    const cdLastTags = at.tags || [];
    const cdLastNote = at.note || "";
    const cdLastCat = at.kind;
    const cdLastSub = at.sub_category || "";
    const cdLastLabel = at.label;

    at = null;
    Store.setActiveTimer(null);
    window.UI.beep(3);
    window.UI.buzz();
    const msg = k === "study" ? "学习结束！该休息一下啦 🎵" : k === "break" ? "休息结束，继续冲！💪" : "计时结束 ⏰";
    window.UI.showAlert(msg, 5000);
    window.UI.notify("⏰ 计时结束", msg);
    render();

    // 结束后无标签自动弹出仪表盘
    if (!cdLastTags || cdLastTags.length === 0) {
      setTimeout(() => {
        openTagDrawer({
          category: cdLastSub || cdLastCat,
          tags: cdLastTags,
          note: cdLastNote,
          onSave: (result) => {
            // 精确更新刚结束的这条时间记录
            if (cdLastRecId) {
              Store.updateTimeRecord(cdLastRecId, {
                category: result.category,
                sub_category: result.subCategory,
                label: result.label,
                tags: result.tags,
                note: result.note
              });
            }
          }
        });
      }, 300);
    }
  }

  /* ---------- 显示格式化 ---------- */
  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!displayEl) return;
    const idle = !at;
    setupPanel.style.display = idle ? "" : "none";
    runPanel.style.display = idle ? "none" : "";

    // v2：Store.isSyncing —— 写入操作（开始/暂停/停止/继续）同步中 → 按钮全 disabled
    //   对照 Todoist：写入中防止用户反复点击、产生竞态操作
    const syncing = Store.isSyncing && Store.isSyncing();
    if (idle) {
      countdownSetup.style.display = mode === "countdown" ? "" : "none";
      countupNote.style.display = mode === "countup" ? "" : "none";
      startBtn.textContent = syncing ? "同步中…" : "开始";
      startBtn.disabled = syncing;      // 同步中禁止再开始
      pauseBtn.disabled = true; stopBtn.disabled = true;
      restBtn.disabled = syncing;       // 休息按钮也在同步中禁用
      renderTimeInput();
      return;
    }
    // 运行中 / 暂停
    const modeTxt = at.mode === "countdown" ? "倒计时" : "正计时·打点";
    const cm = getCategoryMeta(at.sub_category || at.kind) || catMeta(at.kind);
    tagEl.innerHTML = `<span class="tag" style="background:${cm.color}22;color:${cm.color}">${cm.label} · ${modeTxt}</span>`;
    const hasTags = at.tags && at.tags.length > 0;
    displayEl.style.color = hasTags ? cm.color : "";
    displayEl.classList.toggle("break", at.kind === "break");
    // 按钮文案 + disabled
    if (syncing) {
      startBtn.textContent = "同步中…";
      startBtn.disabled = true;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      restBtn.disabled = true;
    } else {
      startBtn.textContent = (at.status === "paused") ? "继续" : "开始";
      startBtn.disabled = at.status === "running";
      pauseBtn.disabled = at.status !== "running";
      stopBtn.disabled = false;
      restBtn.disabled = at.status === "running";
    }
    displayEl.classList.toggle("running", at.status === "running");
  }

  function tick() {
    if (!at) return;
    if (at.mode === "countdown") {
      const remaining = (at.duration_sec || 0) - currentElapsed();
      if (remaining <= 0) { finishCountdown(); return; }
      if (displayEl) displayEl.textContent = fmt(remaining);
    } else {
      const el = currentElapsed();
      if (displayEl) displayEl.textContent = fmt(el);
      // 预估时间提醒（任务关联时有效）
      if (at.task_id && !estimateReminded) {
        const task = Store.getTasks().find(x => x.id === at.task_id);
        if (task && task.estimated_min && task.remind_on_estimate) {
          const estSec = task.estimated_min * 60;
          if (el >= estSec) {
            estimateReminded = true;
            window.UI.beep(2);
            window.UI.showAlert(`「${task.title}」已达到预估时长 ${task.estimated_min} 分钟`, 6000);
            window.UI.notify("⏱️ 预估时长到了", `「${task.title}」已学习 ${task.estimated_min} 分钟，可继续或结束`);
          }
        }
      }
    }
  }

  /* ---------- 同步模式 UI ---------- */
  function syncModeUI() {
    modeToggleEl.querySelectorAll("button").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === mode));
    render();
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    displayEl = document.getElementById("timerDisplay");
    tagEl = document.getElementById("timerTag");
    startBtn = document.getElementById("btnStart");
    pauseBtn = document.getElementById("btnPause");
    stopBtn = document.getElementById("btnStop");
    restBtn = document.getElementById("btnRest");
    setupPanel = document.getElementById("setupPanel");
    runPanel = document.getElementById("runPanel");
    countdownSetup = document.getElementById("countdownSetup");
    countupNote = document.getElementById("countupNote");
    timeInputEl = document.getElementById("timeInput");
    numpadEl = document.getElementById("numpad");
    modeToggleEl = document.getElementById("modeToggle");
    catChipsEl = document.getElementById("countupCategory");
    tagChipsEl = document.getElementById("countupTags");
    tagInputEl = document.getElementById("tagInput");

    // 非计时页（如任务页）：仅保留后台计时循环、activeTimer 订阅与数据接口，跳过 UI 绑定
    if (!displayEl || !setupPanel) {
      at = Store.getActiveTimer();
      Store.subscribeActiveTimer((val) => {
        at = val;
        finished = false;
        if (at && at.mode) mode = at.mode; // 对齐模式
      });
      // v2：同步状态变化（syncing → !syncing）→ 立即重绘按钮文案/disabled
      if (Store.subscribeSyncStatus) {
        Store.subscribeSyncStatus(() => { try { render(); } catch (e) {} });
      }
      setInterval(tick, 250);
      return;
    }

    // 初始化分类/标签选择器
    renderCategoryPicker();
    renderTagPicker();

    // 模式切换
    modeToggleEl.addEventListener("click", e => {
      const b = e.target.closest("button[data-mode]"); if (!b) return;
      mode = b.dataset.mode; syncModeUI();
    });

    // 一级分类选择（正计时）
    catChipsEl.addEventListener("click", e => {
      const b = e.target.closest("button[data-cat]"); if (!b) return;
      countupCategory = b.dataset.cat;
      // 切换一级后，默认选第一个二级
      const cat = (C.TIME_CATEGORIES || []).find(c => c.key === countupCategory);
      if (cat && cat.subs && cat.subs.length > 0) {
        countupSubCategory = cat.subs[0].key;
        countupLabel = cat.subs[0].label;
      } else {
        countupSubCategory = "";
        countupLabel = catMeta(countupCategory).label;
      }
      renderCategoryPicker();
    });

    // 二级分类选择（正计时）
    const countupSubEl = document.getElementById("countupSubCategory");
    if (countupSubEl) {
      countupSubEl.addEventListener("click", e => {
        const b = e.target.closest("button[data-sub]"); if (!b) return;
        countupSubCategory = b.dataset.sub;
        const cat = (C.TIME_CATEGORIES || []).find(c => c.key === countupCategory);
        const sub = cat && cat.subs ? cat.subs.find(s => s.key === countupSubCategory) : null;
        countupLabel = sub ? sub.label : catMeta(countupCategory).label;
        renderSubCatPicker("countup");
      });
    }

    // 标签选择（正计时）
    tagChipsEl.addEventListener("click", e => {
      const b = e.target.closest("button[data-tag]"); if (!b) return;
      const t = b.dataset.tag;
      if (countupTags.includes(t)) {
        countupTags = countupTags.filter(x => x !== t);
      } else {
        countupTags.push(t);
      }
      renderTagPicker();
    });

    // 自定义标签输入
    if (tagInputEl) {
      tagInputEl.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = tagInputEl.value.trim();
          if (val && !countupTags.includes(val)) {
            countupTags.push(val);
            renderTagPicker();
          }
          tagInputEl.value = "";
        }
      });
    }

    // 一级分类选择（倒计时）
    const cdCatEl = document.getElementById("countdownCategory");
    if (cdCatEl) {
      cdCatEl.addEventListener("click", e => {
        const b = e.target.closest("button[data-cat]"); if (!b) return;
        countdownCategory = b.dataset.cat;
        // 切换一级后，默认选第一个二级
        const cat = (C.TIME_CATEGORIES || []).find(c => c.key === countdownCategory);
        if (cat && cat.subs && cat.subs.length > 0) {
          countdownSubCategory = cat.subs[0].key;
        } else {
          countdownSubCategory = "";
        }
        renderCountdownCategoryPicker();
      });
    }

    // 二级分类选择（倒计时）
    const cdSubEl = document.getElementById("countdownSubCategory");
    if (cdSubEl) {
      cdSubEl.addEventListener("click", e => {
        const b = e.target.closest("button[data-sub]"); if (!b) return;
        countdownSubCategory = b.dataset.sub;
        renderSubCatPicker("countdown");
      });
    }

    // 标签选择（倒计时）
    const cdTagEl = document.getElementById("countdownTags");
    if (cdTagEl) {
      cdTagEl.addEventListener("click", e => {
        const b = e.target.closest("button[data-tag]"); if (!b) return;
        const t = b.dataset.tag;
        if (countdownTags.includes(t)) {
          countdownTags = countdownTags.filter(x => x !== t);
        } else {
          countdownTags.push(t);
        }
        renderCountdownTagPicker();
      });
    }

    // 倒计时自定义标签输入
    const cdTagInput = document.getElementById("countdownTagInput");
    if (cdTagInput) {
      cdTagInput.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = cdTagInput.value.trim();
          if (val && !countdownTags.includes(val)) {
            countdownTags.push(val);
            renderCountdownTagPicker();
          }
          cdTagInput.value = "";
        }
      });
    }

    // 开始 / 暂停 / 停止 / 休息
    startBtn.addEventListener("click", () => {
      if (at && at.status === "paused") { resume(); return; }
      if (mode === "countup") {
        startCountup(countupCategory, countupLabel, [...countupTags], null, countupSubCategory);
        return;
      }
      const dur = totalSeconds();
      if (dur < 1) { window.UI.showAlert("请先设置倒计时时长", 2000); return; }
      saveCountdownHMS();
      startCountdown(countdownCategory, dur, categoryLabelFor(countdownCategory, countdownSubCategory), [...countdownTags], countdownSubCategory);
    });
    pauseBtn.addEventListener("click", pause);
    stopBtn.addEventListener("click", () => { stop(true); });
    restBtn.addEventListener("click", () => {
      // 若当前有任务计时（运行中/暂停中），先静默记录到时间记录（note 含任务标题），再开始休息
      if (at && at.task_id) {
        stop(true, false, true);
      }
      let dur = totalSeconds();
      if (dur < 1) dur = 10 * 60;
      startCountdown("break", dur, "休息");
    });

    // 绑定时间输入框（系统键盘）
    bindTimeInputs();
    // 绑定 ▲▼ 增减 + 滚轮
    bindStepControls();

    // 快速计时芯片
    document.querySelectorAll("[data-preset]").forEach(chip => {
      chip.addEventListener("click", () => {
        const [kind, dur] = chip.dataset.preset.split(":");
        if (kind === "up") {
          mode = "countup"; countupCategory = "study"; countupLabel = "学习"; countupTags = [];
          syncModeUI(); renderCategoryPicker(); renderTagPicker();
          startCountup("study", "学习", []);
        } else if (kind === "block") {
          // 大块预设：仅设时长，不自动开始
          mode = "countdown"; syncModeUI();
          const B = window.Blocks;
          const isNow = B.currentKey(new Date()) === dur;
          let sec = B.remainingSeconds(dur, new Date());
          if (sec == null || sec < 1) sec = B.blockDurationSec(dur);
          const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
          setHMS(hh, mm, ss);
          renderTimeInput();
          window.UI.showAlert(`已设为${B.NAMES[dur]}${isNow ? "剩余" : "整块"}时长，点「开始」运行`, 2200);
        } else {
          mode = "countdown"; syncModeUI();
          const sec = Math.round(parseFloat(dur) * 60);
          const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
          setHMS(hh, mm, ss);
          renderTimeInput();
          startCountdown(kind, sec, kindLabel(kind));
        }
      });
    });

    // 三端同步：远端改动立即反映
    Store.subscribeActiveTimer((val) => {
      at = val;
      finished = false;
      if (at) {
        // 同步模式、分类、标签，保证两端 UI 完全一致
        if (at.mode) mode = at.mode;
        if (at.kind) countupCategory = at.kind;
        if (at.sub_category) countupSubCategory = at.sub_category;
        if (Array.isArray(at.tags)) countupTags = at.tags;
        if (at.label) countupLabel = at.label;
        if (at.duration_sec) {
          const s = at.duration_sec;
          setHMS(Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60);
        }
        syncModeUI();
        renderCategoryPicker();
        renderTagPicker();
      } else {
        syncModeUI();
        renderCategoryPicker();
        renderTagPicker();
      }
      render();
    });
    // v2：同步状态变化 → 立即重绘按钮（同步中文案变「同步中…」，按钮 disabled）
    if (Store.subscribeSyncStatus) {
      Store.subscribeSyncStatus(() => { try { render(); } catch (e) {} });
    }
    at = Store.getActiveTimer();
    renderCountdownCategoryPicker();
    renderCountdownTagPicker();
    render();

    // 「已进入状态」按钮
    const focusReadyBtn = document.getElementById("focusReadyBtn");
    if (focusReadyBtn) {
      focusReadyBtn.addEventListener("click", focusModeReady);
    }
    // 再次播放音乐按钮
    const replayBtn = document.getElementById("btnReplayMusic");
    if (replayBtn) {
      replayBtn.addEventListener("click", () => {
        playFocusMusic();
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert("🎵 正在播放进入音乐", 1500);
        }
      });
    }
    // 律动开关
    const beatToggle = document.getElementById("beatToggle");
    if (beatToggle) {
      syncBeatToggleUI();
      beatToggle.addEventListener("click", () => {
        beatEnabled = !beatEnabled;
        try { localStorage.setItem("kaoyan:beat_on", beatEnabled ? "1" : "0"); } catch (e) {}
        syncBeatToggleUI();
        // 如果开关打开且音乐正在播放，立即启动可视化
        if (beatEnabled && focusMusicAudio && !focusMusicAudio.paused) {
          startBeatViz();
        }
        if (window.UI && window.UI.showAlert) {
          window.UI.showAlert(beatEnabled ? "律动已开启" : "律动已关闭", 1200);
        }
      });
    }
    // 全局静音/图书馆模式切换 → 同步音乐（本页内点击 + 跨标签 storage）
    const syncMuteToMusic = () => {
      if (!focusMusicAudio) return;
      if (window.UI && (window.UI.isMuted() || window.UI.isLibrary())) {
        pauseFocusMusic();
      } else if (at && at.status === "running") {
        resumeFocusMusic();
      }
    };
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-mute], [data-library]")) setTimeout(syncMuteToMusic, 30);
    });
    window.addEventListener("storage", (e) => {
      if (e.key === "kaoyan:muted" || e.key === "kaoyan:library") syncMuteToMusic();
    });
    // 音量滑块（竖向 + 鼠标滚轮）
    const volSlider = document.getElementById("musicVolume");
    const volVal = document.getElementById("volVal");
    if (volSlider) {
      const applyVol = () => {
        musicVolume = parseInt(volSlider.value, 10) / 100;
        if (focusMusicAudio) focusMusicAudio.volume = musicVolume;
        if (volVal) volVal.textContent = volSlider.value + "%";
        try { localStorage.setItem("kaoyan:music_vol", String(musicVolume)); } catch (e) {}
      };
      volSlider.value = Math.round(musicVolume * 100);
      volSlider.addEventListener("input", applyVol);
      // 鼠标滚轮调节音量（滚轮上=增大，滚轮下=减小，跨 rollup 方向兼容）
      volSlider.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        let step = ev.deltaY < 0 ? 5 : -5;      // 默认：向上滚增大
        volSlider.value = Math.max(0, Math.min(100, parseInt(volSlider.value, 10) + step));
        applyVol();
      }, { passive: false });
    }

    // 音乐进度条绑定（可拖动 seek）
    bindMusicSeek();

    // URL 参数检测：focus=1 自动进入状态模式（一次性参数，处理完即从地址栏清除，避免刷新重复触发）
    const params = new URLSearchParams(location.search);
    if (params.get("focus") === "1") {
      const cat = params.get("cat") || "study";
      const tagsStr = params.get("tags") || "";
      const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(Boolean) : [];
      const label = params.get("label") || "";
      // 兜底：若已有活动会话（正在计时/暂停中），不重复自动进入状态
      // 延迟一下等页面就绪
      setTimeout(() => {
        if (Store.getActiveTimer()) return; // 已有会话则不再自动进入，避免刷新后重进
        startFocusMode(cat, tags, label);
      }, 300);
      // 清除地址栏的 focus 参数：防止用户在进入态/停止/切换任务后刷新仍被重复触发（重新放音乐+进态）
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    }

    // 绑定标签仪表盘
    bindTagDrawer();

    // 定时更新抽屉头部时间 + 标签条
    setInterval(() => {
      if (drawerOpen && at) updateDrawerHeader();
      updateTagBar();
    }, 500);

    setInterval(tick, 250);
  }

  /* ================================================================
   *  标签仪表盘（底部抽屉，对标爱时间）
   * ================================================================ */
  let drawerOpen = false;
  let drawerCategory = "";      // 一级分类 key
  let drawerSubCategory = "";   // 二级分类 key
  let drawerTags = [];          // 标签数组
  let drawerNote = "";          // 备注
  let drawerAfterSave = null;   // 保存后的回调

  function openTagDrawer(opts) {
    opts = opts || {};
    drawerCategory = opts.category || drawerCategory || "study";
    drawerSubCategory = opts.subCategory || "";
    // 有传 tags 就用传入的（编辑模式），没传就清空（新增模式）
    drawerTags = opts.tags ? [...opts.tags] : [];
    drawerNote = opts.note || "";
    drawerAfterSave = opts.onSave || null;

    renderDrawerCategory();
    renderDrawerSubCats();
    renderDrawerTags();
    updateDrawerHeader();

    const noteEl = document.getElementById("tdNote");
    const noteWrap = document.getElementById("tdNoteWrap");
    const noteToggle = document.getElementById("tdNoteToggle");
    if (noteEl) noteEl.value = drawerNote;
    const cntEl = document.getElementById("tdNoteCount");
    if (cntEl) cntEl.textContent = drawerNote.length;
    // 备注默认收起，如果有内容就展开
    if (noteWrap && noteToggle) {
      if (drawerNote) {
        noteWrap.style.display = "block";
        noteToggle.textContent = "收起 ▴";
      } else {
        noteWrap.style.display = "none";
        noteToggle.textContent = "展开 ▾";
      }
    }

    document.getElementById("tagDrawerMask").classList.add("show");
    document.getElementById("tagDrawer").classList.add("show");
    drawerOpen = true;
  }

  function closeTagDrawer() {
    document.getElementById("tagDrawerMask").classList.remove("show");
    document.getElementById("tagDrawer").classList.remove("show");
    drawerOpen = false;
  }

  function updateDrawerHeader() {
    const timeEl = document.getElementById("tdTimeLabel");
    const badgeEl = document.getElementById("tdCatBadge");
    if (at) {
      const el = currentElapsed();
      const h = Math.floor(el / 3600);
      const m = Math.floor((el % 3600) / 60);
      const s = Math.floor(el % 60);
      timeEl.textContent = (h > 0 ? String(h).padStart(2, "0") + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    } else {
      timeEl.textContent = "00:00";
    }
    const cat = getCategoryMeta(drawerCategory);
    if (cat) {
      badgeEl.textContent = cat.label;
      badgeEl.style.background = cat.color + "20";
      badgeEl.style.color = cat.color;
    } else {
      badgeEl.textContent = "无分类";
      badgeEl.style.background = "";
      badgeEl.style.color = "";
    }
  }

  function getCategoryMeta(key) {
    const cats = C.TIME_CATEGORIES || [];
    for (const c of cats) {
      if (c.key === key) return c;
      if (c.subs) {
        for (const s of c.subs) {
          if (s.key === key) return { ...s, parent: c.key };
        }
      }
    }
    return null;
  }

  function renderDrawerCategory() {
    const grid = document.getElementById("tdCatGrid");
    if (!grid) return;
    const cats = C.TIME_CATEGORIES || [];
    // 判断当前 drawerCategory 是一级还是二级
    let activeParent = drawerCategory;
    const meta = getCategoryMeta(drawerCategory);
    if (meta && meta.parent) activeParent = meta.parent;

    grid.innerHTML = cats.map(c => {
      const active = c.key === activeParent;
      return `<button type="button" class="td-cat-chip ${active ? "active" : ""}"
              style="--chip-color:${c.color}; --chip-bg:${c.color}18"
              data-cat="${c.key}">
        <span class="chip-dot" style="color:${c.color}"></span>${c.label}
      </button>`;
    }).join("");
  }

  function renderDrawerSubCats() {
    const sec = document.getElementById("tdSubCatSection");
    const box = document.getElementById("tdSubCats");
    if (!sec || !box) return;
    const cat = getCategoryMeta(drawerCategory);
    const parentKey = cat && cat.parent ? cat.parent : drawerCategory;
    const parent = C.TIME_CATEGORIES.find(c => c.key === parentKey);
    const subs = parent && parent.subs ? parent.subs : [];

    if (subs.length === 0) { sec.style.display = "none"; return; }
    sec.style.display = "block";
    // 二级分类默认选择：一级是「睡觉」且尚未明确选二级时，默认选中「长睡觉」（优先），不默认选「小憩」
    let activeSub = (cat && cat.parent) ? drawerCategory : drawerSubCategory;
    if (!activeSub && parent && parent.key === "sleep") {
      const preferred = subs.find(s => s.key === "long_sleep");
      if (preferred) {
        activeSub = preferred.key;
        drawerSubCategory = preferred.key; // 同步，保证保存时带上默认二级分类
      }
    }
    box.innerHTML = subs.map(s => `
      <button type="button" class="td-sub-cat ${s.key === activeSub ? "active" : ""}"
              style="--sub-color:${s.color}; --sub-bg:${s.color}18"
              data-sub="${s.key}">${s.label}</button>
    `).join("");
  }

  function renderDrawerTags() {
    const box = document.getElementById("tdTags");
    if (!box) return;
    const common = C.COMMON_TAGS || [];
    box.innerHTML = common.map(t => `
      <button type="button" class="td-tag ${drawerTags.includes(t) ? "active" : ""}" data-tag="${t}">${t}</button>
    `).join("");
  }

  function saveDrawerTags() {
    // 确定最终分类（一级或二级）
    let finalCat = drawerCategory;
    const cat = getCategoryMeta(drawerCategory);
    if (cat && !cat.parent && drawerSubCategory) {
      finalCat = drawerSubCategory;
    }
    // 如果选了二级分类，用二级的 key 作为 category，一级作为 parent
    let finalParent = null;
    const m = getCategoryMeta(finalCat);
    if (m && m.parent) finalParent = m.parent;

    const label = m ? m.label : (cat ? cat.label : "学习");

    const result = {
      category: finalParent || finalCat,
      subCategory: finalParent ? finalCat : "",
      label: label,
      tags: [...drawerTags],
      note: drawerNote
    };

    if (drawerAfterSave) {
      drawerAfterSave(result);
      drawerAfterSave = null;
    }
    closeTagDrawer();
  }

  function updateTagBar() {
    const bar = document.getElementById("tagBar");
    const catEl = document.getElementById("tagBarCat");
    const tagsEl = document.getElementById("tagBarTags");
    if (!bar) return;
    if (!at || focusMode) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    // 分类
    const catKey = at.sub_category || at.kind;
    const meta = getCategoryMeta(catKey);
    const dot = catEl.querySelector(".tbc-dot");
    const text = catEl.querySelector(".tbc-text");
    if (dot) dot.style.background = meta ? meta.color : "#ccc";
    if (text) text.textContent = meta ? meta.label : "未分类";
    // 标签
    const tags = at.tags || [];
    if (tags.length === 0) {
      tagsEl.innerHTML = '<span class="tbt-empty">未打标签</span>';
    } else {
      tagsEl.innerHTML = tags.map(t => `<span class="tbt-tag">${t}</span>`).join("");
    }
    if (window.Icon) window.Icon.inject(bar);
  }

  function bindTagDrawer() {
    const mask = document.getElementById("tagDrawerMask");
    const closeBtn = document.getElementById("tdCloseBtn");
    const tagBar = document.getElementById("tagBar");
    const tagBarEdit = document.getElementById("tagBarEdit");
    const tagBox = document.getElementById("tdTags");

    // 点击标签条打开仪表盘
    function openFromTagBar() {
      if (!at) return;
      openTagDrawer({
        category: at.sub_category || at.kind,
        tags: at.tags || [],
        note: at.note || "",
        onSave: (result) => {
          at.kind = result.category;
          at.label = result.label;
          at.tags = result.tags;
          at.sub_category = result.subCategory || "";
          at.note = result.note;
          Store.setActiveTimer(at);
          render();
          updateTagBar();
          if (window.UI && window.UI.showAlert) {
            window.UI.showAlert("标签已更新", 1500);
          }
        }
      });
    }
    if (tagBar) tagBar.addEventListener("click", openFromTagBar);
    if (tagBarEdit) tagBarEdit.addEventListener("click", (e) => {
      e.stopPropagation();
      openFromTagBar();
    });
    if (mask) mask.addEventListener("click", closeTagDrawer);
    if (closeBtn) closeBtn.addEventListener("click", closeTagDrawer);

    // 分类点击
    const catGrid = document.getElementById("tdCatGrid");
    if (catGrid) {
      catGrid.addEventListener("click", e => {
        const b = e.target.closest("[data-cat]"); if (!b) return;
        drawerCategory = b.dataset.cat;
        drawerSubCategory = "";
        updateDrawerHeader();
        renderDrawerCategory();
        renderDrawerSubCats();
      });
    }

    // 二级分类点击
    const subBox = document.getElementById("tdSubCats");
    if (subBox) {
      subBox.addEventListener("click", e => {
        const b = e.target.closest("[data-sub]"); if (!b) return;
        drawerSubCategory = b.dataset.sub;
        // 把一级+二级组合成新的 drawerCategory（用于显示）
        const sub = b.dataset.sub;
        const meta = getCategoryMeta(sub);
        if (meta && meta.parent) {
          drawerCategory = sub;
        }
        updateDrawerHeader();
        renderDrawerCategory();
        renderDrawerSubCats();
      });
    }

    // 备注展开/收起
    const noteToggle = document.getElementById("tdNoteToggle");
    const noteWrap = document.getElementById("tdNoteWrap");
    if (noteToggle && noteWrap) {
      noteToggle.addEventListener("click", () => {
        const shown = noteWrap.style.display !== "none";
        noteWrap.style.display = shown ? "none" : "block";
        noteToggle.textContent = shown ? "展开 ▾" : "收起 ▴";
      });
    }

    // 标签点击
    if (tagBox) {
      tagBox.addEventListener("click", e => {
        const b = e.target.closest("[data-tag]"); if (!b) return;
        const t = b.dataset.tag;
        if (drawerTags.includes(t)) {
          drawerTags = drawerTags.filter(x => x !== t);
        } else {
          drawerTags.push(t);
        }
        renderDrawerTags();
      });
    }

    // 备注输入
    const noteEl = document.getElementById("tdNote");
    const cntEl = document.getElementById("tdNoteCount");
    if (noteEl && cntEl) {
      noteEl.addEventListener("input", () => {
        drawerNote = noteEl.value;
        cntEl.textContent = drawerNote.length;
      });
    }

    // 保存按钮
    const saveBtn = document.getElementById("tdSaveBtn");
    if (saveBtn) saveBtn.addEventListener("click", saveDrawerTags);

    // 继续添加按钮（保存后不关闭，继续下一段）
    const contBtn = document.getElementById("tdContinueBtn");
    if (contBtn) {
      contBtn.addEventListener("click", () => {
        saveDrawerTags();
        // 清空标签和备注，保持分类
        drawerTags = [];
        drawerNote = "";
        setTimeout(() => openTagDrawer({
          category: drawerCategory,
          tags: [],
          note: ""
        }), 100);
      });
    }

    // 沿用上次倒计时设定（记忆功能，不再每次默认 45min）
    const savedHMS = loadCountdownHMS();
    if (savedHMS) setHMS(savedHMS.h, savedHMS.m, savedHMS.s);
  }

  window.Timer = {
    bind,
    getState: () => at,
    startTask: (taskId) => {
      const t = Store.getTasks().find(x => x.id === taskId);
      if (!t) return;
      // 科目 → 二级分类映射，保证记录归类正确
      const subjToSub = { xizong: "xizong", english: "english", politics: "politics", other: "study_other" };
      const subCategory = subjToSub[t.subject] || "study_other";
      // 任务标题写入备注栏（核心需求：记录具体任务，区别于计时器直接设置的无任务记录）
      const note = `任务：${t.title}`;
      startCountup("study", t.title, t.tags || [], taskId, subCategory, note);
    },
    stopAndMarkDone: () => { stop(true, true); },
    getLinkedTaskId: () => at ? at.task_id : null
  };
  document.addEventListener("DOMContentLoaded", bind);
})();

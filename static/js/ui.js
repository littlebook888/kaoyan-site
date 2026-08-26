/* =====================================================================
 *  ui.js —— 共享 UI 行为：导航、全局静音、图书馆模式、警报、同步徽标、浪前抽屉
 * ===================================================================== */
(function () {
  const C = window.APP_CONFIG;
  const LS = "kaoyan:";

  // 静音状态（持久化）
  function isMuted() { return localStorage.getItem(LS + "muted") === "1"; }
  function setMuted(v) { localStorage.setItem(LS + "muted", v ? "1" : "0"); refreshMuteUI(); }
  // 图书馆模式（=静音 + 振动 + 闪光）
  function isLibrary() { return localStorage.getItem(LS + "library") === "1"; }
  function setLibrary(v) { localStorage.setItem(LS + "library", v ? "1" : "0"); if (v) setMuted(true); refreshLibUI(); }

  function refreshMuteUI() {
    document.querySelectorAll("[data-mute]").forEach(el => {
      el.classList.toggle("on", !isMuted());
      el.title = isMuted() ? "已静音（点击开启声音）" : "声音开启（点击静音）";
      if (window.Icon) window.Icon.set(el, isMuted() ? "volume-x" : "volume-2");
    });
  }
  function refreshLibUI() {
    document.querySelectorAll("[data-library]").forEach(el => {
      el.classList.toggle("on", isLibrary());
    });
  }

  // 警报条
  function showAlert(msg, ms = 4000) {
    const a = document.getElementById("alert");
    if (!a) return;
    a.textContent = msg; a.classList.add("show");
    clearTimeout(showAlert._t);
    showAlert._t = setTimeout(() => a.classList.remove("show"), ms);
  }

  // 振动 + 屏幕闪光（防外放替代方案）
  function buzz() {
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (_) {} }
    const f = document.getElementById("flash");
    if (f) {
      f.style.opacity = "1";
      setTimeout(() => { f.style.opacity = "0"; }, 220);
    }
  }

  // 简单提示音（受静音/图书馆模式约束）
  let audioCtx = null;
  function beep(times = 2) {
    if (isMuted() || isLibrary()) return; // 静音/图书馆模式不响
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      let n = 0;
      const tick = () => {
        if (n >= times) return;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type = "sine"; o.frequency.value = 880;
        g.gain.setValueAtTime(0.001, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
        o.start(); o.stop(audioCtx.currentTime + 0.26);
        n++;
        setTimeout(tick, 350);
      };
      tick();
    } catch (_) {}
  }

  // 系统通知
  function notify(title, body) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      try { new Notification(title, { body }); } catch (_) {}
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission();
    }
  }

  // 同步徽标
  function refreshSyncBadge() {
    const el = document.getElementById("syncBadge");
    if (!el) return;
    const txt = el.querySelector(".sb-txt");
    const ico = el.querySelector(".hico");
    const cloud = window.Store && window.Store.isCloud && window.Store.isCloud();
    if (cloud) {
      if (txt) txt.textContent = "云端同步中";
      if (ico) { ico.setAttribute("data-icon", "cloud"); ico.removeAttribute("data-icon-ok"); }
      el.classList.add("cloud");
    } else {
      if (txt) txt.textContent = "本机存储";
      if (ico) { ico.setAttribute("data-icon", "smartphone"); ico.removeAttribute("data-icon-ok"); }
      el.classList.remove("cloud");
    }
    if (window.Icon) window.Icon.inject(el);
  }

  // 浪前抽屉
  function setupLangqianDrawer() {
    const drawer = document.getElementById("langqianDrawer");
    const openBtn = document.getElementById("langqianOpen");
    if (!drawer) return;
    if (openBtn) openBtn.addEventListener("click", () => drawer.classList.add("open"));
    drawer.querySelectorAll("[data-close]").forEach(b =>
      b.addEventListener("click", () => drawer.classList.remove("open")));
  }

  // 请求通知权限（用户首次交互时）
  function askNotifyOnce() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  // 暴露
  window.UI = {
    isMuted, setMuted, isLibrary, setLibrary,
    refreshMuteUI, refreshLibUI, refreshSyncBadge,
    showAlert, buzz, beep, notify, setupLangqianDrawer, askNotifyOnce
  };

  // 绑定悬浮按钮
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-mute]").forEach(el =>
      el.addEventListener("click", () => { askNotifyOnce(); setMuted(!isMuted()); }));
    document.querySelectorAll("[data-library]").forEach(el =>
      el.addEventListener("click", () => setLibrary(!isLibrary())));
    // 跨标签同步静音状态
    window.addEventListener("storage", (e) => {
      if (e.key === LS + "muted" || e.key === LS + "library") { refreshMuteUI(); refreshLibUI(); }
    });
    refreshMuteUI(); refreshLibUI(); refreshSyncBadge();
    setupLangqianDrawer();
  });
})();

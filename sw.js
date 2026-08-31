/* sw.js —— 离线缓存应用外壳（PWA 安装 / 断网可用） */
const CACHE = "kaoyan-v83";
const SHELL = [
  "index.html", "timer.html", "tasks.html", "stats.html", "call.html", "reminders.html",
  "manifest.webmanifest",
  "static/css/theme.css",
  "static/js/config.js", "static/js/blocks.js", "static/js/clock.js", "static/js/store.js", "static/js/ui.js",
  "static/js/today-records.js",
  "static/js/icon.js", "static/js/reveal.js",
  "static/js/home.js", "static/js/timer.js", "static/js/tasks.js", "static/js/stats.js",
  "static/js/call.js", "static/js/call-data.js",
  "static/js/xizong-plan.js", "static/js/xizong-physio.js", "static/js/xizong-live.js", "static/js/today-xizong-plan.js",
  "static/js/reminders-data.js", "static/js/reminders.js",
  "assets/icon.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// —— 缓存策略分层 ——
// HTML / JS / CSS：network-first（部署后立即生效，绝不吃旧缓存）
// 其他静态资源（图片/图标）：stale-while-revalidate（秒开体验，后台偷偷刷新）
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨源（Supabase CDN 等）交给网络

  const isHtml = url.pathname.endsWith(".html") || url.pathname === "/";
  const isCode = url.pathname.endsWith(".js") || url.pathname.endsWith(".css");

  if (isHtml || isCode) {
    // HTML / JS / CSS = network first（保证代码永远是最新的）
    e.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 其他（图片/字体/manifest 等） = stale-while-revalidate
  e.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

/* sw.js —— 离线缓存应用外壳（PWA 安装 / 断网可用） */
const CACHE = "kaoyan-v230";
const SHELL = [
  "index.html", "timer.html", "tasks.html", "stats.html", "call.html", "reminders.html", "rest.html",
  "manifest.webmanifest",
  "static/css/theme.css",
  "static/js/config.js", "static/js/blocks.js", "static/js/clock.js", "static/js/store.js", "static/js/ui.js",
  "static/js/today-records.js", "static/js/day-view.js", "static/js/day-review.js",
  "static/js/icon.js", "static/js/reveal.js",
  "static/js/rec-edit.js", "static/js/home.js", "static/js/timer.js", "static/js/tasks.js", "static/js/stats.js",
  "static/js/call.js", "static/js/call-data.js",
  "static/js/xizong-plan.js", "static/js/xizong-physio.js", "static/js/xizong-live.js", "static/js/today-xizong-plan.js",
  "static/js/reminders-data.js", "static/js/reminders.js",
  "static/js/word-plan.js", "static/js/rest-data.js", "static/js/rest.js",
  "static/js/checkin.js", "static/js/violation.js",
  "schedule.html", "static/js/schedule-data.js", "static/js/schedule.js",
  "static/js/home-schedule.js",
  "assets/icon.svg", "assets/icon-192.png", "assets/icon-512.png", "assets/icon-maskable-512.png"
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

  /* ★ v1.39.0 副站放行：刷题站（neike-306-tiku）不归本 SW 管。
   * 原因（用户 2026-10-07 实测反馈）：副站更新后必须强刷才生效——
   *   本 SW 的作用域是整个 /kaoyan-site/，副站在其之下，
   *   于是副站的 47 个 JS chunk 与 669 张图（91MB）都被本 SW 缓存接管。
   * 不 respondWith 即「不拦截」，请求走浏览器默认缓存，部署后立即生效。
   * 代价：副站离线不可用——但它是题库站，没网本来也刷不了。 */
  if (url.pathname.includes("/neike-306-tiku/")) return;
  /* 口诀复习站同理：单文件 824KB（含 2287 条数据），属"内容型"资源，
   * 与刷题站一样不归本 SW 管——否则每次更新都要强刷才能生效。 */
  if (url.pathname.includes("/koujue/")) return;

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

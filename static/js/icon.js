/* =====================================================================
 *  icon.js —— 注入本地 Lucide 风格 SVG 图标（源自 github.com/lucide-icons/lucide，已本地化）
 *  用法：
 *    <span data-icon="timer"></span>            → 自动填入 assets/icons/timer.svg
 *    Icon.set(el, "volume-2")                    → 把元素内容替换为该图标
 *    await Icon.get("timer")                      → 返回该图标 SVG 字符串
 *  全部本地文件、离线可用、不依赖任何运行时 CDN。
 * ===================================================================== */
(function () {
  const BASE = "assets/icons/";
  const cache = Object.create(null);

  async function get(name) {
    if (name in cache) return cache[name];
    try {
      const r = await fetch(BASE + name + ".svg", { cache: "force-cache" });
      if (!r.ok) { cache[name] = ""; if (window.console) console.warn("[icon] 图标缺失:", BASE + name + ".svg"); return ""; }
      const t = await r.text();
      if (!t.trim()) { cache[name] = ""; if (window.console) console.warn("[icon] 空图标文件:", BASE + name + ".svg"); return ""; }
      cache[name] = t;
      return t;
    } catch (e) { cache[name] = ""; if (window.console) console.warn("[icon] 加载失败:", BASE + name + ".svg"); return ""; }
  }

  async function set(el, name) {
    const svg = await get(name);
    if (svg) el.innerHTML = svg;
    return svg;
  }

  async function inject(root) {
    root = root || document;
    const els = root.querySelectorAll("[data-icon]:not([data-icon-ok])");
    await Promise.all([].slice.call(els).map(async (el) => {
      const name = el.getAttribute("data-icon");
      if (!name) return;
      const svg = await get(name);
      if (svg) {
        el.innerHTML = svg;
        el.setAttribute("data-icon-ok", "");
      }
    }));
  }

  window.Icon = { get, set, inject };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => inject());
  } else {
    inject();
  }
})();

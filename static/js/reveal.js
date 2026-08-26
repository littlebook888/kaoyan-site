/* =====================================================================
 *  reveal.js —— 苹果风滚动入场（IntersectionObserver + CSS，零依赖）
 *  给元素加 data-reveal 即可；进入视口时添加 .in，逐张错落浮现。
 *  尊重 prefers-reduced-motion；JS 失败时内容仍可见（渐进增强）。
 * ===================================================================== */
(function () {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function init() {
    document.documentElement.classList.add("js-reveal");
    const els = document.querySelectorAll("[data-reveal]:not([data-reveal-ok])");
    els.forEach((e) => e.setAttribute("data-reveal-ok", ""));

    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });

    els.forEach((e, i) => {
      e.style.setProperty("--rd", Math.min(i, 10) * 60 + "ms");
      io.observe(e);
    });
  }

  window.Reveal = { init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

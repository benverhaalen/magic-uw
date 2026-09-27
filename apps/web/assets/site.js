// Small progressive enhancements. Every page reads correctly without this script.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Silent product loops. Each <video> ships with a poster and data-src sources only, so nothing
// downloads until the clip nears the viewport; it plays while visible and pauses offscreen.
// Reduced motion (or no IntersectionObserver) keeps the poster. The Pause button appears once a
// clip actually plays, so a slot whose clip isn't there yet stays a still poster.
const loops = [...document.querySelectorAll("[data-loop]")];
if (loops.length && !reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target.querySelector("video");
        if (!entry.isIntersecting) {
          video.pause();
          continue;
        }
        if (!video.dataset.loaded) {
          video.dataset.loaded = "1";
          for (const source of video.querySelectorAll("source[data-src]")) source.src = source.dataset.src;
          video.load();
        }
        if (entry.target.dataset.paused !== "1") video.play().catch(() => {});
      }
    },
    { rootMargin: "150px 0px" },
  );
  for (const loop of loops) {
    const video = loop.querySelector("video");
    const toggle = loop.querySelector("[data-loop-toggle]");
    video.addEventListener("playing", () => (toggle.hidden = false), { once: true });
    toggle.addEventListener("click", () => {
      const pause = loop.dataset.paused !== "1";
      loop.dataset.paused = pause ? "1" : "0";
      toggle.textContent = pause ? "Play" : "Pause";
      if (pause) video.pause();
      else video.play().catch(() => {});
    });
    observer.observe(loop);
  }
}

// Study notebook carousel arrows.
const cards = document.querySelector("[data-cards]");
for (const button of document.querySelectorAll("[data-scroll]")) {
  button.addEventListener("click", () => {
    cards?.scrollBy({ left: Number(button.dataset.scroll) * 266, behavior: "smooth" });
  });
}

// FAQ: category filters and one open answer at a time.
const questions = [...document.querySelectorAll(".qa")];
const filters = [...document.querySelectorAll("[data-filter]")];
const applyFilter = (category) => {
  for (const f of filters) f.setAttribute("aria-pressed", String(f.dataset.filter === category));
  for (const q of questions) {
    q.hidden = category !== "all" && q.dataset.cat !== category;
    if (q.hidden) q.open = false;
  }
};
for (const f of filters) f.addEventListener("click", () => applyFilter(f.dataset.filter));
for (const q of questions) {
  q.addEventListener("toggle", () => {
    if (q.open) for (const other of questions) if (other !== q) other.open = false;
  });
}
if (questions.length && location.hash === "#privacy") {
  applyFilter("privacy");
  document.getElementById("privacy").open = true;
}

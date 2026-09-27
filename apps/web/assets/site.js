// Small progressive enhancements. Every page reads correctly without this script.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Assignment spaces: cursor moves to Homework 6, clicks, and the three windows open.
const stage = document.querySelector(".stage");
if (stage && !reduceMotion) {
  const steps = [
    [0, 900],
    [1, 800],
    [2, 350],
    [3, 3400],
  ];
  let i = 0;
  const next = () => {
    const [step, wait] = steps[i];
    stage.dataset.step = String(step);
    i = (i + 1) % steps.length;
    setTimeout(next, wait);
  };
  next();
}

// Study notebook carousel arrows.
const cards = document.querySelector("[data-cards]");
for (const button of document.querySelectorAll("[data-scroll]")) {
  button.addEventListener("click", () => {
    const step = (cards?.firstElementChild?.getBoundingClientRect().width ?? 240) + 12;
    cards?.scrollBy({ left: Number(button.dataset.scroll) * step, behavior: "smooth" });
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

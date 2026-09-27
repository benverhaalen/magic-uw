"use strict";
const $ = (id) => document.getElementById(id),
  storePrefix = "magic-lab-v3:",
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function read(key, fallback = "") {
  try {
    return localStorage.getItem(storePrefix + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  localStorage.setItem(storePrefix + key, value);
}
window.magicFontsReady.then((loaded) => {
  $("font-state").textContent = loaded
    ? "exact local fonts loaded"
    : "fallback fonts · not a visual match";
  document.documentElement.dataset.fonts = loaded ? "exact" : "fallback";
});
const issueKey = "exam-conflict:source-v1";
$("handled").checked = read(issueKey) === "true";
function ackFeedback() {
  const status = $("ack-status");
  status.replaceChildren();
  if ($("handled").checked) {
    status.append("Recorded locally. ");
    const undo = document.createElement("button");
    undo.className = "mc-action mc-action--quiet";
    undo.style = "min-height:28px;padding:0 4px";
    undo.textContent = "Undo";
    undo.onclick = () => {
      $("handled").checked = false;
      try {
        save(issueKey, "false");
        ackFeedback();
        $("handled").focus();
      } catch {
        status.textContent = "Could not save this choice. Try again.";
      }
    };
    status.append(undo);
  }
}
ackFeedback();
$("handled").addEventListener("change", () => {
  try {
    save(issueKey, String($("handled").checked));
    ackFeedback();
  } catch {
    $("handled").checked = !$("handled").checked;
    $("ack-status").textContent = "Could not save this choice. Try again.";
  }
});
let sourceReturn = null,
  sourceScroll = 0;
const evidence = {
  guest: {
    title: "DESIGN 210 · Guest speaker",
    text: "Synthetic source v1: the guest speaker joins remotely for the October 7 lecture. Students still attend Room 210. No separate call is required.",
  },
  reading: {
    title: "CS 220 · Assigned readings",
    text: "Synthetic source v1: three assigned readings — Testing fundamentals, API contracts, and Debugging strategies — are due before the October 7, 1 PM Central lecture. The syllabus states that lecture quizzes cover these pre-class readings. Opening this source does not mark any reading complete.",
  },
  exam: {
    title: "CS 310 / CS 220 · Exam options",
    text: "Synthetic source v1: both exams list November 12, 5:45–7:15 PM Central. The CS 220 notice lists November 13 as an alternate and asks students to confirm eligibility with the instructor.",
  },
  assignment: {
    title: "DESIGN 210 · End User Interview synthesis",
    text: "Synthetic source v1: one template is submitted per team. A Word document or a publicly shared Google Doc is accepted. This specimen cannot submit coursework.",
  },
};
document.querySelectorAll("[data-source]").forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    sourceReturn = link;
    sourceScroll = window.scrollY;
    const source = evidence[link.dataset.source];
    $("evidence-title").textContent = source.title;
    $("evidence-copy").textContent = source.text;
    $("evidence").hidden = false;
    $("evidence").focus();
    $("evidence").scrollIntoView({ block: "center", behavior: "instant" });
  }),
);
$("evidence-back").onclick = () => {
  $("evidence").hidden = true;
  sourceReturn?.focus({ preventScroll: true });
  window.scrollTo({ top: sourceScroll, behavior: "instant" });
};
$("local-check").onclick = async () => {
  const b = $("local-check");
  if (b.getAttribute("aria-busy") === "true") return;
  b.setAttribute("aria-disabled", "true");
  b.setAttribute("aria-busy", "true");
  $("check-status").textContent = "Checking this local example…";
  await delay(650);
  $("check-status").textContent =
    "Example checked. No external source was refreshed.";
  b.removeAttribute("aria-disabled");
  b.removeAttribute("aria-busy");
};
$("note").value = read("note");
$("note-form").onsubmit = async (e) => {
  e.preventDefault();
  const field = $("note"),
    error = $("note-error"),
    button = $("note-save"),
    status = $("note-status");
  if (button.getAttribute("aria-busy") === "true") return;
  error.hidden = true;
  field.removeAttribute("aria-invalid");
  if (!field.value.trim()) {
    error.hidden = false;
    error.textContent = "Write a note before saving.";
    field.setAttribute("aria-invalid", "true");
    field.focus();
    return;
  }
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  status.textContent = "Saving locally…";
  status.removeAttribute("data-tone");
  await delay(700);
  try {
    if ($("simulate-error").checked) throw Error("Simulated");
    save("note", field.value.trim());
    status.textContent = "Note saved in this browser.";
    status.dataset.tone = "success";
  } catch {
    status.textContent =
      "Could not save. Your note is still here. Turn off the simulated failure and retry.";
    status.dataset.tone = "error";
  } finally {
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-busy");
  }
};
const dialog = $("plan-dialog");
let planGeneration = 0;
$("plan-open").onclick = () => {
  dialog.showModal();
  $("plan-title").focus();
};
function closePlan() {
  planGeneration++;
  dialog.close();
  $("plan-open").focus();
}
$("plan-close").onclick = closePlan;
$("plan-cancel").onclick = closePlan;
dialog.addEventListener("cancel", () => {
  planGeneration++;
});
dialog.addEventListener("close", () => {
  $("plan-save").removeAttribute("aria-disabled");
  $("plan-save").removeAttribute("aria-busy");
  $("plan-progress").textContent = "";
  $("plan-error").hidden = true;
  $("plan-error").textContent = "";
  [$("plan-date"), $("plan-start"), $("plan-end")].forEach((field) =>
    field.removeAttribute("aria-invalid"),
  );
  $("plan-open").focus();
});
$("adjust-time").onclick = () => {
  const open = $("plan-adjust").hidden;
  $("plan-adjust").hidden = !open;
  $("adjust-time").setAttribute("aria-expanded", String(open));
  if (open) $("plan-date").focus();
};
$("plan-form").onsubmit = async (event) => {
  event.preventDefault();
  const error = $("plan-error"),
    fields = [$("plan-date"), $("plan-start"), $("plan-end")],
    button = $("plan-save");
  if (button.getAttribute("aria-busy") === "true") return;
  error.hidden = true;
  fields.forEach((x) => x.removeAttribute("aria-invalid"));
  const invalid =
    fields.find((x) => !x.value) ||
    ($("plan-end").value <= $("plan-start").value ? $("plan-end") : null);
  if (invalid) {
    $("plan-adjust").hidden = false;
    $("adjust-time").setAttribute("aria-expanded", "true");
    error.hidden = false;
    error.textContent = !invalid.value
      ? "Choose a date, start time and end time."
      : "Choose an end time after the start time.";
    invalid.setAttribute("aria-invalid", "true");
    invalid.focus();
    return;
  }
  const generation = ++planGeneration,
    plan = {
      date: $("plan-date").value,
      start: $("plan-start").value,
      end: $("plan-end").value,
      title: "Practice choosing a graph traversal",
      timezone: "America/Chicago",
    };
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  $("plan-progress").textContent = "Saving to this browser…";
  await delay(900);
  if (generation !== planGeneration) return;
  try {
    if ($("simulate-error").checked) throw Error("Simulated");
    save("plan", JSON.stringify(plan));
    closePlan();
    $("plan-status").textContent =
      `Local plan saved: ${plan.date}, ${plan.start}–${plan.end} Central.`;
  } catch {
    error.hidden = false;
    error.textContent =
      "Could not save locally. Your choices are preserved. Turn off the simulated failure and retry.";
    $("plan-progress").textContent = "";
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-busy");
  }
};
// Native popover provides outside/Escape dismissal. A small command menu
// provides roving focus, arrows, Home/End, typeahead, selection and trigger return.
const menu = $("view-menu"),
  trigger = $("menu-trigger"),
  items = [...menu.querySelectorAll("[role=menuitem]")];
function positionMenu() {
  const r = trigger.getBoundingClientRect();
  menu.style.left = Math.min(r.left + scrollX, innerWidth - 226) + "px";
  menu.style.top = r.bottom + scrollY + 6 + "px";
}
menu.addEventListener("toggle", (e) => {
  const open = e.newState === "open";
  trigger.setAttribute("aria-expanded", String(open));
  if (open) {
    positionMenu();
    items[0].focus();
  } else if (
    menu.contains(document.activeElement) ||
    document.activeElement === document.body
  ) {
    trigger.focus();
  }
});
trigger.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    menu.showPopover();
    (e.key === "ArrowDown" ? items[0] : items.at(-1)).focus();
  }
});
menu.addEventListener("keydown", (e) => {
  const index = items.indexOf(document.activeElement);
  let target;
  if (e.key === "ArrowDown") target = items[(index + 1) % items.length];
  if (e.key === "ArrowUp")
    target = items[(index + items.length - 1) % items.length];
  if (e.key === "Home") target = items[0];
  if (e.key === "End") target = items.at(-1);
  if (
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    e.key !== " "
  )
    target = items.find((x) =>
      x.textContent.toLowerCase().startsWith(e.key.toLowerCase()),
    );
  if (target) {
    e.preventDefault();
    target.focus();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    menu.hidePopover();
    trigger.focus();
  }
  if (e.key === "Tab") {
    menu.hidePopover();
    trigger.focus();
  }
});
items.forEach(
  (item) =>
    (item.onclick = () => {
      menu.hidePopover();
      trigger.focus();
      const target =
        item.dataset.view === "context"
          ? $("context-title")
          : item.dataset.view === "controls"
            ? $("local-check")
            : $("main");
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", behavior: "instant" });
      $("check-status").textContent =
        "Showing " +
        item.textContent.toLowerCase() +
        ". The other examples remain available below.";
    }),
);
addEventListener("resize", () => {
  if (menu.matches(":popover-open")) positionMenu();
});
$("reset").onclick = () => {
  try {
    ["note", "plan", issueKey].forEach((k) =>
      localStorage.removeItem(storePrefix + k),
    );
    $("note").value = "";
    $("handled").checked = false;
    ackFeedback();
    $("note-status").textContent = "";
    $("note-error").hidden = true;
    $("note").removeAttribute("aria-invalid");
    $("plan-status").textContent = "";
    $("simulate-error").checked = false;
    $("check-status").textContent = "Local examples reset.";
  } catch {
    $("check-status").textContent = "Browser storage is unavailable.";
  }
};

dialog.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = [
    ...dialog.querySelectorAll("button,input,select,textarea,a[href]"),
  ].filter((x) => !x.disabled && x.getClientRects().length);
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

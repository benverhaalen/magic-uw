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
window.magicFontsReady.then((state) => {
  $("font-state").textContent = window.magicFontLabel(state);
  document.documentElement.dataset.fonts = state.exact ? "exact" : "fallback";
});
// Course identity is supplied once from the object, never its row position.
const courses = {
  design210: { label: "DESIGN 210", identity: "coral" },
  cs220: { label: "CS 220", identity: "blue" },
  cs310: { label: "CS 310", identity: "blue" },
};
document.querySelectorAll("[data-course-id]").forEach((element) => {
  const course = courses[element.dataset.courseId];
  if (course) element.dataset.identity = course.identity;
  else element.removeAttribute("data-identity");
});
let examVersion = read("exam-version") === "v2" ? "v2" : "v1";
const issueKey = () => `exam-conflict:source-${examVersion}`;
function confirmation(version) {
  const value = read(`exam-conflict:source-${version}`);
  if (value === "true")
    return { confirmedAt: "time not recorded (earlier fixture)" };
  try {
    return JSON.parse(value) || null;
  } catch {
    return null;
  }
}
function renderHistory() {
  $("exam-history").textContent = ["v1", "v2"]
    .map((version) => {
      const record = confirmation(version);
      const date = record && new Date(record.confirmedAt);
      const timestamp =
        date && !Number.isNaN(date.getTime())
          ? new Intl.DateTimeFormat("en-US", {
              timeZone: "America/Chicago",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            }).format(date)
          : record?.confirmedAt;
      return `${version}: ${record ? "reported handled · " + timestamp : "no current confirmation"}.`;
    })
    .join(" ");
}
function ackFeedback() {
  const status = $("ack-status");
  status.replaceChildren();
  renderHistory();
  if ($("handled").checked) {
    status.append(`Recorded locally for ${examVersion}. `);
    const undo = document.createElement("button");
    undo.className = "mc-action mc-action--quiet";
    undo.style = "min-height:28px;padding:0 4px";
    undo.textContent = "Undo";
    undo.onclick = () => {
      try {
        save(issueKey(), "false");
        $("handled").checked = false;
        ackFeedback();
        $("handled").focus();
      } catch {
        status.textContent = "Could not save this choice. Try again.";
      }
    };
    status.append(undo);
  }
}
function renderExam() {
  $("exam-alternate").textContent = examVersion === "v2" ? "Nov 14" : "Nov 13";
  $("handled").checked = Boolean(confirmation(examVersion));
  $("exam-update").setAttribute("aria-disabled", String(examVersion === "v2"));
  $("exam-update-status").textContent =
    examVersion === "v2"
      ? "Notice v2 moved the alternate from Nov 13 to Nov 14. Earlier confirmations apply only to v1; review this changed date before confirming again."
      : "Synthetic notice v1 · alternate Nov 13. Updating this example changes the alternate date.";
  ackFeedback();
}
$("handled").addEventListener("change", () => {
  try {
    save(
      issueKey(),
      $("handled").checked
        ? JSON.stringify({ confirmedAt: new Date().toISOString() })
        : "false",
    );
    ackFeedback();
  } catch {
    $("handled").checked = !$("handled").checked;
    $("ack-status").textContent = "Could not save this choice. Try again.";
  }
});
$("exam-update").onclick = () => {
  if (examVersion === "v2") return;
  try {
    save("exam-version", "v2");
    examVersion = "v2";
    renderExam();
    if (!$("evidence").hidden && activeSource?.startsWith("exam-"))
      renderSource(activeSource);
  } catch {
    $("exam-update-status").textContent =
      "Could not update this local example. Try again.";
  }
};
renderExam();
let sourceReturn = null,
  sourceScroll = 0,
  activeSource = null;
const evidence = {
  "design210-lecture": {
    title: "DESIGN 210 · October 7 guest lecture",
    location: "Canvas fixture · Announcements · Guest speaker · paragraph 1",
    text: "The guest joins remotely for the October 7 lecture. Students still attend Room 210. No separate call is required.",
    limits:
      "Synthetic lecture context. No live classroom or call is connected.",
  },
  "cs220-lecture": {
    title: "CS 220 · October 7 lecture",
    location: "Canvas fixture · Week 6 · Lecture preparation",
    text: "The next lecture starts October 7 at 1 PM Central. Testing fundamentals, API contracts and Debugging strategies are assigned beforehand; the syllabus says lecture quizzes cover these readings.",
    limits: "Synthetic lecture context. Reading completion is unknown.",
  },
  "cs220-readings": {
    title: "CS 220 · Assigned readings",
    location: "Canvas fixture · Week 6 · Readings 1–3",
    text: "Review these short synthetic reading excerpts for the October 7 lecture.",
    materials: [
      [
        "Testing fundamentals",
        "Choose cases that check normal input, boundaries and expected failures. A passing case alone does not establish correctness.",
      ],
      [
        "API contracts",
        "An API contract describes accepted inputs, returned values and observable errors. Callers should be able to rely on that contract.",
      ],
      [
        "Debugging strategies",
        "Reproduce the failure, narrow its cause with a small discriminating test, then check the repair against the original failure.",
      ],
    ],
    limits:
      "These are local fixture excerpts, not a connected course's full readings. Opening them records no completion.",
  },
  "exam-context": {
    title: "CS 310 / CS 220 · Midterm schedule",
    location: "Canvas fixture · CS 310 schedule + CS 220 midterm notice",
    text: () =>
      `Both exams list November 12, 5:45–7:15 PM Central. CS 220's ${examVersion} notice lists November ${examVersion === "v2" ? "14" : "13"} as an alternate; eligibility is unconfirmed.`,
    limits:
      "Synthetic exam context. No alternate arrangement has been approved.",
  },
  "exam-options": {
    title: "CS 220 · Alternate exam notice",
    location:
      "Canvas fixture · Midterm notice · Alternate sitting, paragraph 2",
    text: () =>
      `Notice ${examVersion}: the CS 220 alternate sitting is November ${examVersion === "v2" ? "14" : "13"}. Ask the instructor whether you are eligible before relying on it. The original November 12 overlap remains.`,
    materials: [
      [
        "Next step",
        "Use this notice to discuss eligibility with your instructor. The lab can record only your own handled choice; it cannot send a message or book a sitting.",
      ],
    ],
    limits:
      "Synthetic option review. No instructor contact, booking or external launch occurs.",
  },
  "design210-interview": {
    title:
      "DESIGN 210 · End User Interview synthesis: findings, contrasting perspectives and recommendations",
    location:
      "Canvas fixture · Assignments · End User Interview synthesis · Instructions",
    text: "Due October 9 at 11:59 PM Central · 20 points. Submit one synthesis per team, covering findings, contrasting perspectives and recommendations. A Word document or publicly shared Google Doc is accepted.",
    limits:
      "Synthetic assignment context. No submission or document launch is available.",
  },
  "cs220-interface": {
    title: "CS 220 · Interface exercise",
    location:
      "Canvas fixture · Assignments · Interface exercise · Instructions",
    text: "Due October 7 at 11:59 PM Central · 10 points. Define a small interface, document its inputs and outputs, and demonstrate how invalid input is handled.",
    limits:
      "Synthetic assignment context. No coding environment or submission service is connected.",
  },
  "design210-methods": {
    title: "DESIGN 210 · Methods quiz",
    location: "Canvas fixture · Quizzes · Methods quiz · Overview",
    text: "Due October 9 at 11:59 PM Central · 20 points. The example quiz covers interview planning, observation and comparing research methods.",
    limits:
      "Synthetic quiz context. No real quiz can be started or submitted here.",
  },
  "cs310-practice": {
    title: "CS 310 · Practice choosing a graph traversal",
    location:
      "Local practice fixture · Based on Data structures readings · Graph traversals §2",
    text: "Practice prompt: In an unweighted graph, you need the fewest edges from a start node to a target. Choose breadth-first or depth-first search and explain your choice.",
    answer:
      "Breadth-first search visits nodes by distance from the start, so the first visit to the target uses the fewest edges. Depth-first search does not guarantee that shortest path.",
    limits:
      "Synthetic local practice only. No answer is graded or saved, and no mastery is inferred.",
  },
  "cs310-reading-evidence": {
    title: "CS 310 · Data structures readings",
    location: "Canvas fixture · Data structures readings · Graph traversals §2",
    text: "Supporting excerpt: Breadth-first search explores successive distance layers in an unweighted graph. Depth-first search follows a branch before backtracking. This supports the traversal-choice practice prompt.",
    limits:
      "Synthetic provenance excerpt. The original course resource is unavailable in this lab; reading completion is unknown.",
  },
};
function renderSource(id) {
  const source = evidence[id];
  $("evidence").dataset.objectId = id;
  $("evidence-title").textContent = source.title;
  $("evidence-copy").textContent =
    typeof source.text === "function" ? source.text() : source.text;
  $("evidence-location").textContent = "Location: " + source.location;
  $("evidence-captured").textContent =
    `Fixture capture: October 6, 2026 · ${id.startsWith("exam-") && examVersion === "v2" ? "9:35 AM Central · v2" : "9:00 AM Central · v1"}.`;
  $("evidence-limits").textContent = source.limits;
  const material = $("evidence-material");
  material.replaceChildren();
  for (const [title, text] of source.materials || []) {
    const heading = document.createElement("h3"),
      paragraph = document.createElement("p");
    heading.textContent = title;
    paragraph.textContent = text;
    material.append(heading, paragraph);
  }
  if (source.answer) {
    const details = document.createElement("details"),
      summary = document.createElement("summary"),
      answer = document.createElement("p");
    summary.className = "mc-disclosure";
    const disclosureIcon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      ),
      disclosureUse = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "use",
      );
    disclosureIcon.setAttribute("class", "mc-glyph");
    disclosureIcon.setAttribute("aria-hidden", "true");
    disclosureUse.setAttribute("href", "#chevron-right");
    disclosureIcon.append(disclosureUse);
    summary.append(disclosureIcon, "Compare your reasoning");
    answer.textContent = source.answer;
    details.append(summary, answer);
    material.append(details);
  }
}
document.querySelectorAll("[data-source]").forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    sourceReturn = link;
    sourceScroll = window.scrollY;
    activeSource = link.dataset.source;
    renderSource(activeSource);
    const anchor = link.closest(
      ".mc-context,.mc-passage,.lab-item-list,.lab-learning-grid",
    );
    anchor.after($("evidence"));
    $("evidence").hidden = false;
    $("evidence").focus({ preventScroll: true });
    $("evidence").scrollIntoView({ block: "nearest", behavior: "instant" });
  }),
);
$("evidence-back").onclick = () => {
  $("evidence").hidden = true;
  sourceReturn?.focus({ preventScroll: true });
  window.scrollTo({ top: sourceScroll, behavior: "instant" });
};
let operationGeneration = 0;
$("local-check").onclick = async () => {
  const b = $("local-check");
  if (b.getAttribute("aria-busy") === "true") return;
  b.setAttribute("aria-disabled", "true");
  b.setAttribute("aria-busy", "true");
  $("check-status").textContent = "Checking this local example…";
  const generation = operationGeneration;
  await delay(650);
  if (generation !== operationGeneration) return;
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
  const submittedValue = field.value,
    payload = submittedValue.trim(),
    generation = operationGeneration,
    simulateFailure = $("simulate-error").checked;
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  status.textContent = "Saving locally…";
  status.removeAttribute("data-tone");
  await delay(700);
  if (generation !== operationGeneration) return;
  try {
    if (simulateFailure) throw Error("Simulated");
    save("note", payload);
    status.textContent =
      field.value === submittedValue
        ? "Note saved in this browser."
        : "Submitted note saved. Your later edits are still here and have not been saved.";
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
// This is navigation, so anchors keep native Tab order and link semantics.
const menu = $("view-menu"),
  trigger = $("menu-trigger");
function positionMenu() {
  const r = trigger.getBoundingClientRect();
  menu.style.left = Math.min(r.left + scrollX, innerWidth - 226) + "px";
  menu.style.top = r.bottom + scrollY + 6 + "px";
}
menu.addEventListener("toggle", (event) => {
  trigger.setAttribute("aria-expanded", String(event.newState === "open"));
  if (event.newState === "open") positionMenu();
});
menu.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    menu.hidePopover();
    const target = document.querySelector(link.getAttribute("href"));
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start", behavior: "instant" });
  });
});
addEventListener("resize", () => {
  if (menu.matches(":popover-open")) positionMenu();
});
$("reset").onclick = () => {
  // Pending requests belong to the state before reset and cannot commit after it.
  operationGeneration++;
  planGeneration++;
  [$("note-save"), $("local-check"), $("plan-save")].forEach((button) => {
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-busy");
  });
  if (dialog.open) closePlan();
  $("plan-form").reset();
  $("plan-adjust").hidden = true;
  $("adjust-time").setAttribute("aria-expanded", "false");
  $("plan-progress").textContent = "";
  $("plan-error").hidden = true;
  try {
    [
      "note",
      "plan",
      "exam-version",
      "exam-conflict:source-v1",
      "exam-conflict:source-v2",
    ].forEach((k) => localStorage.removeItem(storePrefix + k));
    $("note").value = "";
    examVersion = "v1";
    renderExam();
    if (!$("evidence").hidden && activeSource?.startsWith("exam-"))
      renderSource(activeSource);
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

// A nonmodal navigation popover must not linger over work after Tab leaves it.
menu.addEventListener("focusout", (event) => {
  if (
    event.relatedTarget &&
    !menu.contains(event.relatedTarget) &&
    event.relatedTarget !== trigger &&
    menu.matches(":popover-open")
  )
    menu.hidePopover();
});

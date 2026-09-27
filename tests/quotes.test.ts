import assert from "node:assert/strict";
import test from "node:test";
import {
  findQuote,
  PASSAGE_MAX_CHARS,
  spanMatches,
  splitPassages,
  validateQuote,
} from "@magic/retrieval";

// Synthetic text only.
const paragraph = (seed: number, sentences: number) =>
  Array.from(
    { length: sentences },
    (_, i) => `Sentence ${seed}-${i} explains membrane transport and osmotic pressure in cells.`,
  ).join(" ");

function assertCovers(text: string, passages: { start: number; end: number }[]) {
  // Ordered, disjoint, trimmed, and every non-whitespace character lies in exactly one passage.
  let cursor = 0;
  for (const p of passages) {
    assert.ok(p.start >= cursor, "passages are ordered and disjoint");
    assert.ok(p.end > p.start);
    assert.match(text.slice(cursor, p.start), /^\s*$/u, "no text is skipped between passages");
    assert.doesNotMatch(text[p.start]!, /\s/u);
    assert.doesNotMatch(text[p.end - 1]!, /\s/u);
    cursor = p.end;
  }
  assert.match(text.slice(cursor), /^\s*$/u);
}

test("split offsets slice back to the exact text, paragraphs first, within the size cap", () => {
  const text = [
    "Week 3: Membranes",
    paragraph(1, 6),
    paragraph(2, 9),
    paragraph(3, 40), // one paragraph far over the cap
    "Short tail.",
  ].join("\n\n");
  const passages = splitPassages(text);
  assert.ok(passages.length >= 4);
  assertCovers(text, passages);
  for (const p of passages) {
    assert.ok(p.end - p.start <= PASSAGE_MAX_CHARS, "no passage exceeds the cap");
    assert.equal(p.tokEst, Math.ceil((p.end - p.start) / 4));
  }
  assert.deepEqual(
    passages.map((p) => p.ord),
    passages.map((_, i) => i),
  );
  assert.equal(passages[0]!.heading, "Week 3: Membranes");
  // The long paragraph is cut at sentence ends, not mid-word.
  for (const p of passages) assert.match(text.slice(p.start, p.end), /[.:\w]$/u);
});

test("parts are followed: a passage never crosses a page or slide, and carries its number", () => {
  const pages = [paragraph(10, 3), paragraph(11, 30), paragraph(12, 2)];
  const text = pages.join("\n\n");
  const parts = pages.map((t, i) => ({ page: i + 1, text: t }));
  const passages = splitPassages(text, parts);
  assertCovers(text, passages);
  let start = 0;
  const bounds = pages.map((t) => {
    const at = text.indexOf(t, start);
    start = at + t.length;
    return [at, at + t.length] as const;
  });
  for (const p of passages) {
    const [s, e] = bounds[p.page! - 1]!;
    assert.ok(p.start >= s && p.end <= e, "inside its page");
  }
  assert.deepEqual([...new Set(passages.map((p) => p.page))], [1, 2, 3]);
  // Slides and sections too; explicit part offsets are honoured when they match.
  const slides = splitPassages("Intro slide\n\nSecond slide", [
    { slide: 1, text: "Intro slide", start: 0, end: 11 },
    { slide: 2, text: "Second slide", start: 13, end: 25 },
  ]);
  assert.deepEqual(
    slides.map((p) => [p.slide, p.start, p.end]),
    [
      [1, 0, 11],
      [2, 13, 25],
    ],
  );
  // A part the text doesn't contain (a bounded extraction) ends part-following; nothing is lost.
  const bounded = splitPassages("alpha page\n\nbeta page", [
    { page: 1, text: "alpha page" },
    { page: 2, text: "not present" },
  ]);
  assertCovers("alpha page\n\nbeta page", bounded);
  assert.equal(bounded[0]!.page, 1);
  assert.equal(bounded.at(-1)!.page, undefined);
});

test("empty or whitespace-only text yields no passages; a word longer than the cap is hard-cut", () => {
  assert.deepEqual(splitPassages(""), []);
  assert.deepEqual(splitPassages(" \n\n\t "), []);
  const long = "x".repeat(PASSAGE_MAX_CHARS * 2 + 5);
  const passages = splitPassages(long);
  assertCovers(long, passages);
  assert.equal(passages.map((p) => p.end - p.start).reduce((a, b) => a + b), long.length);
});

test("the quote validator matches verbatim under whitespace normalization and returns offsets", () => {
  const text = "The midterm covers\n  chapters 1–4. Late work loses 10% per day.";
  const found = findQuote(text, "covers chapters 1–4.");
  assert.equal(found.status, "unique");
  if (found.status !== "unique") return;
  assert.equal(text.slice(found.start, found.end), "covers\n  chapters 1–4.");
  assert.ok(spanMatches(text, found, " covers chapters   1–4. "));
  const check = validateQuote({ version: 2, text }, { version: 2, quote: "Late work loses 10% per day." });
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(text.slice(check.start, check.end), "Late work loses 10% per day.");
});

test("a paraphrase, a changed digit, a case change or a missing quote is rejected", () => {
  const text = "Late work loses 10% per day. The final exam is cumulative.";
  for (const quote of [
    "Late work loses ten percent per day.", // paraphrase
    "Late work loses 15% per day.", // changed number
    "late work loses 10% per day.", // case
    "The final exam is comprehensive.", // synonym
    "Late work loses 10% per day - the final exam", // punctuation differs
  ]) {
    const check = validateQuote({ version: 1, text }, { version: 1, quote });
    assert.deepEqual(check, { ok: false, reason: "missing", occurrences: 0 }, quote);
  }
  assert.equal(validateQuote({ version: 1, text }, { version: 1, quote: "  \n" }).ok, false);
});

test("a repeated quote is ambiguous unless the proposed offsets select one occurrence exactly", () => {
  const text = "Quiz on Friday. Lab on Monday. Quiz on Friday.";
  assert.equal(findQuote(text, "Quiz on Friday.").status, "ambiguous");
  assert.deepEqual(validateQuote({ version: 1, text }, { version: 1, quote: "Quiz on Friday." }), {
    ok: false,
    reason: "ambiguous",
    occurrences: 2,
  });
  const second = text.lastIndexOf("Quiz on Friday.");
  const exact = validateQuote(
    { version: 1, text },
    { version: 1, quote: "Quiz on Friday.", start: second, end: second + 15 },
  );
  assert.deepEqual(exact, { ok: true, start: second, end: second + 15, repaired: false, occurrences: 2 });
  // Wrong offsets on a repeated quote are not repaired to the first occurrence.
  const wrong = validateQuote(
    { version: 1, text },
    { version: 1, quote: "Quiz on Friday.", start: 3, end: 18 },
  );
  assert.equal(wrong.ok, false);
  // Wrong offsets on a unique quote are repaired, and say so.
  const repaired = validateQuote(
    { version: 1, text },
    { version: 1, quote: "Lab on Monday.", start: 0, end: 5 },
  );
  assert.deepEqual(repaired, { ok: true, start: 16, end: 30, repaired: true, occurrences: 1 });
});

test("a verbatim quote validates only against the version it names; a quote from another version fails", () => {
  const v1 = { version: 1, text: "Exam 1 covers chapters 1-3." };
  const v2 = { version: 2, text: "Exam 1 covers chapters 1-4." };
  assert.equal(validateQuote(v1, { version: 1, quote: "covers chapters 1-3." }).ok, true);
  // Named v1, checked against v2: refused by version.
  assert.deepEqual(validateQuote(v2, { version: 1, quote: "covers chapters 1-3." }), {
    ok: false,
    reason: "version_mismatch",
    occurrences: 0,
  });
  // v1's text claimed as v2: not in v2's text.
  assert.deepEqual(validateQuote(v2, { version: 2, quote: "covers chapters 1-3." }), {
    ok: false,
    reason: "missing",
    occurrences: 0,
  });
});

test("offsets are UTF-16 indexes into the original text, astral characters included", () => {
  const text = "Emoji 🧪 lab:\tbring   goggles 🥽 and a notebook.";
  const found = findQuote(text, "bring goggles 🥽 and");
  assert.equal(found.status, "unique");
  if (found.status === "unique") assert.equal(text.slice(found.start, found.end), "bring   goggles 🥽 and");
});

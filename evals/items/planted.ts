/**
 * Planted defects (cases/planted.json): each is a clean item the offline model wrote, mutated
 * into one known defect and appended to the same model response, so it travels the real pack
 * path. Every catalogue entry has a builder here; the harness refuses to run otherwise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuizOutput } from "../../packages/packs/items/src/index";
import type { CardsOutput } from "../../packages/packs/cards/src/index";
import { hash, type PromptPassage } from "./offline-model";

export interface Defect {
  id: string;
  pack: "quiz" | "cards";
  expectedStage: string | null;
  caughtWhen: "dropped" | "not_revealed";
  requiresJudge: boolean;
  description: string;
}
type QuizItem = QuizOutput["items"][number];
type Card = CardsOutput["cards"][number];

/**
 * Defects checked after the near-duplicate stage (executed, support) keep their base item's
 * stem, and the harness takes the base item out of the response, so the defect reaches the
 * stage it tests instead of being dropped as a copy.
 */
export const REPLACES_BASE = new Set(["q-bad-formula", "q-wrong-key", "c-term-altered-definition"]);

export function loadDefects(casesDir: string): Defect[] {
  return (JSON.parse(readFileSync(join(casesDir, "planted.json"), "utf8")) as { defects: Defect[] }).defects;
}

/** One word of the quote changed (the longest word, so the change is never a no-op). */
function alterQuote(quote: string): string {
  const words = [...quote.matchAll(/\p{L}{4,}/gu)];
  if (!words.length) return `${quote} (altered)`;
  const w = words.sort((a, b) => b[0].length - a[0].length)[0]!;
  return `${quote.slice(0, w.index)}${w[0].split("").reverse().join("")}${quote.slice(w.index! + w[0].length)}`;
}

const pick = <T>(xs: T[], seed: string): T | undefined => (xs.length ? xs[hash(seed) % xs.length] : undefined);

export function plantQuiz(id: string, clean: QuizItem[], passages: PromptPassage[], seed: string): QuizItem | null {
  const mcs = clean.filter((i) => i.kind === "mc");
  const base = pick(mcs, seed) ?? pick(clean, seed);
  if (!base) return null;
  const mcBase = pick(mcs, seed);
  switch (id) {
    case "q-fabricated-quote":
      return { ...base, stem: `${base.stem} (variant)`, quote: alterQuote(base.quote) };
    case "q-foreign-source": {
      const sent = new Set(passages.map((p) => p.sourceId));
      let n = 1;
      while (sent.has(`p${n}`)) n++;
      return { ...base, stem: `${base.stem} (another source)`, sourceId: `p${n + 100000}` };
    }
    case "q-two-keys":
      return mcBase ? { ...mcBase, stem: `${mcBase.stem} (two keys)`, options: mcBase.options.map((o, i) => ({ ...o, correct: o.correct || i === (mcBase.options.findIndex((x) => x.correct) + 1) % 4 })) } : null;
    case "q-three-options": {
      if (!mcBase) return null;
      const keep = mcBase.options.filter((o, i) => o.correct || i !== mcBase.options.findIndex((x) => !x.correct));
      return { ...mcBase, stem: `${mcBase.stem} (three options)`, options: keep };
    }
    case "q-all-of-the-above": {
      if (!mcBase) return null;
      const at = mcBase.options.findIndex((o) => !o.correct);
      return { ...mcBase, stem: `${mcBase.stem} (all of the above)`, options: mcBase.options.map((o, i) => (i === at ? { text: "All of the above", correct: false } : o)) };
    }
    case "q-longest-key":
      return mcBase
        ? {
            ...mcBase,
            stem: `${mcBase.stem} (longest key)`,
            options: mcBase.options.map((o) => (o.correct ? { ...o, text: `${o.text}, which is the answer the course material gives in full detail here` } : o)),
          }
        : null;
    case "q-negation-unemphasised":
      return mcBase ? { ...mcBase, stem: `Which of these is not the right answer to this: ${mcBase.stem}` } : null;
    case "q-near-duplicate":
      return { ...base, stem: `${base.stem} `.replace(/\?\s*$/, "?!") };
    case "q-bad-formula": {
      const num = clean.find((i) => i.kind === "numeric" && i.numeric?.formula);
      return num ? { ...num, numeric: { ...num.numeric!, value: num.numeric!.value + 1 } } : null;
    }
    case "q-tf-no-truth": {
      const t = clean.find((i) => i.kind === "tf");
      return t ? { ...t, stem: `${t.stem} (unset)`, statementIsTrue: null } : null;
    }
    case "q-wrong-key":
      return mcBase ? { ...mcBase, options: mcBase.options.map((o, i) => ({ ...o, correct: i === (mcBase.options.findIndex((x) => x.correct) + 1) % 4 })) } : null;
    default:
      throw new Error(`no builder for planted defect ${id}`);
  }
}

export function plantCard(id: string, clean: Card[], passages: PromptPassage[], seed: string): Card | null {
  const clozes = clean.filter((c) => c.kind === "cloze");
  const terms = clean.filter((c) => c.kind === "term");
  const base = pick(clean, seed);
  const cz = pick(clozes, seed);
  if (!base) return null;
  switch (id) {
    case "c-fabricated-quote":
      return { ...base, front: `${base.front} (variant)`, quote: alterQuote(base.quote) };
    case "c-cloze-answer-absent":
      return cz ? { ...cz, front: cz.front.split(cz.back).join("it"), back: cz.back } : null;
    case "c-cloze-answer-leak": {
      // Prefer a verbatim sentence that already holds a word twice ("the number of stored keys
      // divided by the number of buckets"), blanking that word; otherwise repeat the answer.
      for (const c of clozes) {
        const counts = new Map<string, number>();
        for (const m of c.front.matchAll(/\p{L}{4,}/gu)) counts.set(m[0].toLowerCase(), (counts.get(m[0].toLowerCase()) ?? 0) + 1);
        const twice = [...counts].find(([, n]) => n >= 2)?.[0];
        if (twice) return { ...c, back: twice };
      }
      return cz ? { ...cz, front: `${cz.front} Remember: ${cz.back}.` } : null;
    }
    case "c-cloze-whole-sentence": {
      if (!cz) return null;
      const words = cz.front.replace(/[.!?]$/, "").split(/\s+/);
      return { ...cz, back: words.slice(1).join(" ") };
    }
    case "c-cloze-function-word":
      return cz && /\bthe\b/.test(cz.front) ? { ...cz, back: "the" } : cz && /\bis\b/.test(cz.front) ? { ...cz, back: "is" } : null;
    case "c-cloze-altered-sentence": {
      if (!cz) return null;
      const words = [...cz.front.matchAll(/\p{L}{4,}/gu)].filter((m) => m[0].toLowerCase() !== cz.back.toLowerCase());
      const w = pick(words, seed);
      if (!w) return null;
      const replacement = w[0] === "first" ? "last" : w[0] === "last" ? "first" : `un${w[0]}`;
      return { ...cz, front: `${cz.front.slice(0, w.index)}${replacement}${cz.front.slice(w.index! + w[0].length)}` };
    }
    case "c-term-same-front-back": {
      const t = pick(terms, seed);
      return t ? { ...t, front: `${t.front} (again)`, back: `${t.front} (again)` } : null;
    }
    case "c-near-duplicate":
      return { ...base, front: `${base.front}`.replace(/\.?$/, "!") };
    case "c-term-altered-definition": {
      const t = pick(terms, seed);
      const other = terms.find((x) => x !== t);
      return t && other ? { ...t, back: other.back } : null;
    }
    default:
      throw new Error(`no builder for planted defect ${id}`);
  }
}

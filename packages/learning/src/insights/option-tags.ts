// P12: tag multiple-choice distractors to concepts in code (addendum §6), by
// matching the option text against concept labels and glossary terms of the
// item's course. An option matching none, or more than one concept, stays
// untagged and never forms a confusable pair.
import { normaliseTokens } from "../grade";
import type { Concept, LearningItem } from "../store";
import type { OptionTag } from "../practice/store";

function contains(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, k) => hay[i + k] === w)) return true;
  return false;
}

export function tagOptions(
  item: Pick<LearningItem, "id" | "version" | "courseRef" | "options" | "key">,
  map: Concept[],
  glossary: { term: string; conceptId: string }[] = [],
): OptionTag[] {
  if (!item.options) return [];
  const course = map.filter((c) => c.courseRef === item.courseRef && c.status === "active");
  const ids = new Set(course.map((c) => c.id));
  const vocab: { tokens: string[]; conceptId: string }[] = [
    ...course.flatMap((c) => [c.label, c.studentLabel].filter((x): x is string => !!x).map((l) => ({ tokens: normaliseTokens(l), conceptId: c.id }))),
    ...glossary.filter((g) => ids.has(g.conceptId)).map((g) => ({ tokens: normaliseTokens(g.term), conceptId: g.conceptId })),
  ].filter((v) => v.tokens.length);
  const out: OptionTag[] = [];
  for (const o of item.options) {
    if (o.id === String(item.key)) continue;
    const text = normaliseTokens(o.text);
    const hits = new Set(vocab.filter((v) => contains(text, v.tokens)).map((v) => v.conceptId));
    if (hits.size === 1) out.push({ itemId: item.id, itemVersion: item.version, optionId: o.id, conceptId: [...hits][0]! });
  }
  return out;
}

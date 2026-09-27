// N06: labels that name the check that ran (spec §6.4). No label says
// "verified", "correct" or "accurate": §6.4's "One correct option" rows are
// worded "One keyed answer" here, because the rule under that table wins.
import type { Tier } from "./store";

export const LABEL = {
  quoteFound: "Quote found in source",
  executed: "Answer checked by running it",
  oneKeyStructure: "One keyed answer: structure checked",
  oneKeyJev: "One keyed answer: judged by Jev",
  supportJev: "Support judged by Jev",
  supportJevShadow: "Support: Jev (shadow)",
  supportNotChecked: "Support not checked",
  editedByYou: "Edited by you",
} as const;

export function supportByModel(model: string, sameModel: boolean): string {
  return `Support judged by ${model} in a separate check${sameModel ? " (same model that wrote it)" : ""}`;
}

export function tierLabel(tier: Tier, term?: string | null): string {
  switch (tier) {
    case "T1":
      return "From your instructor's practice exam";
    case "T2":
      return "From this term's exam info";
    case "T3":
      return `Partly from ${term ?? "past-term"} exams`;
    case "T4":
      return "From course materials";
  }
}

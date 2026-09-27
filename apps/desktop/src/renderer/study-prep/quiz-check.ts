// owner: study-prep. Grading a practice question is code: the key the pack gave was already checked
// by the item pipeline (one key among the options; a numeric value recomputed from its formula).

export interface CheckableItem {
  kind: "mc" | "tf" | "numeric";
  options: { id: string; text: string }[] | null;
  key: string | number;
  unit: string | null;
}
export type QuizResponse = { kind: "choice"; optionId: string } | { kind: "number"; text: string };
export type QuizCheck = { status: "right" | "wrong"; expected: string } | { status: "invalid"; reason: string };

/** Relative tolerance for a numeric answer (rounding in a worked value), with an absolute floor. */
export const REL_TOL = 0.01;
const ABS_TOL = 1e-9;

/** "8", "8.0", "-2.5e3", "1/8000", "8 kHz" (the unit must match when the question has one). */
export function parseNumber(text: string, unit: string | null): { value: number } | { reason: string } {
  const t = text.trim().replace(/,(?=\d{3}\b)/g, "");
  const m = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(?:\s*\/\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?))?\s*(.*)$/i.exec(t);
  if (!m) return { reason: "Enter a number." };
  const value = m[2] !== undefined ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  if (!Number.isFinite(value)) return { reason: "Enter a finite number." };
  const written = m[3]!.trim();
  if (written && unit && written.toLowerCase() !== unit.toLowerCase()) return { reason: `Answer in ${unit}.` };
  if (written && !unit) return { reason: "This answer takes no unit." };
  return { value };
}

export function checkAnswer(item: CheckableItem, response: QuizResponse): QuizCheck {
  if (item.kind === "numeric") {
    if (response.kind !== "number") return { status: "invalid", reason: "Enter a number." };
    const parsed = parseNumber(response.text, item.unit);
    if ("reason" in parsed) return { status: "invalid", reason: parsed.reason };
    const key = Number(item.key);
    const right = Math.abs(parsed.value - key) <= Math.max(ABS_TOL, REL_TOL * Math.abs(key));
    return { status: right ? "right" : "wrong", expected: `${key}${item.unit ? ` ${item.unit}` : ""}` };
  }
  if (response.kind !== "choice") return { status: "invalid", reason: "Choose an answer." };
  const options = item.options ?? [];
  if (!options.some((o) => o.id === response.optionId)) return { status: "invalid", reason: "Choose one of the options." };
  const key = options.find((o) => o.id === String(item.key));
  return { status: response.optionId === String(item.key) ? "right" : "wrong", expected: key?.text ?? String(item.key) };
}

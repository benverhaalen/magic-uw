// owner: study-prep. Splits generated text into plain text and TeX. Pure code, no DOM.
//
// Delimiters: $$…$$ and \[…\] display; $…$ and \(…\) inline. A dollar sign is maths only when it
// reads as maths (the Pandoc rule): the opening $ has a non-space right after it, the closing $
// has a non-space right before it and no digit right after it, and nothing between them is
// another unescaped $. So "$5", "costs $5 and $10" and "\$" stay text, and "$x$" is maths.

export type MathSegment = { kind: "text"; value: string } | { kind: "math"; tex: string; display: boolean };

/** TeX longer than this is shown as text: a model can't make the renderer do unbounded work. */
export const MAX_TEX = 2000;

export function splitMath(input: string): MathSegment[] {
  const out: MathSegment[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", value: text });
    text = "";
  };
  const math = (tex: string, display: boolean) => {
    const t = tex.trim();
    if (!t || t.length > MAX_TEX) return false;
    flush();
    out.push({ kind: "math", tex: t, display });
    return true;
  };
  /** The next unescaped `token` at or after `from`, or -1. */
  const find = (token: string, from: number) => {
    for (let j = input.indexOf(token, from); j >= 0; j = input.indexOf(token, j + 1)) if (input[j - 1] !== "\\") return j;
    return -1;
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    const next = input[i + 1];
    if (c === "\\" && next === "$") {
      text += "$";
      i += 2;
      continue;
    }
    if (c === "\\" && (next === "(" || next === "[")) {
      const close = find(next === "(" ? "\\)" : "\\]", i + 2);
      if (close >= 0 && math(input.slice(i + 2, close), next === "[")) {
        i = close + 2;
        continue;
      }
    }
    if (c === "$" && next === "$") {
      const close = find("$$", i + 2);
      if (close >= 0 && math(input.slice(i + 2, close), true)) {
        i = close + 2;
        continue;
      }
      text += "$$";
      i += 2;
      continue;
    }
    if (c === "$" && next !== undefined && !/\s/.test(next)) {
      const close = find("$", i + 1);
      const ok = close > i + 1 && !/\s/.test(input[close - 1]!) && !/\d/.test(input[close + 1] ?? "") && input[close + 1] !== "$";
      if (ok && !input.slice(i + 1, close).includes("\n\n") && math(input.slice(i + 1, close), false)) {
        i = close + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** Whether text holds any maths (so a caller can skip loading the renderer for plain text). */
export const hasMath = (text: string) => splitMath(text).some((s) => s.kind === "math");

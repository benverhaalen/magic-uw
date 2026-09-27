// N06 stage 6: a safe arithmetic evaluator. It parses numbers, + − × ÷ (and
// * /), parentheses and simple units by recursive descent. It never calls eval
// or Function.

export interface Quantity {
  value: number;
  unit: string | null;
}

type Tok = { t: "num"; v: number } | { t: "unit"; v: string } | { t: "op"; v: "+" | "-" | "*" | "/" } | { t: "(" } | { t: ")" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if (ch === "+") out.push({ t: "op", v: "+" });
    else if (ch === "-" || ch === "−" || ch === "–") out.push({ t: "op", v: "-" });
    else if (ch === "*" || ch === "×" || ch === "·") out.push({ t: "op", v: "*" });
    else if (ch === "/" || ch === "÷") out.push({ t: "op", v: "/" });
    else if (ch === "(") out.push({ t: "(" });
    else if (ch === ")") out.push({ t: ")" });
    else {
      const unit = /^[A-Za-zµΩ°%][A-Za-zµΩ°%0-9^]*/.exec(src.slice(i));
      if (!unit) throw new Error(`unexpected character ${JSON.stringify(ch)}`);
      out.push({ t: "unit", v: unit[0] });
      i += unit[0].length;
      continue;
    }
    i++;
  }
  return out;
}

const combine = (a: string | null, op: "*" | "/", b: string | null): string | null => {
  if (!a && !b) return null;
  if (op === "/" && a === b) return null;
  return `${a ?? "1"}${op}${b ?? "1"}`.replace(/^1\*/, "").replace(/\*1$/, "");
};

/** Evaluate an arithmetic expression with optional units. Throws on anything else. */
export function evaluate(src: string): Quantity {
  if (src.length > 500) throw new Error("expression too long");
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];

  const primary = (): Quantity => {
    const tok = toks[p++];
    if (!tok) throw new Error("unexpected end of expression");
    if (tok.t === "op" && tok.v === "-") {
      const q = primary();
      return { value: -q.value, unit: q.unit };
    }
    if (tok.t === "op" && tok.v === "+") return primary();
    let q: Quantity;
    if (tok.t === "num") q = { value: tok.v, unit: null };
    else if (tok.t === "(") {
      q = expr();
      if (toks[p++]?.t !== ")") throw new Error("missing )");
    } else throw new Error("expected a number");
    const u = peek();
    if (u?.t === "unit") {
      p++;
      if (q.unit) throw new Error("two units on one quantity");
      q = { value: q.value, unit: u.v };
    }
    return q;
  };

  const term = (): Quantity => {
    let left = primary();
    for (let tok = peek(); tok?.t === "op" && (tok.v === "*" || tok.v === "/"); tok = peek()) {
      p++;
      const right = primary();
      if (tok.v === "/" && right.value === 0) throw new Error("division by zero");
      left = { value: tok.v === "*" ? left.value * right.value : left.value / right.value, unit: combine(left.unit, tok.v, right.unit) };
    }
    return left;
  };

  const expr = (): Quantity => {
    let left = term();
    for (let tok = peek(); tok?.t === "op" && (tok.v === "+" || tok.v === "-"); tok = peek()) {
      p++;
      const right = term();
      if (left.unit !== right.unit) throw new Error(`can't add ${left.unit ?? "a plain number"} and ${right.unit ?? "a plain number"}`);
      left = { value: tok.v === "+" ? left.value + right.value : left.value - right.value, unit: left.unit };
    }
    return left;
  };

  const result = expr();
  if (p !== toks.length) throw new Error("unexpected trailing input");
  if (!Number.isFinite(result.value)) throw new Error("not a finite number");
  return result;
}

/** Relative-tolerance equality for recomputed keys. */
export function sameQuantity(a: Quantity, b: Quantity, relTol = 1e-6): boolean {
  if ((a.unit ?? null) !== (b.unit ?? null)) return false;
  const scale = Math.max(1, Math.abs(a.value), Math.abs(b.value));
  return Math.abs(a.value - b.value) <= relTol * scale;
}

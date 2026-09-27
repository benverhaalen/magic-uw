/**
 * Symbolic and unit checks by code (owner: exam-prep), on mathjs 15.2.0 (Apache-2.0; checked in
 * node_modules/mathjs/package.json). Expressions are parsed into a syntax tree and only a small
 * allow-list of node types, operators, functions and the problem's own variables is accepted;
 * nothing is ever passed to `eval`. Equivalence is decided the way WeBWorK-style checkers do it:
 * a symbolic simplification of the difference first, then agreement at many seeded sample points
 * (a mismatch at any point rejects). A required form (expanded or factored) is checked on the
 * tree. Units convert through mathjs's unit system; an unknown unit is reported, never guessed.
 */
import { create, all, type MathNode } from "mathjs";

const math = create(all, {});

const FUNCTIONS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "exp", "log", "log10", "log2", "sqrt", "abs", "cbrt"]);
const CONSTANTS = new Set(["pi", "e"]);
const OPERATORS = new Set(["+", "-", "*", "/", "^"]);

export type ParsedExpression = { ok: true; node: MathNode; symbols: string[] } | { ok: false; reason: string };

/** Student-typed notation into mathjs notation: `**`, `ln`, `·`, `×`, `−`, superscripts. */
export function normaliseExpression(text: string): string {
  return text
    .replace(/\*\*/g, "^")
    .replace(/\bln\s*\(/g, "log(")
    .replace(/[·×]/g, "*")
    .replace(/[−–]/g, "-")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/π/g, "pi")
    .trim();
}

/** Parse under the allow-list; `variables` are the only free symbols permitted. */
export function parseExpression(text: string, variables: string[]): ParsedExpression {
  const src = normaliseExpression(text);
  if (!src) return { ok: false, reason: "Type an expression." };
  if (src.length > 300) return { ok: false, reason: "That expression is too long." };
  let node: MathNode;
  try {
    node = math.parse(src);
  } catch {
    return { ok: false, reason: "That expression can't be read. Check the brackets and operators." };
  }
  const allowed = new Set(variables);
  const symbols = new Set<string>();
  let problem: string | null = null;
  node.traverse((n, path) => {
    if (problem) return;
    switch (n.type) {
      case "ConstantNode": {
        const v = (n as unknown as { value: unknown }).value;
        if (typeof v !== "number") problem = "Only numbers and the problem's variables are allowed.";
        return;
      }
      case "ParenthesisNode":
        return;
      case "OperatorNode": {
        const op = (n as unknown as { op: string }).op;
        if (!OPERATORS.has(op)) problem = `The operator ${op} isn't used here.`;
        return;
      }
      case "FunctionNode": {
        const name = (n as unknown as { fn: { name?: string } }).fn?.name ?? "";
        if (!FUNCTIONS.has(name)) problem = `${name || "That function"} isn't allowed here.`;
        return;
      }
      case "SymbolNode": {
        if (path === "fn") return; // a function's name, checked on its FunctionNode
        const name = (n as unknown as { name: string }).name;
        if (CONSTANTS.has(name)) return;
        if (!allowed.has(name)) problem = `Unknown symbol "${name}". Use ${variables.length ? variables.join(", ") : "numbers only"}.`;
        else symbols.add(name);
        return;
      }
      default:
        problem = "Only arithmetic, powers and standard functions are allowed.";
    }
  });
  return problem ? { ok: false, reason: problem } : { ok: true, node, symbols: [...symbols] };
}

/** A small deterministic PRNG (mulberry32), seeded per check so results are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function real(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type Equivalence = { equivalent: true; method: "simplify" | "sampling" } | { equivalent: false; reason: string; at?: Record<string, number> };

/**
 * Are two expressions equal for every value of the variables? Symbolic simplification of the
 * difference first; otherwise 24 seeded sample points in [-3, 3] (points where either side is
 * undefined are skipped; at least 8 must be usable). Any disagreement beyond 1e-7 relative rejects.
 */
export function equivalent(expected: MathNode, given: MathNode, variables: string[], seed = "check"): Equivalence {
  try {
    const diff = math.simplify(new math.OperatorNode("-", "subtract", [expected, given]));
    if (diff.type === "ConstantNode" && (diff as unknown as { value: unknown }).value === 0) return { equivalent: true, method: "simplify" };
  } catch {
    // Fall through to sampling.
  }
  const a = expected.compile();
  const b = given.compile();
  const next = rng(seedOf(`${seed}:${expected.toString()}`));
  let usable = 0;
  for (let i = 0; i < 24; i++) {
    const scope: Record<string, number> = {};
    for (const v of variables) scope[v] = Math.round((next() * 6 - 3) * 1000) / 1000 || 0.5;
    let x: number | null, y: number | null;
    try {
      x = real(a.evaluate({ ...scope }));
      y = real(b.evaluate({ ...scope }));
    } catch {
      continue;
    }
    if (x === null && y === null) continue;
    if (x === null || y === null) return { equivalent: false, reason: "The expressions differ where one of them is undefined.", at: scope };
    usable++;
    if (Math.abs(x - y) > 1e-7 * Math.max(1, Math.abs(x), Math.abs(y))) return { equivalent: false, reason: "The expressions give different values.", at: scope };
  }
  return usable >= 8 ? { equivalent: true, method: "sampling" } : { equivalent: false, reason: "Code couldn't evaluate these expressions at enough points to compare them." };
}

const isSum = (n: MathNode): boolean => {
  const inner = n.type === "ParenthesisNode" ? (n as unknown as { content: MathNode }).content : n;
  return inner.type === "OperatorNode" && ["+", "-"].includes((inner as unknown as { op: string }).op) && (inner as unknown as { args: MathNode[] }).args.length === 2;
};

/** Expanded: no product or power has a sum as a factor. */
export function isExpanded(node: MathNode): boolean {
  let ok = true;
  node.traverse((n) => {
    if (!ok || n.type !== "OperatorNode") return;
    const { op, args } = n as unknown as { op: string; args: MathNode[] };
    if (op === "*" && args.some(isSum)) ok = false;
    if (op === "^" && args[0] && isSum(args[0])) ok = false;
  });
  return ok;
}

/** Factored: the top level is a product, quotient or power (not a sum). */
export function isFactored(node: MathNode): boolean {
  let top = node;
  while (top.type === "ParenthesisNode") top = (top as unknown as { content: MathNode }).content;
  if (top.type === "OperatorNode" && (top as unknown as { fn: string }).fn === "unaryMinus") top = (top as unknown as { args: MathNode[] }).args[0]!;
  return !isSum(top);
}

// ---------- Units ----------

/** Unit notation into mathjs notation; `null` for a blank unit. */
export function normaliseUnit(unit: string | null | undefined): string | null {
  const u = (unit ?? "").trim();
  if (!u) return null;
  return u
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/[·×]/g, " ")
    .replace(/Ω/g, "ohm")
    .replace(/µ/g, "u")
    .replace(/°C\b/g, "degC")
    .replace(/°F\b/g, "degF")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

export type UnitCheck = { ok: true; value: number } | { ok: false; reason: string; code: "unknown_unit" | "wrong_dimension" | "missing_unit" | "unexpected_unit" };

/** The given value converted into the expected unit; the reason when it can't be. */
export function convertTo(value: number, given: string | null | undefined, expected: string | null | undefined): UnitCheck {
  const want = normaliseUnit(expected);
  const got = normaliseUnit(given);
  if (!want && !got) return { ok: true, value };
  if (want && !got) return { ok: false, code: "missing_unit", reason: `Add the unit (the answer is in ${expected}, or an equivalent unit).` };
  if (!want && got) return { ok: false, code: "unexpected_unit", reason: "This answer is a plain number; it takes no unit." };
  if (want === got) return { ok: true, value };
  let target, source;
  try {
    target = math.unit(want!);
  } catch {
    return { ok: false, code: "unknown_unit", reason: `Only ${expected} is accepted here.` };
  }
  try {
    source = math.unit(value, got!);
  } catch {
    return { ok: false, code: "unknown_unit", reason: `"${given}" isn't a unit code recognises.` };
  }
  if (!source.equalBase(target)) return { ok: false, code: "wrong_dimension", reason: `${given} measures a different quantity than ${expected}.` };
  return { ok: true, value: source.toNumber(want!) };
}

/** True when the unit string parses (or is blank). */
export function knownUnit(unit: string | null | undefined): boolean {
  const u = normaliseUnit(unit);
  if (!u) return true;
  try {
    math.unit(u);
    return true;
  } catch {
    return false;
  }
}

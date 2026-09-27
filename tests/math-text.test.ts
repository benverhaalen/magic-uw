// owner: study-prep. MathText: TeX in generated text renders with KaTeX; plain text (including
// currency and escaped dollars) stays text; malformed TeX never throws; nothing in the text can
// inject markup, links or scripts.
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { splitMath, MAX_TEX } from "../apps/desktop/src/renderer/study-prep/math";
import { MathText } from "../apps/desktop/src/renderer/study-prep/MathText";

const html = (text: string) => renderToStaticMarkup(React.createElement(MathText, { text }));
const kinds = (text: string) => splitMath(text).map((s) => (s.kind === "text" ? `T:${s.value}` : `${s.display ? "D" : "I"}:${s.tex}`));

test("inline and display maths", () => {
  assert.deepEqual(kinds("The DTFT is $X(e^{j\\omega})$ here."), ["T:The DTFT is ", "I:X(e^{j\\omega})", "T: here."]);
  assert.deepEqual(kinds("Energy: $$\\int_{-\\infty}^{\\infty} |x(t)|^2\\,dt$$ done"), ["T:Energy: ", "D:\\int_{-\\infty}^{\\infty} |x(t)|^2\\,dt", "T: done"]);
  assert.deepEqual(kinds("\\(a+b\\) and \\[c\\]"), ["I:a+b", "T: and ", "D:c"]);
  const out = html("Sum: $\\sum_{n=0}^{N-1} x[n] e^{-j2\\pi kn/N}$");
  assert.match(out, /class="katex"/);
  assert.match(out, /<math/, "MathML is emitted for screen readers");
  assert.match(html("$$e^{j\\theta} = \\cos\\theta + j\\sin\\theta$$"), /katex-display/);
});

test("dollar signs that aren't maths stay text: currency, escapes, lone and unbalanced", () => {
  assert.deepEqual(kinds("The kit costs $5."), ["T:The kit costs $5."]);
  assert.deepEqual(kinds("Between $5 and $10 per lab."), ["T:Between $5 and $10 per lab."]);
  assert.deepEqual(kinds("Pay \\$5 or \\$10, not $x$."), ["T:Pay $5 or $10, not ", "I:x", "T:."]);
  assert.deepEqual(kinds("$ 5 $"), ["T:$ 5 $"], "a space after the opening $ is not maths");
  assert.deepEqual(kinds("$$ unclosed"), ["T:$$ unclosed"]);
  assert.deepEqual(kinds("$5, $x$"), ["T:$5, ", "I:x"]);
  assert.equal(html("The kit costs $5."), '<span class="sp-math">The kit costs $5.</span>');
});

test("malformed TeX renders as its source in the error style and never throws", () => {
  const out = html("Broken: $\\frac{1}{$ and $\\notacommand{x}$");
  assert.match(out, /katex-error/);
  assert.doesNotThrow(() => html("$\\left( x$"));
  assert.doesNotThrow(() => html("$$\\begin{matrix} a & b \\end{pmatrix}$$"));
  const long = `$${"x+".repeat(MAX_TEX)}x$`;
  assert.doesNotMatch(html(long), /katex/, "oversized TeX is shown as text");
});

test("XSS attempts in text or TeX produce no markup, links or script", () => {
  const attacks = [
    '<img src=x onerror="alert(1)"> and <script>alert(1)</script>',
    "$\\href{javascript:alert(1)}{click}$",
    "$\\url{javascript:alert(1)}$",
    "$\\htmlClass{x}{y}$ $\\htmlStyle{color:red}{y}$ $\\htmlId{a}{b}$ $\\htmlData{a=b}{c}$",
    "$\\includegraphics{https://evil.example/x.png}$",
    '$x" onmouseover="alert(1)$',
    "$</span><script>alert(1)</script>$",
  ];
  for (const text of attacks) {
    const out = html(text);
    // Inspect the markup itself: every tag and every attribute it carries. Escaped text may mention anything.
    const tags = out.match(/<[^>]+>/g) ?? [];
    for (const tag of tags) {
      const name = /^<\/?([a-z0-9-]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
      assert.ok(!["script", "img", "a", "iframe", "object", "embed", "link", "style"].includes(name), `${text}: <${name}>`);
      assert.doesNotMatch(tag, /\son\w+\s*=/i, `${text}: event handler in ${tag}`);
      assert.doesNotMatch(tag, /\s(?:href|src|xlink:href|action|formaction)\s*=/i, `${text}: link attribute in ${tag}`);
      assert.doesNotMatch(tag, /javascript:/i, `${text}: ${tag}`);
      assert.doesNotMatch(tag, /\sid\s*=\s*"a"|\sdata-a\s*=/i, `${text}: trusted-only attribute in ${tag}`);
    }
  }
  assert.match(html('<img src=x onerror="alert(1)">'), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/, "text is escaped, not parsed");
  assert.match(html("$\\href{javascript:alert(1)}{click}$"), /katex-error|color:/, "\\href is refused without trust and shown as an error");
});

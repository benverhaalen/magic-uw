// owner: study-prep. Text with TeX maths, rendered by KaTeX (MIT, bundled locally with its CSS and
// fonts; no CDN). Plain text stays React text, so it is always escaped. The only HTML injected is
// KaTeX's own output, rendered with trust: false (no \href, \url, \htmlClass, \includegraphics …),
// throwOnError: false (malformed TeX shows as the source in the error colour) and bounded sizes.
import katex from "katex";
import { Fragment } from "react";
import { splitMath } from "./math";

const OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: "ignore" as const,
  output: "htmlAndMathml" as const,
  maxSize: 20,
  maxExpand: 200,
};

const cache = new Map<string, string>();
const MAX_CACHE = 500;
/** KaTeX's HTML for one expression; memoised, since a guide repeats the same symbols. */
export function renderTex(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = cache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { ...OPTIONS, displayMode: display });
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(key, html);
  }
  return html;
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = splitMath(text);
  return (
    <span className={className ? `sp-math ${className}` : "sp-math"}>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{p.value}</Fragment>
        ) : (
          // KaTeX output only (trust: false); never the model's text.
          <span key={i} className={p.display ? "sp-math-display" : "sp-math-inline"} dangerouslySetInnerHTML={{ __html: renderTex(p.tex, p.display) }} />
        ),
      )}
    </span>
  );
}

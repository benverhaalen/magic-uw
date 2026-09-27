import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACCENT_IDS, measureAll, readTokens, resolve, tokenScope } from "../scripts/theme-contrast";

const css = readTokens();

test("every required pair meets WCAG 2.2 AA in light and dark, for every accent", () => {
  const failures: string[] = [];
  for (const { theme, accent, results } of measureAll(css))
    for (const m of results)
      if (!m.pass && m.exception?.theme !== theme)
        failures.push(`${theme}/${accent} ${m.label}: ${m.fgHex} on ${m.bgHex} (${m.worst}) = ${m.min.toFixed(2)}`);
  assert.deepEqual(failures, []);
});

test("every colour token has a dark value; only the shell's own inks keep one value", () => {
  const scope = tokenScope(css);
  const sameInBoth = new Set(["--magic-ink-on-shell", "--magic-ink-on-shell-secondary", "--magic-focus-on-shell"]);
  for (const name of scope.keys()) {
    const light = resolve(scope, name, "light"), dark = resolve(scope, name, "dark");
    if (!/#[0-9a-f]{3,8}\b/i.test(light)) continue;
    if (sameInBoth.has(name)) assert.equal(light, dark, name);
    else assert.notEqual(light, dark, `${name} has no dark value`);
  }
});

test("an accent changes only command, focus and selection roles, never status, identity or surfaces", () => {
  const base = tokenScope(css);
  const allowed = new Set(["--magic-fill-action", "--magic-fill-action-hover", "--magic-ink-action", "--magic-line-action-candidate",
    "--magic-fill-secondary", "--magic-fill-secondary-hover", "--magic-ink-secondary", "--magic-fill-confirmation",
    "--magic-line-confirmation", "--magic-ink-confirmation", "--magic-focus", "--magic-fill-selection",
    "--magic-fill-review", "--magic-fill-review-hover", "--magic-ink-review"]);
  for (const accent of ACCENT_IDS) {
    const scope = tokenScope(css, accent);
    for (const theme of ["light", "dark"] as const)
      for (const name of base.keys())
        if (resolve(scope, name, theme) !== resolve(base, name, theme))
          assert.ok(allowed.has(name), `${accent} changes ${name} in ${theme}`);
  }
});

test("the theme switch follows data-theme, and the OS only when no explicit light choice is set", () => {
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{\s*color-scheme:\s*dark;/);
});

test("renderer styles hold no raw colour literals; values come from tokens", () => {
  const files = ["apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/desktop.css", "apps/desktop/src/renderer/notifications.css",
    "apps/desktop/src/renderer/calendar/calendar.css", "apps/desktop/src/renderer/sources/sources.css", "apps/desktop/src/renderer/courses/courses.css",
    "apps/desktop/src/renderer/myuw/myuw.css", "apps/desktop/src/renderer/onboarding/onboarding.css", "apps/desktop/src/renderer/StartWork.css",
    "packages/ui/src/styles.css", "packages/ui/src/deadline-emphasis.css", "packages/ui/src/inline-context/inline-context.css"];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black)\s*[;}!]/, file);
  }
});

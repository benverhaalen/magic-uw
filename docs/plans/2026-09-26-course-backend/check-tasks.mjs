// Run: node docs/plans/2026-09-26-course-backend/check-tasks.mjs  (from the repo root)
// Mechanical check of tasks.md: every dependency is defined, none is superseded or dropped, no phase inversions, no cycles.
import { readFileSync } from 'node:fs';
const cb = readFileSync(new URL('./tasks.md', import.meta.url), 'utf8');
const superseded = new Set(['T37','N01','N02','N03','N13','N18','N19','N26','N20','N21','B01','B03','B04','B06','B09','B02','B12','B05','B07','B08','MT5']);
const dropped = new Set(['N16','P03','P04','P06','P10','P15','T49','T47a','T47b','P17a']);
const deps = new Map();
const idRe = new RegExp('^(T\\d{2}[a-zL]?|MT\\d[a-z]?|MB\\d|R\\d|G0|P17|N28|N29)\\b');
const lines = cb.split(/\r?\n/);
let cur = null;
for (const line of lines) {
  const m = line.match(idRe);
  if (m) { cur = m[1]; if (!deps.has(cur)) deps.set(cur, new Set()); }
  const d = line.match(/dependsOn:\s*\[([^\]]*)\]/);
  if (d && cur) for (const x of d[1].split(',').map(s => s.trim()).filter(Boolean)) deps.get(cur).add(x.replace(/\s.*$/, ''));
}
for (const line of lines) {
  const m = line.match(/^\| (N\d{2}|P\d{2}|B\d{2}) \| \[([^\]]*)\]/);
  if (m) deps.set(m[1], new Set(m[2].split(',').map(s => s.trim()).filter(Boolean)));
}
const defined = new Set(deps.keys());
let bad = 0;
for (const [id, ds] of deps) for (const x of ds) {
  const base = x.replace(/[^A-Za-z0-9].*$/, '');
  if (superseded.has(base)) { console.log(`SUPERSEDED dep: ${id} -> ${base}`); bad++; }
  else if (dropped.has(base)) { console.log(`DROPPED dep: ${id} -> ${base}`); bad++; }
  else if (!defined.has(base)) { console.log(`UNDEFINED dep: ${id} -> ${base}`); bad++; }
}
// phase-order check: a phase-1 task must not depend on a phase-2+ task, etc.
const phaseOf = new Map(); let ph = 0;
for (const line of lines) {
  const h = line.match(/^## Phase (\d)/); if (h) ph = Number(h[1]);
  if (line.startsWith('## §L')) ph = 0;
  const m = line.match(idRe); if (m && ph && !phaseOf.has(m[1])) phaseOf.set(m[1], ph);
  for (const tok of line.matchAll(/\b(N\d{2}|P\d{2}|B\d{2})\b/g)) if (ph && /^(Engines|Validation)/.test(line.trim()) && !phaseOf.has(tok[1])) phaseOf.set(tok[1], ph);
}
for (const [id, ds] of deps) for (const x of ds) {
  const a = phaseOf.get(id), b = phaseOf.get(x);
  if (a && b && b > a) { console.log(`PHASE inversion: ${id} (phase ${a}) -> ${x} (phase ${b})`); bad++; }
}
const state = new Map();
const visit = (n, stack) => {
  if (state.get(n) === 1) { console.log('CYCLE: ' + [...stack, n].join(' -> ')); bad++; return; }
  if (state.get(n) === 2) return;
  state.set(n, 1);
  for (const x of deps.get(n) || []) if (deps.has(x)) visit(x, [...stack, n]);
  state.set(n, 2);
};
for (const n of deps.keys()) visit(n, []);
console.log(`tasks parsed: ${deps.size}; phases assigned: ${phaseOf.size}; problems: ${bad}`);
process.exit(bad ? 1 : 0);

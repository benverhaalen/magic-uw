# Notification benchmark

Measures the notifications feature on a capture folder (for example a private field-test run) and on the labeled synthetic corpora in this folder. Outputs are aggregate CSV/JSON for charts and are written **outside the repository**; the runner refuses an output path inside it.

```bash
pnpm exec tsx evals/notifications/run.ts --captures <run>/captures --out <folder outside the repo>
# With Jev (bounded, identity-scrubbed and PII-redacted before every send):
node --env-file=apps/gateway/.env --import tsx evals/notifications/run.ts --captures <run>/captures --out <folder> --jev --max-calls 260
# Offline raise-policy comparison from a run's recorded answers (no calls):
pnpm exec tsx evals/notifications/policies.ts --out <folder>
```

| File | What it holds | Suggested chart |
| --- | --- | --- |
| `summary.json` | Every aggregate below in one place | — |
| `b1_baseline_items.csv` | Items a first import produced (should be source health only) | Bar by reason/level |
| `b2_announcements_real.csv` | Per real announcement: anonymous id, course alias, age, code level, keyword family, Jev kind/top/lead/action/affects, final level, payload size, latency | Level shift (code → final) sankey; probability histograms; latency distribution |
| `b3_change_simulation.csv` | Controlled changes on real assignments: detected, reason and level match | Recall by scenario |
| `b4_performance.csv` | Feed, snapshot and rules timings; rules vs change volume | Line: ms vs changes |
| `b5`/`b6_synthetic_*.csv` | Labeled synthetic announcements/email: label, code level, Jev fields, final level | — |
| `b7_confusion_matrices.csv` | Label × predicted counts, code vs code+Jev | Heatmaps |
| `b8_policy_comparison.csv` | Precision/recall/F1 and badge share per raise policy | Grouped bars |
| `PRIVATE-labeling-sheet.csv` | Real titles and excerpts with an empty `your_label` column, for a human to fill in; pass it back with `--labels` for real-data accuracy | Never commit or share |

Labels in the synthetic corpora were written independently of the rules. Treat results as evidence about these corpora, not calibrated accuracy. Keep Jev latency, cost and accuracy figures out of the repository (see `docs/notes/jev-usage.md`).

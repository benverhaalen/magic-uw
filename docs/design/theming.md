# Theming: dark mode and accents

September 27, 2026 · **Proposed** (built, tested in isolation and rendered against the synthetic sample course; not yet judged by Ben). Values live only in [tokens.css](tokens.css); this page is the contract and the measured record. The reason and scope are in the [decision record](decision-record.md#theming-dark-mode-and-accents--recorded-september-27-2026).

## How a theme is chosen

| Attribute on `<html>` | Effect |
| --- | --- |
| `data-theme="light"` | Light. Also overrides a dark OS setting. |
| `data-theme="dark"` | Dark. |
| no `data-theme` | Follows `prefers-color-scheme` (the "system" preference in CSS alone). |
| `data-accent="<id>"` | Accent for commands, focus and selection. Missing or unknown ids fall back to `blue`. |

Every colour token carries `light-dark(<light>, <dark>)`; `color-scheme` on the root picks the branch, so one declaration holds both values and nothing is forked. The client-health appearance module (`feat/client-health`, `appearance.ts`) resolves "system" to `data-theme`, and also writes `data-theme-preference`; both routes land on the same tokens. Its proposed accent ids `warm/rose/blue/coral` should become the accepted set below; until then its `warm` falls back to the default blue, which is today's look.

Any element may carry `data-accent` to preview an accent locally: an onboarding swatch is `<span data-accent="rose" style="background: var(--magic-fill-action)">`.

## Dark derivation

Dark is derived per role from the light palette's hue and role structure, not inverted. Hues stay; lightness moves to the role's position.

- **Surfaces:** warm near-black workspace (OKLCH L 0.205, hue 70), with quiet and raised steps lighter, because elevation reads as lighter in dark.
- **Inks:** warm off-white ink (L 0.935). Muted steps are chosen for 4.5:1 on the raised surface. In dark, `ink-muted-strong` is lighter than `ink-muted`, which keeps its role of having more contrast.
- **Shell:** the same ember gradient, deepened (lightness about 0.72x). Shell inks and the on-shell focus ring keep one value in both themes, because the shell stays dark ember in both.
- **Filled surfaces** (action, identity rose/blue/coral, study, schedule, status, hue palette, calendar and Sources tints): these become deep tints of the same hue with light paired inks. The Home rows keep their colour identity without glaring on a dark workspace.
- **Gold roles** (study, schedule event, calendar event, amber tint, warning): yellow hues read olive when darkened, so their dark hue moves from about 86-90 to 76-80. They read as amber, not olive. Light values are unchanged.

## Accents

An accent changes only these roles, in both themes: `fill-action`, `fill-action-hover`, `ink-action`, `line-action-candidate`, `fill-secondary`, `fill-secondary-hover`, `ink-secondary`, `fill-confirmation`, `line-confirmation`, `ink-confirmation`, `focus` and `fill-selection` (plus the `review` aliases that point at them). Surfaces, the shell, links, identity, study, schedule and status never change. `tests/theme-contrast.test.ts` fails if an accent touches anything else.

| Id | Hue | Source |
| --- | --- | --- |
| `blue` (default) | 255 | The accepted Home blue, exact v3 values. |
| `rose` | 352 | Identity rose family. |
| `coral` | 42 | Identity coral family. |
| `plum` | 318 | New hue (proposal). |

Each accent transfers the default blue's lightness and chroma per role (for example, action stops L 0.80 and 0.92, ink L 0.365, focus L 0.538), so the four read at matched weight. No gold accent: it would collide with study and warning. No green: D13, and success.

## New tokens (proposals)

- `--magic-fill-selection` aliases the accent's `fill-secondary-hover`. It is used for `::selection`, selected legacy rows and the selected mode card.
- `--magic-hue-<rose|coral|orange|yellow|lime|green|teal|blue|indigo|purple|magenta|neutral>-<strong|pale|ink>` fill the seam `deadline-emphasis.css` already reserved. Light values are its former literal fallbacks, exactly.
- `--magic-fill-calendar-event|deadline|study` hold the calendar's former local gradients (light exact).
- `--magic-fill-tint-<coral|blue|rose|amber>` and `-action` hold Sources' former flat row tints (light exact).
- `--magic-fill-today-marker` with `--magic-ink-today-marker` carry the calendar today date (see below).
- `--magic-shadow-color` is the base colour for small component shadows, mixed with transparency at the call site.

## Contrast (WCAG 2.2 AA)

Measured by `pnpm exec tsx scripts/theme-contrast.ts` from the shipped tokens, which prints these tables. Gradients are measured at every stop and between stops; translucent colours are composited over their base; each row reports the worst background. Text needs 4.5:1, non-text UI 3:1. Advisory rows are decorative separators; the exempt row is disabled text (WCAG 1.4.3 exempts inactive controls).

| Pair (foreground on backgrounds) | Requirement | Light min | Dark min | Worst background (light / dark) |
| --- | --- | --- | --- | --- |
| magic-ink | 4.5:1 text | 14.15 | 13.07 | surface-quiet / surface-raised |
| magic-ink-prose | 4.5:1 text | 11.19 | 10.84 | surface-quiet / surface-raised |
| magic-ink-muted-strong | 4.5:1 text | 5.82 | 8.15 | surface-quiet / surface-raised |
| magic-ink-muted | 4.5:1 text | 4.65 | 6.72 | surface-quiet / surface-raised |
| magic-ink-link | 4.5:1 text | 6.24 | 8.20 | surface-quiet / surface-raised |
| magic-ink-feedback | 4.5:1 text | 7.45 | 9.54 | surface-quiet / surface-raised |
| magic-ink-error | 4.5:1 text | 8.76 | 9.68 | surface-quiet / surface-raised |
| tag ink on tag fill | 4.5:1 text | 7.23 | 8.86 | fill-tag-candidate / fill-tag-candidate |
| avatar initial | 4.5:1 text | 6.07 | 5.93 | fill-avatar / fill-avatar |
| identity rose | 4.5:1 text | 6.10 | 6.29 | fill-identity-rose / fill-identity-rose |
| identity blue | 4.5:1 text | 5.15 | 6.05 | fill-identity-blue / fill-identity-blue |
| identity coral | 4.5:1 text | 5.80 | 5.73 | fill-identity-coral / fill-identity-coral |
| study | 4.5:1 text | 6.05 | 4.80 | fill-study / fill-study |
| schedule event | 4.5:1 text | 6.73 | 8.22 | fill-schedule-event / fill-schedule-event |
| warning status | 4.5:1 text | 7.44 | 9.42 | fill-status-warning-candidate / fill-status-warning-candidate |
| error status | 4.5:1 text | 8.04 | 8.53 | fill-status-error-candidate / fill-status-error-candidate |
| link on link backing | 4.5:1 text | 5.74 | 6.32 | fill-link-candidate / fill-link-candidate |
| today marker date | 4.5:1 text | 5.08 | 6.05 | fill-today-marker / fill-today-marker |
| shell text | 4.5:1 text | 4.52 | 8.70 | fill-shell / fill-shell |
| shell text, selected row | 4.5:1 text | 6.41 | 12.71 | fill-shell / fill-shell |
| shell secondary text | 4.5:1 text | **4.17 fails** (recorded exception) | 8.05 | fill-shell / fill-shell |
| calendar event | 4.5:1 text | 5.84 | 5.39 | fill-calendar-event / fill-calendar-event |
| calendar deadline | 4.5:1 text | 6.66 | 6.22 | fill-calendar-deadline / fill-calendar-deadline |
| sources coral row | 4.5:1 text | 10.01 | 11.48 | fill-tint-coral / fill-tint-coral |
| sources blue row | 4.5:1 text | 9.05 | 11.51 | fill-tint-blue / fill-tint-blue |
| sources rose row | 4.5:1 text | 10.15 | 11.52 | fill-tint-rose / fill-tint-rose |
| sources amber row | 4.5:1 text | 7.92 | 12.22 | fill-tint-amber / fill-tint-amber |
| sources row action | 4.5:1 text | 8.54 | 5.06 | fill-tint-coral-action / fill-tint-amber-action |
| field boundary | 3:1 non-text | 3.10 | 3.99 | surface-quiet / surface-raised |
| focus on shell | 3:1 non-text | 4.37 | 8.42 | fill-shell / fill-shell |
| current-time line | 3:1 non-text | 4.04 | 5.35 | surface-quiet / surface-raised |
| quiet separator | advisory | 1.30 | 1.28 | surface-quiet / surface-raised |
| disabled text | exempt | 4.02 | 3.62 | fill-disabled / fill-disabled |
| hue rose | 4.5:1 text | 5.50 | 4.93 | hue-rose-strong / hue-rose-strong |
| hue coral | 4.5:1 text | 5.04 | 4.93 | hue-coral-strong / hue-coral-strong |
| hue orange | 4.5:1 text | 5.43 | 4.86 | hue-orange-strong / hue-orange-strong |
| hue yellow | 4.5:1 text | 7.25 | 4.78 | hue-yellow-strong / hue-yellow-strong |
| hue lime | 4.5:1 text | 6.59 | 4.64 | hue-lime-strong / hue-lime-strong |
| hue green | 4.5:1 text | 5.90 | 4.61 | hue-green-strong / hue-green-strong |
| hue teal | 4.5:1 text | 5.43 | 4.60 | hue-teal-strong / hue-teal-strong |
| hue blue | 4.5:1 text | 4.87 | 4.80 | hue-blue-strong / hue-blue-strong |
| hue indigo | 4.5:1 text | 5.01 | 4.84 | hue-indigo-strong / hue-indigo-strong |
| hue purple | 4.5:1 text | 5.34 | 4.93 | hue-purple-strong / hue-purple-strong |
| hue magenta | 4.5:1 text | 5.29 | 4.97 | hue-magenta-strong / hue-magenta-strong |
| hue neutral | 4.5:1 text | 9.03 | 5.76 | hue-neutral-strong / hue-neutral-strong |

| Accent | Theme | action text (4.5:1) | action text, hover (4.5:1) | secondary text (4.5:1) | confirmation text (4.5:1) | selected text (4.5:1) | calendar study block (4.5:1) | focus ring (3:1) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| blue (default) | light | 5.72 | 5.01 | 5.26 | 5.53 | 11.91 | 6.84 | 4.59 |
| blue (default) | dark | 5.90 | 5.00 | 5.90 | 8.36 | 9.39 | 6.41 | 6.08 |
| rose | light | 5.76 | 4.99 | 5.45 | 5.63 | 11.73 | 7.14 | 4.87 |
| rose | dark | 6.13 | 5.21 | 5.71 | 8.29 | 9.53 | 6.30 | 5.76 |
| coral | light | 5.73 | 4.99 | 5.43 | 5.60 | 11.82 | 7.02 | 4.78 |
| coral | dark | 6.09 | 5.13 | 5.76 | 8.32 | 9.51 | 6.33 | 5.82 |
| plum | light | 5.78 | 5.02 | 5.45 | 5.61 | 11.76 | 7.11 | 4.84 |
| plum | dark | 6.13 | 5.15 | 5.75 | 8.25 | 9.60 | 6.34 | 5.80 |

### Below AA, and what was done

| Pair | Before | Resolution |
| --- | --- | --- |
| `.eyebrow` label on the assignment page (legacy `#898981`) | 3.32 | Routed to `--magic-ink-muted`: 4.65 light, 6.72 dark. |
| `.source-url` (legacy `#a0a095`) | 2.48 | Routed to `--magic-ink-muted`. |
| Calendar today date, white on `--magic-accent-current-time` | 4.42 | Date sits on `--magic-fill-today-marker` (light `#b64e39`): 5.08 light, 6.05 dark. The current-time line keeps its exact value. |
| `--magic-ink-on-shell-secondary` on the light shell highlight | 4.17 | **Open, recorded exception.** Both are accepted v3 values; the only consumer is the design lab (`lab/components.css`). Nearest passing: use `--magic-ink-on-shell` (4.52:1), or confine the highlight beneath text as the token comment already asks. Ben's call. |

The first three were found by axe on the light baseline render; all 99 renders after the change (9 variants by 11 surfaces) report no contrast violation.

## Renderer consumers

No colour literal remains in the renderer or `packages/ui/src` (a test enforces it). Legacy `styles.css` and `notifications.css` now read role tokens, which changes some legacy light rendering on purpose:

- Neutral greys and whites move to the nearest warm Magic role.
- Greys lighter than `--magic-ink-muted` become `--magic-ink-muted`, which is darker and passes AA.
- The legacy indigo Join button, dark toggle-on and checkbox tint, and Sources' page-level primary button now use the accent's action or focus roles, so the student's accent reaches them.

Measured against the pre-change light render: onboarding, Courses, the course page, My UW and Sources are pixel-identical, and Home differs only in the Today rail's legacy hour labels, "Show" link and event time. Form controls without their own background take `--magic-surface-raised` through a zero-specificity rule, so dark mode never shows the browser's grey control.

Motion and reduced motion are unchanged.

## Not covered

- The design lab and the public website are not themed or verified in dark.
- There is no high-contrast theme or `forced-colors` check.
- Two left-edge stripes remain and are flagged for their owners: `.evidence-list blockquote` and `.notif-warning`. They contravene the accepted no-stripe correction; only their colours were routed here.
- Hover and pressed states were checked by token contrast, not by rendering each one.

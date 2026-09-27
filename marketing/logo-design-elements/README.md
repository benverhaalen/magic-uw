# Logo design elements

Wizard mascot logo pack (v0.1, working name "Magic Canvas").

## Files (`svg/`)

| File | Use |
| --- | --- |
| `mark-color.svg` | Primary full wizard, light backgrounds |
| `mark-on-dark.svg` | Full wizard for dark/navy backgrounds |
| `mark-mono-ink.svg` | One-color ink |
| `mark-mono-reverse.svg` | One-color reversed (cream on navy) |
| `head-color.svg` | Head-only mark, small spaces |
| `head-mono-ink.svg` | Head-only, one-color |
| `app-icon-yellow.svg` | App icon, yellow tile |
| `app-icon-navy.svg` | App icon, navy tile |
| `favicon.svg` | Favicon (head on navy) |

## Palette

- Ink `#1b1d33`
- Night Navy `#1e2757`
- Hat Blue `#2c55b8`
- Robe Blue `#3a67cf`
- Star Yellow `#f7c440`
- Beard Cream `#f7efdc`
- Nose Peach `#ee9f7c`

Wordmark: Fredoka SemiBold. Clear space: one eye-width on every side. Minimum: full mark 48px tall; below that use the head/favicon.

## Animation

Full-body marks group each arm (sleeve + hand) as `#arm-left` / `#arm-right`, pivoting at the shoulder. Resting pose is `rotate(-40)` / `rotate(40)`; `0` is arms straight out. Animate the `transform` to wave.

# Logo design elements

Wizard mascot logo pack (v0.2, product name "My Magic UW"). v0.2 (September 27) recolours the wizard from blue to a red, orange and yellow palette built on UW–Madison cardinal, so it sits with the product's warm shell instead of against it. Shapes, eyes, arms and animation are unchanged.

## Files (`svg/`)

| File | Use |
| --- | --- |
| `mark-color.svg` | Primary full wizard, light backgrounds |
| `mark-on-dark.svg` | Full wizard for dark or cardinal backgrounds (lighter tint of the robe colour) |
| `mark-mono-ink.svg` | One-color ink |
| `mark-mono-reverse.svg` | One-color reversed (cream on night cardinal) |
| `head-color.svg` | Head-only mark, small spaces |
| `head-mono-ink.svg` | Head-only, one-color |
| `app-icon-yellow.svg` | App icon, yellow tile |
| `app-icon-cardinal.svg` | App icon, night-cardinal tile (was `app-icon-navy.svg`) |
| `favicon.svg` | Favicon (head on night cardinal) |

## Palette

| Name | Hex | Used for |
| --- | --- | --- |
| Robe Cardinal | `#c5050c` | The whole outfit (hat, robe, sleeves) on light backgrounds; UW–Madison's official cardinal (PMS 200 C), the core colour and default of `--wizard-robe` |
| Robe on Dark | `#d44449` | The whole outfit on dark backgrounds: 75% robe colour, 25% white |
| Night Cardinal | `#5c0b10` | App-icon and favicon tiles, reversed marks (replaces Night Navy `#1e2757`) |
| Star Yellow | `#f7c440` | Stars, moon, hem band, yellow tiles (unchanged) |
| Beard Cream | `#f7efdc` | Beard (unchanged) |
| Nose Peach | `#ee9f7c` | Nose (unchanged) |
| Ink | `#29231f` | Outlines on light backgrounds; the product's warm ink (replaces `#1b1d33`) |
| Deep Ink | `#1a0d0b` | Outlines on dark backgrounds (replaces `#0b0d1c`) |

The hat is no longer a separate colour: per Aidan (September 27), the wizard's entire outfit is one colour.

## Theming the wizard colour

Every outfit shape carries both a plain fill and a CSS variable, for example
`fill="#c5050c" style="fill:var(--wizard-robe, #c5050c)"`. Tools that ignore CSS use the plain
fill; browsers use the variable and fall back to cardinal when it is unset.

| Variable | Shapes | Default |
| --- | --- | --- |
| `--wizard-robe` | Hat, robe and sleeves in `mark-color`, `head-color`, `app-icon-yellow` | `#c5050c` |
| `--wizard-robe-on-dark` | Hat, robe and sleeves in `mark-on-dark`, `favicon`, `app-icon-cardinal` | `#d44449` |
| `--wizard-tile` | The rounded tile in `favicon` and `app-icon-cardinal` | `#5c0b10` |

Set only `--wizard-robe`; the site derives the other two from it with `color-mix` (see the top of
`apps/web/assets/site.css`), so a future theme setting changes the whole wizard with one value.
Variables only reach an SVG that is inline in the page. `<img>` and favicon uses render the
defaults, which is why the website build (`scripts/build-web.mjs`) inlines the marks. The mono
variants stay single-ink and are not themed.

The website (`apps/web`) uses the same palette for its brand colour roles. UW's cardinal is an institutional brand colour; the product carries a non-affiliation line, and the team should keep that line visible wherever this palette appears with the "UW" name.

Wordmark: Lora Medium (500; bundled in `packages/ui/assets/fonts`) in this pack. The newly integrated website currently uses Fraunces; the shared editorial-font rollout is tracked separately. Clear space: one eye-width on every side. Minimum: full mark 48px tall; below that use the head/favicon.

## Animation

Full-body marks group each arm (sleeve + hand) as `#arm-left` / `#arm-right`, pivoting at the shoulder. Resting pose is `rotate(-40)` / `rotate(40)`; `0` is arms straight out. Animate the `transform` to wave.

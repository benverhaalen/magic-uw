# Logo design elements

Wizard mascot logo pack (v0.2, product name "My Magic UW"). v0.2 (September 27) recolours the wizard from blue to a red, orange and yellow palette built on UW–Madison cardinal, so it sits with the product's warm shell instead of against it. Shapes, eyes, arms and animation are unchanged.

## Files (`svg/`)

| File | Use |
| --- | --- |
| `mark-color.svg` | Primary full wizard, light backgrounds |
| `mark-on-dark.svg` | Full wizard for dark or cardinal backgrounds (flame hat, orange robe) |
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
| Robe Cardinal | `#c5050c` | Robe on light backgrounds; UW–Madison's official cardinal (PMS 200 C), the core colour |
| Hat Deep Red | `#9b0000` | Hat on light backgrounds; UW's darker companion red |
| Night Cardinal | `#5c0b10` | Dark tiles and reversed marks (replaces Night Navy `#1e2757`) |
| Flame | `#e8331e` | Hat on dark backgrounds (replaces `#3b69d8`) |
| Ember Orange | `#f36c21` | Robe on dark backgrounds (replaces `#4a7ee8`) |
| Star Yellow | `#f7c440` | Stars, moon, hem band, yellow tiles (unchanged) |
| Beard Cream | `#f7efdc` | Beard (unchanged) |
| Nose Peach | `#ee9f7c` | Nose (unchanged) |
| Ink | `#29231f` | Outlines on light backgrounds; the product's warm ink (replaces `#1b1d33`) |
| Deep Ink | `#1a0d0b` | Outlines on dark backgrounds (replaces `#0b0d1c`) |

The website (`apps/web`) uses the same palette for its brand colour roles. UW's cardinal is an institutional brand colour; the product carries a non-affiliation line, and the team should keep that line visible wherever this palette appears with the "UW" name.

Wordmark: Fredoka SemiBold in this pack; the website sets it in Fraunces (soft, light) since September 27. Clear space: one eye-width on every side. Minimum: full mark 48px tall; below that use the head/favicon.

## Animation

Full-body marks group each arm (sleeve + hand) as `#arm-left` / `#arm-right`, pivoting at the shoulder. Resting pose is `rotate(-40)` / `rotate(40)`; `0` is arms straight out. Animate the `transform` to wave.

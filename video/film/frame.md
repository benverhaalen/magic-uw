# Frame spec: My Magic UW film

Taken from the marketing site (`apps/web/assets/site.css` on `feat/site-update`) and the product tokens (`docs/design/tokens.css`, `DESIGN.md`). The film adds no second palette or type system.

## Type
- **Editorial / display:** Karma Medium 500 (`assets/fonts/Karma-Medium.ttf`, SIL OFL; the site's `--serif` and `--round`). Titles, group names, end card, big statements.
- **Interface / body:** Geist Variable (`assets/fonts/Geist-Variable.woff2`, SIL OFL; the site's `--sans`). Summaries, labels, tables, captions at 500–600.
- **Mono:** Geist Mono is the site's data face; the film has no code blocks, so it is not used. No decorative monospace.
- Scale on a 1920×1080 frame: display 88–96, section 46–58, statement 40–52, summary and caption 34–38, label 17–22. Upright only; no italic accent words.

## Colour (site roles)
| Role | Value |
|---|---|
| Cardinal (marks, primary) | `#c5050c` |
| Deep red → night cardinal (the dark rooms, `--dark-fill`) | `#9b0000` → `#5c0b10` |
| Star yellow (accent on dark) | `#f7c440` |
| Blush / rose (pale chips) | `#faebec` / `#f6d9da` |
| Ink | `#29231f`; deep ink ground `#1a0d0b` |
| White text on dark | `#ffffff` |

Grounds are the dark rooms or the real app. No cream full-frame grounds, no pill buttons, no 01/02/03 labels.

## Layout
- The feature minute is the real app, full frame. Group title (Karma 58) and a one-line summary (Geist 34, star yellow) sit bottom-left on a deep-ink gradient band.
- Presenter segment: the presenter owns the left 55%; overlays sit on the right 45% over a deep-ink scrim.
- Captions for spoken dialogue: Geist 500 38, white with a deep-ink shadow, bottom centre (left-aligned in the presenter segment).

## Motion
- Entrances use expo.out, 0.45–0.7 s; stagger 0.1–0.28 s. Chips and stings use back.out.
- The camera on real UI uses power3.inOut, 0.7–0.8 s. It starts wide on each page and punches in with margin, never past 1.6×.
- Flips are rotateY with power2.inOut. No infinite loops.

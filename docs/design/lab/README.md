# Working component lab · v3

An isolated HTML/CSS/JS specimen, not production Home or a Calendar page. Synthetic data and browser-only operations are labeled in the specimen. This is a candidate component implementation; user acceptance of the foundations sheet does not approve every component treatment.

Serve this repository using a normal static server and open `docs/design/lab/index.html`. It imports `../tokens.css`; do not copy this stylesheet into a second theme. JavaScript here is a small fixture controller, not domain/data plumbing or a React component package.

## Private local fonts

Without configuration the lab labels its font fallback honestly. On localhost, pass `?fontBase=/work/fonts/` when that served directory contains the supplied `cooperl.ttf` and `Geist-Variable.woff2`. Alternatively set `window.MAGIC_LOCAL_FONT_BASE` before loading `local-fonts.js`. The loader rejects cross-origin paths and non-localhost hosts. No font binary or embedded font data is included. Production distribution requires separate permission/configuration. `document.documentElement.dataset.fonts` reports `exact` only after both FontFaces load.

## Reusable roles and structure

| Role | Markup/class API | State API and responsibility |
| --- | --- | --- |
| Action | `button.mc-action` for a mutation, `a.mc-action[href]` for navigation; `--secondary`, `--quiet`, `--learning` variants | Native `disabled` for unavailable controls; pending uses `aria-busy=true` plus guarded `aria-disabled=true` to preserve focus; readable nearby status. A disabled anchor requires explicit behavior and is not demonstrated. |
| Inline navigation | `a.mc-link[href]` | Underline, hover, visible focus. No backing fill. A noun link opens exactly its named source. |
| Time | `time.mc-time[datetime]` | Same text size as prose, atomic token. Long-range values may need shorter visible copy plus full accessible detail; do not shrink type. |
| Context + action | `.mc-context` containing prose and action/compound | Whole composition has a bounded measure, natural wrapping, and stretch alignment. The local comparison has an 84px minimum for both single/compound regions; they can grow. This is not a universal height for buttons or arbitrary passages. |
| Compound acknowledgement | `.mc-compound > a.mc-action` followed by `.mc-confirmation` with separately labeled native checkbox | Review does not change checkbox. Fixture stores by issue + source version; persistent Undo returns focus to checkbox. Production owns reopening on materially changed evidence. |
| Information only | `p.mc-passage` | Full text width, source link when useful, no mandatory action container. Guest speaker example explains the consequence without redundant action. |
| Flat identity item | `a.mc-entity[href]`, children `__label`, `__title`, `__time`, optional glyph | `data-identity=blue|coral`, default rose. One navigation target, long title wraps and date remains visible. No nested controls or provider launch claim. Real stable identity mapping belongs to the domain adapter. |
| Field | `.mc-field`, native label + input/select, separate `__error` | Associate helper/error IDs via `aria-describedby`; set `aria-invalid` on invalid field; focus first invalid; preserve input on save failure. |
| Feedback | `.mc-feedback` | Default neutral ink. `data-tone=error` for failure; `data-tone=success` only for confirmed local save. Use `role=status` or `aria-live=polite` where warranted. |
| Dialog | Native `dialog.mc-dialog` with `aria-labelledby` + `aria-describedby`, header/footer slots | Entry explicitly requested. Initial focus on explanatory title. Background inert through `showModal`; Tab loops controls; Escape and close return to trigger. Backdrop does not dismiss. Draft adjustment fields survive dismissal/reopen during the session. Cancel invalidates an in-flight fixture save. |
| Menu | `.mc-menu[popover][role=menu]`, buttons `role=menuitem`, named trigger | Native dismissal, arrows/Home/End/first-character navigation, Escape return, Tab exit. Command selection scrolls/focuses destination; does not pretend to filter. No arbitrary form controls inside the menu. |
| Time context | `.mc-temporal`, `__event`, `__now` | Separate deadline, interval, and current-time marker; labels preserve meaning without color. No calendar grid or live time claim. |
| Glyph | `svg.mc-glyph[aria-hidden=true]` with named external control | Small drawing independent of control target. Do not use Lucide as a provider logo. |

`lab-*` classes are documentation composition/context only. The shell borrows the inspected Home's warm wrap, 234px sidebar, 55px header and 13px ivory workspace at 1440px; its navigation indexes the lab. It does not demonstrate production routes, history, or every shell control. Small viewport context intentionally becomes a document navigation strip.

## Source and license

Actual Lucide v0.468.0 SVG nodes were obtained from `lucide-static` on unpkg for arrow-right, chevron-down, x, house, book-open and file-text. Originals and upstream ISC license are in `vendor/`; the inline sprite retains their geometry with the project's 1.65 stroke role. License is preserved. The reviewed raster studies were rejected by the user and are not component appearance authority. Code was built from the original Home image, exact fonts, corrected contracts and runtime comparisons, without reading the old mock cascade.

## Demonstrated and unverified

Rendered in Chrome for Testing 153 via agent-browser 0.27.0 at 1440×900 and 390×900 with exact fonts. Observed no horizontal overflow at those viewports. Default single and compound footprints both measured 196×84 at desktop; glyphs remain small and source/time text readable. Inspected screenshots include default, full family sheet, dialog, narrow, field error and local recovery.

Exercised: required note validation and focus; pending state; intentional local-save failure preserving draft; retry/save; exam source identity and explicit return restoring focus/scroll; independent handled + Undo; dialog title focus, containment wrap, Escape return, optional adjustment and missing field validation; menu End and Escape return. Menu selection focus was also exercised: End + Enter focuses its destination. Error → dismiss → reopen was checked after the final repair: stale error and aria-invalid clear, field draft remains. Keyboard activation keeps focus on a pending guarded action. Hover/focus rules exist; this is not a complete accessibility, assistive-technology, browser, zoom or contrast certification. No real calendar/course API or app integration was tested. Local storage, popup positioning at unusual zoom, very long unbreakable tokens, source-version refresh behavior, and production routing need their adapter-specific checks.

# Silent product loops

The home page (`apps/web/index.html`) has seven video slots. Each loads `<slot>.webm` first and `<slot>.mp4` as the fallback, with `<slot>-poster.jpg` as its poster. Drop a clip here under its expected name and it plays with no code change; until then the slot shows its poster.

## Clip requirements

- 4 to 8 seconds, loops cleanly (last frame flows into the first)
- 1280×720 (16:9), or smaller at the same ratio; the slot crops with `object-fit: cover`
- silent: no audio track
- under 1.5 MB per file; WebM (VP9 or AV1) and MP4 (H.264, `+faststart`)
- the poster is the clip's first frame, 1280×720 JPEG; replace the placeholder poster with it so the swap from poster to clip does not jump

## Slots

| Slot | Page section | Files | Source scene (launch-video, `video/film/compositions/`) | Current poster |
| --- | --- | --- | --- | --- |
| `spell` | Hero | `spell.webm`, `spell.mp4` | `s03-spell.html`: the spell, Canvas → app | real UI capture `course-page.png` (synthetic sample course) |
| `agenda` | Daily agenda | `agenda.webm`, `agenda.mp4` | `s04-home.html`: agenda plus the announcement toast | real UI capture `home.png` |
| `item-space` | Study spaces | `item-space.webm`, `item-space.mp4` | `s05-item.html`: the item space with evidence lines | real UI capture `study-space.png` |
| `quiz` | Practice | `quiz.webm`, `quiz.mp4` | `s06-quiz.html`: the practice quiz | real quiz component, synthetic items, `quiz-q6.png` |
| `analytics` | Course analytics | `analytics.webm`, `analytics.mp4` | `s07-analytics.html`: the analytics charts | styled placeholder (abstract bars and ring, no data) |
| `guard` | Privacy | `guard.webm`, `guard.mp4` | `s08-guard.html`: Whiz the guard | styled placeholder (Whiz and the four privacy lines) |
| `agent-ring` | Open source | `agent-ring.webm`, `agent-ring.mp4` | the open-agent ring (the presenters part; no composition file yet) | styled placeholder (Whiz inside a ring of Claude Code, Codex, Any MCP harness) |

The proof flip (`s09-proof.html`) has no slot: the home page shows the two figures as text, each with its label.

## Behaviour (in `assets/site.js`)

- The `<video>` carries only `data-src` sources, so nothing downloads until the slot is within 150 px of the viewport (IntersectionObserver).
- It plays while visible and pauses offscreen. A Pause/Play button appears once a clip is actually playing.
- `prefers-reduced-motion: reduce`, or a browser without IntersectionObserver or JavaScript, shows the poster only.

The four UI posters were cut from the launch-video UI captures (`video/film/assets/ui/`, taken headlessly from the app's own preview with its synthetic sample course), downscaled to 1280×720 JPEG. No private coursework is in any poster.

# Marketing materials

Website page directions and the wizard logo pack, exported from the design tool on September 26, 2026. Status: **proposal**. These are design exports, not the built website in [`apps/web`](../apps/web); the product and the website scope are described in [shared context](../docs/README.md).

## Contents

| Path | Contents |
| --- | --- |
| `Website Directions.dc.html` | Home page directions and refinements |
| `About Us.dc.html`, `FAQ.dc.html`, `Pricing.dc.html` | Supporting page drafts |
| `Logo Pack.dc.html` | Logo usage sheet |
| `logo/` | SVG marks referenced by the pages |
| `logo-design-elements/` | The same SVG set with palette, clear-space, and animation notes |
| `team/` | Team photos used on About Us |
| `uploads/` | Source uploads: original wizard logo, reference screenshots, team photo originals |
| `support.js` | Generated runtime the `.dc.html` pages load; do not edit |

## Viewing

The pages load `support.js` and relative images, so serve the folder over HTTP rather than opening files directly:

```bash
python3 -m http.server 4178 --directory marketing
```

Then open `http://localhost:4178/Website%20Directions.dc.html`. Fonts and provider icons load from Google Fonts and public icon CDNs.

Pricing and AI-access copy must match [the current pricing decision](../docs/decisions.md#pricing-and-ai-access-resolution--september-26) before publishing. **Open:** `Pricing.dc.html` shows a $10 license; the recorded decision is $5 one-time.

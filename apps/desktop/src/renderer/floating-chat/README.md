# Floating chat

The app's third way into chat, after the full-pane chat and the command bar: a wizard launcher in a corner of the window that opens a small chat panel about the page the student is on. Drag it, or press the arrow keys while it has focus, and it snaps to the nearest corner. The corner is remembered.

| File | Role |
| --- | --- |
| `wizard.svg` | The one canonical wizard: a layered, rigged inline SVG traced from `marketing/uploads/Wizard_logo.jpg`. Also the source for the marketing site and the video. |
| `rig.ts` | The wizard's animation state machine (`createWizardRig`, `setWizardState`). |
| `model.ts` | Pure rules: the 5 px press threshold, corner choice and avoidance, panel placement and resizing, keys, persistence. |
| `element.ts`, `element.css` | `<magic-floating-chat>`: the launcher, the "Click to chat" pill and the panel frame, all in a shadow root. |
| `FloatingChat.tsx`, `floating-chat.css` | The app mount. It hosts the chat lane's `ChatPane` and store unchanged. |
| `setting.tsx` | "Floating chat: on/off" (default on), shown on the Data & AI page. |

## How it fits the app

- **Mount.** `App.tsx` renders `<FloatingChat>` once in the shell. It is portalled to `<body>` so page-entrance transforms never move it. It is not rendered during onboarding (the shell is not mounted yet), and it is hidden while setup or agreements show. The setting unmounts it.
- **Same command path.** Messages call `startChat` or `continueChat`. The chat store runs them the way the command bar does: the `intent.preview` query, then the router's `command` run and the grounded ask. Deadline and saved-item answers fall back to the store's local paths when the router is unavailable. The composer reuses the conversation launcher's draft model (idempotency keys, text kept on failure).
- **Scope chip.** It shows the chat's current scope once a chat exists. Before that it shows the page the student is on (course, item or included courses). A new chat always takes the page shown in the chip.
- **Opening.** The launcher, or the chat button in the top bar (`openFloatingChat()`), opens the panel about the current page. With the setting off, the top-bar button says so and points to Data & AI.
- **Warm-up.** The router's `prewarm` command runs once per session so the first answer does not wait on the AI client's start-up. Warming starts an AI session, so `chatWarmPolicy` (`warm.ts`) decides the trigger: on the first hover, keyboard focus or open only when the student's settings already let chat run on their hosted AI without a preview (hosted mode, their AI selected and agreed to, course text shared, always-preview off); on the first open only when a preview or setting stands in the way; never in local-only mode or with no hosted AI agreed to. Hovering never starts a session the student did not ask for.
- **Placement.** The launcher keeps clear of `.desktop-chrome` (below it for top corners) and `.desktop-sidebar` (a side column narrows the frame, so left corners sit beside it, never over the navigation). It also keeps clear of a bottom composer bar if one is mounted. The panel opens beside the launcher on the same side, grows out of it, and fits between those regions.
- **Keyboard.** Enter or Space opens and closes. Escape closes from anywhere in the panel and returns focus to the launcher. Arrow keys on the launcher move it between corners, and the move is announced. Arrow keys on the resize grip resize the panel. Minimise keeps the chat; Close ends it, so the next open starts a new chat about the current page.

## The wizard rig

Colours come from the `--magic-wizard-*` tokens in `docs/design/tokens.css` (light and dark). Every part has its own transform origin. The arm (`#arm`, holding the wand, `#wand-tip`, `#glow` and `#sparkles`) pivots at the shoulder.

| State | Set by | What moves (at most two parts) | Length |
| --- | --- | --- | --- |
| `idle` | default | hat bob, blink | loops (5.2 s, 6.4 s) |
| `hover` | launcher hover or keyboard focus | arm wave, 4 staggered sparkles after the peak | 1.1 s, once |
| `listening` | a dictation owner | wand-tip glow: follows `setWizardLevel(0..1)`, else a slow pulse; blink | loop |
| `thinking` | a question in flight (chat store) | sparkles orbit the raised wand; blink | loop |
| `answered` | the answer arrived | one sparkle burst, then idle | 0.8 s |
| `error` | the question failed | a small head tilt, then idle (no red) | 1.0 s |
| `settle` | the launcher landed in a corner | a small squash and settle of the whole figure | 0.36 s |

Loops and the hover wave are CSS keyframes inside `wizard.svg`, keyed on `data-state`. The one-shots are Web Animations sequenced by `rig.ts`. Only transforms and opacity animate, and `will-change` is set only while a part moves. Everything pauses while the window is hidden or unfocused. With reduced motion the wizard is still, and the state shows as a small text label ("Thinking", "Listening", "Answered", "Couldn't answer").

```ts
import { setWizardState } from "./floating-chat";
setWizardState("listening", level); // from a dictation button; level 0..1 or null
setWizardState("idle");
```

## Embedding outside the app

The element has no React or app dependency. It needs only the design tokens on the page.

1. Build it once as a module with Vite. Plain esbuild does not understand the `?raw` and `?inline` imports.

   ```js
   // embed.vite.mjs
   export default { configFile: false, build: { lib: { entry: "apps/desktop/src/renderer/floating-chat/element.ts", formats: ["es"], fileName: "floating-chat" }, outDir: "dist/embed" } };
   ```

   Run `npx vite build --config embed.vite.mjs` from the repo root. The output is `floating-chat.js`, about 31 KB, or 10 KB gzipped.
2. Load `docs/design/tokens.css` on the page. `packages/ui/src/motion/motion.css` is optional; the durations fall back to the same values. Load Lora Medium and Geist for the exact faces (Lora ships with its OFL in `packages/ui/assets/fonts`).
3. Use the element, putting your own content into its two slots:

   ```html
   <script type="module">import { defineFloatingChat } from "./floating-chat.js"; defineFloatingChat();</script>
   <magic-floating-chat scope-label="Demo course" avoid=".site-header">
     <div slot="body">Panel content</div>
     <form slot="footer"><input data-autofocus aria-label="Message"></form>
   </magic-floating-chat>
   ```

**Attributes:** `scope-label` (the chip; hidden when empty), `avoid` (a selector list of regions to keep clear of) and `hidden`. `open` is reflected.

**Methods:** `open()`, `close(reason)`, `toggle()`, `moveTo(corner)`, `setWizardState(state)` and `setWizardLevel(level)`.

**Events** (bubbling, composed): `floating-chat-open`, `floating-chat-close` (`detail.reason`: toggle, escape, minimise, end), `floating-chat-warm` (once per session, on the first hover or focus and on the first open, `detail.trigger`: hover or open; cancel it to decline, and the next trigger asks again) and `floating-chat-move` (`detail.corner`). An element in the footer with `data-autofocus` receives focus on open. The inset from the window edges is `--floating-chat-inset` (16px). The design system has no spacing token yet.

**The asset outside a page.** `wizard.svg` reads its colours from the tokens, so an `<img src="wizard.svg">` cannot see them and renders without colour. Inline it in a page that loads `tokens.css`, which is also the only way to drive its states. A flattened copy for image or video tools would have to be generated from the tokens; none exists yet.

This embedding was checked in a plain page (no React, no app CSS). A marketing-site integration has not been done.

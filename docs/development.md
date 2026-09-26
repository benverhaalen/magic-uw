# Development

Use **Node 24** (see `.nvmrc`) and **pnpm 10.29.2**. SQLite uses Node's built-in `node:sqlite`; an older Node version is not supported.

## Working method

Read [AGENTS.md](../AGENTS.md), the relevant [agent work principles](agent-work-principles.md), and [reference-driven design](reference-driven-design.md). Before substantial UI or behavior changes, establish the normal student journey and success check, inspect the relevant reference mechanism, and verify its transfer in the running product. The [tool matrix](tool-evaluation.md) preserves the newer acquisition/extraction candidates; none should be installed merely because it appears there. [Pipeline details](pipeline-details.md) retain actual endpoints, limits, and unresolved behaviors.

Keep a short reference/evidence note with a consequential change: what was inspected, what property was adopted, what changed in the artifact, and how it was checked. Use the existing docs rather than a duplicate report when sufficient. Flag unclear intent, added clutter/complexity, and disproportionate model or tool cost with Ben. Do not implement or merge the six organizing concepts before his reaction.

## Run

```sh
pnpm install
pnpm dev
```

`dev` builds and opens the Electron desktop app. It starts empty with hosted AI sharing off. **Load sample course** imports synthetic data explicitly. **Import capture** accepts JSON matching `captureEnvelopeSchema` (records are validated individually) in `packages/contracts`. **Sources** contains UW sign-in, Canvas refresh, and session removal. The sign-in browser uses the app's own local session; it does not import a personal browser profile. UW/Duo interaction belongs to the student. After a successful Canvas profile response, the sign-in window closes and the workspace starts a refresh; this embedded sign-in path still needs live validation.

The app stores its database in Electron's local user-data directory. Use a separate `MAGIC_USER_DATA` directory when isolating an experiment. Captured school data is private even when it is useful for debugging: keep it outside this repository. Never replace the synthetic fixtures with an unredacted export.

## Checks and headless verification

| Command                      | Purpose                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm check`                 | Type-check applications and shared packages                                                           |
| `pnpm test`                  | Run synthetic tests for contracts, storage, connectors, privacy, model adapters, and gateway limits   |
| `pnpm build`                 | Type-check and build desktop code plus the informational website; does not sign or package installers |
| `pnpm test:desktop`          | Build and run a hidden Electron check with temporary data, no gateway, and no school connection       |
| `pnpm fixture`               | Inspect the synthetic capture and deadline interpretation in the terminal                             |
| `pnpm build && pnpm preview` | Serve the renderer with the real core and a temporary SQLite store at `http://127.0.0.1:4173`         |

The preview has no UW session, gateway, file dialog, or external-window launch. It is a local verification surface, not a web deployment. Stop it with Ctrl-C to remove its temporary data. Use a headless browser for agent-driven verification. **All agent testing on Ben's computer and Canvas stays headless**; do not open a visible browser to resolve a sign-in challenge.

Tests with fake HTTP responses establish behavior for those cases. They do not establish live UW access, model accuracy, provider billing, or Windows compatibility. Current evidence and remaining checks belong in [implementation status](implementation-status.md).

## One shared Jev key

Only the gateway operator supplies the upstream key. Ben can put it in the ignored server file without sending it in chat:

```sh
test -f apps/gateway/.env || cp apps/gateway/.env.example apps/gateway/.env
```

Edit `apps/gateway/.env` locally and set `TYPESAFE_API_KEY`. Keep the initial request caps conservative, then start the gateway:

```sh
pnpm gateway
```

In another terminal, point the desktop at that local server:

```sh
MAGIC_GATEWAY_URL=http://127.0.0.1:8787 pnpm dev
```

`MAGIC_GATEWAY_URL` contains only the server address. Do not put the TypeSafe key in it, in a `VITE_` variable, or anywhere in the desktop configuration. The desktop enrolls a device automatically and stores its separate gateway token using Electron's OS-backed `safeStorage`. Students need no Jev account or key. Nothing is sent for judgments until the user enables selective cloud access, Jev, and course-text sharing in **Data & AI**.

For the whole team to share the key, deploy this gateway once and give teammates its HTTPS URL. Put the key in the host's secret manager. The gateway is **not deployed yet**. It currently requires one process, persistent SQLite, TLS termination, and deliberately configured global request limits. Anonymous enrollment is not proof of a unique person; the global ceiling protects the bill. Behind a reverse proxy, IP limits currently see the proxy address. See the [gateway README](../apps/gateway/README.md) for spend controls, metadata retention, device revocation, and deployment limitations before exposing it publicly.

## Local and hosted AI

Use **Check local setup** in Data & AI, or open a course item and use **Ask locally**. The local adapter expects an existing compatible **llmfit** CLI and a local **Ollama** service with cloud features disabled. It ranks hardware-fit candidates, then requires an exact installed model and quantization match. It does not download software or weights, and no real local-model run has yet established tutoring quality. A missing dependency produces a setup message; it does not hand course text to a hosted model.

ChatGPT, Claude, and Gemini are selectable data preferences and context-preview recipients. Compatible external MCP clients can read explicitly granted evidence through the local server below. The desktop has **no embedded provider account connections or hosted answer providers yet**. Do not enter plan credentials or claim that a subscription pays for embedded inference. A working stdio connection does not establish compatibility with every provider account.

## Package boundaries

| Location              | Responsibility                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`        | Isolated renderer/preload, browser session, desktop capabilities, local worker                                |
| `apps/gateway`        | Narrow Jev endpoint, owner credential, enrollment and persistent usage limits                                 |
| `apps/web`            | Informational page; no download link until a release exists                                                   |
| `packages/contracts`  | Shared schemas, store interface, commands, and renderer bridge                                                |
| `packages/domain`     | Pure deadline resolution and data-sharing rules                                                               |
| `packages/storage`    | SQLite migrations, versions, field observations, typed changes, search, jobs, grants, and student state       |
| `packages/connectors` | Canvas, calendar, public-site, document, and GitLab reads through separate bounded transports                 |
| `packages/core`       | Commands, context, exact evidence links, refresh scheduling, MCP tools, judgments, and stale-result rejection |
| `packages/ai`         | Gateway client and local model adapter                                                                        |

Change shared contracts before making incompatible changes across packages. Keep source access, extraction, interpretation, and model calls independently replaceable. Follow the [engineering principles](engineering-principles.md): choose against the actual student task, verify current licenses and benchmark provenance, and distinguish a researched candidate from a working integration.

## Local ingestion and MCP

Sources exposes term/inclusion choices, refresh timing, metadata/download concurrency, local feedback collection, and recent runs. Inaccessible courses stay excluded even with an inclusion override. Read [course ingestion](ingestion-upgrade.md) for capture scopes, defaults, limits, and failure semantics. Canvas reads may register views or satisfy must-view requirements; the entry screen discloses that accepted side effect. Data & AI lets the student create an MCP grant, choose courses/categories, export a local stdio configuration, and revoke it. Export replaces that connection’s credential; keep its access file on the device. Provider/client support must be verified separately.

OCR is optional and local: explicit absolute `MAGIC_PDFTOPPM_PATH`, `MAGIC_TESSERACT_PATH`, and `MAGIC_TESSDATA_DIRECTORY` paths connect installed tools and language data. Without them, textless documents report `needs_ocr`. No binaries/models are downloaded or bundled by this adapter. Distributing external tools requires their own license review.

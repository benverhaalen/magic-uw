# Magic Canvas

**The future of learning, tailored to you.**

Stop managing school. Start learning.

Magic Canvas is an AI workspace being built to already know your classes: what matters now, which materials you need, and how to practice for your professor's expectations. It builds on the apps and study habits students already use.

Built for UW–Madison's Badger BuildFest 2026 by a team of four. Entering **Applied AI & Automation**, **Badgers Building for Badgers (DoIT)**, and **The Art of the Break**.

## Start here

Read the [shared context](docs/README.md). It separates the product direction, proposed implementation, verified event requirements, and unanswered questions.

**Current state:** an Electron desktop workspace with local SQLite storage, a Canvas read connector, source and deadline evidence, explicit data-sharing controls, and an owner-funded Jev gateway. A local-model adapter selects a suitable installed model using hardware recommendations. Hosted account connections, managed model downloads, and the broader learning loop are still ahead. See [implementation status](docs/implementation-status.md) for the exact boundary and [development setup](docs/development.md) to run it.

## Run the workspace

Use Node 24 and pnpm 10.29.2:

```sh
pnpm install
pnpm dev
```

The app starts empty with hosted AI sharing off. Load the explicitly synthetic sample course, import a local capture, or use the app's UW sign-in browser. No Jev key is needed to develop the local workspace. Ben's one shared key belongs only on the [gateway server](apps/gateway/README.md).

| Document | What it answers |
| --- | --- |
| [Product](docs/product.md) | Who is this for, what should feel magical, and what remains open? |
| [AI and privacy](docs/ai-and-privacy.md) | Which AI choices, sign-ins, and data controls are intended? |
| [Architecture](docs/architecture.md) | How should access, local data, judgments, and learning fit together? |
| [Implementation status](docs/implementation-status.md) | What exists, what has been exercised, and what is still intended? |
| [Engineering principles](docs/engineering-principles.md) | How do we select tools, evaluate evidence, and preserve trust? |
| [BuildFest](docs/buildfest.md) | What must we submit, when, and what should we ask mentors? |
| [Decisions](docs/decisions.md) | What is direction, what is proposed, and what needs evidence? |
| [Research](docs/research.md) | What has been checked, and what still needs investigation? |

Private course data, credentials, sessions, and unredacted research captures do not belong in this repository. Use synthetic or appropriately redacted examples when sharing context.

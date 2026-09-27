# My Magic UW

My Magic UW is an independent student project. It is not affiliated with, sponsored by or endorsed by the University of Wisconsin–Madison.

**The future of learning, tailored to you.**

Stop managing school. Start learning.

My Magic UW is an AI workspace being built to already know your classes: what matters now, which materials you need, and how to practice for your professor's expectations. It builds on the apps and study habits students already use.

Built for UW–Madison's Badger BuildFest 2026 by a team of four. Entering **Applied AI & Automation**, **Badgers Building for Badgers (DoIT)**, and **The Art of the Break**.

## Start here

Read the [shared context](docs/README.md). It separates the product direction, proposed implementation, verified event requirements, and unanswered questions.

**How we build:** [reference-driven design](docs/reference-driven-design.md). Study the actual mechanism or interaction, adapt it to the student journey, and verify its effect in the product. [Agent instructions](AGENTS.md) carry this method into new sessions and delegated work.

**Current state:** an Electron desktop workspace with versioned local SQLite storage, expanded Canvas reads, background refresh, independent calendar feeds, linked course-site/document/GitLab evidence, and local MCP tools with explicit sharing grants. My UW adds local enrollment, saved DARS audits, course search/sections, and conservative academic-source comparison. An owner-funded Jev gateway and an installed-local-model adapter provide bounded AI features. Embedded hosted account connections, managed model downloads, and the broader learning loop are still ahead. See [implementation status](docs/implementation-status.md) for the exact boundary and [development setup](docs/development.md) to run it.

## The course backend and the open academic data platform

Under the app is a local-first academic database. After one UW sign-in, code inventories and reads every course the student can already see, stores it in one SQLite file on their computer as passages with exact offsets, and checks every quote, ID and date. The student's own AI client writes only what code can't, and studying costs no model tokens. The same packages are MIT and open to Badger developers who want to build their own study tools.

- [Academic data platform](docs/academic-data-platform.md): what it is, what's built, a developer quickstart, the decisions with their evidence, and a sourced scorecard against NotebookLM, Quizlet, Anki and seven other tools.
- [Course backend architecture](docs/course-backend-architecture.md): the system map and where the build stands.
- [Build record](docs/course-backend-build-record.md): tests, measurements and the live trial.

## Run the workspace

Use Node 24 and pnpm 10.29.2:

```sh
pnpm install
pnpm dev
```

The app starts empty with hosted AI sharing off. Load the explicitly synthetic sample course, import a local capture, or use the app's UW sign-in browser. No Jev key is needed to develop the local workspace. Ben's one shared key belongs only on the [gateway server](apps/gateway/README.md).

| Document                                                   | What it answers                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Product](docs/product.md)                                 | Who is this for, what should feel magical, and what remains open?                   |
| [AI and privacy](docs/ai-and-privacy.md)                   | Which AI choices, sign-ins, and data controls are intended?                         |
| [Architecture](docs/architecture.md)                       | How should access, local data, judgments, and learning fit together?                |
| [Course ingestion](docs/ingestion-upgrade.md)              | What gets captured, how it refreshes, and what evidence survives failures?          |
| [Planning integration](docs/planning-upgrade.md)         | What My UW reads, how academic sources differ, and what remains unverified?         |
| [Implementation status](docs/implementation-status.md)     | What exists, what has been exercised, and what is still intended?                   |
| [Engineering principles](docs/engineering-principles.md)   | How do we select tools, evaluate evidence, and preserve trust?                      |
| [Reference-driven design](docs/reference-driven-design.md) | How do references change our design, implementation, and verification?              |
| [Organizing concepts](docs/product-directions.md)          | Which six different product structures are open for discussion?                     |
| [Pipeline details](docs/pipeline-details.md)               | What are the concrete reads, limits, recovery rules, and link-evaluation proposals? |
| [BuildFest](docs/buildfest.md)                             | What must we submit, when, and what should we ask mentors?                          |
| [Decisions](docs/decisions.md)                             | What is direction, what is proposed, and what needs evidence?                       |
| [Research](docs/research.md)                               | What has been checked, and what still needs investigation?                          |

Private course data, credentials, sessions, and unredacted research captures do not belong in this repository. Use synthetic or appropriately redacted examples when sharing context.

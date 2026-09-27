# My Magic UW

My Magic UW is an independent student project. It is not affiliated with, sponsored by or endorsed by the University of Wisconsin–Madison.

**The future of learning, tailored to you.**

Stop managing school. Start learning.

My Magic UW is an AI workspace being built to already know your classes: what matters now, which materials you need, and how to practice for your professor's expectations. It builds on the apps and study habits students already use.

Built for UW–Madison's Badger BuildFest 2026 by a team of four. Entering **Applied AI & Automation**, **Badgers Building for Badgers (DoIT)**, and **The Art of the Break**.

## Start here

Read the [shared context](docs/README.md). It separates the product direction, proposed implementation, verified event requirements, and unanswered questions.

**How we build:** [reference-driven design](docs/reference-driven-design.md). Study the actual mechanism or interaction, adapt it to the student journey, and verify its effect in the product. [Agent instructions](AGENTS.md) carry this method into new sessions and delegated work.

**Current state** (`main`, 2026-09-27; labels as defined in [architecture §1.1](docs/course-backend-architecture.md#11-status-labels)): an Electron desktop app over one local SQLite database. After one UW sign-in it reads every current course automatically (demonstrated on a real account), splits materials into passages with exact offsets, and maps each course by code: material roles, dates, terms, formulas and what each assignment references (demonstrated on 6 live courses). Quizzes, flashcards and study guides are generated with one checked call on the student's own Claude Code or Codex (integrated; a generation run on real course content is not yet recorded), lecture-note scaffolds are built by code, and study itself (FSRS flashcards, Learn rounds, sectioned quizzes, topic states, analytics) runs at zero model tokens (integrated). UW Outlook and Microsoft 365 connect through the app's own Microsoft sign-in (integrated; the live run against UW's tenant is pending). My UW adds local enrollment, saved DARS audits and course search, which never leave the computer. [Implementation status](docs/implementation-status.md) has the exact boundary and [development setup](docs/development.md) runs it.

## The platform: an open academic database for students and Badger developers

My Magic UW is built on an **agent-first academic database**: courses, modules, versioned resources, passages with offsets and full-text search, quoted material facts, a reference graph, the course profile, learning state and notes, all in one file on the student's computer. **AI writes, code decides:** code checks every quote, number, date and ID a model returns, the model never gets tools inside the app, and planning data never leaves the machine.

- **Open source (MIT) and free with the student's own AI.** Generation runs on the plan the student already has, so there are no extra usage credits; those calls do count toward that plan's limits, and whether the route fits each provider's terms is an open decision (H5). An optional hosted Jev service is the paid part; its price is an open team decision (H1).
- **Built to be built on.** A versioned, grant-scoped, read-only agent API (`@magic/agent-api` v1) and a read-only MCP course bank let a developer's tool or a student's own AI client read their courses, with a receipt for every read.

| Read next | What it answers |
|---|---|
| [Academic data platform](docs/academic-data-platform.md) | what the database stores, the agent API and MCP course bank, a developer quickstart, the business model, licensing, governance, the scorecard and the roadmap |
| [Course backend architecture](docs/course-backend-architecture.md) | processes, the data flow from sign-in to study, the agent runtime, privacy layers, the job drain, freshness, and the measured effect of each design choice |
| [Benchmarks](docs/benchmarks.md) | performance and quality measurements, with methods and the rows we lose |
| [Business model](docs/notes/business-model.md) | pricing, the hosted service, the UW licence path, payments and distribution |

## Run the workspace

Use Node 24 and pnpm 10.29.2:

```sh
pnpm install
pnpm dev
```

The app starts empty with hosted AI sharing off. Load the explicitly synthetic sample course, import a local capture, or use the app's UW sign-in browser. No Jev key is needed to develop the local workspace. The team's Jev key belongs only on the [gateway server](apps/gateway/README.md).

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

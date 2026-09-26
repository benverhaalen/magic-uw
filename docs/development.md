# Development

Use Node 24 LTS and pnpm 10.29.2. Run `pnpm install`, `pnpm check`, and `pnpm test`.

The initial skeleton's `pnpm dev` validates a synthetic course capture and prints deadline interpretation. Desktop and gateway integration are being built on the same contracts. Fixtures are explicitly synthetic; never commit personal exports or credentials.

Packages separate shared schemas, pure rules, application services, SQLite storage, source connectors, and AI adapters. The applications compose them. `packages/contracts` is the coordination boundary; propose schema changes there before making incompatible changes in multiple packages.

The Jev key belongs only in the gateway server's secret environment, never in a desktop bundle, Vite variable, fixture, or git commit. A gateway environment example and setup guide follow with the gateway implementation.

# Upstream source inventory

Inspected 2026-09-26. Pins record the inspected source, not a claim of latest version. Read [source adapters](../source-adapters.md) first: these upstream opinions are selectively adapted to Magic's accepted intent.

| Repository | Commit | Use | Notice |
| --- | --- | --- | --- |
| [Emil Kowalski skills](https://github.com/emilkowalski/skills/tree/d16ebe60d09a5ba2afcb7054ede9d0a10c9f6128) | `d16ebe60d09a5ba2afcb7054ede9d0a10c9f6128` | Adapted motion gates, interruption, review and edge cases; source files linked from adapters | [MIT, Emil Kowalski](emil/LICENSE) |
| [shadcn/ui](https://github.com/shadcn-ui/ui/tree/98a1fe67b439324ddc857f47fbdce056600a4329) | `98a1fe67b439324ddc857f47fbdce056600a4329` | Actual `skills/shadcn/SKILL.md` inspected and linked; two small rule files retained below | [MIT, shadcn](shadcn/LICENSE.md) |
| [Taste Skill](https://github.com/Leonxlnx/taste-skill/tree/ce26fc25c0e5e8cab638f883de62d9a86ee5e45b) | `ce26fc25c0e5e8cab638f883de62d9a86ee5e45b` | Adapted image extraction/fidelity, audit and brief inference; source files linked from adapters | [MIT, Leonxlnx](taste/LICENSE) |

## Retained source files

| Local file | Upstream file at above pin | SHA-256 |
| --- | --- | --- |
| `shadcn/rules/icons.md` | `skills/shadcn/rules/icons.md` | `d4a58266648872d9ee07d0c2368843a1cb88b8253b7f528dd7bda9d68b6c2535` |
| `shadcn/rules/composition.md` | `skills/shadcn/rules/composition.md` | `2105b3d402135e7642839eb1ac0d4d44abfff5cf6e4f428525c079f682746387` |

The icon source is unchanged. The composition source has one packaging edit: its relative `chat.md` link points to the immutable upstream URL because chat is intentionally not vendored. The original composition SHA-256 was `f282df828d83a91132a846ddb62eea149a7c7c94822e9ca88cfddf85af01aa41`. If chat becomes the task, read the [pinned chat source](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/skills/shadcn/rules/chat.md) and evaluate it against the project's actual chat contract. These reference copies do not register additional automatic skills.

For updates, inspect the new upstream diff and license, re-evaluate changed mechanisms against user decisions, then update the pin/hash and adaptation together. Never replace a working local component or design choice solely because upstream changed a default.

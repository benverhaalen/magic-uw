# Shared Magic UI

A small React implementation of audited patterns. This is a reusable source package, not a new page layout. Start with [DESIGN.md](../../DESIGN.md) and read only the affected recipe. Its first consumer is [the adoption example](examples/adoption.tsx); production screens have **not** been migrated.

## Use

Within this monorepo, import from the relative `packages/ui/src` path and import `packages/ui/src/styles.css` once in the host entry. This follows source-level consumption without requiring a workspace install/lockfile change. A consumer may later declare `@magic/ui: workspace:*` and use package exports when its owner updates dependencies. React 19 is supplied by the host. Popover requires the native Popover API in the target browser; verify that platform before adopting.

CSS imports the existing canonical `docs/design/tokens.css`; there is no second palette. Styles are namespaced and do not reset the page. `styles.css` also imports `src/fonts.css`, which declares the one bundled editorial face: unmodified Karma Medium at weight 500 in `assets/fonts` with its SIL OFL (`Karma-OFL.txt`). Ship that license beside any copied font file. Geist, host layout and typography for page content remain host responsibilities; do not add other font binaries here. Exporting this package outside the monorepo requires packaging the token import deliberately.

## Contracts beside the implementation

| Export | Use and guarantee | Caller responsibility / audit lesson |
| --- | --- | --- |
| `Action` | A command with shared fill, focus, press, quiet and pending treatments; pending guards repeated clicks | Use a real link for navigation. Supply honest state, visible unavailable reason and application result. |
| `EvidenceLink` | Real anchor carrying stable resource/version identity; no unexpected launch or completion side effect | Supply exact authorized route; render source label, capture time, uncertainty and evidence at destination. Null means unknown. It does not validate evidence or sanitize URLs. |
| `Confirmation` | Controlled student report matched to issue + source version; Undo follows checkbox and restores focus | Persist by issue/version; retain prior history; supply pending/error. Source changes alter version only when evidence materially changes. Parent handles rejection and stale network results. |
| `Disclosure` | Native details semantics; shared Hugeicons Stroke Rounded chevron | Supply useful contents; do not use it to hide decision-critical uncertainty. |
| `NavigationPopover` | Native nonmodal popover, ordinary links, Escape return, dismissal when Tab leaves | Supply unique real destinations. Router owns destination focus, return scroll and draft preservation. No fake menu roles. |
| `createOperationScope` | Only current ticket may commit; invalidation makes previous tickets stale | Snapshot inputs before awaiting; invalidate on reset/route/unmount; check ticket before committing. This does not abort network requests or reverse external writes. |

Recipe provenance: [direct-source audit](../../docs/design/audit-v3-direct-sources.md). Exact behavior lives in code/comments, not solely in this table. Hugeicons Stroke Rounded MIT attribution is in [LICENSE.icons](LICENSE.icons).

## Manual adoption check

Use the existing build tooling to bundle `examples/adoption.tsx` (`esbuild packages/ui/examples/adoption.tsx --bundle --jsx=automatic --loader:.ttf=file --outfile=<temporary-directory>/example.js` from the repo root) and load it in a local page with a `root` element, the emitted `example.css` stylesheet and `example.js` script. Karma Medium is emitted beside the bundle; supply Geist through the host’s permitted setup for visual review. Check confirmation → Tab → Undo; change version; popover → Escape/Tab away; save → edit and save → reset. The example deliberately uses in-memory synthetic data. It is not a persistence or integrated app test.

Run the package's `tsconfig.json` with TypeScript for a focused check. No CI, hooks or automatic checks are installed. Record observed evidence in the [adoption handoff](../../docs/design/adoption.md), including actual consumers and exceptions. Consult the [coverage record](../../docs/design/adoption.md#current-consumers) before claiming app adoption.

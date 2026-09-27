// owner: acquisition. Loads extract-worker.ts in a worker thread under tsx (tests and perf); the
// app runs the bundled apps/desktop/dist/extract-worker.cjs instead.
import { register } from "tsx/esm/api";
register();
await import("../packages/connectors/src/extract-worker.ts");

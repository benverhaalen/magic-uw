import { runDocumentStage } from "./documents.ts";
import { ACQUISITION_APP, ACQUISITION_BEFORE } from "../../apps/desktop/src/ingestion";
const which = process.argv[2];
const r = which === "after" ? await runDocumentStage("after", ACQUISITION_APP, { files: 60, maxSyncs: 2 }) : await runDocumentStage("before", ACQUISITION_BEFORE, { files: 60, maxSyncs: 1, direct: which === "direct" });
console.log(JSON.stringify(r, null, 1));

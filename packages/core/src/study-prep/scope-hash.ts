// owner: study-prep. One stable hash for keys and fingerprints.
import { createHash } from "node:crypto";

export const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

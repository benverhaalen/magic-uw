/**
 * The stored form of a resource version's payload. New versions are raw-DEFLATE compressed JSON
 * (a BLOB); versions written before v6 stay JSON text and read unchanged. Course text was 40% of
 * the database at 5,000 resources (MT1 corpus); read only by this package. Level 1: on MT1 it
 * compresses as well as level 6 (10.3 vs 10.3 MB per 1,000 resources) at a third of the cost.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { ResourceInput } from "@magic/contracts";

export function encodePayload(item: ResourceInput): Uint8Array {
  return deflateRawSync(Buffer.from(JSON.stringify(item), "utf8"), { level: 1 });
}

export function decodePayload(value: unknown): ResourceInput {
  if (value instanceof Uint8Array)
    return JSON.parse(inflateRawSync(value).toString("utf8")) as ResourceInput;
  return JSON.parse(String(value)) as ResourceInput;
}

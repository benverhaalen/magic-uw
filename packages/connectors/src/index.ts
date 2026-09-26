import {
  captureBatchSchema,
  type CaptureBatch,
  type Connector,
} from "@magic/contracts";
export function recordedConnector(input: unknown): Connector {
  const batches = (Array.isArray(input) ? input : [input]).map((x) =>
    captureBatchSchema.parse(x),
  );
  return {
    id: "recorded",
    async *pull(signal) {
      for (const batch of batches) {
        signal?.throwIfAborted();
        yield batch;
      }
    },
  };
}
export function validateCapture(input: unknown): CaptureBatch {
  return captureBatchSchema.parse(input);
}

export { canvasConnector } from "./canvas";
export * from "./network";
export * from "./external";
export * from "./documents";
export * from "./calendar";
export * from "./gitlab";

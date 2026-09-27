// owner: benchmarks. Opt-in preview fixture (MAGIC_PREVIEW_BENCHMARK_FIXTURE=1): real Local
// benchmarks of the fabricated university (packages/connectors/src/canvas-fixture.ts), synced
// through the app's own ingestion, core pipeline and recorder into the preview's store. Offline:
// public reads fail by design, so these runs are honestly "partly read". Never a live account.
import { join } from "node:path";
import type { Store } from "@magic/contracts";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createBenchmarkBank, createBenchmarkRecorder, type BenchmarkRecorder } from "../apps/desktop/src/benchmarks";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import type { PublicClient } from "../packages/connectors/src/network";
import type { createCore } from "@magic/core";
import type { createStore } from "@magic/storage";
import { CONSENT_DISCLOSURE_VERSION } from "../packages/core/src/egress";

const origin = "https://canvas.wisc.edu";
const offline: PublicClient = {
  isCanvas: (url) => new URL(url).origin === origin,
  get: async () => { throw new Error("offline"); },
  text: async () => { throw new Error("offline"); },
  feed: async () => { throw new Error("offline"); },
  signedDownload: async () => { throw new Error("offline"); },
};

export function createBenchmarkFixture(input: {
  directory: string;
  store: ReturnType<typeof createStore>;
  core: ReturnType<typeof createCore>;
}) {
  const { directory, store, core } = input;
  const bank = createBenchmarkBank(join(directory, "benchmarks.sqlite"));
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  let recorder: BenchmarkRecorder | undefined;
  // A little latency, so phases and the trend have shape (a replay answers instantly).
  const canvasFetch = async (url: string, init?: RequestInit) => {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 4 + Math.random() * 18));
    const response = await university.fetch(url, init);
    const body = await response.clone().text();
    recorder?.request("canvas", url, { status: response.status, bytes: body.length, ms: performance.now() - started });
    return response;
  };
  const ingestion = createIngestion(store as Store & Parameters<typeof createIngestion>[0], {
    directory,
    client: offline,
    canvasFetch,
    secrets: async () => ({}),
    onSaved: (sourceId) => {
      recorder?.saved(sourceId);
      core.saved(sourceId);
    },
    onRunStart: () => {
      core.pipeline.syncStarted();
      recorder?.started();
    },
    onRunEnd: (run) => {
      core.pipeline.syncEnded();
      recorder?.ended(run);
    },
  });
  recorder = createBenchmarkRecorder({
    store,
    dbPath: join(directory, "workspace.sqlite"),
    bank,
    registry: core.jobs,
    pipelineTotals: () => core.pipeline.totals,
    present: () => false,
    drainPollMs: 100,
  });
  const run = () => recorder!.runBenchmark(() => ingestion.tick("manual"));
  return {
    async seed(count: number) {
      // As in the app, Canvas sources only exist after the setup agreement: the synthetic student agreed.
      await core.execute({ type: "consent", value: { action: "grant", recipient: "uw", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
      for (let i = 0; i < count; i++) await run();
    },
    async handle(request: { op?: string; id?: string }) {
      if (request.op === "list") return bank.list();
      if (request.op === "get" && typeof request.id === "string") return bank.get(request.id);
      if (request.op === "status") return recorder!.status();
      if (request.op === "run") return run();
      if (request.op === "clear") return bank.clear(), null;
      throw new Error("Unknown benchmarks request.");
    },
    async close() {
      recorder!.close();
      await ingestion.stop();
      bank.close();
    },
  };
}

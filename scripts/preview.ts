import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createCore } from "@magic/core";
import { createStore } from "@magic/storage";
import { captureBatchSchema } from "@magic/contracts";
import fixture from "../fixtures/course.json";
import {
  createLearningRouter,
  type StudyContext,
} from "../packages/learning/src/router";
import { createStudyContextResolver } from "../apps/desktop/src/learning-context";
import { seedLearningFixture } from "./learning-fixture";
import { seedSyncResilienceFixture } from "./sync-resilience-fixture";
import { linkExactEvidence } from "../packages/core/src/evidence";
// Explicit opt-in QA output, never a substitute for live model inference.
const syncFixture = process.env.MAGIC_PREVIEW_SYNC_FIXTURE === "1";
const learningFixture = process.env.MAGIC_PREVIEW_LEARNING_FIXTURE === "1";
// Local verification surface using the real core/store. No browser sessions or gateway.
const directory = await mkdtemp(join(tmpdir(), "magic-preview-"));
const store = createStore(join(directory, "workspace.sqlite"));
const sample = captureBatchSchema.parse(fixture);
if (learningFixture) {
  const assignment = sample.resources.find((r) => r.kind === "assignment");
  const material = sample.resources.find((r) => r.kind === "material");
  if (assignment && material)
    assignment.links = [{ url: material.url, text: "Supporting reading" }];
}
const core = createCore(store, {
  fixture: sample,
  seams: {
    learning: createLearningRouter({
      store: store.learning,
      resolveContext: (resourceId): StudyContext | null =>
        resolveStudyContext(resourceId),
    }),
  },
});
const resolveStudyContext = createStudyContextResolver(store, core);
const token = randomBytes(32).toString("hex");
const root = resolve("apps/desktop/dist/renderer");
const server = createServer(async (req, res) => {
  const address = server.address();
  if (!address || typeof address === "string") {
    res.writeHead(503).end();
    return;
  }
  const expected = `127.0.0.1:${address.port}`;
  if (req.headers.host !== expected) {
    res.writeHead(403).end();
    return;
  }
  const path = new URL(req.url ?? "/", `http://${expected}`).pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (path === "/command" || path === "/query") {
      if (
        req.method !== "POST" ||
        req.headers.authorization !== `Bearer ${token}` ||
        (req.headers.origin && req.headers.origin !== `http://${expected}`)
      ) {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      const parsed = JSON.parse(body);
      let result = path === "/query" ? core.query(parsed) : await core.execute(parsed);
      if (syncFixture && path === "/command" && parsed.type === "fixture") {
        seedSyncResilienceFixture(store);
        result = await core.execute({type:"snapshot"});
      }
      if (learningFixture && parsed.type === "fixture") {
        linkExactEvidence(store);
        const loaded = await core.execute({ type: "snapshot" });
        if (loaded.snapshot)
          seedLearningFixture(store.learning, loaded.snapshot);
        result = loaded;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/bridge.js") {
      const script = `window.magic={query:async(request)=>{const r=await fetch('/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ${token}'},body:JSON.stringify(request)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;},execute:async(command)=>{const r=await fetch('/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ${token}'},body:JSON.stringify(command)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;},openExternal:async()=>{throw new Error('External windows are disabled in this headless verification surface.');},importFile:async()=>{throw new Error('Use the desktop app to import a local capture.');},localStatus:async()=>({status:'setup_needed',reason:'Local runtime checks are disabled in this browser verification surface. Use the desktop app.',cloudDisabled:false,selectedModel:null,recommenderAvailable:false,basis:'No runtime was contacted.'}),localAsk:async()=>{throw new Error('Local inference is disabled in this browser verification surface. Use the desktop app.');},cancelLocal:async()=>{}};`;
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
      return;
    }
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (
      file !== join(root, "index.html") &&
      !file.startsWith(root + "/assets/")
    ) {
      res.writeHead(404).end();
      return;
    }
    let body = await readFile(file);
    if (file.endsWith("index.html"))
      body = Buffer.from(
        body
          .toString()
          .replace("<head>", '<head><script src="/bridge.js"></script>')
          .replace(
            "<body>",
            learningFixture || syncFixture
              ? '<body><div role="note" style="padding:8px;background:#ffe7a8;color:#382700">Synthetic verification — test fixtures, no live school or AI connections.</div>'
              : "<body>",
          ),
      );
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    };
    res
      .writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
      })
      .end(body);
  } catch {
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(
        JSON.stringify({ error: "The local request could not be completed." }),
      );
  }
});
server.listen(4173, "127.0.0.1", () =>
  console.log(
    "Local verification: http://127.0.0.1:4173 (temporary data; no cloud or school connections)",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(async () => {
      await core.close();
      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    });
  });

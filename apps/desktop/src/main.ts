import { judgmentFailure } from "./judgment-errors";
import {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  shell,
  utilityProcess,
  safeStorage,
  powerMonitor,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, writeFile, mkdir, stat, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { gatewayClient } from "@magic/ai";
import { checkedCanvasUrl } from "../../../packages/connectors/src/canvas-http";
import {
  UwPlanningHttp,
} from "../../../packages/connectors/src/uw-planning-http";
import { syncUwPlanning } from "../../../packages/connectors/src/uw-planning-sync";
import {
  isOutlookPublishedCalendar,
  readBounded,
} from "../../../packages/connectors/src/network";
import { checkedSpaceProbeUrl } from "../../../packages/connectors/src/space-hosts"; // owner: T05b
import { clearSignOutSecrets, createSecretVault } from "./secrets";
import { createGoogleNotesAuth } from "./notes-google"; // owner: notes
// owner: T30. Outlook through the app's own Microsoft sign-in (Graph); the token stays in main.
import { createOutlook, readOutlookConfig } from "./outlook";
import { electronAuthWindow } from "./outlook-window";
import { checkedGraphUrl } from "../../../packages/connectors/src/graph";
import { OUTLOOK_MAIL_COURSE_ID, OUTLOOK_CALENDAR_COURSE_ID, type OutlookStatus } from "@magic/contracts";
// end owner: T30
import { MadgradesHttp, madgradesRequestSchema } from "../../../packages/connectors/src/madgrades";
import sampleFixture from "../../../fixtures/course.json";
// owner: T05c
import { Tray, Menu, nativeImage } from "electron";
import {
  closeAction,
  launchSession,
  loginItemSettings,
  planningProbe,
  planningSessionConfirmed,
  readSessionSettings,
  singleFlight,
  trayBitmap,
  trayMenu,
  trayWanted,
  writeSessionSettings,
  type TrayAction,
} from "./keep-signed-in";
// end owner: T05c
import { consentGateAllows } from "../../../packages/core/src/egress"; // owner: T06
import { consentRecordSchema, type ConsentRecord } from "@magic/contracts"; // owner: T06
import {
  commandSchema,
  captureBatchSchema,
  captureEnvelopeSchema,
  planningCaptureSchema,
  localQuestionSchema,
  queryRequestSchema, // owner: T15
  type CommandResult,
} from "@magic/contracts";
const headless = process.env.MAGIC_HEADLESS === "1";
if (headless) {
  app.commandLine.appendSwitch("headless");
  void app.dock?.hide();
}
if (process.env.MAGIC_USER_DATA)
  app.setPath("userData", process.env.MAGIC_USER_DATA);
// Internal data-folder name: kept stable across the display rename so existing local data stays in place.
app.setName("Magic Canvas");
let window: BrowserWindow | null = null,
  signIn: BrowserWindow | null = null;
let sync: AbortController | undefined;
let quitting = false;
const root = __dirname;
const rendererURL = pathToFileURL(join(root, "renderer/index.html")).toString();
function validateSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== rendererURL
  )
    throw new Error("Untrusted workspace request.");
}
function safeExternal(input: unknown) {
  if (typeof input !== "string" || input.length > 4000)
    throw new Error("Invalid link.");
  const url = new URL(input);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only ordinary web links can be opened.");
  return url.toString();
}
// owner: T05b. A link card opens in the default browser, https only (D40). The app never
// launches an LTI tool itself (D32); opening a link is the student's own click.
function safeLinkCard(input: unknown) {
  const url = new URL(safeExternal(input));
  if (url.protocol !== "https:") throw new Error("Only https links open from a link card.");
  return url.toString();
}
// end owner: T05b
// Dev-only live-trial log (MAGIC_TRIAL_LOG=<file>): hosts, masked paths, statuses and timings only;
// never bodies, queries, cookies or identity. Off unless the variable is set.
function trialPath(input: string): string {
  try {
    const u = new URL(input);
    return (
      u.hostname +
      u.pathname
        .replace(/\/\d+(?=\/|$)/g, "/:id")
        // Page slugs and file names are course titles; keep only the shape.
        .replace(/\/(pages|files|wiki)\/[^/]+/g, "/$1/:slug")
    ).slice(0, 120);
  } catch {
    return "invalid-url";
  }
}
function trialLog(event: Record<string, unknown>) {
  const file = process.env.MAGIC_TRIAL_LOG;
  if (!file) return;
  void appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n").catch(() => {});
}
function allowedLogin(input: string) {
  try {
    const u = new URL(input);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.hostname === "wisc.edu" ||
        u.hostname.endsWith(".wisc.edu") ||
        // Instructure's SSO relay: UW's IdP returns the SAML response through it (live trial 2026-09-26).
        u.hostname === "sso.canvaslms.com" ||
        u.hostname === "duosecurity.com" ||
        u.hostname.endsWith(".duosecurity.com"))
    );
  } catch {
    return false;
  }
}
app
  .whenReady()
  .then(async () => {
    const data = app.getPath("userData");
    await mkdir(data, { recursive: true, mode: 0o700 });
    const studentSession = session.fromPartition("persist:uw");
    const planningScopePath = join(data, "planning-session-scope");
    let planningAccountScope: string;
    try {
      const saved = (await readFile(planningScopePath, "utf8")).trim();
      planningAccountScope = /^uw-session:[a-f0-9-]{36}$/.test(saved)
        ? saved : `uw-session:${randomUUID()}`;
    } catch {
      planningAccountScope = `uw-session:${randomUUID()}`;
    }
    const planningHttp = new UwPlanningHttp({
      fetch: (url, init) => studentSession.fetch(url, init),
    });
    const planningReads = new Set<string>();
    let planningCall: { id: string; promise: Promise<CommandResult> } | undefined;
    let planningEpoch = 0;
    let planningClears = 0;
    const gitlabSession = session.fromPartition("persist:gitlab");
    gitlabSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    gitlabSession.setPermissionCheckHandler(() => false);
    gitlabSession.on("will-download", (event) => event.preventDefault());
    const vault = createSecretVault(join(data, "source-capabilities.enc"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value)),
    });
    // owner: notes. Google Docs sync: OAuth (PKCE, loopback) and the Drive proxy; the token stays here.
    const notesGoogle = createGoogleNotesAuth({
      clientId: process.env.MAGIC_GOOGLE_CLIENT_ID || undefined,
      vault,
      openExternal: (url) => shell.openExternal(url),
    });
    // end owner: notes
    // The Madgrades token stays in the main-process vault; the workspace sends only fixed request shapes.
    const madgradesHttp = new MadgradesHttp({
      fetch: (url, init) => fetch(url, init),
      token: () => vault.get("madgrades:token"),
    });
    const sourceReads = new Map<string, AbortController>();
    // owner: T30. Outlook (Graph). No client ID configured: "not set up" and no network call.
    const outlookFiles = {
      async read(path: string) {
        try {
          return await readFile(path);
        } catch {
          return null;
        }
      },
      async write(path: string, value: Buffer | string) {
        await writeFile(path, value, { mode: 0o600 });
      },
      async remove(path: string) {
        await rm(path, { force: true });
      },
    };
    const outlook = createOutlook({
      config: await readOutlookConfig(process.env, async () =>
        (await outlookFiles.read(join(data, "outlook-settings.json")))?.toString("utf8") ?? null,
      ),
      cachePath: join(data, "outlook-token-cache.enc"),
      statePath: join(data, "outlook-state.json"),
      encryptor: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
      files: outlookFiles,
      window: electronAuthWindow({ parent: () => window, headless }),
      consented: () => consentGate("source-fetch"),
    });
    // end owner: T30
    studentSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    studentSession.setPermissionCheckHandler(() => false);
    studentSession.on("will-download", (event) => event.preventDefault());
    const worker = utilityProcess.fork(join(root, "worker.cjs"), [], {
      env: {
        ...process.env,
        MAGIC_DB_PATH: join(data, "workspace.sqlite"),
        MAGIC_PLANNING_SCOPE: planningAccountScope,
      },
      stdio: "pipe",
      serviceName: "My Magic UW local workspace",
    });
    const calls = new Map<
      string,
      {
        resolve: (value: CommandResult) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const localCalls = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let readyResolve: () => void, readyReject: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimer = setTimeout(
      () => readyReject(new Error("Local workspace did not start.")),
      15000,
    );
    const evaluations = new Map<string, AbortController>();
    const credentialPath = join(data, "gateway-device.enc");
    const gateway = process.env.MAGIC_GATEWAY_URL
      ? gatewayClient(process.env.MAGIC_GATEWAY_URL, {
          async read() {
            if (!safeStorage.isEncryptionAvailable())
              throw new Error("Secure credential storage is unavailable.");
            try {
              return safeStorage.decryptString(await readFile(credentialPath));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
              throw new Error("Reconnect the judgment gateway.");
            }
          },
          async write(token) {
            if (!safeStorage.isEncryptionAvailable())
              throw new Error("Secure credential storage is unavailable.");
            await writeFile(credentialPath, safeStorage.encryptString(token), {
              mode: 0o600,
            });
          },
        })
      : undefined;
    function cancelPlanning() {
      planningEpoch++;
      worker.postMessage({ kind: "planning-cancel" });
      for (const id of planningReads) sourceReads.get(id)?.abort();
      if (planningCall) {
        const pending = calls.get(planningCall.id);
        if (pending) {
          clearTimeout(pending.timer);
          calls.delete(planningCall.id);
          pending.reject(new Error("Planning refresh cancelled. Saved records are still available."));
        }
        planningCall = undefined;
      }
    }
    async function resetPlanningScope() {
      planningAccountScope = `uw-session:${randomUUID()}`;
      await rm(planningScopePath, { force: true });
      worker.postMessage({ kind: "planning-scope", accountScope: planningAccountScope });
    }
    worker.on("message", async (message: any) => {
      if (message.kind === "source-abort") {
        sourceReads.get(message.id)?.abort();
        return;
      }
      // owner: notes. The worker's Google Docs calls: status, the student's sign-in, and Drive requests.
      if (message.kind === "notes-google") {
        try {
          const { op, request } = message.payload ?? {};
          const result =
            op === "status" ? await notesGoogle.status()
            : op === "connect" ? await notesGoogle.connect()
            : op === "disconnect" ? await notesGoogle.disconnect()
            : op === "request" ? await notesGoogle.request(request)
            : (() => { throw new Error("Unsupported notes operation"); })();
          worker.postMessage({ kind: "source-response", id: message.id, result });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
        }
        return;
      }
      // end owner: notes
      if (message.kind === "source-secret") {
        try {
          const { operation, key, value } = message.payload;
          let result: unknown;
          if (operation === "list")
            result = Object.fromEntries(
              (await vault.list("calendar:")).map(({ key, value }) => [
                key,
                value,
              ]),
            );
          else if (
            operation === "set" &&
            typeof key === "string" &&
            key.startsWith("calendar:") &&
            key.length < 1000 &&
            typeof value === "string" &&
            value.length < 4000 &&
            key !== "calendar:outlook"
          ) {
            const u = new URL(value);
            if (
              u.origin !== "https://canvas.wisc.edu" ||
              !/^\/(?:feeds|calendar_feeds)\//.test(u.pathname) ||
              u.username ||
              u.password
            )
              throw new Error();
            await vault.set(key, value);
          } else throw new Error();
          worker.postMessage({
            kind: "source-response",
            id: message.id,
            result,
          });
        } catch {
          worker.postMessage({
            kind: "source-response",
            id: message.id,
            error: true,
          });
        }
        return;
      }
      // owner: T30. The worker's Graph delta links and watermarks, in the encrypted vault.
      if (message.kind === "graph-state") {
        try {
          const { operation, key, value } = message.payload ?? {};
          if (typeof key !== "string" || !/^graph:(?:delta|at):[a-z0-9:_-]{1,120}$/i.test(key)) throw new Error();
          let result: unknown;
          if (operation === "get") result = (await vault.get(key)) || undefined;
          else if (operation === "set") {
            if (value === null) await vault.set(key, "");
            else if (typeof value === "string" && key.startsWith("graph:delta:")) await vault.set(key, checkedGraphUrl(value));
            else if (typeof value === "string" && Number.isFinite(Date.parse(value)) && value.length <= 40)
              await vault.set(key, value);
            else throw new Error();
          } else throw new Error();
          worker.postMessage({ kind: "source-response", id: message.id, result });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
        }
        return;
      }
      if (message.kind === "graph-synced") {
        const { at, failures } = message.payload ?? {};
        if (typeof at === "string" && failures && typeof failures === "object")
          void outlook.recordSync(at, failures as Record<string, string>).catch(() => {});
        return;
      }
      // end owner: T30
      if (message.kind === "planning-public-read") {
        if (!(await consentGate("planning-public-read"))) {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
          return;
        }
        const controller = new AbortController();
        sourceReads.set(message.id, controller);
        planningReads.add(message.id);
        try {
          const request = message.payload?.request;
          if (planningClears > 0 || !["public-search", "enrollment-packages"].includes(request?.kind)) throw new Error("Unsupported planning read");
          const result = await planningHttp.read(request, controller.signal);
          controller.signal.throwIfAborted();
          worker.postMessage({ kind: "source-response", id: message.id, result });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
        } finally { planningReads.delete(message.id); sourceReads.delete(message.id); }
        return;
      }
      if (message.kind === "madgrades-read") {
        if (!(await consentGate("planning-public-read"))) {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
          return;
        }
        const controller = new AbortController();
        sourceReads.set(message.id, controller);
        planningReads.add(message.id);
        try {
          const request = madgradesRequestSchema.parse(message.payload?.request);
          if (planningClears > 0) throw new Error("Madgrades read cancelled");
          const result = await madgradesHttp.read(request, controller.signal);
          controller.signal.throwIfAborted();
          worker.postMessage({ kind: "source-response", id: message.id, result });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
        } finally { planningReads.delete(message.id); sourceReads.delete(message.id); }
        return;
      }
      if (message.kind === "planning-refresh") {
        if (!(await consentGate("planning-refresh"))) {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
          return;
        }
        const controller = new AbortController();
        sourceReads.set(message.id, controller);
        planningReads.add(message.id);
        try {
          if (!planningCall || planningClears > 0) throw new Error("Planning read cancelled");
          // The native orchestration owns fixed reads, identity validation, and raw
          // response projection. The worker cannot supply URLs or private identities.
          const result = await syncUwPlanning({
            http: planningHttp, accountSeed: planningAccountScope, signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          worker.postMessage({ kind: "source-response", id: message.id, result });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
        } finally {
          planningReads.delete(message.id);
          sourceReads.delete(message.id);
        }
        return;
      }
      if (message.kind === "source-fetch") {
        if (!(await consentGate("source-fetch"))) {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
          return;
        }
        const controller = new AbortController();
        sourceReads.set(message.id, controller);
        // owner: T30. Graph: main's proxy attaches the token; the worker gets status, headers, body.
        if (message.payload?.service === "graph") {
          try {
            const result = await outlook.graphProxy(
              message.payload,
              AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
            );
            trialLog({ event: "fetch", service: "graph", status: result.status, bytes: result.body.length });
            worker.postMessage({ kind: "source-response", id: message.id, result });
          } catch {
            worker.postMessage({ kind: "source-response", id: message.id, error: true });
          } finally {
            sourceReads.delete(message.id);
          }
          return;
        }
        // end owner: T30
        try {
          const { service, url } = message.payload;
          let target: string;
          if (service === "canvas")
            target = checkedCanvasUrl(url, "https://canvas.wisc.edu");
          else if (service === "gitlab") {
            const u = new URL(url);
            if (
              u.origin !== "https://git.doit.wisc.edu" ||
              u.username ||
              u.password ||
              u.hash ||
              !/^\/api\/v4\/projects(?:\/|$)/.test(u.pathname)
            )
              throw new Error();
            for (const key of u.searchParams.keys())
              if (
                ![
                  "per_page",
                  "page",
                  "id_after",
                  "pagination",
                  "membership",
                  "simple",
                  "ref",
                  "ref_name",
                  "recursive",
                  "path",
                  "all",
                  "scope",
                  "order_by",
                  "sort",
                ].includes(key)
              )
                throw new Error();
            target = u.href;
          } else if (service === "kaltura") {
            // owner: T05b. Kaltura on its own host (D32), GET only, in the app's UW session.
            const u = new URL(url);
            if (
              u.protocol !== "https:" ||
              u.hostname !== "mediaspace.wisc.edu" ||
              u.port ||
              u.username ||
              u.password ||
              u.hash
            )
              throw new Error();
            target = u.href;
          } else if (service === "space") {
            // owner: T05b. D41's access check: one plain GET to a UW single-sign-on host the host
            // table allows (Kaltura, UW GitLab); never a launch, redirects not followed.
            target = checkedSpaceProbeUrl(url);
          } else throw new Error(); // owner: T30: "graph" is answered above, by outlook.graphProxy
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]);
          const response = await (
            service === "gitlab" ||
            (service === "space" && new URL(target).hostname === "git.doit.wisc.edu")
              ? gitlabSession
              : studentSession
          ).fetch(target, {
            method: "GET",
            credentials: "include",
            redirect: "manual",
            headers: {
              Accept:
                service === "kaltura" || service === "space"
                  ? "text/html"
                  : service === "canvas" ? "application/json+canvas-string-ids" : "application/json",
            },
            signal,
          });
          // owner: T05b: a space check needs only the status and a bounded start of the page.
          const body =
            service === "space"
              ? await readBounded(response, 256 * 1024, signal).catch(() => "")
              : await readBounded(response, 8 * 1024 * 1024, signal);
          const headers = Object.fromEntries(
            [
              "content-type",
              "link",
              "retry-after",
              "x-request-cost",
              "x-rate-limit-remaining",
              "x-next-page",
            ].flatMap((key) =>
              response.headers.has(key)
                ? [[key, response.headers.get(key)!]]
                : [],
            ),
          );
          // owner: T05c (lead integration). The Canvas reader needs a redirect's target to tell a sign-in
          // redirect from other redirects; only its origin and path cross, never the query.
          const moved = response.headers.get("location");
          if (moved) {
            try {
              const to = new URL(moved, target);
              headers.location = to.origin + to.pathname;
            } catch {}
          }
          trialLog({ event: "fetch", service, to: trialPath(target), status: response.status, contentType: (response.headers.get("content-type") ?? "").split(";")[0], bytes: body.length, redirect: headers.location ? trialPath(headers.location) : undefined });
          worker.postMessage({
            kind: "source-response",
            id: message.id,
            result: {
              status: response.status,
              url: response.url,
              headers,
              body,
            },
          });
        } catch {
          worker.postMessage({
            kind: "source-response",
            id: message.id,
            error: true,
          });
        } finally {
          sourceReads.delete(message.id);
        }
        return;
      }
      if (message.kind === "ready") {
        clearTimeout(readyTimer);
        readyResolve();
        return;
      }
      if (message.kind === "closed") {
        worker.kill();
        return;
      }
      if (message.kind === "local-response") {
        const c = localCalls.get(message.id);
        if (!c) return;
        clearTimeout(c.timer);
        localCalls.delete(message.id);
        if (message.error) c.reject(new Error(message.error));
        else c.resolve(message.result);
        return;
      }
      if (message.kind === "response") {
        const c = calls.get(message.id);
        if (!c) return;
        clearTimeout(c.timer);
        calls.delete(message.id);
        if (message.error) c.reject(new Error(message.error));
        else c.resolve(message.result);
        return;
      }
      if (message.kind === "abort") {
        evaluations.get(message.id)?.abort();
        return;
      }
      if (message.kind === "evaluate") {
        if (!(await consentGate("evaluate"))) {
          worker.postMessage({ kind: "evaluation", id: message.id, error: true });
          return;
        }
        const controller = new AbortController();
        evaluations.set(message.id, controller);
        try {
          if (!gateway) throw new Error("Gateway unavailable");
          const result = await gateway.evaluate(
            message.payload,
            controller.signal,
          );
          worker.postMessage({ kind: "evaluation", id: message.id, result });
        } catch (error) {
          worker.postMessage({
            kind: "evaluation",
            id: message.id,
            ...judgmentFailure(error),
          });
        } finally {
          evaluations.delete(message.id);
        }
      }
    });
    worker.on("exit", () => {
      clearTimeout(readyTimer);
      readyReject(new Error("Local workspace stopped."));
      for (const c of [...calls.values(), ...localCalls.values()]) {
        clearTimeout(c.timer);
        c.reject(new Error("Local workspace stopped. Restart the app."));
      }
      calls.clear();
      localCalls.clear();
    });
    async function execute(command: unknown): Promise<CommandResult> {
      const parsed = commandSchema.parse(command);
      await ready;
      if (parsed.type === "madgrades-token") {
        // Stored only in the OS-protected vault; the workspace, records, and logs never receive it.
        if (parsed.token === null) await vault.deletePrefix("madgrades:");
        else await vault.set("madgrades:token", parsed.token);
        const result = await execute({ type: "snapshot" });
        return { ...result, message: parsed.token === null ? "Madgrades token removed from this device." : "Madgrades token saved on this device." };
      }
      if (parsed.type === "purge") {
        sync?.abort();
        cancelPlanning();
        signIn?.close();
        for (const c of sourceReads.values()) c.abort();
        for (const c of evaluations.values()) c.abort();
      }
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error("Local workspace request timed out."));
        }, 30000);
        calls.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "command", id, command: parsed });
      });
    }
    // owner: T06. Consent gate: every channel that can reach the network asks here first.
    // UW reads need the setup record; `evaluate` (Jev) needs Jev's record. The decision is
    // `consentGateAllows` (packages/core/src/egress.ts, unit-tested). A false return refuses.
    // Main's copy of the records comes from the worker's own replies: every command response
    // carries `snapshot.consents`. Worker messages arrive in order and this listener runs in
    // the same dispatch as the reply's resolver, so a grant is visible before the renderer
    // hears of it and a read posted after a revoke is refused. Until the first reply, the
    // gate asks the worker once. Sends nothing.
    type ConsentGatedChannel = Parameters<typeof consentGateAllows>[0];
    let consentRecords: ConsentRecord[] | undefined;
    worker.on("message", (message: any) => {
      if (message?.kind !== "response") return;
      const records = message.result?.snapshot?.consents;
      if (!Array.isArray(records)) return;
      const hadUw = consentGateAllows("source-fetch", consentRecords),
        hadJev = consentGateAllows("evaluate", consentRecords);
      consentRecords = records.flatMap((record: unknown) => {
        const parsed = consentRecordSchema.safeParse(record);
        return parsed.success ? [parsed.data] : [];
      });
      // A withdrawn agreement also stops reads already in flight.
      if (hadUw && !consentGateAllows("source-fetch", consentRecords)) {
        void disconnectGraph().catch(() => {}); // owner: T30: withdrawing uw disconnects Outlook
        sync?.abort();
        cancelPlanning();
        signIn?.close();
        for (const c of sourceReads.values()) c.abort();
      }
      if (hadJev && !consentGateAllows("evaluate", consentRecords))
        for (const c of evaluations.values()) c.abort();
    });
    async function consentGate(channel: ConsentGatedChannel): Promise<boolean> {
      if (!consentRecords)
        try {
          await execute({ type: "snapshot" });
        } catch {
          return false;
        }
      return consentGateAllows(channel, consentRecords);
    }
    const consentRefused =
      "Finish the setup step before My Magic UW connects to UW.";
    // end owner: T06
    // owner: T30. Outlook: the worker learns only the granted scopes; tokens never cross.
    async function postGraphScopes() {
      const current = await outlook.state();
      worker.postMessage({
        kind: "graph-scopes",
        scopes: outlook.configured() && current.state === "connected" ? current.scopes : [],
      });
    }
    function workerQuery(request: unknown): Promise<any> {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error("Local workspace request timed out."));
        }, 30000);
        calls.set(id, { resolve: resolve as (value: CommandResult) => void, reject, timer });
        worker.postMessage({ kind: "query", id, query: request });
      });
    }
    async function outlookStatus(): Promise<OutlookStatus> {
      let counts = { messages: 0, events: 0 };
      try {
        const summary = await workerQuery({ view: "summary" });
        const byCourse = (id: string) =>
          (summary.courses as { courseId: string; resources: number }[])
            .filter((c) => c.courseId === id)
            .reduce((n, c) => n + c.resources, 0);
        counts = { messages: byCourse(OUTLOOK_MAIL_COURSE_ID), events: byCourse(OUTLOOK_CALENDAR_COURSE_ID) };
      } catch {
        /* counts stay zero */
      }
      return outlook.status(counts, Boolean(await vault.get("calendar:outlook")));
    }
    async function disconnectGraph() {
      await outlook.disconnect();
      await vault.deletePrefix("graph:");
      await postGraphScopes();
      await execute({ type: "outlook-disconnect-graph" });
    }
    /** Launch and after a confirmed UW sign-in: silent; Microsoft's window at most once on its own. */
    async function outlookSilent(allowVisible: boolean) {
      if (!outlook.configured()) return;
      try {
        await outlook.connectSilently({ allowVisible });
      } catch {
        /* the status reports it; nothing retries in a loop */
      }
      await postGraphScopes();
    }
    ipcMain.handle("magic:outlook-connect", async (event) => {
      validateSender(event);
      if (!(await consentGate("source-fetch"))) throw new Error(consentRefused);
      await outlook.connect().catch(() => undefined);
      await postGraphScopes();
      return outlookStatus();
    });
    ipcMain.handle("magic:outlook-status", async (event) => {
      validateSender(event);
      return outlookStatus();
    });
    ipcMain.handle("magic:outlook-disconnect-graph", async (event) => {
      validateSender(event);
      await disconnectGraph();
      return outlookStatus();
    });
    ipcMain.handle("magic:outlook-mail-body", async (event, id: unknown) => {
      validateSender(event);
      if (typeof id !== "string" || id.length > 256) throw new Error("Invalid message.");
      if (!(await consentGate("source-fetch"))) throw new Error(consentRefused);
      const answer = await workerQuery({ view: "resource", id });
      const messageId = answer?.resource?.mail?.messageId;
      if (typeof messageId !== "string") throw new Error("This isn't an Outlook message.");
      return outlook.mailBody(messageId);
    });
    ipcMain.handle("magic:calendar-propose-event", async (event, input: unknown) => {
      validateSender(event);
      return outlook.proposeEvent(input);
    });
    ipcMain.handle("magic:calendar-create-event", async (event, proposalId: unknown) => {
      validateSender(event);
      if (!(await consentGate("source-fetch"))) throw new Error(consentRefused);
      return outlook.createEvent(proposalId);
    });
    // end owner: T30
    // owner: T40. Onboarding detection (apps/desktop/src/onboarding.ts): the installed CLIs,
    // their own auth status, and the engine choice (Claude Code → Codex → a stored key → Ollama).
    // Runs only when asked; reads no credential file, sends no course data, never prompts.
    // Stored-key presence and the settings (local only, prefer Ollama, a picked engine) are not
    // wired yet: no key naming exists in the vault, and no settings record holds them.
    let onboardingRuntime: Awaited<ReturnType<typeof loadOnboarding>> | undefined;
    async function loadOnboarding() {
      const { createOnboarding } = await import("./onboarding");
      return createOnboarding({ workDir: join(data, "ai-runtime") });
    }
    async function onboarding() {
      onboardingRuntime ??= await loadOnboarding();
      const { detection, decision, checkedAt } = await onboardingRuntime.refresh();
      // Executable paths stay in main; the view gets the facts and the choice.
      return {
        checkedAt,
        clients: detection.clients.map(({ command: _command, ...c }) => c),
        storedKeys: detection.storedKeys,
        local: detection.local,
        choice:
          decision.choice.engine === "claude" || decision.choice.engine === "codex"
            ? { engine: decision.choice.engine, route: decision.choice.route }
            : decision.choice,
        reason: decision.reason,
        actions: decision.actions,
        disclosures: decision.disclosures,
      };
    }
    ipcMain.handle("magic:onboarding", async (event) => {
      validateSender(event);
      return onboarding();
    });
    // end owner: T40
    // owner: T50b. The reader stub: the in-app reader's window and its GET-only navigation.
    // Does nothing and sends nothing yet.
    async function reader(): Promise<void> {}
    // end owner: T50b
    // owner: T62. The licence stub: the $5 lifetime hosted-Jev licence check. Does nothing yet;
    // payment waits on the operator's say and accounts.
    async function licence(): Promise<void> {}
    // end owner: T62
    // owner: T80. AI clients in app-owned profiles (apps/desktop/src/clients/): detection runs
    // `--version` only and needs no consent; a terminal needs that provider's consent record.
    // The renderer names a client and a purpose; main resolves the binary and fixed arguments.
    // Sessions end when their window closes, when the provider's consent is withdrawn, and at quit.
    let clientsRuntime: import("./clients").Clients | undefined;
    const terminalHooked = new WeakSet<object>();
    async function clients() {
      if (clientsRuntime) return clientsRuntime;
      const { createClients, providerConsented } = await import("./clients");
      clientsRuntime = createClients({
        userData: data,
        alive: (owner) => !(owner as Electron.WebContents).isDestroyed(),
        async consented(id) {
          if (!consentRecords)
            try {
              await execute({ type: "snapshot" });
            } catch {
              return false;
            }
          return providerConsented(consentRecords, id);
        },
        events: {
          data: (owner, sessionId, chunk) => {
            const wc = owner as Electron.WebContents;
            if (!wc.isDestroyed()) wc.send("magic:terminal-data", sessionId, chunk);
          },
          exit: (owner, sessionId, code) => {
            const wc = owner as Electron.WebContents;
            if (!wc.isDestroyed()) wc.send("magic:terminal-exit", sessionId, code);
          },
        },
      });
      return clientsRuntime;
    }
    worker.on("message", async (message: any) => {
      if (message?.kind !== "response" || !clientsRuntime) return;
      const { providerConsented } = await import("./clients");
      for (const s of clientsRuntime.terminal.sessions())
        if (!providerConsented(consentRecords, s.client)) clientsRuntime.terminal.closeAll({ client: s.client });
    });
    app.on("before-quit", () => clientsRuntime?.terminal.closeAll());
    ipcMain.handle("magic:clients-detect", async (event) => {
      validateSender(event);
      return (await clients()).detect();
    });
    ipcMain.handle("magic:clients-prepare", async (event, id: unknown) => {
      validateSender(event);
      return (await clients()).prepare(id);
    });
    ipcMain.handle("magic:clients-auth", async (event, id: unknown) => {
      validateSender(event);
      return (await clients()).authStatus(id);
    });
    ipcMain.handle("magic:clients-choose", async (event, id: unknown) => {
      validateSender(event);
      await (await clients()).choose(id);
    });
    ipcMain.handle("magic:terminal-open", async (event, ...args: unknown[]) => {
      validateSender(event);
      const runtime = await clients();
      const owner = event.sender;
      const w = BrowserWindow.fromWebContents(owner);
      if (w && !terminalHooked.has(w)) {
        terminalHooked.add(w);
        w.on("close", () => runtime.terminal.closeAll({ owner }));
      }
      if (!terminalHooked.has(owner)) {
        terminalHooked.add(owner);
        owner.once("destroyed", () => runtime.terminal.closeAll({ owner }));
      }
      return runtime.terminal.open(owner, ...args);
    });
    ipcMain.handle("magic:terminal-write", async (event, sessionId: unknown, input: unknown) => {
      validateSender(event);
      (await clients()).terminal.write(event.sender, sessionId, input);
    });
    ipcMain.handle("magic:terminal-resize", async (event, sessionId: unknown, cols: unknown, rows: unknown) => {
      validateSender(event);
      (await clients()).terminal.resize(event.sender, sessionId, cols, rows);
    });
    ipcMain.handle("magic:terminal-close", async (event, sessionId: unknown) => {
      validateSender(event);
      await (await clients()).terminal.close(event.sender, sessionId);
    });
    // end owner: T80
    ipcMain.handle("magic:execute", async (event, command) => {
      validateSender(event);
      const purging = command?.type === "purge";
      if (purging) planningClears++;
      try {
        const result = await execute(command);
        if (purging) {
          for (const c of sourceReads.values()) c.abort();
          await vault.clear();
          await outlook.disconnect().catch(() => {}); // owner: T30: tokens and state
          void postGraphScopes(); // owner: T30
          clientsRuntime?.terminal.closeAll(); // owner: T80
          await Promise.all([
            rm(join(data, "clients"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), // owner: T80
            rm(join(data, "documents"), { recursive: true, force: true }),
            rm(join(data, "mcp"), { recursive: true, force: true }),
            studentSession.clearStorageData(),
            gitlabSession.clearStorageData(),
            resetPlanningScope(),
          ]);
        }
        return result;
      } finally {
        if (purging) planningClears--;
      }
    });
    ipcMain.handle("magic:mcp-export", async (event, id) => {
      validateSender(event);
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
        throw new Error("Invalid connection.");
      const snapshot = (await execute({ type: "snapshot" })).snapshot;
      const grant = snapshot.mcpGrants?.find((g) => g.id === id && g.enabled);
      if (!grant) throw new Error("Enable this connection before exporting.");
      const token = randomBytes(32).toString("hex"),
        directory = join(data, "mcp");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const connection = join(directory, `${id}.json`);
      await writeFile(
        connection,
        JSON.stringify({
          databasePath: join(data, "workspace.sqlite"),
          clientId: id,
          token,
        }),
        { mode: 0o600 },
      );
      await execute({
        type: "mcp-grant",
        value: {
          ...grant,
          tokenHash: createHash("sha256").update(token).digest("hex"),
        },
      });
      return JSON.stringify(
        {
          mcpServers: {
            magicCanvas: {
              command: process.execPath,
              args: [join(root, "mcp-server.cjs"), "--connection", connection],
              env: { ELECTRON_RUN_AS_NODE: "1" },
            },
          },
        },
        null,
        2,
      );
    });
    async function localOperation(
      operation: "status" | "ask",
      request?: unknown,
    ): Promise<unknown> {
      await ready;
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            localCalls.delete(id);
            worker.postMessage({ kind: "local-cancel", id });
            reject(
              new Error(
                "The request timed out. Your saved coursework is still available.",
              ),
            );
          },
          operation === "ask" ? 180000 : 75000,
        );
        localCalls.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "local", id, operation, request });
      });
    }
    ipcMain.handle("magic:local-status", (event) => {
      validateSender(event);
      return localOperation("status");
    });
    ipcMain.handle("magic:local-ask", (event, request) => {
      validateSender(event);
      return localOperation("ask", localQuestionSchema.parse(request));
    });
    ipcMain.handle("magic:local-cancel", (event) => {
      validateSender(event);
      worker.postMessage({ kind: "local-cancel" });
    });
    ipcMain.handle("magic:open", async (event, url) => {
      validateSender(event);
      if (headless)
        throw new Error("External windows are disabled in headless mode.");
      await shell.openExternal(safeExternal(url));
    });
    // owner: T15. Scoped queries (O1): reads only; the worker answers on the response channel.
    ipcMain.handle("magic:query", async (event, request) => {
      validateSender(event);
      const parsed = queryRequestSchema.parse(request);
      await ready;
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error("Local workspace request timed out."));
        }, 30000);
        calls.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "query", id, query: parsed });
      });
    });
    // end owner: T15
    // owner: T05b. Link cards (D40): the default browser, https only.
    ipcMain.handle("magic:open-link", async (event, url) => {
      validateSender(event);
      if (headless)
        throw new Error("External windows are disabled in headless mode.");
      await shell.openExternal(safeLinkCard(url));
    });
    // end owner: T05b
    ipcMain.handle("magic:import", async (event) => {
      validateSender(event);
      if (headless)
        throw new Error("File dialogs are disabled in headless mode.");
      const choice = await dialog.showOpenDialog(window!, {
        title: "Import a local capture",
        properties: ["openFile"],
        filters: [{ name: "JSON capture", extensions: ["json"] }],
      });
      if (choice.canceled) return null;
      if ((await stat(choice.filePaths[0])).size > 8 * 1024 * 1024)
        throw new Error("Capture exceeds the 8 MB import limit.");
      let imported: unknown;
      try {
        imported = JSON.parse(await readFile(choice.filePaths[0], "utf8"));
      } catch {
        throw new Error("File is not a valid JSON capture.");
      }
      const planning = planningCaptureSchema.safeParse(imported);
      if (planning.success) return execute({ type: "planning-import", batch: planning.data });
      const course = captureEnvelopeSchema.safeParse(imported);
      if (course.success) return execute({ type: "import", batch: course.data });
      throw new Error("File is not a valid coursework or normalized planning capture.");
    });
    // owner: T05c. magic:signin: one app-owned, visible sign-in window at a time (spec A1).
    // A second call while it is open waits for that window. Canvas and GitLab confirm with
    // their profile read; My UW and Enroll confirm with the existing session.json or
    // student-info read and then close themselves. No script is injected, no field is read
    // or filled, and no cookie is written.
    type SignInService = "canvas" | "gitlab" | "enroll" | "myuw";
    const isSignInService = (value: unknown): value is SignInService =>
      value === "canvas" || value === "gitlab" || value === "enroll" || value === "myuw";
    const sessionSettingsPath = join(data, "session-settings.json");
    let sessionSettings = await readSessionSettings(sessionSettingsPath);
    async function rememberSignIn() {
      if (sessionSettings.signedInBefore) return;
      sessionSettings = { ...sessionSettings, signedInBefore: true };
      await writeSessionSettings(sessionSettingsPath, sessionSettings).catch(() => {});
    }
    const signInFlight = singleFlight<boolean>();
    /** Resolves when the window closes: true when a sign-in was confirmed. */
    function openSignIn(requestedService?: SignInService): Promise<boolean> {
      if (headless)
        return Promise.reject(
          new Error(
            "Sign-in requires your interaction; headless mode will not open a window.",
          ),
        );
      if (signInFlight.pending) signIn?.focus();
      return signInFlight.run(() => signInWindow(requestedService));
    }
    async function signInWindow(requestedService?: SignInService): Promise<boolean> {
      const gitlab = requestedService === "gitlab",
        planning = requestedService === "enroll" || requestedService === "myuw"
          ? requestedService : undefined,
        loginSession = gitlab ? gitlabSession : studentSession,
        loginOrigin = gitlab
          ? "https://git.doit.wisc.edu"
          : requestedService === "enroll" ? "https://enroll.wisc.edu"
            : requestedService === "myuw" ? "https://my.wisc.edu"
              : "https://canvas.wisc.edu";
      // The sign-in window is never opened behind a hidden workspace.
      if (window && !window.isVisible()) window.show();
      signIn = new BrowserWindow({
        width: 760,
        height: 720,
        parent: window!,
        title: `UW sign in · ${new URL(loginOrigin).hostname}`,
        autoHideMenuBar: true,
        webPreferences: {
          partition: gitlab ? "persist:gitlab" : "persist:uw",
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      const login = signIn;
      login.webContents.on("page-title-updated", (event) =>
        event.preventDefault(),
      );
      const guard = (event: Electron.Event, url: string) => {
        if (!allowedLogin(url)) {
          trialLog({ event: "signin.blocked", to: trialPath(url) });
          event.preventDefault();
        }
      };
      login.webContents.on("will-navigate", guard);
      login.webContents.on("will-redirect", guard);
      login.webContents.on("did-navigate", (_event, url) => {
        trialLog({ event: "signin.navigate", to: trialPath(url), allowed: allowedLogin(url) });
        if (allowedLogin(url))
          login.setTitle(`UW sign in · ${new URL(url).hostname}`);
      });
      login.webContents.on("did-fail-load", (_event, code, description, url, mainFrame) =>
        trialLog({ event: "signin.load-failed", code, description, to: trialPath(url), mainFrame }),
      );
      login.webContents.setWindowOpenHandler(({ url }) => {
        trialLog({ event: "signin.window-open", to: trialPath(url), allowed: allowedLogin(url) });
        if (allowedLogin(url)) void login.loadURL(url);
        return { action: "deny" };
      });
      let confirmed = false;
      const closed = new Promise<void>((resolve) => {
        login.once("closed", () => {
          trialLog({ event: "signin.closed", confirmed });
          if (signIn === login) signIn = null;
          resolve();
        });
      });
      let checking = false;
      // Verify only after a user-driven navigation returns to the service; never keep a session alive.
      login.webContents.on("did-finish-load", async () => {
        if (checking || login.isDestroyed()) return;
        if (new URL(login.webContents.getURL()).origin !== loginOrigin)
          return;
        checking = true;
        try {
          if (planning) {
            // The fixed planning probe; only the boolean is kept, never the identity.
            const result = await planningHttp.read(
              planningProbe(planning),
              AbortSignal.timeout(10000),
            );
            if (planningSessionConfirmed(planning, result) && !login.isDestroyed()) {
              confirmed = true;
              login.close();
            }
            return;
          }
          const response = await loginSession.fetch(
            `${loginOrigin}${gitlab ? "/api/v4/user" : "/api/v1/users/self/profile"}`,
            {
              method: "GET",
              credentials: "include",
              redirect: "manual",
              headers: { Accept: "application/json+canvas-string-ids" },
              signal: AbortSignal.timeout(10000),
            },
          );
          const contentType = response.headers.get("content-type") ?? "";
          const text = response.ok ? await response.text() : "";
          // Canvas may prefix session-authenticated JSON with `while(1);` (JSON-hijacking guard).
          const body = text.replace(/^\s*while\s*\(1\);/, "");
          trialLog({
            event: "signin.profile",
            status: response.status,
            contentType: contentType.split(";")[0],
            bodyShape: /^\s*while\s*\(1\);/.test(text) ? "while1-json" : /^\s*[{[]/.test(text) ? "json" : /^\s*</.test(text) ? "html" : text ? "other" : "empty",
          });
          // A successful JSON profile response establishes sign-in; the connector validates its fields on sync.
          if (response.ok && contentType.includes("application/json") && !login.isDestroyed()) {
            let profile: { id?: unknown } = {};
            try {
              profile = JSON.parse(body) as { id?: unknown };
            } catch {
              trialLog({ event: "signin.profile-unparsed" });
            }
            if (
              typeof profile.id === "number" ||
              (typeof profile.id === "string" && /^\d+$/.test(profile.id))
            ) {
              confirmed = true;
              if (!gitlab) {
                worker.postMessage({ kind: "reconnected" });
                await rememberSignIn();
                void outlookSilent(true); // owner: T30: UW single sign-on is live now
              }
              trialLog({ event: "signin.confirmed", service: requestedService ?? "canvas" });
              if (!login.isDestroyed()) login.close();
            }
          }
        } catch (error) {
          /* Keep the sign-in window available for the student. */
          trialLog({ event: "signin.check-failed", error: error instanceof Error ? error.name : "unknown" });
        } finally {
          checking = false;
        }
      });
      try {
        await login.loadURL(`${loginOrigin}/`);
      } catch {
        if (!login.isDestroyed()) login.close();
      }
      await closed;
      return confirmed;
    }
    ipcMain.handle(
      "magic:signin",
      async (event, requestedService?: unknown) => {
        validateSender(event);
        if (requestedService !== undefined && !isSignInService(requestedService))
          throw new Error("Unsupported sign-in source.");
        if (!(await consentGate("magic:signin"))) throw new Error(consentRefused);
        await openSignIn(requestedService);
      },
    );
    // end owner: T05c
    // owner: T05c. Keep me signed in (P1-D1): the tray, the login item and the setting.
    // Quit ends the session (session cookies do not survive a quit); Sign out reuses the
    // existing magic:signout path through the workspace's own bridge.
    let tray: Tray | null = null;
    let sessionEnding = false;
    function showWorkspace() {
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    async function trayAction(action: TrayAction) {
      if (action === "open") showWorkspace();
      else if (action === "quit") app.quit();
      else if (window)
        await window.webContents
          .executeJavaScript("window.magic.signOutUW?.()")
          .catch(() => {});
    }
    function applyKeepSignedIn() {
      // Never registers the dev Electron binary at login: only a packaged build.
      const login = loginItemSettings({
        isPackaged: app.isPackaged,
        keepSignedIn: sessionSettings.keepSignedIn,
      });
      if (login) app.setLoginItemSettings(login);
      if (!trayWanted({ keepSignedIn: sessionSettings.keepSignedIn, headless })) {
        tray?.destroy();
        tray = null;
        return;
      }
      if (tray) return;
      tray = new Tray(
        nativeImage.createFromBitmap(trayBitmap(32), {
          width: 32,
          height: 32,
          scaleFactor: 2,
        }),
      );
      tray.setToolTip("My Magic UW");
      tray.setContextMenu(
        Menu.buildFromTemplate(
          trayMenu.map(({ action, label }) => ({
            label,
            click: () => void trayAction(action),
          })),
        ),
      );
      tray.on("click", showWorkspace);
    }
    ipcMain.handle("magic:keep-signed-in", async (event, value?: unknown) => {
      validateSender(event);
      if (value !== undefined) {
        if (typeof value !== "boolean") throw new Error("Invalid setting.");
        sessionSettings = { ...sessionSettings, keepSignedIn: value };
        await writeSessionSettings(sessionSettingsPath, sessionSettings);
        applyKeepSignedIn();
      }
      return sessionSettings.keepSignedIn;
    });
    /** Reads the local cookie store only: 0 network requests. */
    async function checkSessionAtLaunch() {
      try {
        const cookies = await studentSession.cookies.get({ name: "canvas_session" });
        const { snapshot } = await execute({ type: "snapshot" });
        const canvas = snapshot.sources
          .filter((source) => source.kind === "canvas")
          .sort((a, b) => Number(b.scope === "connection") - Number(a.scope === "connection"));
        const decision = launchSession({
          cookies: cookies.map(({ name, domain }) => ({ name, domain })),
          signedInBefore: sessionSettings.signedInBefore && canvas.length > 0,
          keepSignedIn: sessionSettings.keepSignedIn,
          headless,
        });
        if (decision.state !== "sign_in_again") return;
        // "Sign in again" comes from the stored status, the same record the sign-out path
        // writes; resources: [] with complete: false keeps every stored record.
        for (const source of canvas) {
          if (source.status === "needs_sign_in") continue;
          const { id, label, kind, accountScope, courseId, scope } = source;
          await execute({
            type: "import",
            batch: {
              source: { id, label, kind, accountScope, courseId, scope },
              observedAt: new Date(
                Math.max(Date.now(), Date.parse(source.lastAttemptAt) + 1),
              ).toISOString(),
              complete: false,
              status: "needs_sign_in",
              resources: [],
            },
          });
        }
        // D33: after a previous sign-in, the UW window opens by itself.
        if (!decision.openSignIn || !(await consentGate("magic:signin"))) return;
        if (!(await openSignIn("canvas"))) return;
        const id = randomUUID();
        const timer = setTimeout(() => {
          calls.delete(id);
          worker.postMessage({ kind: "refresh-cancel" });
        }, 600_000);
        calls.set(id, { resolve: () => {}, reject: () => {}, timer });
        worker.postMessage({ kind: "refresh", id });
      } catch {
        /* The next Canvas read still reports the session through the banner. */
      }
    }
    // end owner: T05c
    ipcMain.handle("magic:outlook-calendar", async (event, value: unknown) => {
      validateSender(event);
      if (value !== null && (typeof value !== "string" || !isOutlookPublishedCalendar(value.trim())))
        throw new Error(
          "That isn't a published Outlook calendar link. In Outlook: Settings → Calendar → Shared calendars → Publish a calendar, then copy the ICS link.",
        );
      await vault.set("calendar:outlook", value === null ? "" : value.trim());
      // Disconnecting removes the meetings now, not at the next refresh.
      if (value === null) await execute({ type: "outlook-disconnect" });
      return { connected: value !== null };
    });
    ipcMain.handle("magic:outlook-calendar-status", async (event) => {
      validateSender(event);
      return { connected: Boolean(await vault.get("calendar:outlook")) };
    });
    ipcMain.handle("magic:sync", async (event) => {
      validateSender(event);
      if (!(await consentGate("magic:sync"))) throw new Error(consentRefused);
      await ready;
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          worker.postMessage({ kind: "refresh-cancel" });
          reject(
            new Error(
              "Refresh paused after ten minutes. Partial results remain available.",
            ),
          );
        }, 600_000);
        calls.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "refresh", id });
      });
    });
    ipcMain.handle("magic:planning-sync", async (event) => {
      validateSender(event);
      if (!(await consentGate("magic:planning-sync"))) throw new Error(consentRefused);
      await ready;
      if (planningClears > 0) throw new Error("Planning is unavailable while local data or sessions are being cleared.");
      if (planningCall) return planningCall.promise;
      const epoch = planningEpoch;
      await writeFile(planningScopePath, planningAccountScope, { mode: 0o600 });
      if (epoch !== planningEpoch || planningClears > 0) throw new Error("Planning refresh cancelled.");
      const concurrent = planningCall as { id: string; promise: Promise<CommandResult> } | undefined;
      if (concurrent) return concurrent.promise;
      const id = randomUUID();
      const promise = new Promise<CommandResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          worker.postMessage({ kind: "planning-cancel" });
          for (const requestId of planningReads) sourceReads.get(requestId)?.abort();
          reject(new Error("Planning refresh timed out. Saved records are still available."));
        }, 90_000);
        calls.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "planning-sync", id });
      });
      planningCall = { id, promise };
      try { return await promise; }
      finally { if (planningCall?.id === id) planningCall = undefined; }
    });
    ipcMain.handle("magic:signout", async (event) => {
      validateSender(event);
      planningClears++;
      try {
        sync?.abort();
        cancelPlanning();
        const signOutEpoch = planningEpoch;
        worker.postMessage({ kind: "refresh-cancel" });
        for (const c of sourceReads.values()) c.abort();
        signIn?.close();
        await studentSession.clearStorageData();
        await studentSession.clearCache();
        await gitlabSession.clearStorageData();
        await gitlabSession.clearCache();
        // Every saved calendar link goes, Outlook's included; its meetings are removed too.
        await clearSignOutSecrets(vault);
        await outlook.signOut().catch(() => {}); // owner: T30: the Microsoft tokens go too
        await postGraphScopes(); // owner: T30
        await execute({ type: "outlook-disconnect" });
        await resetPlanningScope();
        if (signOutEpoch !== planningEpoch) return;
        const result = await execute({ type: "snapshot" });
        for (const source of result.snapshot.sources.filter(
          (s) => s.kind === "canvas" || s.kind === "gitlab",
        )) {
          if (signOutEpoch !== planningEpoch) return;
          const { id, label, kind, accountScope, courseId, scope } = source;
          await execute({
            type: "import",
            batch: {
              source: { id, label, kind, accountScope, courseId, scope },
              observedAt: new Date(
                Math.max(Date.now(), Date.parse(source.lastAttemptAt) + 1),
              ).toISOString(),
              complete: false,
              status: "needs_sign_in",
              resources: [],
            },
          });
        }
        for (const source of result.snapshot.planning?.sources.filter(
          (source) => ["uw_enroll", "uw_myuw", "uw_dars"].includes(source.source),
        ) ?? []) {
          if (signOutEpoch !== planningEpoch) return;
          await execute({
            type: "planning-import",
            batch: {
              schemaVersion: 1, id: randomUUID(), accountScope: source.accountScope,
              source: source.source, scope: source.scope, sourceUrl: source.sourceUrl,
              observedAt: new Date(Math.max(Date.now(), Date.parse(source.observedAt) + 1)).toISOString(),
              status: "blocked", completeness: "unknown", records: [],
              diagnostics: [{ code: "needs_sign_in", message: "Signed out. Saved planning records remain on this device." }],
            },
          });
        }
      } finally {
        planningClears--;
      }
    });
    window = new BrowserWindow({
      width: 1240,
      height: 820,
      minWidth: 880,
      minHeight: 620,
      show: !headless,
      title: "My Magic UW",
      backgroundColor: "#fbfbfa",
      webPreferences: {
        preload: join(root, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    window.on("closed", () => {
      window = null;
    });
    await window.loadURL(rendererURL);
    await ready;
    powerMonitor.on("suspend", () => worker.postMessage({ kind: "suspend" }));
    powerMonitor.on("resume", () => {
      worker.postMessage({ kind: "resume" });
      postPresence();
    });
    // Presence gates signed-in background reads (refresh.ts cadence table): OS input within
    // the last 30 minutes and the screen unlocked. Reads no network; posts only on change.
    let screenLocked = powerMonitor.getSystemIdleState(1) === "locked",
      lastPresence: boolean | undefined;
    function postPresence() {
      const present =
        !screenLocked && powerMonitor.getSystemIdleTime() < 30 * 60;
      if (present === lastPresence) return;
      lastPresence = present;
      worker.postMessage({ kind: "presence", present });
    }
    powerMonitor.on("lock-screen", () => {
      screenLocked = true;
      postPresence();
    });
    powerMonitor.on("unlock-screen", () => {
      screenLocked = false;
      postPresence();
    });
    const presenceTimer = setInterval(postPresence, 60_000);
    // owner: T33. App focus: the per-course content probe runs soon (at most once a minute).
    window.on("focus", () => worker.postMessage({ kind: "focus" }));
    // end owner: T33
    postPresence();
    void onboarding();
    void reader(); // owner: T50b
    void licence(); // owner: T62
    // owner: T05c. Launch: the window-close decision, macOS dock reopen, the tray and login
    // item, and the 0-request session check ("Sign in again" within 2 s).
    window.on("close", (event) => {
      const action = closeAction({
        keepSignedIn: sessionSettings.keepSignedIn,
        quitting: quitting || sessionEnding,
      });
      if (action === "hide") {
        event.preventDefault();
        window?.hide();
      }
    });
    window.on("query-session-end", () => {
      sessionEnding = true;
    });
    powerMonitor.on("shutdown", () => {
      sessionEnding = true;
    });
    app.on("activate", showWorkspace);
    applyKeepSignedIn();
    void checkSessionAtLaunch();
    void postGraphScopes().then(() => outlookSilent(false)); // owner: T30: launch: silent only
    // end owner: T05c
    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      clearInterval(presenceTimer);
      sync?.abort();
      cancelPlanning();
      for (const c of sourceReads.values()) c.abort();
      for (const c of evaluations.values()) c.abort();
      worker.postMessage({ kind: "shutdown" });
      setTimeout(() => {
        worker.kill();
        app.exit(Number(process.exitCode ?? 0));
      }, 1000).unref();
    });
    if (headless && process.env.MAGIC_SMOKE === "1") {
      try {
        if (window.isVisible())
          throw new Error("Headless window became visible");
        const initial = await window.webContents.executeJavaScript(
          "window.magic.execute({type:'snapshot'})",
        );
        if (initial.snapshot.resources.length !== 0)
          throw new Error("Unexpected initial data");
        const imported = await window.webContents.executeJavaScript(
          "window.magic.execute({type:'fixture'})",
        );
        if (
          imported.snapshot.resources.length !== sampleFixture.resources.length ||
          !imported.snapshot.fixtureMode
        )
          throw new Error("Fixture import failed");
        const studyResource = imported.snapshot.resources.find(
          (resource: { kind: string }) => resource.kind === "assignment",
        );
        if (!studyResource) throw new Error("Missing study anchor");
        const studySessions = await window.webContents.executeJavaScript(
          `window.magic.execute(${JSON.stringify({ type: "learning", request: {
            op: "study.sessions", resourceId: studyResource.id,
          } })})`,
        );
        if (studySessions.learning?.status !== "ok" ||
            studySessions.learning.data?.sessions?.length !== 0)
          throw new Error("Canonical study session bridge failed");
        const unpreparedStudy = await window.webContents.executeJavaScript(
          `window.magic.execute(${JSON.stringify({ type: "learning", request: {
            op: "study.plan", resourceId: studyResource.id,
            operationId: "smoke-unprepared", minutes: 10, difficulty: "normal",
          } })})`,
        );
        if (unpreparedStudy.learning?.status !== "unavailable")
          throw new Error("Unprepared study must remain explicitly unavailable");
        const planningStamp = new Date().toISOString();
        const planningScope = { kind: "terms", key: "synthetic-smoke" };
        const planningFixture = {
          schemaVersion: 1, id: "synthetic-planning-smoke", accountScope: "synthetic",
          source: "normalized_import", scope: planningScope,
          sourceUrl: "https://example.test/synthetic-planning", observedAt: planningStamp,
          status: "complete", completeness: "complete", diagnostics: [],
          records: [{ kind: "term", id: "1272", code: "1272", season: "fall", year: 2026,
            label: "Fall 2026", past: false,
            provenance: { sourceUrl: "https://example.test/synthetic-planning", observedAt: planningStamp, scope: planningScope },
          }],
        };
        const planningImported = await window.webContents.executeJavaScript(
          `window.magic.execute(${JSON.stringify({ type: "planning-import", batch: planningFixture })})`,
        );
        if (planningImported.snapshot.planning?.records.length !== 1 ||
            planningImported.snapshot.planning?.sources.length !== 1 ||
            !(await window.webContents.executeJavaScript("typeof window.magic.syncPlanning === 'function'")))
          throw new Error("Planning import or preload bridge failed");
        await window.webContents.executeJavaScript(
          "window.magic.execute({type:'mcp-grant',value:{id:'smoke',label:'Synthetic local client',recipient:'local',enabled:true,courses:[{accountScope:'synthetic',courseId:'sample-101'}],categories:['course_text']}})",
        );
        const exported = JSON.parse(
          await window.webContents.executeJavaScript(
            "window.magic.exportMcp('smoke')",
          ),
        );
        if (exported.mcpServers?.magicCanvas?.env?.ELECTRON_RUN_AS_NODE !== "1")
          throw new Error("MCP export failed");
        const accessFile = join(data, "mcp", "smoke.json");
        if ((await stat(accessFile)).mode & 0o077)
          throw new Error("MCP credential permissions are too broad");
        const body = await window.webContents.executeJavaScript(
          "document.body.innerText",
        );
        if (!body.includes("My Magic UW"))
          throw new Error("Renderer did not load");
        // owner: T80. An app-owned client profile exists before the purge (prepare writes
        // only app files; a missing client still gets its folder).
        await window.webContents.executeJavaScript("window.magic.clients.prepare('claude')");
        const clientsDir = join(data, "clients");
        if (!(await stat(clientsDir).catch(() => null)))
          throw new Error("Client profile was not created");
        // end owner: T80
        const cleared = await window.webContents.executeJavaScript(
          "window.magic.execute({type:'purge',confirmation:'DELETE LOCAL DATA'})",
        );
        if (
          cleared.snapshot.resources.length ||
          cleared.snapshot.mcpGrants.length ||
          cleared.snapshot.planning?.records.length ||
          cleared.snapshot.planning?.sources.length ||
          (await stat(accessFile).catch(() => null)) ||
          (await stat(clientsDir).catch(() => null)) // owner: T80
        )
          throw new Error("Local purge left data or access credentials");
        console.log(
          "PASS hidden desktop: renderer → preload → worker → SQLite; synthetic planning import, MCP export and local purge",
        );
      } catch (error) {
        console.error(
          "FAIL hidden desktop integration:",
          error instanceof Error ? error.message : "unknown",
        );
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    }
  })
  .catch(() => {
    console.error(
      "My Magic UW could not start. Check the local runtime and gateway configuration.",
    );
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());

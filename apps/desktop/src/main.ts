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
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
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
import { createSecretVault } from "./secrets";
import sampleFixture from "../../../fixtures/course.json";
import {
  commandSchema,
  captureBatchSchema,
  captureEnvelopeSchema,
  planningCaptureSchema,
  localQuestionSchema,
  type CommandResult,
} from "@magic/contracts";
const headless = process.env.MAGIC_HEADLESS === "1";
if (headless) {
  app.commandLine.appendSwitch("headless");
  void app.dock?.hide();
}
if (process.env.MAGIC_USER_DATA)
  app.setPath("userData", process.env.MAGIC_USER_DATA);
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
function allowedLogin(input: string) {
  try {
    const u = new URL(input);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.hostname === "wisc.edu" ||
        u.hostname.endsWith(".wisc.edu") ||
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
    const sourceReads = new Map<string, AbortController>();
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
      serviceName: "Magic Canvas local workspace",
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
      if (message.kind === "planning-public-read") {
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
      if (message.kind === "planning-refresh") {
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
        const controller = new AbortController();
        sourceReads.set(message.id, controller);
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
          } else throw new Error();
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]);
          const response = await (
            service === "canvas" ? studentSession : gitlabSession
          ).fetch(target, {
            method: "GET",
            credentials: "include",
            redirect: "manual",
            headers: { Accept: "application/json" },
            signal,
          });
          const body = await readBounded(response, 8 * 1024 * 1024, signal);
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
        const controller = new AbortController();
        evaluations.set(message.id, controller);
        try {
          if (!gateway) throw new Error("Gateway unavailable");
          const result = await gateway.evaluate(
            message.payload,
            controller.signal,
          );
          worker.postMessage({ kind: "evaluation", id: message.id, result });
        } catch {
          worker.postMessage({
            kind: "evaluation",
            id: message.id,
            error: true,
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
    ipcMain.handle("magic:execute", async (event, command) => {
      validateSender(event);
      const purging = command?.type === "purge";
      if (purging) planningClears++;
      try {
        const result = await execute(command);
        if (purging) {
          for (const c of sourceReads.values()) c.abort();
          await vault.clear();
          await Promise.all([
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
                "Local AI timed out. Your saved coursework is still available.",
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
    ipcMain.handle(
      "magic:signin",
      async (event, requestedService?: unknown) => {
        validateSender(event);
        if (
          requestedService !== undefined &&
          requestedService !== "canvas" &&
          requestedService !== "gitlab" &&
          requestedService !== "enroll" &&
          requestedService !== "myuw"
        )
          throw new Error("Unsupported sign-in source.");
        const gitlab = requestedService === "gitlab",
          planning = requestedService === "enroll" || requestedService === "myuw",
          loginSession = gitlab ? gitlabSession : studentSession,
          loginOrigin = gitlab
            ? "https://git.doit.wisc.edu"
            : requestedService === "enroll" ? "https://enroll.wisc.edu"
              : requestedService === "myuw" ? "https://my.wisc.edu"
                : "https://canvas.wisc.edu";
        if (headless)
          throw new Error(
            "Sign-in requires your interaction; headless mode will not open a window.",
          );
        if (signIn) {
          signIn.focus();
          return;
        }
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
          if (!allowedLogin(url)) event.preventDefault();
        };
        login.webContents.on("will-navigate", guard);
        login.webContents.on("will-redirect", guard);
        login.webContents.on("did-navigate", (_event, url) => {
          if (allowedLogin(url))
            login.setTitle(`UW sign in · ${new URL(url).hostname}`);
        });
        login.webContents.setWindowOpenHandler(({ url }) => {
          if (allowedLogin(url)) void login.loadURL(url);
          return { action: "deny" };
        });
        const closed = new Promise<void>((resolve) => {
          login.once("closed", () => {
            signIn = null;
            resolve();
          });
        });
        let checking = false;
        // Verify only after a user-driven navigation returns to Canvas; never keep a session alive.
        login.webContents.on("did-finish-load", async () => {
          // Unknown MyUW/enroll JSON cannot establish identity. The student closes this window when done.
          if (planning) return;
          if (checking || login.isDestroyed()) return;
          if (new URL(login.webContents.getURL()).origin !== loginOrigin)
            return;
          checking = true;
          try {
            const response = await loginSession.fetch(
              `${loginOrigin}${gitlab ? "/api/v4/user" : "/api/v1/users/self/profile"}`,
              {
                method: "GET",
                credentials: "include",
                redirect: "manual",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(10000),
              },
            );
            // A successful JSON profile response establishes sign-in; the connector validates its fields on sync.
            if (
              response.ok &&
              response.headers
                .get("content-type")
                ?.includes("application/json") &&
              !login.isDestroyed()
            ) {
              const profile = (await response.json()) as { id?: unknown };
              if (
                typeof profile.id === "number" ||
                (typeof profile.id === "string" && /^\d+$/.test(profile.id))
              ) {
                worker.postMessage({ kind: "reconnected" });
                login.close();
              }
            }
            await response.body?.cancel();
          } catch {
            /* Keep the sign-in window available for the student. */
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
      },
    );
    ipcMain.handle("magic:outlook-calendar", async (event, value: unknown) => {
      validateSender(event);
      if (value !== null && (typeof value !== "string" || !isOutlookPublishedCalendar(value.trim())))
        throw new Error(
          "That isn't a published Outlook calendar link. In Outlook: Settings → Calendar → Shared calendars → Publish a calendar, then copy the ICS link.",
        );
      await vault.set("calendar:outlook", value === null ? "" : value.trim());
      return { connected: value !== null };
    });
    ipcMain.handle("magic:outlook-calendar-status", async (event) => {
      validateSender(event);
      return { connected: Boolean(await vault.get("calendar:outlook")) };
    });
    ipcMain.handle("magic:sync", async (event) => {
      validateSender(event);
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
        await vault.deletePrefix("calendar:");
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
      title: "Magic Canvas",
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
    powerMonitor.on("resume", () => worker.postMessage({ kind: "resume" }));
    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
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
        if (!body.includes("Magic Canvas"))
          throw new Error("Renderer did not load");
        const cleared = await window.webContents.executeJavaScript(
          "window.magic.execute({type:'purge',confirmation:'DELETE LOCAL DATA'})",
        );
        if (
          cleared.snapshot.resources.length ||
          cleared.snapshot.mcpGrants.length ||
          cleared.snapshot.planning?.records.length ||
          cleared.snapshot.planning?.sources.length ||
          (await stat(accessFile).catch(() => null))
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
      "Magic Canvas could not start. Check the local runtime and gateway configuration.",
    );
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());

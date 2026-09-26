import {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  shell,
  utilityProcess,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { gatewayClient } from "@magic/ai";
import { canvasConnector } from "@magic/connectors";
import {
  commandSchema,
  captureBatchSchema,
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
    studentSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    studentSession.setPermissionCheckHandler(() => false);
    studentSession.on("will-download", (event) => event.preventDefault());
    const worker = utilityProcess.fork(join(root, "worker.cjs"), [], {
      env: { ...process.env, MAGIC_DB_PATH: join(data, "workspace.sqlite") },
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
    worker.on("message", async (message: any) => {
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
    ipcMain.handle("magic:execute", (event, command) => {
      validateSender(event);
      return execute(command);
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
        title: "Import a local course capture",
        properties: ["openFile"],
        filters: [{ name: "JSON capture", extensions: ["json"] }],
      });
      if (choice.canceled) return null;
      if ((await stat(choice.filePaths[0])).size > 8 * 1024 * 1024)
        throw new Error("Capture exceeds the 8 MB import limit.");
      let batch;
      try {
        batch = captureBatchSchema.parse(
          JSON.parse(await readFile(choice.filePaths[0], "utf8")),
        );
      } catch {
        throw new Error("File is not a valid course capture.");
      }
      return execute({ type: "import", batch });
    });
    ipcMain.handle("magic:signin", async (event) => {
      validateSender(event);
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
        title: "UW sign in · canvas.wisc.edu",
        autoHideMenuBar: true,
        webPreferences: {
          partition: "persist:uw",
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
        if (checking || login.isDestroyed()) return;
        if (
          new URL(login.webContents.getURL()).origin !==
          "https://canvas.wisc.edu"
        )
          return;
        checking = true;
        try {
          const response = await studentSession.fetch(
            "https://canvas.wisc.edu/api/v1/users/self/profile",
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
          )
            login.close();
          await response.body?.cancel();
        } catch {
          /* Keep the sign-in window available for the student. */
        } finally {
          checking = false;
        }
      });
      try {
        await login.loadURL("https://canvas.wisc.edu/");
      } catch {
        if (!login.isDestroyed()) login.close();
      }
      await closed;
    });
    ipcMain.handle("magic:sync", async (event) => {
      validateSender(event);
      if (sync) throw new Error("Canvas refresh is already running.");
      const controller = new AbortController();
      sync = controller;
      try {
        const connector = canvasConnector({
          fetch: (url, init) => studentSession.fetch(url, init),
        });
        for await (const batch of connector.pull(controller.signal)) {
          controller.signal.throwIfAborted();
          await execute({ type: "import", batch });
        }
        return {
          ...(await execute({ type: "snapshot" })),
          message:
            "Canvas refresh finished. Check source status for any incomplete reads.",
        };
      } finally {
        if (sync === controller) sync = undefined;
      }
    });
    ipcMain.handle("magic:signout", async (event) => {
      validateSender(event);
      sync?.abort();
      signIn?.close();
      await studentSession.clearStorageData();
      await studentSession.clearCache();
      const result = await execute({ type: "snapshot" });
      for (const source of result.snapshot.sources.filter(
        (s) => s.kind === "canvas",
      )) {
        const { id, label, kind, accountScope, courseId, scope } = source;
        await execute({
          type: "import",
          batch: {
            source: { id, label, kind, accountScope, courseId, scope },
            observedAt: new Date().toISOString(),
            complete: false,
            status: "needs_sign_in",
            resources: [],
          },
        });
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
    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      sync?.abort();
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
          imported.snapshot.resources.length !== 2 ||
          !imported.snapshot.fixtureMode
        )
          throw new Error("Fixture import failed");
        const body = await window.webContents.executeJavaScript(
          "document.body.innerText",
        );
        if (!body.includes("Magic Canvas"))
          throw new Error("Renderer did not load");
        console.log(
          "PASS hidden desktop: isolated renderer → preload → utility process → SQLite",
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

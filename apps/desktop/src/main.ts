import { installDesktopVoice } from './voice/desktop-host';
import { createInteractiveDispatch, createVoiceTrialDispatch, INTERACTIVE_ACTIONS } from './voice/intent-dispatch';
import type { VoiceContext, VoiceRequestContext } from './voice/types';
// owner: voice-plan
import { createVoicePlanHost } from './voice/plan-protocol';
import { createConnectedVoiceDispatch } from './voice/connected-dispatch';
import { createRunExecutor, gatedJudge, voiceActionCapability } from './voice/observed-executor';
import { createJevActionJudge, NativeObservedActions, ObservedActionController, type ActionJudge } from './voice/observed-actions';
import { DefaultBrowserTransport } from './voice/default-browser';
import { embeddedJevKey } from './embedded-jev';
import type { AgentReadiness } from './voice/agent-warmup';
import { access as accessFile, constants as fsConstants } from 'node:fs/promises';
// end owner: voice-plan
import { intentCommandSchema, type Snapshot } from '@magic/contracts';
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
  net,
  systemPreferences, // owner: voice-plan
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { readFile, writeFile, mkdir, stat, rm, appendFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
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
} from "../../../packages/connectors/src/network";
import { checkedSpaceProbeUrl } from "../../../packages/connectors/src/space-hosts"; // owner: T05b
// owner: acquisition
import {
  canvasFileDownloadUrl,
  causeHeaders,
  fetchCanvasFile,
} from "../../../packages/connectors/src/canvas-file-download";
import { sessionHopFetch, sessionSourceResult } from "../../../packages/connectors/src/session-fetch";
import { MaterialReadError } from "../../../packages/connectors/src/network";
// end owner: acquisition
import { clearSignOutSecrets, createSecretVault } from "./secrets";
import { createAccount } from "./account";
import { purgeHostData } from "./purge-host"; // owner: platform-fix
// owner: doc-window. A synced note's Word online or Google Doc in a signed-in window on persist:uw.
import { createDocWindows } from "./doc-window";
import { handleOpenDocument } from "./doc-window-policy";
// end owner: doc-window
import { createGoogleNotesAuth } from "./notes-google"; // owner: notes
// owner: T30. Outlook through the app's own Microsoft sign-in (Graph); the token stays in main.
import { createOutlook, readOutlookConfig } from "./outlook";
import { restrictToCurrentUser } from "./mcp-connection-acl";
import { electronAuthWindow } from "./outlook-window";
import { checkedGraphUrl } from "../../../packages/connectors/src/graph";
import { OUTLOOK_MAIL_COURSE_ID, OUTLOOK_CALENDAR_COURSE_ID, type OutlookStatus } from "@magic/contracts";
// end owner: T30
import { MadgradesHttp, madgradesRequestSchema } from "../../../packages/connectors/src/madgrades";
import sampleFixture from "../../../fixtures/sample-courses.json";
// owner: T05c
import { Tray, Menu, nativeImage } from "electron";
import { clearUwLoginCookies } from "./sign-in-cookies";
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
import { bringSignInForward } from "./sign-in-foreground"; // owner: onboarding-recovery
// end owner: T05c
// owner: T05e. Remember my sign-in (plan D39).
import {
  PRESENT_IDLE_SECONDS,
  REMEMBERED_SIGNIN_FILE,
  autoSignInWanted,
  emptyAutoSignInRecord,
  nextAutoSignInRecord,
  studentAtKeyboard,
  type AutoSignInEvent,
  createAutoSignIn,
  createRememberedSignInStore,
  isNetIdLoginPage,
  parseCapture,
  rememberAvailability,
  rememberSignInBuildEnabled,
  type SignInCapture,
  type SignInPageState,
} from "./remember-signin";
import {
  canvasProfilePath,
  canvasProfileSignedOut,
} from "../../../packages/connectors/src/canvas-http";
import type { RememberSignInStatus } from "@magic/contracts";
// end owner: T05e
import { CONSENT_DISCLOSURE_VERSION, consentGateAllows } from "../../../packages/core/src/egress"; // owner: T06
import { logLine, redactForLog } from "../../../packages/core/src/privacy/log"; // owner: privacy
import { consentRecordSchema, type ConsentRecord } from "@magic/contracts"; // owner: T06
import { launchWorkSet, materializeCopy, selectWorkRetry } from "../../../packages/core/src/work-set";
import { startEmbeddedJev } from "./embedded-jev"; // owner: embedded-jev
import { createTaskWindows, helperRunner, taskContextFrom } from "./task-windows/controller"; // owner: task-workspace
import { createCalendarImport } from "./calendar-import/controller"; // owner: calendar-import
import { sourceInvestigationOps } from "./source-investigation-ops"; // owner: source-investigator
import {
  commandSchema,
  captureBatchSchema,
  captureEnvelopeSchema,
  planningCaptureSchema,
  localQuestionSchema,
  queryRequestSchema, // owner: T15
  graphQuerySchema, // owner: pipeline
  type CommandResult,
} from "@magic/contracts";
const headless = process.env.MAGIC_HEADLESS === "1";
// A generation command (packs and guides, study prep, the learning ask, notes fill) waits on the
// student's AI: measured live with Claude Code, 25-84 s per study-prep kind and 30 s for a briefing.
// The runner bounds each call itself (180 s, and one stronger-model retry), so main doesn't cut a
// run short; every other command keeps the 30 s workspace timeout.
const GENERATION_COMMANDS = new Set(["pack", "learning", "notes"]);
const GENERATION_TIMEOUT_MS = 2 * 180_000 + 30_000;
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
const appIconPath = join(root, "app-icon.png");
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
  // owner: privacy: every line is redacted (URL → host + path class, no query, no identifiers).
  void appendFile(file, logLine({ at: new Date().toISOString(), ...event })).catch(() => {});
}
/** Trial-log text from a sign-in page: no emails, long numbers, or URLs; short. */
function trialText(input: unknown): string {
  return String(input ?? "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\d{5,}/g, "[n]")
    .slice(0, 120);
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
    if (!headless) app.dock?.setIcon(appIconPath);
    const data = app.getPath("userData");
    await mkdir(data, { recursive: true, mode: 0o700 });
    const studentSession = session.fromPartition("persist:uw");
    // owner: acquisition. A read in an app-owned session that sees redirects (session-fetch.ts):
    // Electron's session.fetch with redirect "manual" rejects every redirect instead. Same
    // cookies, method, headers and Origin as session.fetch sent; no redirect is ever followed.
    const sessionFetch = (ses: Session) =>
      sessionHopFetch((url, init) =>
        net.request({
          url,
          method: init.method,
          session: ses,
          credentials: "include",
          redirect: "manual",
          headers: init.headers,
          ...(init.headers.origin ? { origin: init.headers.origin } : {}),
        }),
      );
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
      fetch: sessionFetch(studentSession), // owner: acquisition: not studentSession.fetch (session-fetch.ts)
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
    // owner: T05e. Remember my sign-in (plan D39): its own encrypted file, apart from the vault the
    // worker's messages can reach. MAGIC_REMEMBER_SIGNIN is baked in by scripts/build.ts.
    const remembered = createRememberedSignInStore(join(data, REMEMBERED_SIGNIN_FILE), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value)),
    });
    const rememberState = () =>
      rememberAvailability({
        buildEnabled: rememberSignInBuildEnabled(process.env.MAGIC_REMEMBER_SIGNIN),
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        platform: process.platform,
        linuxBackend:
          process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : undefined,
      });
    // A build with the switch off keeps no saved sign-in from an earlier build.
    if (rememberState().state === "off") await remembered.forget().catch(() => {});
    // end owner: T05e
    // owner: accounts. My Magic UW account and purchase status (docs/accounts-and-payments.md).
    const account = createAccount(
      {
        url: process.env.MAGIC_SUPABASE_URL || undefined,
        anonKey: process.env.MAGIC_SUPABASE_ANON_KEY || undefined,
        accountUrl: process.env.MAGIC_ACCOUNT_URL || undefined,
      },
      { vault },
    );
    // end owner: accounts
    // owner: notes. Google Docs sync: OAuth (PKCE, loopback) and the Drive proxy; the token stays here.
    const notesGoogle = createGoogleNotesAuth({
      clientId: process.env.MAGIC_GOOGLE_CLIENT_ID || undefined,
      clientSecret: process.env.MAGIC_GOOGLE_CLIENT_SECRET || undefined,
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
    // Every permission stays refused; the trial log records which ones a sign-in page asked for.
    studentSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      trialLog({ event: "permission.request", permission, origin: trialPath(details?.requestingUrl ?? "") });
      callback(false);
    });
    studentSession.setPermissionCheckHandler((_wc, permission, origin) => {
      trialLog({ event: "permission.check", permission, origin: trialPath(origin ?? "") });
      return false;
    });
    // owner: doc-window. Only a document window may download (the save prompt, Downloads only).
    const docWindows = createDocWindows({
      openExternal: (url) => shell.openExternal(url),
      trialLog,
    });
    studentSession.on("will-download", (event, item, contents) => {
      if (docWindows.owns(contents)) return docWindows.download(item, contents);
      event.preventDefault();
    });
    // end owner: doc-window
    // owner: embedded-jev. A configured MAGIC_GATEWAY_URL (hosted or local dev) wins; otherwise a
    // build carrying the embedded key serves Jev from loopback. The worker learns only the URL.
    const embeddedJev = process.env.MAGIC_GATEWAY_URL
      ? null
      : await startEmbeddedJev(data).catch(() => null); // unavailable: code rules still sort
    const gatewayUrl = process.env.MAGIC_GATEWAY_URL || embeddedJev?.url || "";
    // end owner: embedded-jev
    const worker = utilityProcess.fork(join(root, "worker.cjs"), [], {
      env: {
        ...process.env,
        MAGIC_GATEWAY_URL: gatewayUrl,
        MAGIC_DB_PATH: join(data, "workspace.sqlite"),
        MAGIC_PLANNING_SCOPE: planningAccountScope,
      },
      stdio: "pipe",
      serviceName: "My Magic UW local workspace",
    });
    // owner: voice-plan. One observed executor per spoken run (the observed-executor lane's controller over
    // the product-owned native helpers). Jev Choice runs here with the build's key, re-checking Jev consent
    // on every choice; the key never reaches the worker or renderer. The run's voice fence (Stop, account,
    // consent revision) is checked before every observation and action.
    const voicePlanHost = createVoicePlanHost({
      post: (message) => worker.postMessage(message),
      executor: (planId, operation) => {
        const native = new NativeObservedActions(join(root, 'observed-action-helper'));
        const browser = new DefaultBrowserTransport<{ planId: string }>(join(root, 'default-browser-helper'));
        const key = embeddedJevKey();
        const judge: ActionJudge = key ? createJevActionJudge(key) : { choose: async () => { throw new Error('Jev is unavailable.'); } };
        const controller = new ObservedActionController(native, browser, gatedJudge(judge, () => consentGate('evaluate')));
        return createRunExecutor({ observe: (signal, current) => native.run({ action: 'observe' }, signal, current), controller, context: { planId }, current: operation.current, now: () => new Date() });
      },
    });
    // end owner: voice-plan
    // owner: privacy. The install secret: 32 random bytes wrapped by safeStorage in
    // privacy-key.enc, sent to the worker over its channel (never env, argv or a log). The worker
    // derives the at-rest and pseudonym keys from it. Purge deletes the file and sends a new one.
    const privacyKeyPath = join(data, "privacy-key.enc");
    async function privacySecret(): Promise<Buffer | null> {
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        return Buffer.from(safeStorage.decryptString(await readFile(privacyKeyPath)), "base64");
      } catch (error) {
        // An unreadable wrapped key is never overwritten: sealed rows might still open later.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      const secret = randomBytes(32);
      await writeFile(privacyKeyPath, safeStorage.encryptString(secret.toString("base64")), { mode: 0o600 });
      return secret;
    }
    async function sendPrivacyKey() {
      const secret = await privacySecret().catch(() => null);
      worker.postMessage({ kind: "privacy-key", secret: secret ? secret.toString("base64") : null });
      secret?.fill(0);
    }
    void sendPrivacyKey();
    // end owner: privacy
    // owner: client-detection. Off the launch path: the login shell's PATH (macOS, Linux; 2 s at
    // most, once) plus every known install folder that exists, for main and then the worker, so
    // a client installed through nvm, Volta or pnpm is found and a script-based one finds its node.
    // Known folders are searched on every lookup anyway, so a timeout only loses shell-only folders.
    void import("@magic/runner")
      .then(({ extendPathForClients }) => extendPathForClients(process.env))
      .then((added) => {
        if (added.length) worker.postMessage({ kind: "client-path", path: process.env.PATH });
      })
      .catch(() => undefined);
    // end owner: client-detection
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
    const gateway = gatewayUrl
      ? gatewayClient(gatewayUrl, {
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
      if (voicePlanHost.handle(message)) return; // owner: voice-plan
      if (message?.kind === "voice-agent") { voiceAgent = message.agent; desktopVoice?.announceAgent(voiceAgent); return; } // owner: voice-plan
      if (message.kind === "source-abort") {
        sourceReads.get(message.id)?.abort();
        return;
      }
      // owner: stall-audit. The workspace changed: the window re-reads its snapshot (no poll).
      if (message.kind === "changed") {
        if (window && !window.isDestroyed()) window.webContents.send("magic:changed");
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
      // owner: client-health (D36, D50). Gemini's key for the worker's runner, only when the
      // worker builds a Gemini backend. Read from the safeStorage vault; never logged.
      // owner: claude-chat. The agent's app-control tools: navigate the window (fixed pages, ids the
      // worker already checked) and bring it forward, or open a stored Canvas link through the safe path.
      if (message.kind === "app-control") {
        try {
          const p = message.payload ?? {};
          if (p.op === "navigate" && window && !window.isDestroyed()) {
            const t = p.target ?? {};
            const pages = ["home", "course", "item", "prep", "study", "calendar", "data-ai"];
            if (!pages.includes(t.page)) throw new Error();
            const clean = Object.fromEntries(["page", "courseId", "accountScope", "resourceId", "action"].flatMap((k) => (typeof t[k] === "string" && t[k].length <= 300 ? [[k, t[k]]] : [])));
            window.webContents.send("magic:agent-navigate", clean);
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
            worker.postMessage({ kind: "source-response", id: message.id, result: { ok: true } });
          } else if (p.op === "open" && typeof p.url === "string" && !headless) {
            await shell.openExternal(safeExternal(p.url));
            worker.postMessage({ kind: "source-response", id: message.id, result: { ok: true } });
          } else worker.postMessage({ kind: "source-response", id: message.id, result: { ok: false } });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, result: { ok: false } });
        }
        return;
      }
      if (message.kind === "ai-key") {
        try {
          if (message.payload?.provider !== "gemini") throw new Error();
          const key = await vault.get("ai-key:gemini");
          worker.postMessage({ kind: "source-response", id: message.id, result: { key: key || null } });
        } catch {
          worker.postMessage({ kind: "source-response", id: message.id, error: true });
        }
        return;
      }
      // end owner: client-health
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
          // owner: planning-perf. A presence-gated scheduled refresh (worker cadence) runs without
          // an open button call; the consent gate above still applies.
          const scheduled = message.payload?.scheduled === true;
          if ((!planningCall && !scheduled) || planningClears > 0) throw new Error("Planning read cancelled");
          // The native orchestration owns fixed reads, identity validation, and raw
          // response projection. The worker cannot supply URLs or private identities; its
          // stored-report and fresh-subject hints are schema-checked inside the sync.
          // Soft deadline 70 s < main's 90 s timer ≤ the worker's 95 s: a slow sync keeps what arrived.
          const result = await syncUwPlanning({
            http: planningHttp, accountSeed: planningAccountScope, signal: controller.signal,
            deadline: AbortSignal.timeout(70_000),
            storedAudits: message.payload?.storedAudits, freshSubjects: message.payload?.freshSubjects,
            ...(message.payload?.phase === "enrollment" ? { phase: "enrollment" as const } : {}), // fix/current-courses-only
          });
          // end owner: planning-perf
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
        // owner: acquisition. A course file's bytes in the student's Canvas session. Redirects are
        // followed here, only to the Canvas origin and Instructure's file hosts (canvasFileHost);
        // non-Canvas hops get no cookies. Bytes cross as a Uint8Array; a failure crosses as a cause
        // header (code and host only), never a URL.
        const fileUrl =
          message.payload?.service === "canvas"
            ? canvasFileDownloadUrl(String(message.payload.url), "https://canvas.wisc.edu")
            : undefined;
        if (fileUrl) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]);
          let result: { status: number; url: string; headers: Record<string, string>; body: Uint8Array | string };
          try {
            const file = await fetchCanvasFile(fileUrl, {
              origin: "https://canvas.wisc.edu",
              // Not studentSession.fetch: it rejects every redirect, and every download is one.
              session: sessionFetch(studentSession),
              plain: (url, init) => fetch(url, init),
              signal,
            });
            const limit = 100 * 1024 * 1024;
            if (Number(file.response.headers.get("content-length")) > limit)
              throw new MaterialReadError("byte_limit");
            const chunks: Uint8Array[] = [];
            let size = 0;
            const reader = file.response.body?.getReader();
            while (reader) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > limit) {
                await reader.cancel().catch(() => {});
                throw new MaterialReadError("byte_limit");
              }
              chunks.push(next.value);
            }
            const body = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const headers: Record<string, string> = { "x-magic-host-class": file.hostClass };
            for (const key of ["content-type", "content-length", "last-modified", "etag"])
              if (file.response.headers.has(key)) headers[key] = file.response.headers.get(key)!;
            headers["content-length"] = String(size);
            result = { status: 200, url: fileUrl, headers, body };
            trialLog({ event: "file-fetch", hostClass: file.hostClass, hops: file.hops, status: 200, bytes: size });
          } catch (error) {
            if (controller.signal.aborted) {
              worker.postMessage({ kind: "source-response", id: message.id, error: true });
              sourceReads.delete(message.id);
              return;
            }
            const headers = causeHeaders(error);
            result = { status: 502, url: fileUrl, headers, body: "" };
            trialLog({ event: "file-fetch", status: 502, cause: headers["x-magic-cause"], host: headers["x-magic-cause-host"] });
          }
          worker.postMessage({ kind: "source-response", id: message.id, result });
          sourceReads.delete(message.id);
          return;
        }
        // end owner: acquisition
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
          const response = await sessionFetch(
            service === "gitlab" ||
            (service === "space" && new URL(target).hostname === "git.doit.wisc.edu")
              ? gitlabSession
              : studentSession,
          )(target, {
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
          // owner: T05b, T05c: the bounded body, fixed headers and a redirect's origin and path only
          // (session-fetch.ts sessionSourceResult).
          const result = await sessionSourceResult(response, target, service, signal);
          const { body, headers } = result;
          // owner: T05e. A sync's profile read that confirms the session ended (spec A1): with
          // Remember my sign-in on and the student present, the app signs in again.
          if (
            service === "canvas" &&
            new URL(target).pathname === canvasProfilePath &&
            canvasProfileSignedOut(
              {
                status: response.status,
                body,
                contentType: response.headers.get("content-type"),
                location: headers.location,
                url: response.url,
              },
              "https://canvas.wisc.edu",
            )
          )
            void autoSignInAfterExpiry();
          // end owner: T05e
          trialLog({ event: "fetch", service, to: trialPath(target), status: response.status, contentType: (response.headers.get("content-type") ?? "").split(";")[0], bytes: body.length, redirect: headers.location ? trialPath(headers.location) : undefined });
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
      // Every Jev judgment (assignment kind, message triage, mail triage) shares Jev's consent
      // gate, abort map and reply shape; the worker never reaches the network itself.
      if (
        message.kind === "evaluate" ||
        message.kind === "triage" ||
        message.kind === "mailTriage"
      ) {
        if (!(await consentGate("evaluate"))) {
          worker.postMessage({ kind: "evaluation", id: message.id, error: true });
          return;
        }
        const controller = new AbortController();
        evaluations.set(message.id, controller);
        try {
          if (!gateway) throw new Error("Gateway unavailable");
          let result: unknown;
          if (message.kind === "evaluate") {
            result = await gateway.evaluate(message.payload, controller.signal);
          } else if (message.kind === "triage") {
            if (!gateway.triage) throw new Error("Gateway unavailable");
            result = await gateway.triage(message.state, controller.signal);
          } else {
            if (!gateway.mailTriage) throw new Error("Gateway unavailable");
            result = await gateway.mailTriage(message.state, controller.signal);
          }
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
    let desktopVoice: Awaited<ReturnType<typeof installDesktopVoice>> | undefined;
    let voiceAuthority: VoiceContext = { account: '', revision: '', allowed: false };
    let voiceSnapshot: Snapshot | null = null;
    const interactiveCalls = new Map<string, AbortController>();
    // owner: voice-plan. Speech reaches the planner only when every part of the path is present.
    const voiceCapability = () => voiceActionCapability({
      platform: process.platform,
      helpers: async () => (await Promise.all(['observed-action-helper', 'default-browser-helper'].map((name) => accessFile(join(root, name), fsConstants.X_OK).then(() => true, () => false)))).every(Boolean),
      jevKey: () => !!embeddedJevKey(),
      jevAllowed: () => consentGate('evaluate'),
      accessibility: () => process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false),
    });
    // A planner's course question goes to the grounded ask only (course AI policy enforced in the producer).
    const voiceAsk = async (question: string, context: VoiceRequestContext, operation: { signal: AbortSignal; current(): boolean }) => {
      const value = intentCommandSchema.parse({ text: question, context, mode: 'run', allowedActions: ['ask'] });
      const result = await execute({ type: 'command', value }, operation.signal);
      operation.signal.throwIfAborted();
      if (!operation.current()) throw new Error('Request context changed.');
      if (!result.command) throw new Error('The app returned no result for this request.');
      return result.command;
    };
    // end owner: voice-plan
    // owner: voice-plan. The connected agent's launch session (worker: voice/agent-warmup.ts). Readiness is
    // what the worker observed; main only forwards it to the voice host and asks again after a failure.
    let voiceAgent: AgentReadiness = { state: "idle" };
    const refreshVoiceAgent = () => worker.postMessage({ kind: "voice-agent-refresh" });
    const voiceAgentHooks = {
      status: () => voiceAgent,
      // A click with the open page always asks: the worker warms that page's planner session (or reuses it) and,
      // with a course open, the router's ask session, without a second launch. Without a page, only a retry.
      activate: (context?: VoiceRequestContext) => {
        if (context && voiceAuthority.allowed) worker.postMessage({ kind: "voice-agent-warm", context });
        else if (!["ready", "starting", "per_request"].includes(voiceAgent.state)) worker.postMessage({ kind: "voice-agent-warm" });
      },
      release: () => worker.postMessage({ kind: "voice-agent-release" }),
    };
    // end owner: voice-plan
    const stopInteractive = () => {
      desktopVoice?.stop('context-changed');
      voicePlanHost.stopAll(); // owner: voice-plan
      for (const controller of interactiveCalls.values()) controller.abort();
      interactiveCalls.clear();
    };
    async function execute(command: unknown, signal?: AbortSignal): Promise<CommandResult> {
      signal?.throwIfAborted();
      const parsed = commandSchema.parse(command);
      if (['purge', 'privacy', 'consent', 'course-override', 'ingestion-settings'].includes(parsed.type)) { stopInteractive(); refreshVoiceAgent(); } // owner: voice-plan: + agent session
      await ready;
      signal?.throwIfAborted();
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
          calls.delete(id); finish();
          worker.postMessage({ kind: "cancel-command", id });
          reject(new Error("Local workspace request timed out."));
        }, GENERATION_COMMANDS.has(parsed.type) ? GENERATION_TIMEOUT_MS : 30000);
        const abort = () => {
          clearTimeout(timer); calls.delete(id); finish();
          worker.postMessage({ kind: "cancel-command", id });
          reject(new Error("Request stopped."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const finish = () => signal?.removeEventListener("abort", abort);
        calls.set(id, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); }, timer });
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
      const snapshot = message.result?.snapshot;
      if (snapshot) {
        voiceSnapshot = snapshot;
        const accounts = [...new Set((snapshot.sources ?? []).map((source: {accountScope: string}) => source.accountScope))].sort();
        const authority = { account: JSON.stringify(accounts), revision: JSON.stringify([snapshot.consents, snapshot.privacy, snapshot.courseOverrides, snapshot.ingestionSettings, accounts]), allowed: true };
        if (voiceAuthority.allowed && (authority.account !== voiceAuthority.account || authority.revision !== voiceAuthority.revision)) { stopInteractive(); refreshVoiceAgent(); } // owner: voice-plan: + agent session
        if (!voiceAuthority.allowed || authority.account !== voiceAuthority.account || authority.revision !== voiceAuthority.revision) voiceAuthority = authority;
      }
      const records = snapshot?.consents;
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
    // T50b (the reader) and T62 (the licence) are not built yet.
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
      refreshVoiceAgent(); // owner: voice-plan: the old provider's session ends; the new one starts
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
    // owner: client-health (D50). Health per client and mode, the saved mode, and Gemini's key
    // (safeStorage vault; presence only crosses). Checks run the client's own --version, --help and
    // status commands: no model call, no credential read, nothing sent to a provider.
    let healthRuntime: import("./clients").ClientHealthRuntime | undefined;
    async function clientHealth() {
      if (healthRuntime) return healthRuntime;
      const { createClientHealth } = await import("./clients");
      healthRuntime = createClientHealth({ userData: data, vault });
      return healthRuntime;
    }
    ipcMain.handle("magic:clients-health", async (event, id: unknown, mode?: unknown) => {
      validateSender(event);
      return (await clientHealth()).health(id, mode);
    });
    // owner: reconfigure. Setup starts fresh: client config, modes, separate profiles, health answers.
    ipcMain.handle("magic:clients-reset", async (event) => {
      validateSender(event);
      await (await clients()).reset();
      healthRuntime = undefined;
    });
    ipcMain.handle("magic:clients-set-mode", async (event, id: unknown, mode: unknown) => {
      validateSender(event);
      const changed = await (await clientHealth()).setMode(id, mode);
      refreshVoiceAgent(); // owner: voice-plan
      return changed;
    });
    ipcMain.handle("magic:clients-gemini-key", async (event, op: unknown, key?: unknown) => {
      validateSender(event);
      const keys = (await clientHealth()).geminiKey;
      if (op === "status") return keys.status();
      if (op === "save") return keys.save(key);
      if (op === "remove") return keys.remove();
      throw new Error("Unknown key operation.");
    });
    // end owner: client-health
    const dispatchInteractive = createInteractiveDispatch(execute);
    // owner: voice-plan. Whether the command bar's code resolver alone places a spoken request (the
    // `intent.preview` query: 0 tokens, never the model, no snapshot); only then does voice take the
    // interactive dispatch before the planner.
    const voiceCodeRoute = async (text: string, context: VoiceRequestContext) => {
      const found = await workerQuery({ view: 'intent.preview', text: text.slice(0, 500), ...(context.courseId ? { courseId: context.courseId } : {}) });
      const action = found?.view === 'intent.preview' && found.preview?.status === 'preview' ? found.preview.action : null;
      return typeof action === 'string' && INTERACTIVE_ACTIONS.includes(action);
    };
    ipcMain.handle("magic:intent-run", async (event, request: unknown) => {
      validateSender(event);
      const r = request as { operationId?: unknown; text?: unknown; context?: unknown };
      if (!r || typeof r.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.operationId)) throw new Error('Invalid request identity.');
      const value = intentCommandSchema.parse({ text: r.text, context: r.context, mode: 'run' });
      if (interactiveCalls.has(r.operationId)) throw new Error('This request is already running.');
      const controller = new AbortController(), authority = voiceAuthority;
      interactiveCalls.set(r.operationId, controller);
      try { return await dispatchInteractive(value.text, value.context ?? {}, { operationId: r.operationId, signal: controller.signal, current: () => !controller.signal.aborted && authority === voiceAuthority }); }
      finally { if (interactiveCalls.get(r.operationId) === controller) interactiveCalls.delete(r.operationId); }
    });
    // owner: claude-chat. A chat question goes to the worker's persistent Claude session; its text
    // streams back as `magic:chat-delta` to the asking window, and the answer resolves the invoke.
    const chatCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; sender: Electron.WebContents; timer: NodeJS.Timeout }>();
    worker.on("message", (message: any) => {
      if (typeof message?.id !== "string") return;
      const c = chatCalls.get(message.id);
      if (!c) return;
      if (message.kind === "claude-chat-delta" && typeof message.text === "string") {
        if (!c.sender.isDestroyed()) c.sender.send("magic:chat-delta", message.id, { text: message.text });
      } else if (message.kind === "claude-chat-tool" && typeof message.tool === "string") {
        if (!c.sender.isDestroyed()) c.sender.send("magic:chat-delta", message.id, { tool: message.tool });
      } else if (message.kind === "claude-chat-response") {
        clearTimeout(c.timer);
        chatCalls.delete(message.id);
        if (message.error) c.reject(new Error(String(message.error)));
        else c.resolve(message.result);
      }
    });
    ipcMain.handle("magic:chat-ask", async (event, request: unknown) => {
      validateSender(event);
      const r = request as { operationId?: unknown; text?: unknown } | null;
      if (!r || typeof r.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.operationId)) throw new Error("Invalid request identity.");
      if (typeof r.text !== "string" || !r.text.trim() || r.text.length > 2000) throw new Error("Write a message of up to 2,000 characters.");
      if (chatCalls.has(r.operationId)) throw new Error("This request is already running.");
      await ready;
      const id = r.operationId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          chatCalls.delete(id);
          worker.postMessage({ kind: "claude-chat-cancel", id });
          reject(new Error("Claude took too long to answer. Try again."));
        }, 250_000);
        chatCalls.set(id, { resolve, reject, sender: event.sender, timer });
        worker.postMessage({ kind: "claude-chat", id, text: r.text });
      });
    });
    // The voice agent: Claude Code in Windows Terminal (else a console window) on the app's tools.
    ipcMain.handle("magic:agent-terminal", async (event) => {
      validateSender(event);
      if (headless) throw new Error("Terminal windows are disabled in headless mode.");
      await ready;
      const id = randomUUID();
      const prepared = (await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { calls.delete(id); reject(new Error("The Claude Code terminal couldn't be prepared.")); }, 30_000);
        calls.set(id, { resolve: (value: CommandResult) => resolve(value), reject, timer });
        worker.postMessage({ kind: "agent-terminal", id });
      })) as { status: string; reason?: string; folder?: string; launcher?: string };
      if (prepared.status !== "ready" || !prepared.folder || !prepared.launcher) return { status: "setup", reason: prepared.reason ?? "Claude Code isn't ready." };
      const { spawn } = await import("node:child_process");
      const wt = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "wt.exe");
      const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const launch = (file: string, args: string[]) => new Promise<boolean>((resolve) => {
        const child = spawn(file, args, { cwd: prepared.folder, detached: true, stdio: "ignore", windowsHide: false, shell: false });
        child.once("error", () => resolve(false));
        child.once("spawn", () => { child.unref(); resolve(true); });
      });
      const opened = process.platform === "win32"
        && ((await stat(wt).then(() => true, () => false) && await launch(wt, ["-w", "new", "new-tab", "--title", "My Magic UW agent", "-d", prepared.folder, cmd, "/k", prepared.launcher]))
          || await launch(cmd, ["/c", "start", "My Magic UW agent", cmd, "/k", prepared.launcher]));
      return opened ? { status: "opened" } : { status: "setup", reason: "No terminal could be opened on this computer." };
    });
    ipcMain.handle("magic:chat-cancel", (event, operationId: unknown) => {
      validateSender(event);
      if (typeof operationId === "string") worker.postMessage({ kind: "claude-chat-cancel", id: operationId });
    });
    // end owner: claude-chat
    ipcMain.handle("magic:intent-cancel", (event, operationId: unknown) => {
      validateSender(event);
      if (typeof operationId === 'string') interactiveCalls.get(operationId)?.abort();
    });
    // A student opens one assignment; the worker owns evidence, grants and the provider call.
    // Registered before the workspace is ready, so an early Stop means nothing is sent to the worker.
    const sourceInvestigations = sourceInvestigationOps({
      ready, newId: randomUUID,
      send: (id, assignmentId, call) => { calls.set(id, call); worker.postMessage({kind:"source-investigate",id,assignmentId}); },
      cancel: id => { calls.delete(id); worker.postMessage({kind:"cancel-command",id}); },
    });
    ipcMain.handle("magic:source-investigate", async (event, request: unknown) => {
      validateSender(event);
      const r = request as { operationId?: unknown; assignmentId?: unknown } | null;
      if (!r || typeof r.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.operationId) ||
        typeof r.assignmentId !== "string" || !r.assignmentId || r.assignmentId.length > 300 || sourceInvestigations.has(r.operationId))
        throw new Error("Invalid investigation request.");
      return sourceInvestigations.run(r.operationId, r.assignmentId);
    });
    ipcMain.handle("magic:source-investigate-stop", (event, operationId: unknown) => {
      validateSender(event);
      if (typeof operationId === "string") sourceInvestigations.stop(operationId);
    });
    ipcMain.handle("magic:execute", async (event, command) => {
      validateSender(event);
      const purging = command?.type === "purge";
      if (purging) planningClears++;
      try {
        const result = await execute(command);
        if (purging) {
          for (const c of sourceReads.values()) c.abort();
          await vault.clear();
          await remembered.forget(); // owner: T05e
          await outlook.disconnect().catch(() => {}); // owner: T30: tokens and state
          void postGraphScopes(); // owner: T30
          clientsRuntime?.terminal.closeAll(); // owner: T80
          docWindows.closeAll(); // owner: doc-window: before persist:uw is cleared
          await calendarImport.disposeAll(); // owner: calendar-import: prepared .ics files
          // owner: platform-fix. Both sessions lose their storage and their HTTP cache (sign-out
          // already cleared the cache; purge did not), and every app-owned folder goes.
          await purgeHostData({
            sessions: [studentSession, gitlabSession],
            folders: [join(data, "clients"), join(data, "documents"), join(data, "mcp"), join(data, "courses") /* owner: course-facts: syllabus.md briefs */], // clients: owner T80
            remove: (path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
            also: [resetPlanningScope()],
          });
          // end owner: platform-fix
          // owner: privacy: purge destroys the install secret; new data is sealed under a new one.
          await rm(privacyKeyPath, { force: true });
          await sendPrivacyKey();
        }
        return result;
      } finally {
        if (purging) planningClears--;
      }
    });
    // owner: data-ai. Space used, Show in folder and Export for "Your data on this computer".
    ipcMain.handle("magic:local-data", async (event, op: unknown) => {
      validateSender(event);
      const { localDataBytes } = await import("./local-data");
      if (op === "show") shell.showItemInFolder(join(data, "workspace.sqlite"));
      if (op === "export") {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = { title: "Export My Magic UW data", defaultPath: "my-magic-uw-export.json", filters: [{ name: "JSON", extensions: ["json"] }] };
        const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
        if (choice.canceled || !choice.filePath) return { bytes: await localDataBytes(data), exported: "cancelled" };
        const snapshot = (await execute({ type: "snapshot" })).snapshot;
        await writeFile(choice.filePath, JSON.stringify({ exportedAt: new Date().toISOString(), snapshot }, null, 2), { mode: 0o600 });
        return { bytes: await localDataBytes(data), exported: "saved" };
      }
      if (op !== "status" && op !== "show") throw new Error("Unknown operation.");
      return { bytes: await localDataBytes(data) };
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
        // owner: platform-fix. No database path: the reader derives it from this file's folder.
        JSON.stringify({
          clientId: id,
          token,
        }),
        { mode: 0o600 },
      );
      await restrictToCurrentUser(connection); // `mode` alone doesn't restrict an NTFS ACL on Windows
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
    // owner: accounts. Only the student's own actions reach the account server: no course data.
    ipcMain.handle("magic:account-status", async (event) => {
      validateSender(event);
      return account.status();
    });
    ipcMain.handle("magic:account-send-code", async (event, email: unknown) => {
      validateSender(event);
      if (typeof email !== "string" || email.length > 320) return { sent: false, reason: "invalid" };
      return account.sendCode(email);
    });
    ipcMain.handle("magic:account-verify", async (event, email: unknown, code: unknown) => {
      validateSender(event);
      if (typeof email !== "string" || email.length > 320 || typeof code !== "string" || code.length > 20)
        return { signedIn: false, reason: "invalid" };
      return account.verifyCode(email, code);
    });
    ipcMain.handle("magic:account-sign-out", async (event) => {
      validateSender(event);
      await account.signOut();
    });
    ipcMain.handle("magic:account-buy", async (event) => {
      validateSender(event);
      const url = account.buyUrl();
      if (!url) throw new Error("Buying isn't set up in this build.");
      if (headless) throw new Error("External windows are disabled in headless mode.");
      await shell.openExternal(url);
    });
    // end owner: accounts
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
    // owner: pipeline. Graph reads (references, agenda, a course's graph): sender-checked, parsed
    // here and again in the worker, answered on the same response channel as queries.
    ipcMain.handle("magic:graph", async (event, request) => {
      validateSender(event);
      const parsed = graphQuerySchema.parse(request);
      await ready;
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error("Local workspace request timed out."));
        }, 30000);
        calls.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "graph", id, query: parsed });
      });
    });
    // end owner: pipeline
    // owner: T05b. Link cards (D40): the default browser, https only.
    ipcMain.handle("magic:open-link", async (event, url) => {
      validateSender(event);
      if (headless)
        throw new Error("External windows are disabled in headless mode.");
      await shell.openExternal(safeLinkCard(url));
    });
    // end owner: T05b
    // Only stored destinations from the exact preview can launch. A retry is
    // restricted to failures in the previous receipt from this renderer.
    const workFailures = new Map<string, Set<string>>();
    let workLaunching = false;
    ipcMain.handle("magic:start-work", async (event, id, previewHash, only) => {
      validateSender(event);
      if (typeof id !== "string" || !id || id.length > 1000 ||
          typeof previewHash !== "string" || !/^[a-f0-9]{64}$/.test(previewHash))
        throw new Error("Review the prepared destinations before opening.");
      if (only !== undefined && (!Array.isArray(only) || only.length > 6 ||
          !only.every(v => typeof v === "string" && v.length <= 1000)))
        throw new Error("Invalid retry selection.");
      if (workLaunching) throw new Error("Prepared work is already opening.");
      workLaunching = true;
      const key = `${id}:${previewHash}`;
      try {
        const prepare = async () => {
          const { workSet } = await execute({ type: "work-set", id });
          if (!workSet) throw new Error("This item has nothing to open.");
          return workSet;
        };
        const beforeItem = async () => {
          if (!(await consentGate("source-fetch"))) throw new Error(consentRefused);
          selectWorkRetry(await prepare(), previewHash);
        };
        const workSet = selectWorkRetry(await prepare(), previewHash, only, workFailures.get(key));
        await beforeItem();
        const documentsRoot = await realpath(join(data, "documents")).catch(() => join(data, "documents"));
        const receipt = await launchWorkSet(workSet, {
          dryRun: headless,
          beforeItem,
          openExternal: async (url, activate) => { await beforeItem(); await shell.openExternal(url, { activate }); },
          openPath: async path => { await beforeItem(); return shell.openPath(path); },
          realpath: path => realpath(path),
          materialize: (path, extension) => materializeCopy(documentsRoot, path, extension),
          documentsRoot, separator: sep, now: () => new Date(),
        });
        // Bounded session receipt state; nothing is persisted or uploaded.
        if (workFailures.size >= 20) workFailures.delete(workFailures.keys().next().value!);
        workFailures.set(key, new Set([...(only ? [...(workFailures.get(key) ?? [])].filter(id => !only.includes(id)) : []), ...receipt.failed.map(item => item.resourceId)]));
        return receipt;
      } finally { workLaunching = false; }
    });
    // owner: doc-window. A document link opens the signed-in document window; any other ordinary
    // web link falls back to the default browser.
    ipcMain.handle("magic:open-document", (event, url) => {
      validateSender(event);
      return handleOpenDocument(url, {
        headless,
        openWindow: (target) => docWindows.open(target),
        openExternal: (target) => shell.openExternal(target),
      });
    });
    // end owner: doc-window
    // owner: task-workspace. Fresh default-browser windows for one task; URLs are
    // re-derived from the saved assignment and only observed windows are touched.
    const taskWindows = createTaskWindows({
      run: helperRunner(join(__dirname, "task-window-helper")),
      headless,
      beforeOpen: async () => { if (!(await consentGate("source-fetch"))) throw new Error(consentRefused); },
      context: async (accountScope, resourceId) =>
        taskContextFrom(await execute({ type: "work-set", id: resourceId }), accountScope, resourceId, "https://git.doit.wisc.edu"),
      now: () => new Date(),
    });
    ipcMain.handle("magic:task-windows", async (event, request) => {
      validateSender(event);
      return taskWindows.handle(request);
    });
    // end owner: task-workspace
    // owner: calendar-import. Private .ics files handed to Google's chooser in one observed window.
    const calendarImport = createCalendarImport({
      run: helperRunner(join(__dirname, "calendar-import-helper")),
      headless,
      tempRoot: app.getPath("temp"),
      reveal: (path) => shell.showItemInFolder(path),
      now: () => new Date(),
    });
    void calendarImport.sweep();
    ipcMain.handle("magic:calendar-import", async (event, request) => {
      validateSender(event);
      return calendarImport.handle(request);
    });
    // end owner: calendar-import
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
    // student-info read and then close themselves. No cookie is written. The only script is
    // T05e's sign-in preload, which reads or fills the NetID form only on UW's exact NetID
    // login origin, and only with Remember my sign-in ticked (signin-preload.ts).
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
    // owner: T05e. Remember my sign-in in the UW sign-in window. The window's preload
    // (signin-preload.ts) sends two messages, accepted only from the open UW sign-in window's top
    // frame while it is on UW's exact NetID login origin. A capture is held in memory and saved
    // only once the sign-in is confirmed; an automatic window fills once and never retries.
    let signInAttempt:
      | {
          contents: Electron.WebContents;
          auto: ReturnType<typeof createAutoSignIn>;
          pending?: SignInCapture;
        }
      | undefined;
    // Present = input in the last minute, the screen unlocked, and one of the app's windows focused.
    const studentPresent = () =>
      studentAtKeyboard({
        idleSeconds: powerMonitor.getSystemIdleTime(),
        appFocused: BrowserWindow.getFocusedWindow() !== null,
        locked: powerMonitor.getSystemIdleState(PRESENT_IDLE_SECONDS) === "locked",
        headless,
      });
    // The automatic-attempt record (blocked flag and last open) lives in the session settings file,
    // so the one-attempt-per-expiry rule and the spacing survive a restart.
    const autoRecord = () => sessionSettings.autoSignIn ?? { ...emptyAutoSignInRecord };
    async function recordAutoSignIn(event: AutoSignInEvent) {
      const next = nextAutoSignInRecord(autoRecord(), event);
      const current = autoRecord();
      if (next.blocked === current.blocked && next.lastAt === current.lastAt) return;
      sessionSettings = { ...sessionSettings, autoSignIn: next };
      await writeSessionSettings(sessionSettingsPath, sessionSettings).catch(() => {});
    }
    /** The one decision for every automatic (filling) open; records the open when it says yes. */
    async function claimAutoSignIn(): Promise<boolean> {
      const saved = await remembered.saved(),
        now = Date.now();
      const wanted = autoSignInWanted({
        availability: rememberState(),
        saved,
        present: studentPresent(),
        headless,
        signInOpen: signInFlight.pending,
        record: autoRecord(),
        now,
      });
      if (wanted) await recordAutoSignIn({ kind: "opened", at: now });
      return wanted;
    }
    function signInFrame(event: IpcMainInvokeEvent | Electron.IpcMainEvent) {
      const attempt = signInAttempt,
        frame = event.senderFrame;
      if (
        !attempt ||
        attempt.contents.isDestroyed() ||
        event.sender !== attempt.contents ||
        !frame ||
        frame !== attempt.contents.mainFrame ||
        !isNetIdLoginPage(frame.url)
      )
        throw new Error("Untrusted sign-in page.");
      return attempt;
    }
    ipcMain.handle("magic-signin:page", async (event): Promise<SignInPageState> => {
      const attempt = signInFrame(event);
      const availability = rememberState();
      if (availability.state === "off") return { offer: false };
      if (availability.state === "unavailable")
        return { offer: true, checked: false, disabledReason: availability.reason };
      const saved = await remembered.saved();
      const step = attempt.auto.formShown(saved);
      if (step === "failed") {
        // UW showed the NetID form again after the automatic submit: clear it, show the normal sign-in.
        await remembered.forget();
        trialLog({ event: "signin.remember", step: "auto-failed" });
        return { offer: true, checked: false, notice: "failed" };
      }
      if (step === "fill") {
        const fill = await remembered.load();
        // Checked again after the awaits: the same window, its top frame, the exact origin.
        signInFrame(event);
        if (!fill) {
          attempt.auto.abandon();
          return { offer: true, checked: false };
        }
        trialLog({ event: "signin.remember", step: "auto-fill" });
        return { offer: true, checked: true, fill };
      }
      return { offer: true, checked: saved };
    });
    ipcMain.on("magic-signin:capture", (event, payload: unknown) => {
      let attempt: NonNullable<typeof signInAttempt>;
      try {
        attempt = signInFrame(event);
      } catch {
        return;
      }
      if (rememberState().state !== "available") return;
      const capture = parseCapture(payload);
      if (capture) attempt.pending = capture;
    });
    /** Wires one sign-in window; gitlab's window (its own partition) gets none of this. */
    function trackSignIn(login: BrowserWindow, automatic: boolean, confirmedNow: () => boolean) {
      const attempt = { contents: login.webContents, auto: createAutoSignIn(automatic) } as NonNullable<
        typeof signInAttempt
      >;
      signInAttempt = attempt;
      login.webContents.on("did-navigate", (_event, url) => attempt.auto.navigated(url));
      login.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
        // -3 is an aborted load (a newer navigation replaced it), not a failed sign-in.
        if (mainFrame && code !== -3 && attempt.auto.loadFailed() === "failed") {
          void remembered.forget().catch(() => {});
          trialLog({ event: "signin.remember", step: "auto-failed" });
        }
      });
      login.once("closed", () => {
        if (signInAttempt === attempt) signInAttempt = undefined;
        const confirmed = confirmedNow(),
          pending = attempt.pending;
        attempt.pending = undefined;
        // An automatic window that closes unconfirmed blocks further automatic attempts until a
        // confirmed sign-in or the student's own "Sign in again" (no Duo-push loop).
        void recordAutoSignIn({ kind: "closed", automatic, confirmed });
        if (attempt.auto.closed(confirmed) === "failed") {
          void remembered.forget().catch(() => {});
          trialLog({ event: "signin.remember", step: "auto-failed" });
          return;
        }
        // Saved only after UW accepted it: a mistyped password is never stored.
        if (!confirmed || !pending || rememberState().state !== "available") return;
        const step = pending.remember ? "saved" : "declined";
        void (pending.remember ? remembered.save(pending.signIn) : remembered.forget()).catch(
          () => {},
        );
        trialLog({ event: "signin.remember", step });
      });
    }
    /** A sync confirmed the session ended: sign in again, once per expiry, with the student here. */
    async function autoSignInAfterExpiry() {
      try {
        if (!(await consentGate("magic:signin"))) return;
        if (!(await claimAutoSignIn())) return;
        trialLog({ event: "signin.remember", step: "auto-open" });
        if (!(await openSignIn("canvas", true))) return;
        const id = randomUUID();
        const timer = setTimeout(() => {
          calls.delete(id);
          worker.postMessage({ kind: "refresh-cancel" });
        }, 600_000);
        calls.set(id, { resolve: () => {}, reject: () => {}, timer });
        worker.postMessage({ kind: "refresh", id });
      } catch {
        /* The banner still offers Sign in again. */
      }
    }
    ipcMain.handle(
      "magic:remember-signin",
      async (event, op: unknown): Promise<RememberSignInStatus> => {
        validateSender(event);
        if (op === "forget") await remembered.forget();
        else if (op !== "status") throw new Error("Unknown operation.");
        const availability = rememberState();
        if (availability.state === "off") return { offered: false };
        const saved = await remembered.saved();
        return availability.state === "available"
          ? { offered: true, available: true, saved }
          : { offered: true, available: false, reason: availability.reason, saved };
      },
    );
    // end owner: T05e
    /** Resolves when the window closes: true when a sign-in was confirmed. */
    function openSignIn(requestedService?: SignInService, automatic = false): Promise<boolean> {
      if (headless)
        return Promise.reject(
          new Error(
            "Sign-in requires your interaction; headless mode will not open a window.",
          ),
        );
      // The open UW window comes forward (restored if minimized); the request joins it, never a second one.
      if (signInFlight.pending) bringSignInForward(signIn);
      return signInFlight.run(() => signInWindow(requestedService, automatic));
    }
    async function signInWindow(
      requestedService?: SignInService,
      automatic = false, // owner: T05e: opened by the app, so a saved sign-in is filled
    ): Promise<boolean> {
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
          // owner: T05e. The Remember my sign-in box, capture and fill (UW windows only).
          ...(gitlab ? {} : { preload: join(root, "signin-preload.cjs") }),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      const login = signIn;
      login.webContents.on("page-title-updated", (event, title) => {
        event.preventDefault();
        // A page title such as "Stale Request" or "Login" says which step the window is on.
        trialLog({ event: "signin.title", title: trialText(title), page: trialPath(login.webContents.getURL()) });
      });
      login.webContents.on("did-frame-navigate", (_event, url, code, _text, isMainFrame) => {
        if (!isMainFrame) trialLog({ event: "signin.frame-navigate", to: trialPath(url), status: code, allowed: allowedLogin(url) });
      });
      login.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) =>
        trialLog({ event: "signin.in-page", to: trialPath(url), mainFrame: isMainFrame }),
      );
      login.webContents.on("did-fail-provisional-load", (_event, code, description, url, isMainFrame) =>
        trialLog({ event: "signin.provisional-failed", code, description: trialText(description), to: trialPath(url), mainFrame: isMainFrame }),
      );
      login.webContents.on("render-process-gone", (_event, details) =>
        trialLog({ event: "signin.renderer-gone", reason: details.reason, exitCode: details.exitCode }),
      );
      login.on("unresponsive", () => trialLog({ event: "signin.unresponsive" }));
      login.webContents.on("console-message", (details) => {
        const d = details as unknown as { level?: string | number; message?: string };
        if (d.level === "error" || d.level === "warning" || d.level === 3 || d.level === 2)
          trialLog({ event: "signin.console", level: String(d.level), message: trialText(d.message) });
      });
      const guard = (event: Electron.Event, url: string) => {
        if (!allowedLogin(url)) {
          trialLog({ event: "signin.blocked", to: trialPath(url) });
          event.preventDefault();
        } else trialLog({ event: "signin.hop", to: trialPath(url) });
      };
      login.webContents.on("will-navigate", guard);
      login.webContents.on("will-redirect", guard);
      let lastSignInAt = "";
      login.webContents.on("did-navigate", (_event, url, code) => {
        lastSignInAt = trialPath(url);
        trialLog({ event: "signin.navigate", to: trialPath(url), status: code, allowed: allowedLogin(url) });
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
          trialLog({ event: "signin.closed", confirmed, lastAt: lastSignInAt });
          // Remember an unfinished sign-in (even across a restart) so the next one starts clean.
          if (Boolean(sessionSettings.loginUnfinished) !== !confirmed) {
            sessionSettings = { ...sessionSettings, loginUnfinished: !confirmed };
            void writeSessionSettings(sessionSettingsPath, sessionSettings).catch(() => {});
          }
          if (signIn === login) signIn = null;
          resolve();
        });
      });
      if (!gitlab) trackSignIn(login, automatic, () => confirmed); // owner: T05e
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
          // owner: acquisition: not loginSession.fetch, which rejects a redirect (session-fetch.ts).
          const response = await sessionFetch(loginSession)(
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
      // After a sign-in that did not finish, clear only UW's login-page cookies first, so a
      // half-finished login flow can't answer "Stale Request" (see sign-in-cookies.ts).
      if (sessionSettings.loginUnfinished) {
        const cleared = await clearUwLoginCookies(loginSession.cookies).catch(() => -1);
        trialLog({ event: "signin.cleared-stale-login", cookies: cleared });
      }
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
        // owner: client-health (FDB-002). The window's confirmed/cancelled result is returned as a
        // typed SignInOutcome instead of being dropped; validation and the consent gate are unchanged.
        const { handleSignInRequest } = await import("./sign-in-outcome");
        return handleSignInRequest(requestedService, {
          consented: () => consentGate("magic:signin"),
          refused: consentRefused,
          // owner: T05e: the student's own sign-in lifts the one-automatic-attempt block.
          open: async (service) => {
            await recordAutoSignIn({ kind: "student-sign-in" });
            return openSignIn(service);
          },
        });
        // end owner: client-health
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
        // owner: T05e: opened by the app; it fills a saved sign-in only when the same rule as a
        // sync's expiry allows it (at the keyboard, not blocked, spaced; recorded across restarts).
        if (!(await openSignIn("canvas", await claimAutoSignIn()))) return;
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
    ipcMain.handle("magic:sync", async (event, options?: unknown) => {
      validateSender(event);
      // fix/current-courses-only: discovery reads only the course lists (onboarding's chooser).
      const discover =
        !!options && typeof options === "object" && (options as { discover?: unknown }).discover === true;
      // "Start syncing": the student's confirmation, the only message that releases the hold.
      const confirm =
        !!options && typeof options === "object" && (options as { confirm?: unknown }).confirm === true;
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
        worker.postMessage({ kind: "refresh", id, ...(confirm ? { confirm: true } : discover ? { discover: true } : {}) });
      });
    });
    ipcMain.handle("magic:planning-sync", async (event, options?: unknown) => {
      validateSender(event);
      // fix/current-courses-only: onboarding reads this term's enrollment first.
      const phase =
        !!options && typeof options === "object" && (options as { phase?: unknown }).phase === "enrollment"
          ? ("enrollment" as const)
          : undefined;
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
        worker.postMessage({ kind: "planning-sync", id, ...(phase ? { phase } : {}) });
      });
      planningCall = { id, promise };
      try { return await promise; }
      finally { if (planningCall?.id === id) planningCall = undefined; }
    });
    ipcMain.handle("magic:signout", async (event) => {
      validateSender(event);
      stopInteractive();
      refreshVoiceAgent(); // owner: voice-plan
      planningClears++;
      try {
        sync?.abort();
        cancelPlanning();
        const signOutEpoch = planningEpoch;
        worker.postMessage({ kind: "refresh-cancel" });
        for (const c of sourceReads.values()) c.abort();
        signIn?.close();
        docWindows.closeAll(); // owner: doc-window: no live document page outlives the clear
        await studentSession.clearStorageData();
        await studentSession.clearCache();
        await gitlabSession.clearStorageData();
        await gitlabSession.clearCache();
        // Every saved calendar link goes, Outlook's included; its meetings are removed too.
        await clearSignOutSecrets(vault);
        await remembered.forget(); // owner: T05e: Sign out deletes a saved sign-in
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
      icon: appIconPath,
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
    desktopVoice = await installDesktopVoice({ window, rendererURL, headless, context: () => voiceAuthority, agent: voiceAgentHooks, streamingHelper: join(root, 'native-streaming-stt'), dispatch: createConnectedVoiceDispatch({ trial: createVoiceTrialDispatch(() => voiceSnapshot), capability: voiceCapability, plan: voicePlanHost.plan, ask: voiceAsk, interactive: { code: voiceCodeRoute, run: dispatchInteractive } }) }); // owner: voice-plan
    window.webContents.session.setPermissionRequestHandler(
      (sender, permission, callback, details) => callback(desktopVoice?.allowsPermission(sender, permission, details) ?? false),
    );
    window.webContents.session.setPermissionCheckHandler((sender, permission, _origin, details) => desktopVoice?.allowsPermission(sender, permission, details) ?? false);
    window.on("closed", () => {
      stopInteractive(); desktopVoice?.dispose(); desktopVoice = undefined;
      window = null;
    });
    await window.loadURL(rendererURL);
    await ready;
    worker.postMessage({ kind: "voice-agent-warm" }); // owner: voice-plan: after first paint, before any voice; no microphone
    worker.postMessage({ kind: "claude-chat-warm" }); // owner: claude-chat: the chat's session starts now (0 tokens)
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
      void embeddedJev?.close().catch(() => {}); // owner: embedded-jev
      void calendarImport.disposeAll().catch(() => {}); // owner: calendar-import
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
        // owner: embedded-jev. `MAGIC_SMOKE_EXPECT_JEV=1 pnpm test:desktop` checks a keyed build.
        if (process.env.MAGIC_SMOKE_EXPECT_JEV === "1" && (!embeddedJev || !initial.snapshot.gatewayConfigured))
          throw new Error("Embedded Jev did not start");
        const imported = await window.webContents.executeJavaScript(
          "window.magic.execute({type:'fixture'})",
        );
        if (
          imported.snapshot.resources.length !== sampleFixture.reduce((n, batch) => n + batch.resources.length, 0) ||
          !imported.snapshot.fixtureMode
        )
          throw new Error("Fixture import failed");
        const essay = imported.snapshot.resources.find(
          (r: { externalId: string }) => r.externalId === "essay-1",
        );
        const previewLaunch = `(async()=>{const prepared=await window.magic.execute({type:"work-set",id:${JSON.stringify(essay.id)}});return window.magic.startWork(${JSON.stringify(essay.id)},prepared.workSet.previewHash)})()`;
        if (await window.webContents.executeJavaScript(previewLaunch).then(() => true, () => false))
          throw new Error("Start work bypassed setup consent");
        await window.webContents.executeJavaScript(`window.magic.execute(${JSON.stringify({type:"consent",value:{action:"grant",recipient:"uw",disclosureVersion:CONSENT_DISCLOSURE_VERSION}})})`);
        const started = await window.webContents.executeJavaScript(
          `(async()=>{const prepared=await window.magic.execute({type:"work-set",id:${JSON.stringify(essay.id)}});return window.magic.startWork(${JSON.stringify(essay.id)},prepared.workSet.previewHash)})()`,
        );
        if (
          started.mode !== "dry_run" ||
          started.opened.length !== 2 ||
          started.failed.length ||
          (await window.webContents
            .executeJavaScript("window.magic.startWork('missing-item')")
            .then(() => true, () => false))
        )
          throw new Error("Start work did not rebuild the linked work set");
        for (const invalidLaunch of [
          `window.magic.startWork(${JSON.stringify(essay.id)},${JSON.stringify("0".repeat(64))})`,
          `(async()=>{const p=await window.magic.execute({type:"work-set",id:${JSON.stringify(essay.id)}});return window.magic.startWork(${JSON.stringify(essay.id)},p.workSet.previewHash,[p.workSet.items[0].resourceId])})()`,
        ]) if (await window.webContents.executeJavaScript(invalidLaunch).then(() => true, () => false))
          throw new Error("Start work accepted an unreviewed destination or unfailed retry");
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
          "PASS hidden desktop: renderer → preload → worker → SQLite; Start work dry run, synthetic planning import, MCP export and local purge",
        );
      } catch (error) {
        console.error(
          "FAIL hidden desktop integration:",
          error instanceof Error ? redactForLog(error.message) : "unknown", // owner: privacy
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

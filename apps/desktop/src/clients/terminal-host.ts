import { randomUUID } from "node:crypto";
import type { ClientId, TerminalPurpose } from "@magic/contracts";
import type { CliCommand } from "@magic/runner";
import { CLIENTS, clientIdSchema, isIsolated, profileEnv, prepareProfile, resolveClient, workDir, type ClientsDeps } from "./profiles";

/**
 * T80 terminal host: runs the unmodified client in a pseudo-terminal so the student signs in
 * through the provider's own flow. The binary is resolved here, spawned without a shell, with
 * fixed arguments per purpose and the profile's environment. The renderer names only a client
 * and a purpose; it can never choose the command or its arguments.
 *
 * PTY: node-pty 1.1.0 (MIT). Its npm package ships N-API prebuilds for win32-x64/arm64 and
 * darwin-x64/arm64; measured loading and spawning under Electron 44.4.5 (Node 24.21, ABI 149)
 * on Windows 11 with no build tools. It is loaded lazily and outside the esbuild bundle.
 */

/** The subset of node-pty's IPty the host uses; tests substitute their own. */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => PtyProcess;

/** Loads node-pty at run time. The specifier is a variable so the bundler leaves it external. */
export async function loadNodePty(): Promise<PtySpawn> {
  const specifier = "node-pty";
  const mod = (await import(specifier)) as { spawn?: PtySpawn; default?: { spawn: PtySpawn } };
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== "function") throw new Error("node-pty has no spawn export.");
  return (file, args, options) => spawn(file, args, { ...options, env: options.env as Record<string, string> });
}

/** Sign-in only; see the TODO(T81) on `ClientSpec.args` for why there's no session yet. */
const purposeSchema = ["signin"] as const;
const MAX_SESSIONS = 4;
const MAX_WRITE = 64 * 1024;

/**
 * Validates an open request exactly as it arrives over IPC: a known client, a known purpose,
 * and nothing else. Extra arguments are refused, not ignored.
 */
export function parseOpenRequest(args: unknown[]): { id: ClientId; purpose: TerminalPurpose } {
  if (args.length !== 2) throw new Error("A terminal opens with a client and a purpose only.");
  const id = clientIdSchema.safeParse(args[0]);
  if (!id.success) throw new Error("Unknown client.");
  const purpose = args[1];
  if (typeof purpose !== "string" || !(purposeSchema as readonly string[]).includes(purpose))
    throw new Error("Unknown terminal purpose.");
  return { id: id.data, purpose: purpose as TerminalPurpose };
}

export function sessionIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new Error("Unknown terminal session.");
  return value;
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const ok = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  if (!ok(cols, 1000) || !ok(rows, 500)) throw new Error("Invalid terminal size.");
  return { cols, rows };
}

export interface TerminalEvents {
  /** `owner` is whatever the caller passed to open (main uses the WebContents). */
  data(owner: unknown, sessionId: string, chunk: string): void;
  exit(owner: unknown, sessionId: string, code: number | null): void;
}
export interface TerminalHostDeps extends ClientsDeps {
  /** Checked on every open, again right before the spawn: the provider's consent record. */
  consented(id: ClientId): Promise<boolean>;
  /** False once the requesting window is gone; checked right before the spawn. */
  alive?(owner: unknown): boolean;
  pty?: () => Promise<PtySpawn>;
  events: TerminalEvents;
}
interface Session {
  id: string;
  client: ClientId;
  owner: unknown;
  pty: PtyProcess;
  exited: Promise<void>;
}

/** The fixed command line for a client and purpose. The only place argv is built. */
export function commandLine(command: CliCommand, id: ClientId, purpose: TerminalPurpose): { file: string; args: string[] } {
  return { file: command.file, args: [...command.prefixArgs, ...CLIENTS[id].args[purpose]] };
}

export function createTerminalHost(deps: TerminalHostDeps) {
  const sessions = new Map<string, Session>();
  let spawner: Promise<PtySpawn> | undefined;
  const pty = () => (spawner ??= (deps.pty ?? loadNodePty)().catch((e) => {
    spawner = undefined;
    throw e;
  }));

  function kill(session: Session) {
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }

  return {
    sessions: () => [...sessions.values()].map(({ id, client }) => ({ id, client })),
    async open(owner: unknown, ...args: unknown[]): Promise<{ sessionId: string }> {
      const { id, purpose } = parseOpenRequest(args);
      if (!isIsolated(id))
        throw new Error("This client can't be given its own profile yet, so Magic Canvas won't open it.");
      if (!(await deps.consented(id)))
        throw new Error("Agree to share with this AI provider before opening its client.");
      if (sessions.size >= MAX_SESSIONS) throw new Error("Too many terminal sessions are open.");
      const command = resolveClient(id, deps);
      if (!command) throw new Error("This client isn't installed.");
      await prepareProfile(id, deps);
      const spawn = await pty().catch(() => {
        throw new Error("The built-in terminal could not start on this device.");
      });
      const { file, args: argv } = commandLine(command, id, purpose);
      // Consent can be withdrawn and the window closed while the awaits above ran. This is the
      // last await: nothing but synchronous checks sits between it and the spawn.
      const stillConsented = await deps.consented(id);
      if (!stillConsented) throw new Error("Agree to share with this AI provider before opening its client.");
      if (deps.alive && !deps.alive(owner)) throw new Error("The window that asked for this terminal is closed.");
      if (sessions.size >= MAX_SESSIONS) throw new Error("Too many terminal sessions are open.");
      const proc = spawn(file, argv, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: workDir(deps.userData, id),
        env: { ...profileEnv(id, deps), TERM: "xterm-256color" },
      });
      const sessionId = randomUUID();
      let done!: () => void;
      const session: Session = { id: sessionId, client: id, owner, pty: proc, exited: new Promise((r) => (done = r)) };
      sessions.set(sessionId, session);
      proc.onData((chunk) => {
        if (sessions.get(sessionId) === session) deps.events.data(owner, sessionId, chunk);
      });
      proc.onExit(({ exitCode }) => {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        deps.events.exit(owner, sessionId, Number.isInteger(exitCode) ? exitCode : null);
        done();
      });
      return { sessionId };
    },
    write(owner: unknown, sessionId: unknown, data: unknown) {
      const s = sessions.get(sessionIdOf(sessionId));
      if (!s || s.owner !== owner) throw new Error("Unknown terminal session.");
      if (typeof data !== "string" || data.length > MAX_WRITE) throw new Error("Invalid terminal input.");
      s.pty.write(data);
    },
    resize(owner: unknown, sessionId: unknown, cols: unknown, rows: unknown) {
      const s = sessions.get(sessionIdOf(sessionId));
      if (!s || s.owner !== owner) throw new Error("Unknown terminal session.");
      const size = terminalSize(cols, rows);
      s.pty.resize(size.cols, size.rows);
    },
    /** Kills the session and resolves once it has exited (or after 3 s). */
    async close(owner: unknown, sessionId: unknown): Promise<void> {
      const s = sessions.get(sessionIdOf(sessionId));
      if (!s || s.owner !== owner) return;
      kill(s);
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 3000).unref())]);
      sessions.delete(s.id);
    },
    /** Window close, consent withdrawal and app quit. `client` limits it to one client. */
    closeAll(filter: { owner?: unknown; client?: ClientId } = {}) {
      for (const s of [...sessions.values()]) {
        if (filter.owner !== undefined && s.owner !== filter.owner) continue;
        if (filter.client && s.client !== filter.client) continue;
        sessions.delete(s.id);
        kill(s);
      }
    },
  };
}
export type TerminalHost = ReturnType<typeof createTerminalHost>;

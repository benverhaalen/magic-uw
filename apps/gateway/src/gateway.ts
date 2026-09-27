import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  HttpError,
  RateLimitError,
  extractBearerToken,
  readJsonBody,
  requireJsonContentType,
  sendError,
  sendJson,
} from "./http-utils";
import { judgmentRequestSchema } from "./schema";
import { openStore, type Store } from "./store";
import {
  createTypeSafeEvaluate,
  UpstreamError,
  UpstreamRateLimitError,
  validateAssignmentKindResult,
  type AssignmentKindResult,
  type Evaluate,
} from "./typesafe";
import {
  createTypeSafeTriage,
  triageRequestSchema,
  validateMessageTriageResult,
  type Triage,
} from "./triage";

export interface GatewayLimits {
  maxBodyBytes: number;
  requestTimeoutMs: number;
  globalDailyRequestLimit: number;
  deviceDailyLimit: number;
  deviceHourlyLimit: number;
  deviceConcurrency: number;
  globalConcurrency: number;
  globalEnrollmentDailyLimit: number;
  enrollHourlyLimitPerIp: number;
  enrollDailyLimitPerIp: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  maxBodyBytes: 256 * 1024,
  requestTimeoutMs: 15_000,
  // Conservative default: bounds worst-case daily spend even if every other
  // control were somehow bypassed.
  globalDailyRequestLimit: 100,
  deviceDailyLimit: 20,
  deviceHourlyLimit: 5,
  deviceConcurrency: 1,
  globalConcurrency: 8,
  globalEnrollmentDailyLimit: 500,
  enrollHourlyLimitPerIp: 5,
  enrollDailyLimitPerIp: 15,
};

export interface LogEvent {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  deviceId?: string;
  reason?: string;
}

export interface GatewayOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  /** Server-side TypeSafe credential. Required unless `evaluate` is provided (tests only). */
  apiKey?: string;
  /** Test-only injection point: bypasses the real TypeSafe network call entirely. */
  evaluate?: Evaluate;
  /** Test-only injection point for message.triage.v1; same fail-closed rule as `evaluate`. */
  triage?: Triage;
  limits?: Partial<GatewayLimits>;
  log?: (event: LogEvent) => void;
  now?: () => Date;
}

export interface GatewayHandle {
  server: Server;
  /** Resolves once the server is actually bound and accepting connections. */
  listening: Promise<void>;
  /** Closes the HTTP server and the underlying SQLite handle. */
  close(): Promise<void>;
  /** Local operator action only: there is deliberately no public admin route. */
  revokeDevice(deviceId: string): boolean;
}

function defaultLog(event: LogEvent): void {
  // Structured, constant-shape line. Never includes request/response bodies,
  // headers, tokens, or the TypeSafe API key.
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

export function createGateway(options: GatewayOptions = {}): GatewayHandle {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const dbPath = options.dbPath ?? "./.data/gateway.sqlite";
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer.`);
  }
  const log = options.log ?? defaultLog;
  const now = options.now ?? (() => new Date());

  const evaluate: Evaluate =
    options.evaluate ??
    createDefaultEvaluate(options.apiKey, limits.requestTimeoutMs);
  const triage: Triage =
    options.triage ??
    (options.evaluate && !options.apiKey?.trim()
      ? // A test gateway that overrides only the assignment judgment: the triage route stays
        // closed (every call fails as an upstream error) rather than answering without a key.
        async () => {
          throw new UpstreamError("Judgment upstream is not configured.");
        }
      : createDefaultTriage(options.apiKey, limits.requestTimeoutMs));

  const store: Store = openStore(dbPath);
  const activeByDevice = new Map<string, number>();
  let activeTotal = 0;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal_error",
          message: "Unexpected server error.",
        });
      } else {
        res.destroy();
      }
    });
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const start = Date.now();
    const method =
      req.method === "GET" || req.method === "POST" ? req.method : "OTHER";
    const path = new URL(req.url ?? "/", "http://gateway.internal").pathname;
    const logPath = [
      "/health",
      "/v1/devices",
      "/v1/judgments/assignment.kind.v1",
      "/v1/judgments/message.triage.v1",
    ].includes(path)
      ? path
      : "/unrecognized";
    let status = 500;
    let reason: string | undefined;
    let deviceId: string | undefined;

    try {
      if (method === "GET" && path === "/health") {
        status = 200;
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (method === "POST" && path === "/v1/devices") {
        status = await handleEnroll(req, res);
        return;
      }

      if (method === "POST" && path === "/v1/judgments/assignment.kind.v1") {
        const result = await handleJudgment(
          req,
          res,
          (value) => {
            const parsed = judgmentRequestSchema.safeParse(value);
            return parsed.success ? parsed.data.state : undefined;
          },
          async (state, signal) => {
            const result: AssignmentKindResult = validateAssignmentKindResult(
              await evaluate(state, signal),
            );
            return {
              kind: result.kind,
              probabilities: result.probabilities,
              model: result.model,
              questionVersion: result.questionVersion,
            };
          },
        );
        status = result.status;
        deviceId = result.deviceId;
        return;
      }

      if (method === "POST" && path === "/v1/judgments/message.triage.v1") {
        const result = await handleJudgment(
          req,
          res,
          (value) => {
            const parsed = triageRequestSchema.safeParse(value);
            return parsed.success ? parsed.data.state : undefined;
          },
          async (state, signal) => {
            const result = validateMessageTriageResult(
              await triage(state, signal),
              state,
            );
            return {
              kind: result.kind,
              kindProbabilities: result.kindProbabilities,
              actionRequired: result.actionRequired,
              affects: result.affects,
              model: result.model,
              questionVersion: result.questionVersion,
            };
          },
        );
        status = result.status;
        deviceId = result.deviceId;
        return;
      }

      status = 404;
      sendJson(res, 404, { error: "not_found", message: "Unknown route." });
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        reason = err.code;
        sendError(res, err);
        if (err.status === 413 || err.status === 408) {
          // The request stream was left unconsumed (oversized or stalled);
          // drop the connection once the error response is flushed instead
          // of continuing to read from an abusive or hung client.
          res.once("finish", () => req.destroy());
        }
      } else {
        status = 500;
        reason = "internal_error";
        sendJson(res, 500, {
          error: "internal_error",
          message: "Unexpected server error.",
        });
      }
    } finally {
      try {
        log({
          method,
          path: logPath,
          status,
          durationMs: Date.now() - start,
          deviceId,
          reason,
        });
      } catch {
        // A failed logging sink cannot change an already completed request.
      }
    }
  }

  async function handleEnroll(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<number> {
    requireJsonContentType(req, { allowEmpty: true });
    const body = await readJsonBody(
      req,
      limits.maxBodyBytes,
      limits.requestTimeoutMs,
    );
    if (body.length !== 0) {
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch {
        throw new HttpError(
          400,
          "invalid_json",
          "Enrollment request must be an empty JSON object.",
        );
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 0
      ) {
        throw new HttpError(
          422,
          "invalid_request",
          "Enrollment request must be an empty JSON object.",
        );
      }
    }

    const ip = req.socket.remoteAddress ?? "unknown";
    const enrollment = store.enrollDevice(
      ip,
      {
        hourlyLimitPerIp: limits.enrollHourlyLimitPerIp,
        dailyLimitPerIp: limits.enrollDailyLimitPerIp,
        globalDailyLimit: limits.globalEnrollmentDailyLimit,
      },
      now(),
    );
    if (!enrollment.ok) {
      throw new RateLimitError(
        enrollment.code,
        "Too many device enrollments from this address.",
      );
    }

    sendJson(res, 201, { token: enrollment.token });
    return 201;
  }

  /**
   * Shared by every judgment route: device auth, content type, body cap, strict schema,
   * concurrency, and ONE reservation against the same per-device and global budget.
   * `run` must return only validated, allowlisted response fields.
   */
  async function handleJudgment<S>(
    req: IncomingMessage,
    res: ServerResponse,
    parseState: (value: unknown) => S | undefined,
    run: (state: S, signal: AbortSignal) => Promise<Record<string, unknown>>,
  ): Promise<{ status: number; deviceId?: string }> {
    const token = extractBearerToken(req);
    const device = store.authenticate(token);
    if (!device) {
      throw new HttpError(
        401,
        "unauthorized",
        "Invalid or unknown device token.",
      );
    }

    requireJsonContentType(req, { allowEmpty: false });
    const body = await readJsonBody(
      req,
      limits.maxBodyBytes,
      limits.requestTimeoutMs,
    );

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
    } catch {
      throw new HttpError(
        400,
        "invalid_json",
        "Request body must be valid JSON.",
      );
    }
    const state = parseState(parsedBody);
    if (state === undefined) {
      throw new HttpError(
        422,
        "invalid_request",
        "Request body failed schema validation.",
      );
    }

    if (res.destroyed) return { status: 499, deviceId: device.id };
    if (activeTotal >= limits.globalConcurrency) {
      throw new RateLimitError(
        "global_concurrency_limit",
        "Judgment service is busy. Try again later.",
      );
    }
    const active = activeByDevice.get(device.id) ?? 0;
    if (active >= limits.deviceConcurrency) {
      throw new RateLimitError(
        "device_concurrency_limit",
        "Too many concurrent requests for this device.",
      );
    }

    const reservedAt = now();
    const reservation = store.reserveJudgment(
      device.id,
      {
        globalDailyLimit: limits.globalDailyRequestLimit,
        deviceDailyLimit: limits.deviceDailyLimit,
        deviceHourlyLimit: limits.deviceHourlyLimit,
      },
      reservedAt,
    );
    if (!reservation.ok) {
      // Reservation was never granted, so nothing was spent and the
      // upstream model is never called for a blocked request.
      throw new RateLimitError(
        reservation.code,
        "Judgment budget exceeded. Try again later.",
      );
    }

    activeByDevice.set(device.id, active + 1);
    activeTotal += 1;
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", abort);
    try {
      let result: Record<string, unknown>;
      try {
        // The reservation above already counted this attempt, so an
        // upstream failure here still bounds spend rather than being retried
        // for free.
        result = await run(state, controller.signal);
      } catch (error) {
        // An upstream 429 spent nothing: refund the reservation and pass the wait through.
        if (error instanceof UpstreamRateLimitError) {
          store.refundJudgment(device.id, reservedAt);
          throw new RateLimitError(
            "upstream_rate_limited",
            "The judgment service is rate limited. Try again later.",
            error.retryAfterSeconds,
          );
        }
        throw new HttpError(
          502,
          "upstream_error",
          "The judgment service is temporarily unavailable.",
        );
      }

      if (res.destroyed) return { status: 499, deviceId: device.id };
      sendJson(res, 200, result);
      return { status: 200, deviceId: device.id };
    } finally {
      res.removeListener("close", abort);
      activeTotal -= 1;
      const remaining = (activeByDevice.get(device.id) ?? 1) - 1;
      if (remaining <= 0) activeByDevice.delete(device.id);
      else activeByDevice.set(device.id, remaining);
    }
  }

  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = Math.min(limits.requestTimeoutMs, 10_000);
  server.listen(port, host);
  let closing: Promise<void> | undefined;

  return {
    server,
    listening,
    revokeDevice: (deviceId) => store.revokeDevice(deviceId),
    close(): Promise<void> {
      if (!closing)
        closing = new Promise((resolve, reject) => {
          server.close((err) => {
            store.close();
            if (
              err &&
              (!("code" in err) || err.code !== "ERR_SERVER_NOT_RUNNING")
            )
              reject(err);
            else resolve();
          });
        });
      return closing;
    },
  };
}

function createDefaultEvaluate(
  apiKey: string | undefined,
  timeoutMs: number,
): Evaluate {
  if (!apiKey?.trim()) {
    // Fail closed: refuse to construct a gateway that would silently return
    // fake judgments when no real credential is configured.
    throw new Error(
      "TYPESAFE_API_KEY is required to start the gateway (no evaluate() override was provided). See apps/gateway/README.md.",
    );
  }
  return createTypeSafeEvaluate(apiKey, timeoutMs);
}

function createDefaultTriage(
  apiKey: string | undefined,
  timeoutMs: number,
): Triage {
  if (!apiKey?.trim()) {
    // Fail closed exactly like the assignment evaluator: never start a gateway whose
    // triage route could answer without a real credential.
    throw new Error(
      "TYPESAFE_API_KEY is required to start the gateway (no triage() override was provided). See apps/gateway/README.md.",
    );
  }
  return createTypeSafeTriage(apiKey, timeoutMs);
}

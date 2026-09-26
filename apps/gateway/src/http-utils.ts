import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  code: string;
  headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export class RateLimitError extends HttpError {
  retryAfterSeconds: number;

  constructor(code: string, message: string, retryAfterSeconds = 60) {
    super(429, code, message, { "retry-after": String(retryAfterSeconds) });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  const body: Record<string, unknown> = {
    error: err.code,
    message: err.message,
  };
  if (err instanceof RateLimitError)
    body.retryAfterSeconds = err.retryAfterSeconds;
  sendJson(res, err.status, body, err.headers);
}

/**
 * Reads a request body up to `maxBytes`, counting bytes actually received off
 * the stream rather than trusting Content-Length, so a missing or lying
 * header cannot bypass the limit.
 *
 * On a limit or timeout violation this stops consuming the stream (rather
 * than destroying the socket outright) so the caller can still write a
 * clean error response on the same connection; the caller is responsible
 * for closing the connection once that response has been sent.
 */
export function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const timer = setTimeout(() => {
      req.pause();
      finish(() =>
        reject(new HttpError(408, "request_timeout", "Request timed out.")),
      );
    }, timeoutMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      fn();
    }

    function onData(chunk: Buffer): void {
      received += chunk.length;
      if (received > maxBytes) {
        req.pause();
        finish(() =>
          reject(
            new HttpError(
              413,
              "payload_too_large",
              "Request body exceeds the size limit.",
            ),
          ),
        );
      } else {
        chunks.push(chunk);
      }
    }
    function onEnd(): void {
      finish(() => resolve(Buffer.concat(chunks)));
    }
    function onError(): void {
      finish(() =>
        reject(
          new HttpError(400, "bad_request", "Error reading request body."),
        ),
      );
    }

    function onAborted(): void {
      finish(() =>
        reject(
          new HttpError(400, "request_aborted", "Request was interrupted."),
        ),
      );
    }

    req.on("aborted", onAborted);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function requireJsonContentType(
  req: IncomingMessage,
  options: { allowEmpty: boolean },
): void {
  const raw = req.headers["content-type"];
  if (!raw) {
    if (options.allowEmpty) return;
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
  const type = raw.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
}

export function extractBearerToken(req: IncomingMessage): string {
  const header = req.headers["authorization"];
  if (typeof header !== "string") {
    throw new HttpError(401, "unauthorized", "Missing Authorization header.");
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) {
    throw new HttpError(
      401,
      "unauthorized",
      "Authorization header must be a Bearer token.",
    );
  }
  return match[1];
}

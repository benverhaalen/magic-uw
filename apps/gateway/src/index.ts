import { createGateway, DEFAULT_LIMITS } from "./gateway";

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey?.trim()) {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "startup_failed",
      reason: "missing_api_key",
      message:
        "TYPESAFE_API_KEY is not set. Refusing to start. See apps/gateway/README.md.",
    }),
  );
  process.exit(1);
}

const gateway = createGateway({
  host: process.env.GATEWAY_HOST ?? "127.0.0.1",
  port: readIntEnv("GATEWAY_PORT", 8787),
  dbPath: process.env.GATEWAY_DB_PATH ?? "./.data/gateway.sqlite",
  apiKey,
  limits: {
    maxBodyBytes: readIntEnv(
      "GATEWAY_MAX_BODY_BYTES",
      DEFAULT_LIMITS.maxBodyBytes,
    ),
    requestTimeoutMs: readIntEnv(
      "GATEWAY_REQUEST_TIMEOUT_MS",
      DEFAULT_LIMITS.requestTimeoutMs,
    ),
    globalDailyRequestLimit: readIntEnv(
      "GATEWAY_GLOBAL_DAILY_LIMIT",
      DEFAULT_LIMITS.globalDailyRequestLimit,
    ),
    deviceDailyLimit: readIntEnv(
      "GATEWAY_DEVICE_DAILY_LIMIT",
      DEFAULT_LIMITS.deviceDailyLimit,
    ),
    deviceHourlyLimit: readIntEnv(
      "GATEWAY_DEVICE_HOURLY_LIMIT",
      DEFAULT_LIMITS.deviceHourlyLimit,
    ),
    deviceConcurrency: readIntEnv(
      "GATEWAY_DEVICE_CONCURRENCY",
      DEFAULT_LIMITS.deviceConcurrency,
    ),
    globalConcurrency: readIntEnv(
      "GATEWAY_GLOBAL_CONCURRENCY",
      DEFAULT_LIMITS.globalConcurrency,
    ),
    globalEnrollmentDailyLimit: readIntEnv(
      "GATEWAY_ENROLL_GLOBAL_DAILY_LIMIT",
      DEFAULT_LIMITS.globalEnrollmentDailyLimit,
    ),
    enrollHourlyLimitPerIp: readIntEnv(
      "GATEWAY_ENROLL_HOURLY_LIMIT_PER_IP",
      DEFAULT_LIMITS.enrollHourlyLimitPerIp,
    ),
    enrollDailyLimitPerIp: readIntEnv(
      "GATEWAY_ENROLL_DAILY_LIMIT_PER_IP",
      DEFAULT_LIMITS.enrollDailyLimitPerIp,
    ),
  },
});

gateway.listening
  .then(() => {
    const address = gateway.server.address();
    const boundPort =
      address && typeof address === "object" ? address.port : undefined;
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: "gateway_listening",
        host: process.env.GATEWAY_HOST ?? "127.0.0.1",
        port: boundPort,
      }),
    );
  })
  .catch(async () => {
    console.error(
      JSON.stringify({ event: "startup_failed", reason: "listen_failed" }),
    );
    await gateway.close();
    process.exitCode = 1;
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    gateway
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

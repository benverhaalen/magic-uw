import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";
const data = await mkdtemp(join(tmpdir(), "magic-smoke-"));
const child = spawn(electron as unknown as string, ["apps/desktop"], {
  env: {
    ...process.env,
    MAGIC_HEADLESS: "1",
    MAGIC_SMOKE: "1",
    MAGIC_USER_DATA: data,
    MAGIC_GATEWAY_URL: "",
  },
  stdio: "inherit",
});
const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
const code = await new Promise<number | null>((resolve) =>
  child.once("exit", resolve),
);
clearTimeout(timer);
await rm(data, { recursive: true, force: true });
if (code !== 0) process.exitCode = 1;

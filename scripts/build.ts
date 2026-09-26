import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { resolve } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
await build({
  entryPoints: [
    "apps/desktop/src/main.ts",
    "apps/desktop/src/preload.ts",
    "apps/desktop/src/worker.ts",
  ],
  outdir: "apps/desktop/dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
  sourcemap: false,
  logLevel: "warning",
});
await viteBuild({
  configFile: false,
  root: "apps/desktop",
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
  logLevel: "warn",
});
await mkdir("apps/web/dist", { recursive: true });
await copyFile("apps/web/index.html", "apps/web/dist/index.html");
console.log(
  "Built desktop main, isolated preload, local worker, renderer, and informational website.",
);

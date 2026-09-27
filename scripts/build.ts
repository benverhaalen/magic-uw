import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { resolve } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
// owner: T05e. The Remember my sign-in build switch (plan D39): a UW-licensed build runs
// `MAGIC_REMEMBER_SIGNIN=off pnpm build`. The value is baked into the bundle, so an environment
// variable at run time can't turn the feature back on.
const rememberSignIn = process.env.MAGIC_REMEMBER_SIGNIN === "off" ? "off" : "on";
await build({
  entryPoints: [
    "apps/desktop/src/main.ts",
    "apps/desktop/src/preload.ts",
    "apps/desktop/src/signin-preload.ts", // owner: T05e: the UW sign-in window's preload
    "apps/desktop/src/worker.ts",
    "apps/desktop/src/mcp-server.ts",
  ],
  outdir: "apps/desktop/dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  define: { "process.env.MAGIC_REMEMBER_SIGNIN": JSON.stringify(rememberSignIn) }, // owner: T05e
  external: ["electron", "pdfjs-dist/*"],
  sourcemap: false,
  logLevel: "warning",
});
// owner: acquisition: the extraction thread (extract-pool.ts), beside the utility bundle.
await build({
  entryPoints: ["packages/connectors/src/extract-worker.ts"],
  outfile: "apps/desktop/dist/extract-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron", "pdfjs-dist/*"],
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

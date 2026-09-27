import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { join } from "node:path";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const fonts = "packages/ui/assets/fonts";
const karma = await readFile(join(fonts, "Karma-Medium.ttf"));
await build({
  entryPoints: [
    "apps/desktop/src/main.ts",
    "apps/desktop/src/preload.ts",
    "apps/desktop/src/worker.ts",
    "apps/desktop/src/mcp-server.ts",
  ],
  outdir: "apps/desktop/dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
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
// Vite emits the CSS-referenced Karma file; ship its OFL beside it.
const rendererAssets = "apps/desktop/dist/renderer/assets";
const emitted = (await readdir(rendererAssets)).filter((name) =>
  /^Karma-Medium.*\.ttf$/.test(name),
);
if (emitted.length !== 1)
  throw new Error(`Expected one emitted Karma font, found ${emitted.length}.`);
if (!karma.equals(await readFile(join(rendererAssets, emitted[0]))))
  throw new Error("Emitted desktop Karma font differs from the supplied file.");
await copyFile(join(fonts, "Karma-OFL.txt"), join(rendererAssets, "Karma-OFL.txt"));
const geistFiles = (await readdir(rendererAssets)).filter(name => /^Geist-Variable.*\.woff2$/.test(name));
if (geistFiles.length !== 1 || !(await readFile(join(fonts, "Geist-Variable.woff2"))).equals(await readFile(join(rendererAssets, geistFiles[0]))))
  throw new Error("Emitted desktop Geist font differs from the supplied file.");
await copyFile(join(fonts, "Geist-OFL.txt"), join(rendererAssets, "Geist-OFL.txt"));
execFileSync(process.execPath, ["scripts/build-web.mjs"], { stdio: "inherit" });
console.log(
  "Built desktop main, isolated preload, local worker, renderer, and informational website.",
);

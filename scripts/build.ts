import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { join } from "node:path";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const fonts = "packages/ui/assets/fonts";
const lora = await readFile(join(fonts, "Lora-Medium.ttf"));
// owner: embedded-jev. Only a builder who sets MAGIC_EMBED_TYPESAFE_KEY embeds the owner's key
// (September 27 decision in docs/decisions.md). The key is extractable from that build, so it
// only reaches apps/desktop/src/embedded-jev.ts in main.cjs; dist/ is gitignored. Never printed.
const embeddedKey = process.env.MAGIC_EMBED_TYPESAFE_KEY?.trim() ?? "";
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
  define: { __MAGIC_EMBEDDED_TYPESAFE_KEY__: JSON.stringify(embeddedKey) },
});
console.log(embeddedKey
  ? "Embedded Jev: this build carries the TypeSafe key. Do not commit or publish dist/ publicly."
  : "Embedded Jev: no key embedded; Jev needs MAGIC_GATEWAY_URL.");
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
// Vite emits the CSS-referenced Lora file; ship its OFL beside it.
const rendererAssets = "apps/desktop/dist/renderer/assets";
const emitted = (await readdir(rendererAssets)).filter((name) =>
  /^Lora-Medium.*\.ttf$/.test(name),
);
if (emitted.length !== 1)
  throw new Error(`Expected one emitted Lora font, found ${emitted.length}.`);
if (!lora.equals(await readFile(join(rendererAssets, emitted[0]))))
  throw new Error("Emitted desktop Lora font differs from the supplied file.");
await copyFile(join(fonts, "Lora-OFL.txt"), join(rendererAssets, "Lora-OFL.txt"));
const geistFiles = (await readdir(rendererAssets)).filter(name => /^Geist-Variable.*\.woff2$/.test(name));
if (geistFiles.length !== 1 || !(await readFile(join(fonts, "Geist-Variable.woff2"))).equals(await readFile(join(rendererAssets, geistFiles[0]))))
  throw new Error("Emitted desktop Geist font differs from the supplied file.");
await copyFile(join(fonts, "Geist-OFL.txt"), join(rendererAssets, "Geist-OFL.txt"));
execFileSync(process.execPath, ["scripts/build-web.mjs"], { stdio: "inherit" });
console.log(
  "Built desktop main, isolated preload, local worker, renderer, and informational website.",
);

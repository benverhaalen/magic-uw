import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { join } from "node:path";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const fonts = "packages/ui/assets/fonts";
const karma = await readFile(join(fonts, "Karma-Medium.ttf"));
// owner: embedded-jev. Only a builder who sets MAGIC_EMBED_TYPESAFE_KEY embeds the owner's key
// (September 27 decision in docs/decisions.md). The key is extractable from that build, so it
// only reaches apps/desktop/src/embedded-jev.ts in main.cjs; dist/ is gitignored. Never printed.
const embeddedKey = process.env.MAGIC_EMBED_TYPESAFE_KEY?.trim() ?? "";
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
  external: ["electron", "pdfjs-dist/*"],
  sourcemap: false,
  logLevel: "warning",
  define: { __MAGIC_EMBEDDED_TYPESAFE_KEY__: JSON.stringify(embeddedKey), "process.env.MAGIC_REMEMBER_SIGNIN": JSON.stringify(rememberSignIn) },
});
console.log(embeddedKey
  ? "Embedded Jev: this build carries the TypeSafe key. Do not commit or publish dist/ publicly."
  : "Embedded Jev: no key embedded; Jev needs MAGIC_GATEWAY_URL.");
// Compile the product-owned macOS default-browser observer beside main.cjs.
// Unsupported platforms retain the typed unavailable result from the caller.
execFileSync(process.execPath, ["scripts/build-native-browser.mjs"], { stdio: "inherit" });
// Runtime window/Dock icon; editable vector and packaging assets stay in source.
for (const extension of ["png", "icns", "ico"])
  await copyFile(join("apps/desktop/assets", `app-icon.${extension}`), join("apps/desktop/dist", `app-icon.${extension}`));
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
  // owner: study-prep. Fonts are always emitted as files: the renderer's CSP (default-src 'self')
  // blocks data: fonts, and Vite would otherwise inline a small one (KaTeX_Size3 is 3.6 KB).
  build: { outDir: "dist/renderer", emptyOutDir: true, assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined) },
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
execFileSync(process.execPath, ["scripts/build-task-window-helper.mjs"], { stdio: "inherit" }); // owner: task-workspace
execFileSync(process.execPath, ["scripts/build-calendar-import-helper.mjs"], { stdio: "inherit" }); // owner: calendar-import
execFileSync(process.execPath, ["scripts/build-web.mjs"], { stdio: "inherit" });
console.log(
  "Built desktop main, isolated preload, local worker, renderer, and informational website.",
);

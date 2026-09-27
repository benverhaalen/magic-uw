import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { join } from "node:path";
import { mkdir, copyFile, readFile, readdir } from "node:fs/promises";
const fonts = "packages/ui/assets/fonts";
const lora = await readFile(join(fonts, "Lora-Medium.ttf"));
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
// The static website references fonts/Lora-Medium.ttf relative to index.html.
await mkdir("apps/web/dist/fonts", { recursive: true });
await copyFile("apps/web/index.html", "apps/web/dist/index.html");
for (const name of ["Lora-Medium.ttf", "Lora-OFL.txt"])
  await copyFile(join(fonts, name), join("apps/web/dist/fonts", name));
if (!(await readFile("apps/web/dist/index.html", "utf8")).includes('url("fonts/Lora-Medium.ttf")'))
  throw new Error("Website no longer references the copied Lora font path.");
console.log(
  "Built desktop main, isolated preload, local worker, renderer, and informational website.",
);

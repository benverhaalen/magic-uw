// The floating Stop window renders in the app's Geist 400 from the bundled font file, under a CSP that
// admits only inline style and that data font; no script, remote resource or bridge.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledGeist, floatingStopHtml } from "../apps/desktop/src/voice/floating-stop";

const GEIST = "packages/ui/assets/fonts/Geist-Variable.woff2";

test("floating Stop: Geist 400 from the bundled file, data-font-only CSP, clear focus ring and Stop label", async () => {
  // The build emits one hashed Geist beside the renderer; read it the way the host does.
  const root = await mkdtemp(join(tmpdir(), "stop-font-"));
  await mkdir(join(root, "assets"));
  await copyFile(GEIST, join(root, "assets", "Geist-Variable-abc123.woff2"));
  const font = await bundledGeist(pathToFileURL(join(root, "index.html")).toString());
  assert.ok(font && Buffer.from(font).equals(await readFile(GEIST)), "the embedded bytes are the supplied Geist file");
  const html = floatingStopHtml(font);
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"/);
  assert.match(html, /@font-face\{font-family:"Geist";src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\) format\("woff2"\);font-weight:100 900/);
  assert.match(html, /font:400 15px "Geist",system-ui,sans-serif/);
  assert.doesNotMatch(html, /font:500|<script|https?:/);
  assert.match(html, /a:focus-visible\{outline:2px solid #3c70ac/);
  assert.match(html, /<a href="magic-voice:stop" aria-label="Stop voice">.*Stop voice<\/a>/);
  assert.doesNotMatch(html, /aria-disabled/);
  // A missing file (a broken build) still renders the Stop control.
  assert.equal(await bundledGeist(pathToFileURL(join(root, "missing", "index.html")).toString()), undefined);
  assert.match(floatingStopHtml(), /Stop voice<\/a>/);
});

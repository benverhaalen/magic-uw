import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The floating Stop page: constant local content, no script, remote resource, app activation, or bridge.
 * The app's Geist 400 comes from the bundled font file as a data URL; the CSP admits only that data font
 * and inline style. Without the file (a broken build) the text still renders in the system face.
 */
export function floatingStopHtml(geistWoff2?: Uint8Array): string {
  const face = geistWoff2 ? `@font-face{font-family:"Geist";src:url(data:font/woff2;base64,${Buffer.from(geistWoff2).toString('base64')}) format("woff2");font-weight:100 900;font-style:normal}` : '';
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:">'
    + `<style>${face}html,body{margin:0;height:100%;background:#f9f6ee}a{display:flex;align-items:center;justify-content:center;gap:9px;height:100%;color:#29231f;font:400 15px "Geist",system-ui,sans-serif;text-decoration:none}a:focus-visible{outline:2px solid #3c70ac;outline-offset:-4px;border-radius:6px}span{height:11px;width:11px;border-radius:2px;background:#8b4941}</style>`
    + '<a href="magic-voice:stop" aria-label="Stop voice"><span aria-hidden="true"></span>Stop voice</a>';
}

/** The build emits exactly one Geist-Variable*.woff2 beside the renderer and checks it equals the supplied file. */
export async function bundledGeist(rendererURL: string): Promise<Uint8Array | undefined> {
  try {
    const assets = join(dirname(fileURLToPath(rendererURL)), 'assets');
    const name = (await readdir(assets)).find(n => /^Geist-Variable.*\.woff2$/.test(n));
    return name ? await readFile(join(assets, name)) : undefined;
  } catch { return undefined; }
}

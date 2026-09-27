// Builds the static website into apps/web/dist. Plain Node with no dependencies, so Vercel can
// run it without installing the desktop toolchain. Shared markup lives here once and is filled
// into every page's <!--#name--> markers. Colours come from the product seed
// (docs/design/tokens.css), copied in unchanged rather than re-declared.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = "apps/web";
const out = join(root, "dist");
const github = "https://github.com/benverhaalen/magic-uw";

const nav = [
  ["home", "/#how", "How it works"],
  ["pricing", "/pricing/", "Pricing"],
  ["devs", "/pricing/#pipeline", "For devs"],
  ["about", "/about/", "About us"],
  ["faq", "/faq/", "FAQ"],
];

const head = `<link rel="icon" href="/assets/logo/favicon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/assets/tokens.css" />
    <link rel="stylesheet" href="/assets/site.css" />`;

const header = (current) => `<header class="site-header">
        <a class="brand" href="/"><img src="/assets/logo/head-color.svg" alt="" width="46" height="100" /><span>My Magic UW</span></a>
        <nav class="site-nav" aria-label="Main">${nav
          .map(([key, href, label]) => `<a href="${href}"${key === current && key !== "home" ? ' aria-current="page"' : ""}>${label}</a>`)
          .join("")}</nav>
        <a class="btn btn-blue btn-sm" href="/#download">Download</a>
      </header>`;

const footer = `<footer class="site-footer">
        <div>My Magic UW · Built for Badger BuildFest 2026<small>My Magic UW is an independent student project. It is not affiliated with, sponsored by or endorsed by the University of Wisconsin–Madison.</small></div>
        <nav aria-label="Footer"><a href="${github}">GitHub</a><a href="/faq/#privacy">Privacy</a><a href="/about/">About us</a><a href="/faq/">FAQ</a></nav>
      </footer>`;

// Wizard marks are inlined rather than loaded with <img>, so the page's --wizard-robe variable
// (and a future theme colour) reaches the robe, sleeves and hat. Arm ids become classes because
// a page can show several wizards; the SVG files keep their hex fallbacks for other tools.
const logos = {};
for (const name of ["mark-color", "mark-on-dark", "head-color"]) {
  logos[name] = (await readFile(join(root, `assets/logo/${name}.svg`), "utf8"))
    .replace(/<metadata>[\s\S]*?<\/metadata>/, "")
    .replace(/ id="(arm-left|arm-right)"/g, ' class="$1"');
}
const inlineLogo = (name, width, height) =>
  logos[name].replace("<svg ", `<svg class="wizard" width="${width}" height="${height}" aria-hidden="true" focusable="false" `);
const logoImg = /<img src="\/assets\/logo\/(mark-color|mark-on-dark|head-color)\.svg" alt="" width="(\d+)" height="(\d+)" \/>/g;

const fill = (html) =>
  html
    .replace("<!--#head-->", head)
    .replace(/<!--#header (\w+)-->/, (_, current) => header(current))
    .replace("<!--#footer-->", footer)
    .replace("<!--#wizard-->", inlineLogo("mark-on-dark", 81, 130))
    .replace(logoImg, (_, name, width, height) => inlineLogo(name, width, height));

async function copy(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    if (from === out) continue;
    const to = join(out, relative(root, from));
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copy(from);
    } else if (entry.name.endsWith(".html")) {
      const html = fill(await readFile(from, "utf8"));
      const left = html.match(/<!--#[^>]*-->/);
      if (left) throw new Error(`${from}: unknown marker ${left[0]}`);
      await writeFile(to, html);
    } else {
      await cp(from, to);
    }
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copy(root);
await cp("docs/design/tokens.css", join(out, "assets/tokens.css"));
await mkdir(join(out, "assets/fonts"), { recursive: true });
for (const name of ["Karma-Medium.ttf", "Karma-OFL.txt"])
  await cp(join("packages/ui/assets/fonts", name), join(out, "assets/fonts", name));
console.log(`Built the website into ${out}.`);

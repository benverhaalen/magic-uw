// Builds the static website into apps/web/dist. Plain Node with no dependencies, so Vercel can
// run it without installing the desktop toolchain. Shared markup lives here once and is filled
// into every page's <!--#name--> markers.
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
    <link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Newsreader:opsz,wght@6..72,400;6..72,500&family=DM+Sans:wght@400;500;700&family=DM+Mono&family=Fredoka:wght@600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/assets/site.css" />`;

const header = (current) => `<header class="site-header">
        <a class="brand" href="/"><img src="/assets/logo/head-color.svg" alt="" width="46" height="100" /><span>Magic Canvas</span></a>
        <nav class="site-nav" aria-label="Main">${nav
          .map(([key, href, label]) => `<a href="${href}"${key === current && key !== "home" ? ' aria-current="page"' : ""}>${label}</a>`)
          .join("")}</nav>
        <a class="btn btn-blue btn-sm" href="/#download">Download</a>
      </header>`;

const footer = `<footer class="site-footer">
        <div>Magic Canvas · Built for Badger BuildFest 2026<small>Student project. Not an official UW–Madison service.</small></div>
        <nav aria-label="Footer"><a href="${github}">GitHub</a><a href="/faq/#privacy">Privacy</a><a href="/about/">About us</a><a href="/faq/">FAQ</a></nav>
      </footer>`;

const wizard = (await readFile(join(root, "assets/logo/mark-on-dark.svg"), "utf8")).replace(
  "<svg ",
  '<svg width="81" height="130" aria-hidden="true" ',
);

const fill = (html) =>
  html
    .replace("<!--#head-->", head)
    .replace(/<!--#header (\w+)-->/, (_, current) => header(current))
    .replace("<!--#footer-->", footer)
    .replace("<!--#wizard-->", wizard);

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
console.log(`Built the website into ${out}.`);

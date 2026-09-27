/**
 * A note as a Word document and back. Export: `docx` (MIT) writes a title, one Heading 2 per block
 * and one bullet per item (links kept). Import: `mammoth` (BSD-2-Clause) turns a .docx into HTML,
 * and `htmlToBlocks` turns that HTML (or Google Docs' HTML export) back into blocks, keeping the
 * ids, kinds and links of blocks and items whose text did not change.
 */
import { createHash } from "node:crypto";
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import mammoth from "mammoth";
import type { NoteBlock, NoteItem } from "@magic/contracts";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function noteToDocx(title: string, blocks: NoteBlock[]): Promise<Uint8Array> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 })];
  for (const block of blocks) {
    children.push(new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_2 }));
    for (const item of block.items) {
      const lines = item.text.split(/\r?\n/);
      const runs = lines.map((line, i) => new TextRun({ text: line, ...(i ? { break: 1 } : {}) }));
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: item.link
            ? [new ExternalHyperlink({ link: item.link.url, children: [new TextRun({ text: item.text, style: "Hyperlink" })] })]
            : runs,
        }),
      );
    }
  }
  const doc = new Document({ creator: "My Magic UW", title, sections: [{ children }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return result.value;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
function plain(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}
/** Google Docs wraps links as https://www.google.com/url?q=<target>; unwrap them. */
function linkOf(html: string): string | null {
  const m = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"/i.exec(html);
  if (!m) return null;
  let href = decode(m[1]!);
  try {
    const url = new URL(href);
    if (url.hostname === "www.google.com" && url.pathname === "/url" && url.searchParams.get("q")) href = url.searchParams.get("q")!;
    const target = new URL(href);
    return target.protocol === "https:" && !target.username && !target.password ? target.href : null;
  } catch {
    return null;
  }
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const idFor = (prefix: string, text: string, n: number) =>
  `${prefix}-${createHash("sha256").update(`${text}\u0000${n}`).digest("hex").slice(0, 12)}`;

/**
 * HTML (mammoth's or Google's export) back into blocks. `previous` is the version the remote was
 * made from: a heading that matches keeps its block's id, kind and hint; an item whose text matches
 * keeps its id, origin and link. Everything else is new text from the remote (origin "remote").
 */
export function htmlToBlocks(html: string, previous: NoteBlock[]): { title: string | null; blocks: NoteBlock[] } {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const clean = body.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "");
  const elements = [...clean.matchAll(/<(h[1-6]|p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi)];
  const byHeading = new Map(previous.map((b) => [norm(b.heading), b]));
  const blocks: NoteBlock[] = [];
  let title: string | null = null;
  let current: NoteBlock | null = null;
  const used = new Set<string>();
  for (const [, tag, attrs, inner] of elements) {
    const t = tag!.toLowerCase();
    // A <p> inside an <li> was already read with the item.
    const text = plain(inner!);
    if (t === "h1" || (t === "p" && /class="[^"]*\btitle\b/i.test(attrs!))) {
      if (title === null && text) title = text;
      continue;
    }
    if (/^h[2-6]$/.test(t)) {
      if (!text) continue;
      const prior = byHeading.get(norm(text));
      let id = prior && !used.has(prior.id) ? prior.id : idFor("sec", text, blocks.length);
      while (used.has(id)) id = `${id}x`;
      used.add(id);
      current = { id, kind: prior && prior.id === id ? prior.kind : "section", heading: text.slice(0, 200), ...(prior?.hint ? { hint: prior.hint } : {}), items: [] };
      blocks.push(current);
      continue;
    }
    if (!text) continue;
    if (t === "p" && /<\/?li\b/i.test(inner!)) continue;
    if (!current) {
      current = { id: idFor("sec", "Notes", 0), kind: "section", heading: "Notes", items: [] };
      blocks.push(current);
    }
    const priorBlock = previous.find((b) => b.id === current!.id);
    const priorItem = priorBlock?.items.find((i) => norm(i.text) === norm(text) && !current!.items.some((x) => x.id === i.id));
    const href = linkOf(inner!);
    const link: NoteItem["link"] | undefined =
      priorItem?.link && (!href || href === priorItem.link.url) ? priorItem.link : href ? { title: text.slice(0, 500), url: href } : undefined;
    current.items.push({
      id: priorItem?.id ?? idFor("r", text, current.items.length),
      text: text.slice(0, 20000),
      ...(link ? { link } : {}),
      origin: priorItem?.origin ?? "remote",
    });
  }
  return { title, blocks };
}

/** Text of a note for search (passages), in reading order. */
export function blocksText(blocks: NoteBlock[]): string {
  return blocks
    .map((b) => [b.heading, ...b.items.map((i) => i.text)].join("\n"))
    .join("\n\n")
    .trim();
}
/** Equal content, ignoring ids and origins. */
export function sameContent(a: NoteBlock[], b: NoteBlock[]): boolean {
  const shape = (x: NoteBlock[]) => JSON.stringify(x.map((bl) => [norm(bl.heading), bl.items.map((i) => norm(i.text))]));
  return shape(a) === shape(b);
}

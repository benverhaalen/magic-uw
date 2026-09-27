/**
 * Course documents for the synthetic replica (PDF, DOCX, PPTX with a real text layer) and the gold's
 * text extraction. The extraction uses pdfjs-dist and the Office XML directly, not the product's
 * documents.ts, so the gold does not share our extractor's behaviour.
 */
import { createRequire } from "node:module";

// fflate is a dependency of the connectors package, not of the root (as in tests/fix-acq-fixtures.ts).
const requireConnectors = createRequire(new URL("../../../packages/connectors/package.json", import.meta.url));
const fflate = requireConnectors("fflate") as {
  zipSync(files: Record<string, Uint8Array>): Uint8Array;
  unzipSync(data: Uint8Array): Record<string, Uint8Array>;
  strToU8(text: string): Uint8Array;
  strFromU8(data: Uint8Array): string;
};

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const latin1 = (s: string) => s.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");

function pdfFile(objects: string[]): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A text PDF: each page is a list of lines (Helvetica, one Tj per line). */
export function buildPdf(pages: string[][]): Uint8Array {
  const n = pages.length;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`];
  pages.forEach((lines, i) => {
    const ops = lines
      .map((line) => `(${latin1(line).replace(/([()\\])/g, "\\$1")}) Tj T*`)
      .join(" ");
    const stream = `BT /F1 11 Tf 14 TL 50 740 Td ${ops} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> >>`,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return pdfFile(objects);
}

/** A DOCX with one paragraph per entry. */
export function buildDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  return fflate.zipSync({
    "[Content_Types].xml": fflate.strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": fflate.strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": fflate.strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

/** A PPTX with one slide per entry (a title and bullet lines). */
export function buildPptx(slides: string[][]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const overrides = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");
  files["[Content_Types].xml"] = fflate.strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${overrides}</Types>`,
  );
  files["_rels/.rels"] = fflate.strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  );
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("");
  files["ppt/presentation.xml"] = fflate.strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = fflate.strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join("")}</Relationships>`,
  );
  slides.forEach((lines, i) => {
    const paragraphs = lines.map((line) => `<a:p><a:r><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`).join("");
    files[`ppt/slides/slide${i + 1}.xml`] = fflate.strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  });
  return fflate.zipSync(files);
}

function officeText(bytes: Uint8Array, part: RegExp, run: RegExp): string {
  const entries = fflate.unzipSync(bytes);
  const names = Object.keys(entries)
    .filter((name) => part.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0));
  const out: string[] = [];
  for (const name of names) {
    const xml = fflate.strFromU8(entries[name]!);
    for (const paragraph of xml.split(/<\/(?:w|a):p>/)) {
      const line = [...paragraph.matchAll(run)].map((m) => m[1]!).join("");
      if (line.trim()) out.push(line.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
    }
  }
  return out.join("\n");
}

/**
 * The gold's text for a document: pdfjs for PDF, the WordprocessingML/DrawingML runs for DOCX and
 * PPTX, UTF-8 for text. `undefined` for formats the gold does not read (the file is then scored on
 * presence only).
 */
export async function goldDocumentText(bytes: Uint8Array, name: string, contentType = ""): Promise<string | undefined> {
  const lower = name.toLowerCase();
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
    try {
      const pdf = await task.promise;
      const pages: string[] = [];
      for (let n = 1; n <= Math.min(pdf.numPages, 300); n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        pages.push(content.items.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "")).join(""));
      }
      return pages.join("\n");
    } finally {
      await task.destroy();
    }
  }
  if (lower.endsWith(".docx")) return officeText(bytes, /^word\/document\.xml$/, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g);
  if (lower.endsWith(".pptx")) return officeText(bytes, /^ppt\/slides\/slide\d+\.xml$/, /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g);
  if (/^text\//i.test(contentType) || /\.(txt|md|csv)$/.test(lower)) return new TextDecoder().decode(bytes);
  return undefined;
}

/** Whether a file's type is one a complete ingestion is expected to extract text from. */
export function textBearing(name: string, contentType: string | null | undefined): boolean {
  return /\.(pdf|docx|pptx|txt|md)$/i.test(name) || /^(application\/pdf|text\/)/i.test(contentType ?? "");
}

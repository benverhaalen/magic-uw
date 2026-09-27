// owner: acquisition. Synthetic documents for the acquisition tests and the perf stage: text PDFs,
// image-only (scanned) PDFs, DOCX files and PNG images, all generated here; no course data.
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

// fflate and @napi-rs/canvas are dependencies of connectors and pdfjs-dist, not of the root.
const requireConnectors = createRequire(new URL("../packages/connectors/package.json", import.meta.url));
const { zipSync, strToU8 } = requireConnectors("fflate") as {
  zipSync(files: Record<string, Uint8Array>): Uint8Array;
  strToU8(text: string): Uint8Array;
};

function pdf(objects: string[] | (string | Uint8Array)[][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  push("%PDF-1.4\n");
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    push(`${index + 1} 0 obj\n`);
    for (const part of Array.isArray(object) ? object : [object]) push(part);
    push("\nendobj\n");
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
/** A PDF with one text line per page (a real text layer). */
export function textPdf(pages: string[]): Uint8Array {
  const n = pages.length;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 14 Tf 40 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return pdf(objects);
}
const requireFromPdfjs = createRequire(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
interface NapiCanvas {
  createCanvas(width: number, height: number): {
    getContext(kind: "2d"): {
      fillStyle: string;
      font: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      fillText(text: string, x: number, y: number): void;
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    toBuffer(type: "image/png"): Buffer;
  };
}
const napi = () => requireFromPdfjs("@napi-rs/canvas") as NapiCanvas;
function drawText(text: string, width = 900, height = 160) {
  const canvas = napi().createCanvas(width, height),
    g = canvas.getContext("2d");
  g.fillStyle = "white";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "black";
  g.font = "44px sans-serif";
  g.fillText(text, 24, 96);
  return canvas;
}
/** A PNG of one line of text. */
export function textPng(text: string): Uint8Array {
  return drawText(text).toBuffer("image/png");
}
/** A one-page PDF whose only content is an image of the text: no text layer, as a scan. */
export function scannedPdf(text: string): Uint8Array {
  const width = 900,
    height = 160,
    canvas = drawText(text, width, height);
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]!;
    rgb[j + 1] = rgba[i + 1]!;
    rgb[j + 2] = rgba[i + 2]!;
  }
  const image = deflateSync(rgb);
  const draw = `q 540 0 0 96 36 600 cm /Im1 Do Q`;
  return pdf([
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>"],
    [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`],
    [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.byteLength} >>\nstream\n`,
      image,
      "\nendstream",
    ],
  ]);
}
/** A minimal DOCX with the given paragraphs. */
export function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

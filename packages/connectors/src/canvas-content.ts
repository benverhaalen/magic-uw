import { Parser } from "htmlparser2";
import { CanvasFailure } from "./canvas-http";

/** Capability URLs are never evidence URLs. File IDs are retained separately. */
export function safeCanvasEvidenceUrl(
  input: string | undefined | null,
  base: string,
): string | undefined {
  if (!input || input.includes("[private-link-removed]")) return undefined;
  try {
    const url = new URL(input, base);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.toString().length > 4000 ||
      /\/feeds\/calendars\//i.test(decodeURIComponent(url.pathname)) ||
      /token|password|cookie|authorization|signature|credential|secret|session/i.test(
        url.hash,
      )
    )
      return undefined;
    if (
      [...url.searchParams.keys()].some((key) =>
        /token|password|cookie|authorization|signature|credential|verifier|secret|api.?key|session|x-amz|x-goog/i.test(
          key,
        ),
      )
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
function decodeAttribute(value: string): string {
  let text = "";
  const parser = new Parser(
    {
      ontext(part) {
        text += part;
      },
    },
    { decodeEntities: true },
  );
  parser.end(value);
  return text;
}
export function canvasContent(
  html: string,
  base: string,
): { rawHtml: string; text: string; links: Array<{ url: string }> } {
  // Preserve source markup, apart from capability-bearing URLs which may never enter the store.
  const redact = (value: string): string => {
    const decoded = decodeAttribute(value);
    if (safeCanvasEvidenceUrl(decoded, base)) return value;
    try {
      const url = new URL(decoded, base);
      // Recover the stable file identity from a verifier URL without retaining its capability.
      if (
        url.origin === new URL(base).origin &&
        !url.username &&
        !url.password &&
        /^\/(?:courses\/\d+\/)?files\/\d+(?:\/download)?$/.test(url.pathname)
      )
        return `${url.origin}${url.pathname.replace(/\/download$/, "")}`;
    } catch {}
    return "[private-link-removed]";
  };
  const rawHtml = html
    .replace(
      /((?:href|src|action|data-api-endpoint)\s*=\s*)(?:"([^"<>]*)"|'([^'<>]*)'|([^\s<>]+))/gi,
      (
        _match,
        prefix: string,
        double: string | undefined,
        single: string | undefined,
        bare: string | undefined,
      ) => `${prefix}"${redact(double ?? single ?? bare ?? "")}"`,
    )
    .replace(/(?:https?:\/\/|\/\/|\/feeds\/calendars\/)[^\s<>"']+/gi, redact);
  const pieces: string[] = [],
    urls = new Set<string>();
  const hidden = new Set([
    "script",
    "style",
    "template",
    "noscript",
    "iframe",
    "object",
    "svg",
  ]);
  const blocks = new Set([
    "p",
    "div",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "br",
    "tr",
    "section",
    "article",
    "blockquote",
    "pre",
    "table",
  ]);
  let suppressed = 0;
  const add = (input: string) => {
    const url = safeCanvasEvidenceUrl(input, base);
    if (url) urls.add(url);
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (hidden.has(name)) suppressed++;
        if (!suppressed && blocks.has(name)) pieces.push("\n");
        if (!suppressed && (name === "a" || name === "link") && attributes.href)
          add(attributes.href);
        if (!suppressed && name === "img" && attributes.src)
          add(attributes.src);
      },
      ontext(text) {
        if (!suppressed) pieces.push(text);
      },
      onclosetag(name) {
        if (hidden.has(name)) suppressed = Math.max(0, suppressed - 1);
        if (!suppressed && blocks.has(name)) pieces.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.end(rawHtml);
  const text = pieces
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g))
    add(match[0].replace(/[.,;!?)]+$/, ""));
  if (text.length > 200_000 || urls.size > 2000)
    throw new CanvasFailure("partial", "content_limit");
  return { rawHtml, text, links: [...urls].map((url) => ({ url })) };
}

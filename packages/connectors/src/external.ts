import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { safeCanvasEvidenceUrl } from "./canvas-content";
import {
  captureBatchSchema,
  resourceInputSchema,
  type CaptureBatch,
  type Connector,
  type ResourceInput,
} from "@magic/contracts";
import {
  MaterialReadError,
  publicUrl,
  readBounded,
  type PublicClient,
  type PublicResponse,
} from "./network.ts";

export const contentHash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const NEVER_CONTENT = [
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "linkedin.com",
  "reddit.com",
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "discord.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.wisc.edu",
  "idp.wisc.edu",
];
export function isBlockedContentHost(host: string): boolean {
  return NEVER_CONTENT.some(
    (item) => host === item || host.endsWith(`.${item}`),
  );
}
export function cleanLink(value: string, base: string): string | undefined {
  if (value.includes("[private-link-removed]")) return undefined;
  try {
    const url = publicUrl(new URL(value, base).href);
    return url.href;
  } catch {
    return undefined;
  }
}
/** Remove URL capabilities from content as well as its extracted link list.
 * Recognition covers literal, entity-encoded, JSON-escaped and percent-encoded
 * URLs; this is not a general detector for secrets written as ordinary prose.
 */
export function sanitizeMaterialContent(input: string, base: string): string {
  const redact = (value: string): string => {
    if (!/[/?#:&%]|\\u/i.test(value)) return value;
    let decoded = "";
    new Parser(
      {
        ontext(text) {
          decoded += text;
        },
      },
      { decodeEntities: true },
    ).end(value);
    decoded = decoded
      .replace(/\\\//g, "/")
      .replace(/\\u([a-f0-9]{4})/gi, (_match, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    // Decode for recognition only. Valid content keeps its original spelling.
    for (let round = 0; round < 2 && /%[a-f0-9]{2}/i.test(decoded); round++) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        break;
      }
    }
    if (!/[?#]|https?:|\/\/|(?:feeds|calendar_feeds)\//i.test(decoded))
      return value;
    try {
      const url = new URL(decoded, base);
      publicUrl(url.href);
      if (safeCanvasEvidenceUrl(url.href, base)) return value;
    } catch {
      /* An unsafe URL is replaced, never copied into a diagnostic. */
    }
    return "[private-link-removed]";
  };
  return input.replace(/[^\s<>"'`()[\]{}]+/g, (value) => redact(value));
}
export function isLoginHtml(body: string): boolean {
  return (
    /<input[^>]+type=["']?password/i.test(body) ||
    /<form[^>]+(?:login|signin|sign_in|\/saml|\/idp\/)/i.test(body) ||
    /<title[^>]*>[^<]*(?:sign[ -]?in|log[ -]?in|authentication required)[^<]*<\/title>/i.test(
      body,
    )
  );
}
/** Parse only. Markup/scripts never execute and cannot start network requests. */
export function extractLinkedText(
  input: string,
  base: string,
  html = true,
): { text: string; links: string[]; title: string; embeddedJson: boolean } {
  input = sanitizeMaterialContent(input, base);
  const links = new Set<string>();
  const text: string[] = [];
  let title = "";
  let inTitle = false;
  let hidden = 0;
  let script = "";
  let scriptType = "";
  const json: string[] = [];
  const add = (value: string) => {
    const url = cleanLink(value, base);
    if (url) links.add(url);
  };
  if (html) {
    new Parser(
      {
        onopentag(name, attrs) {
          if (name === "title") inTitle = true;
          if (["script", "style", "template", "noscript", "svg"].includes(name))
            hidden++;
          if (name === "script") {
            script = "";
            scriptType = attrs.type ?? "";
            if (attrs.src && /\.json(?:$|\?)/i.test(attrs.src)) add(attrs.src);
          }
          if (["a", "area", "link"].includes(name) && attrs.href)
            add(attrs.href);
          if (["iframe", "embed", "source"].includes(name) && attrs.src)
            add(attrs.src);
          if (name === "object" && attrs.data) add(attrs.data);
          if (
            !hidden &&
            /^(?:p|div|br|li|tr|h[1-6]|section|article|pre)$/.test(name)
          )
            text.push("\n");
        },
        ontext(value) {
          if (inTitle) title += value;
          if (hidden) script += value;
          else text.push(value);
        },
        onclosetag(name) {
          if (name === "script") {
            if (/json/i.test(scriptType)) json.push(script);
            // Common static schedule assignments: JSON is parsed, never evaluated.
            else {
              const match = script.match(
                /(?:const|let|var)\s+(?:schedule|courseData|events)\s*=\s*([\[{][\s\S]*[\]}])\s*;?\s*$/,
              );
              if (match) json.push(match[1]!);
            }
          }
          if (["script", "style", "template", "noscript", "svg"].includes(name))
            hidden = Math.max(0, hidden - 1);
          if (name === "title") inTitle = false;
        },
      },
      { decodeEntities: true },
    ).end(input);
  } else text.push(input);
  let plain = text
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let embeddedJson = false;
  if (
    !html ||
    plain.length < 500 ||
    /loading|javascript required|enable javascript|schedule will/i.test(plain)
  ) {
    const candidates = html ? json : [/^\s*[\[{]/.test(input) ? input : ""];
    for (const candidate of candidates) {
      try {
        const root: unknown = JSON.parse(candidate);
        const strings: string[] = [];
        let nodes = 0;
        function walk(value: unknown, depth: number): void {
          if (++nodes > 10000 || depth > 15) return;
          if (typeof value === "string") {
            strings.push(value);
            if (
              /^(?:https?:|\.{0,2}\/)/i.test(value) ||
              /\.(?:pdf|html?|json|ipynb|md|txt)(?:$|\?)/i.test(value)
            )
              add(value);
          } else if (Array.isArray(value))
            value.forEach((item) => walk(item, depth + 1));
          else if (value && typeof value === "object")
            Object.values(value).forEach((item) => walk(item, depth + 1));
        }
        walk(root, 0);
        if (html && strings.length) {
          plain += `\n\nEmbedded schedule data:\n${strings.join("\n")}`;
          embeddedJson = true;
        }
        if (
          !html &&
          root &&
          typeof root === "object" &&
          "cells" in root &&
          Array.isArray(root.cells)
        ) {
          plain = root.cells
            .map((cell, index) => {
              if (!cell || typeof cell !== "object" || !("source" in cell))
                return "";
              const source =
                typeof cell.source === "string"
                  ? cell.source
                  : Array.isArray(cell.source)
                    ? cell.source
                        .filter((part: unknown) => typeof part === "string")
                        .join("")
                    : "";
              return `Cell ${index + 1}\n${source}`;
            })
            .join("\n\n");
        }
      } catch {
        /* Ordinary prose is not JSON. */
      }
    }
  }
  for (const match of input.matchAll(/https?:\/\/[^\s<>"'`\\]+/g))
    add(match[0].replace(/[),.;]+$/, ""));
  for (const match of plain.matchAll(
    /\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g,
  ))
    add(match[1]!);
  for (const match of plain.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm))
    add(match[1]!);
  for (const match of plain.matchAll(
    /["']((?:\.{0,2}\/)?[^\s"']+\.(?:csv|json|pdf|ipynb|txt|md))["']/gi,
  ))
    add(match[1]!);
  return {
    text: sanitizeMaterialContent(plain, base),
    title: sanitizeMaterialContent(title.trim(), base),
    links: [...links],
    embeddedJson,
  };
}
function folder(input: string): string {
  const url = new URL(input);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.endsWith("/")
    ? url.pathname
    : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  return url.href;
}
function inScope(input: string, roots: Set<string>): boolean {
  const url = new URL(input);
  return [...roots].some((root) => {
    const base = new URL(root);
    return base.origin === url.origin && url.pathname.startsWith(base.pathname);
  });
}

/** RFC 9309 longest matching Allow/Disallow rule for our product token or wildcard. */
export function robotsAllows(text: string, input: string): boolean {
  const normalized = (value: string) =>
    encodeURI(value)
      .replace(/%25([a-f0-9]{2})/gi, "%$1")
      .replace(/%([a-f0-9]{2})/gi, (encoded, hex: string) => {
        const character = String.fromCharCode(parseInt(hex, 16));
        return /[a-z0-9._~-]/i.test(character)
          ? character
          : encoded.toUpperCase();
      });
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let current = {
    agents: [] as string[],
    rules: [] as { allow: boolean; path: string }[],
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (name === "user-agent") {
      if (current.rules.length) {
        groups.push(current);
        current = { agents: [], rules: [] };
      }
      current.agents.push(value.toLowerCase());
    } else if (
      (name === "allow" || name === "disallow") &&
      current.agents.length &&
      value
    )
      current.rules.push({ allow: name === "allow", path: value });
  }
  groups.push(current);
  const specific = groups.filter((group) =>
    group.agents.some(
      (agent) => agent !== "*" && "magiccanvas".includes(agent),
    ),
  );
  const rules = (
    specific.length
      ? specific
      : groups.filter((group) => group.agents.includes("*"))
  ).flatMap((group) => group.rules);
  const url = new URL(input);
  const path = normalized(url.pathname + url.search);
  let winner = { length: -1, allow: true };
  for (const rule of rules) {
    const terminal = rule.path.endsWith("$");
    const pattern = normalized(terminal ? rule.path.slice(0, -1) : rule.path);
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    const length = Buffer.byteLength(pattern.replaceAll("*", ""));
    if (
      new RegExp(`^${source}${terminal ? "$" : ""}`).test(path) &&
      (length > winner.length || (length === winner.length && rule.allow))
    )
      winner = { length, allow: rule.allow };
  }
  return winner.allow;
}
export interface ExternalCourseOptions {
  accountScope: string;
  courseId: string;
  courseName: string;
  seeds: string[];
  client: PublicClient;
  previous?: ResourceInput[];
  force?: boolean;
  maxDepth?: number;
  maxPages?: number;
  now?: () => Date;
  onCanvasLink?: (url: string) => void | Promise<void>;
  onDocument?: (input: {
    url: string;
    discoveredFrom: string;
    depth: number;
    response: PublicResponse;
    signal?: AbortSignal;
  }) => Promise<ResourceInput>;
}
export function externalCourseConnector(
  options: ExternalCourseOptions,
): Connector {
  const source: CaptureBatch["source"] = {
    id: `web:${contentHash(`${options.accountScope}:${options.courseId}`).slice(0, 24)}`,
    label: `${options.courseName} course websites`,
    kind: "web",
    accountScope: options.accountScope,
    courseId: options.courseId,
    scope: "course_websites",
  };
  return {
    id: source.id,
    async *pull(signal) {
      const now = (options.now ?? (() => new Date()))();
      const started = Date.now();
      const roots = new Set<string>();
      const queue: { url: string; from: string; depth: number }[] = [];
      const seen = new Set<string>();
      const resources: ResourceInput[] = [];
      const diagnostics: NonNullable<CaptureBatch["diagnostics"]> = [];
      const previous = new Map(
        options.previous?.map((resource) => [
          resource.url,
          resourceInputSchema.strip().parse({
            ...resource,
            title: sanitizeMaterialContent(resource.title, resource.url),
            text: sanitizeMaterialContent(resource.text, resource.url),
            ...(resource.rawHtml !== undefined
              ? {
                  rawHtml: sanitizeMaterialContent(
                    resource.rawHtml,
                    resource.url,
                  ),
                }
              : {}),
          }),
        ]),
      );
      const robots = new Map<string, string>();
      let attention = false;
      let pages = 0, attempts = 0;
      const pageLimit = Math.max(1, Math.min(options.maxPages ?? 300, 1000));
      const queued = new Set<string>();
      const enqueue = (item: { url: string; from: string; depth: number }) => {
        if (queued.has(item.url)) return;
        if (queued.size >= 10000) { issue("frontier_limit"); return; }
        queued.add(item.url); queue.push(item);
      };
      const issue = (code: string) => {
        if (diagnostics.length < 2000)
          diagnostics.push({ code, path: [], severity: "warning" });
      };
      for (const seed of options.seeds) {
        const url = cleanLink(seed, seed);
        if (!url) {
          issue("unsafe_link");
          continue;
        }
        if (options.client.isCanvas(url)) {
          await options.onCanvasLink?.(url);
          continue;
        }
        if (isBlockedContentHost(new URL(url).hostname)) continue;
        roots.add(folder(url));
        enqueue({ url, from: url, depth: 0 });
      }
      async function allowed(url: string): Promise<boolean> {
        const origin = new URL(url).origin;
        if (!robots.has(origin)) {
          try {
            const result = await options.client.text(`${origin}/robots.txt`, {
              signal,
              maxBytes: 512000,
              onRedirect: (target) => new URL(target).origin === origin,
            });
            robots.set(origin, result.text);
          } catch (error) {
            // owner: acquisition: RFC 9309 §2.3.1.3: robots.txt "unavailable" (any 4xx) means no
            // rules; §2.3.1.4: unreachable (5xx, network) stays disallowed.
            const status =
              error instanceof MaterialReadError
                ? (error.detail.status ??
                  (error.code === "not_found" ? 404 : error.code === "inaccessible" ? 403 : undefined))
                : undefined;
            if (status !== undefined && status >= 400 && status < 500) robots.set(origin, "");
            else throw error;
          }
        }
        return robotsAllows(robots.get(origin)!, url);
      }
      // A single in-flight page per course keeps every host below the external two-request ceiling.
      while (queue.length && pages < pageLimit && attempts < pageLimit * 2 && Date.now() - started < 120000) {
        signal?.throwIfAborted();
        queue.sort((a,b) => a.depth - b.depth || Number(previous.has(a.url)) - Number(previous.has(b.url)));
        const next = queue.shift()!;
        if (seen.has(next.url)) continue;
        seen.add(next.url);
        try {
          if (!(await allowed(next.url))) {
            issue("robots_disallowed");
            continue;
          }
          const cached = previous.get(next.url);
          // owner: acquisition: a document records `fetchedAt`, a page `observedAt`; reading only
          // `observedAt` made every course-site PDF re-download on every crawl.
          const fetchedAt = cached?.crawl?.observedAt ?? cached?.crawl?.fetchedAt;
          if (
            !options.force &&
            cached &&
            fetchedAt &&
            now.getTime() >= Date.parse(fetchedAt) &&
            now.getTime() - Date.parse(fetchedAt) < 6 * 60 * 60 * 1000
          ) {
            resources.push(cached); // Cached traversal does not consume the new-page budget.
            for (const link of cached.links ?? []) {
              const url = typeof link === "string" ? link : link.url;
              if (options.client.isCanvas(url)) {
                await options.onCanvasLink?.(url);
                continue;
              }
              if (
                !inScope(url, roots) ||
                seen.has(url) ||
                isBlockedContentHost(new URL(url).hostname)
              )
                continue;
              if (next.depth >= (options.maxDepth ?? 6)) {
                issue("depth_limit");
                continue;
              }
              enqueue({ url, from: next.url, depth: next.depth + 1 });
            }
            continue;
          }
          // Walking saved ancestors is local continuation work, not a new page request.
          // The deduplicated frontier and elapsed-time limits still bound that traversal.
          attempts++;
          const fetched = await options.client.get(next.url, {
            signal,
            // owner: acquisition: a stored document with a Last-Modified is asked for only if newer.
            ...(!options.force && cached?.document?.updatedAt && cached.document.extractionStatus === "ok"
              ? { conditional: { lastModified: new Date(cached.document.updatedAt).toUTCString() } }
              : {}),
            onRedirect: async (target) => {
              if (options.client.isCanvas(target)) {
                await options.onCanvasLink?.(target);
                return false;
              }
              if (
                isBlockedContentHost(new URL(target).hostname) ||
                !(await allowed(target))
              )
                return false;
              roots.add(folder(target));
              return true;
            },
          });
          if (fetched.notModified && cached) {
            // owner: acquisition: unchanged since the stored copy; keep it and restart its window.
            pages++;
            resources.push({
              ...cached,
              crawl: { ...cached.crawl, fetchedAt: now.toISOString() },
            });
            continue;
          }
          if (fetched.url !== next.url && seen.has(fetched.url)) {
            await fetched.response.body?.cancel();
            continue;
          }
          seen.add(fetched.url);
          pages++;
          const contentType = (
            fetched.response.headers.get("content-type") ??
            "application/octet-stream"
          )
            .split(";")[0]!
            .trim();
          const isText =
            /(?:text\/|json|javascript|xml)/i.test(contentType) ||
            /\.(?:ipynb|md|txt|json|html?)$/i.test(
              new URL(fetched.url).pathname,
            );
          if (!isText) {
            if (options.onDocument) {
              const document = await options.onDocument({
                url: fetched.url,
                discoveredFrom: next.from,
                depth: next.depth,
                response: fetched,
                signal,
              });
              if (
                document.document?.extractionStatus &&
                document.document.extractionStatus !== "ok"
              ) {
                issue(`document_${document.document.extractionStatus}`);
                resources.push(cached ?? document);
              } else resources.push(document);
            } else {
              await fetched.response.body?.cancel();
              issue("document_adapter_missing");
            }
            continue;
          }
          const body = sanitizeMaterialContent(
            await readBounded(fetched.response, 1_000_000, signal),
            fetched.url,
          );
          const isHtml =
            /html/i.test(contentType) ||
            /^\s*<!doctype html|^\s*<html/i.test(body);
          if (isHtml && isLoginHtml(body))
            throw new MaterialReadError("login_page");
          const parsed = extractLinkedText(body, fetched.url, isHtml);
          if (parsed.text.length > 200000 || parsed.links.length > 4000)
            throw new MaterialReadError("content_limit");
          if (
            cached &&
            cached.text.length > 300 &&
            parsed.text.length < cached.text.length * 0.25
          ) {
            attention = true;
            issue("content_shape_loss");
            resources.push(cached);
            continue;
          }
          const resource = resourceInputSchema.parse({
            externalId: contentHash(fetched.url),
            kind: "material",
            courseId: options.courseId,
            courseName: options.courseName,
            title:
              parsed.title ||
              decodeURIComponent(
                new URL(fetched.url).pathname.split("/").pop() ||
                  "Course website",
              ),
            url: fetched.url,
            text: parsed.text,
            ...(isHtml ? { rawHtml: body } : {}),
            links: parsed.links,
            contentType,
            crawl: {
              discoveredFrom: next.from,
              depth: next.depth,
              contentType,
              contentHash: contentHash(body),
              observedAt: now.toISOString(),
            },
          });
          resources.push(resource);
          for (const url of parsed.links) {
            if (options.client.isCanvas(url)) {
              await options.onCanvasLink?.(url);
              continue;
            }
            if (
              isBlockedContentHost(new URL(url).hostname) ||
              !inScope(url, roots) ||
              seen.has(url)
            )
              continue;
            if (next.depth >= (options.maxDepth ?? 6)) {
              issue("depth_limit");
              continue;
            }
            enqueue({ url, from: fetched.url, depth: next.depth + 1 });
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          issue(
            error instanceof MaterialReadError ? error.code : "read_failed",
          );
        }
      }
      if (queue.some((item) => !seen.has(item.url))) issue(attempts >= pageLimit * 2 ? "attempt_limit" : Date.now() - started >= 120000 ? "time_limit" : "page_limit");
      yield captureBatchSchema.parse({
        source,
        observedAt: now.toISOString(),
        complete: diagnostics.length === 0,
        status: attention
          ? "needs_attention"
          : diagnostics.length
            ? "partial"
            : "ok",
        resources,
        diagnostics,
        stats: {
          durationMs: Date.now() - started,
          pages,
          records: resources.length,
        },
      });
    },
  };
}

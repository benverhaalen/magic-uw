import type {
  DeadlineEvidenceClaim,
  DeadlineOrigin,
  Resource,
  SourceHealth,
  UnresolvedDeadlineMention,
} from "@magic/contracts";
import {
  extractDeadlineMentions,
  identifiersIn,
  validateDeadlineSpan,
  type DeadlineMention,
  type ExtractionAnchors,
} from "@magic/domain";

const DAY = 86_400_000;
/** Approximate UW term windows, used only when Canvas gives no course dates. Resolver adds slack. */
export function termFromName(name: string | undefined) {
  const m = /\b(fall|spring|summer)\s+(\d{4})\b/i.exec(name ?? "");
  if (!m) return null;
  const y = Number(m[2]);
  const [start, end] = {
    fall: [`${y}-08-25`, `${y}-12-23`],
    spring: [`${y}-01-15`, `${y}-05-20`],
    summer: [`${y}-05-15`, `${y}-08-20`],
  }[m[1]!.toLowerCase() as "fall" | "spring" | "summer"];
  return { start: `${start}T12:00:00Z`, end: `${end}T12:00:00Z` };
}
const normalizedTitle = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Content-addressed across snapshots: key covers version, hash, field, and every anchor. */
const mentionCache = new Map<string, DeadlineMention[]>();
const MENTION_CACHE_LIMIT = 5000;

interface Found {
  claims: DeadlineEvidenceClaim[];
  unresolved: UnresolvedDeadlineMention[];
}

/**
 * Deterministic prose deadline evidence for assignments, derived at read time.
 * Scope: only the assignment's own title/description, and announcements, the
 * syllabus, and course pages from the same account and course that name the
 * assignment by exact title or by an identifier ("HW3") unique in that course.
 */
export function proseDeadlines(
  resources: Resource[],
  sources: Map<string, SourceHealth>,
) {
  const courseKey = (r: Resource) =>
    `${sources.get(r.sourceId)?.accountScope}:${r.courseId}`;
  const byCourse = new Map<string, Resource[]>();
  for (const r of resources)
    byCourse.set(courseKey(r), [...(byCourse.get(courseKey(r)) ?? []), r]);
  const terms = new Map<string, ExtractionAnchors["term"]>();
  function term(key: string) {
    if (!terms.has(key)) {
      const rows = byCourse.get(key) ?? [];
      const dated = rows.find(
        (r) =>
          r.course?.startAt &&
          r.course.endAt &&
          Date.parse(r.course.endAt) > Date.parse(r.course.startAt) &&
          Date.parse(r.course.endAt) - Date.parse(r.course.startAt) < 200 * DAY,
      );
      terms.set(
        key,
        dated
          ? { start: dated.course!.startAt!, end: dated.course!.endAt! }
          : termFromName(rows.find((r) => r.course?.termName)?.course?.termName),
      );
    }
    return terms.get(key) ?? null;
  }
  function originOf(r: Resource): DeadlineOrigin | null {
    if (r.kind === "message")
      return sources.get(r.sourceId)?.scope === "announcements" ? "announcement" : null;
    if (r.kind !== "material" || !r.text) return null;
    // owner: site-recipes: a course website's organized items (D32) are page evidence, below Canvas.
    if (sources.get(r.sourceId)?.kind === "site") return "page";
    if (r.externalId === "syllabus" || /\bsyllabus\b/i.test(r.title)) return "syllabus";
    return /\/pages\//.test(r.url) ? "page" : null;
  }
  function mentions(r: Resource, field: "title" | "text") {
    const statedAt = originOf(r) === "announcement" ? r.createdAt ?? undefined : undefined;
    const key = JSON.stringify([r.id, r.version, r.contentHash, field, statedAt, r.updatedAt ?? r.createdAt, term(courseKey(r))]);
    let found = mentionCache.get(key);
    if (!found) {
      found = extractDeadlineMentions(
        {
          resourceId: r.id,
          version: r.version,
          contentHash: r.contentHash,
          field,
          text: field === "title" ? r.title : r.text,
        },
        {
          ...(statedAt ? { statedAt } : {}),
          ...(r.updatedAt || r.createdAt ? { sourceDate: (r.updatedAt ?? r.createdAt)! } : {}),
          term: term(courseKey(r)),
        },
      );
      if (mentionCache.size >= MENTION_CACHE_LIMIT)
        mentionCache.delete(mentionCache.keys().next().value!);
      mentionCache.set(key, found);
    }
    // Revalidate on every use: a span is shown only if it is a literal slice of this exact version.
    return found.filter((m) => validateDeadlineSpan(r, m.span));
  }
  function add(
    out: Found,
    m: DeadlineMention,
    origin: DeadlineOrigin,
    scopeConfirmed: boolean,
    statedAt?: string,
    note?: string,
  ) {
    if (m.previous) return; // Carried as `supersedes` on the change it belongs to.
    if (!m.value) {
      out.unresolved.push({ kind: m.kind, origin, span: m.span, reason: m.unresolvedReason ?? "Unresolved." });
      return;
    }
    const notes = [m.note, note].filter(Boolean).join(" ");
    out.claims.push({
      value: m.value,
      kind: m.kind,
      quote: m.span.text.slice(0, 4000),
      authority: m.change ? "explicit_change" : origin === "title" ? "title" : "document",
      scopeConfirmed,
      origin,
      span: m.span,
      ...(m.detail ? { detail: m.detail } : {}),
      ...(m.precision ? { precision: m.precision } : {}),
      ...(m.inference ? { inference: m.inference } : {}),
      ...(m.supersedes ? { supersedes: m.supersedes } : {}),
      ...(statedAt ? { statedAt } : {}),
      ...(notes ? { note: notes } : {}),
    });
  }
  const normalized = new WeakMap<DeadlineMention, string>();
  const normalizedSpan = (m: DeadlineMention) => {
    let text = normalized.get(m);
    if (text === undefined) normalized.set(m, (text = ` ${normalizedTitle(m.span.text)} `));
    return text;
  };
  const prose = new Map<string, Array<{ r: Resource; origin: DeadlineOrigin; titleCodes: string[]; found: DeadlineMention[] }>>();
  /** Announcements, syllabus, and pages of one account+course, extracted once per evidence pass. */
  function courseProse(key: string) {
    let rows = prose.get(key);
    if (!rows) {
      rows = [];
      for (const r of byCourse.get(key) ?? []) {
        const origin = originOf(r);
        if (!origin) continue;
        const found = mentions(r, "text");
        if (found.length)
          rows.push({ r, origin, titleCodes: origin === "announcement" ? identifiersIn(r.title) : [], found });
      }
      prose.set(key, rows);
    }
    return rows;
  }
  const results = new Map<string, Found>();
  return function forResource(target: Resource): Found {
    const hit = results.get(target.id);
    if (hit) return hit;
    const out: Found = { claims: [], unresolved: [] };
    results.set(target.id, out);
    if (target.kind !== "assignment") return out;
    const peers = (byCourse.get(courseKey(target)) ?? []).filter((r) => r.kind === "assignment");
    const own = identifiersIn(target.title);
    const unique = own.filter(
      (code) => peers.filter((p) => identifiersIn(p.title).includes(code)).length === 1,
    );
    const title = normalizedTitle(target.title);
    const names = (m: DeadlineMention) =>
      unique.some((c) => m.identifiers.includes(c)) ||
      (title.length >= 6 && normalizedSpan(m).includes(` ${title} `));

    for (const m of mentions(target, "title")) add(out, m, "title", true);

    const ownText = mentions(target, "text").filter(
      (m) => !m.identifiers.length || m.identifiers.some((c) => own.includes(c)),
    );
    const ownDue = new Set(
      ownText.filter((m) => m.kind === "due" && m.value && !m.previous).map((m) => m.value),
    );
    for (const m of ownText)
      add(
        out,
        m,
        "assignment_text",
        ownDue.size <= 1 || m.kind !== "due",
        undefined,
        ownDue.size > 1 && m.kind === "due"
          ? "The description names several due dates; none is applied automatically."
          : undefined,
      );

    for (const { r, origin, titleCodes, found } of courseProse(courseKey(target))) {
      const inheritsTitle = titleCodes.length === 1 && unique.includes(titleCodes[0]!);
      for (const m of found) {
        if (m.identifiers.length ? !names(m) : !(inheritsTitle || names(m))) continue;
        add(
          out,
          m,
          origin,
          true,
          origin === "announcement" ? r.createdAt ?? undefined : undefined,
          !m.identifiers.length && inheritsTitle ? "Applies via the announcement title." : undefined,
        );
      }
    }
    return out;
  };
}

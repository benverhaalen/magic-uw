/**
 * Query shaping for passage search (T11b). Pure. The store runs the FTS5 query; this module
 * decides which words become terms and when a result set means "not in your materials".
 *
 * Questions use OR + bm25 over content words (measured-brief Q4: recall@5 1.0 vs 0.0 for
 * prefix-AND). OR alone matches almost every question, so a term-coverage gate decides
 * not-found: the best of the top hits must contain at least NOT_FOUND_COVERAGE of the
 * question's content terms (P2 synthesis C5; calibrated in tests/passages.test.ts).
 */

/** Function words and question scaffolding that carry no topic. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but nor of to in on at by for with from into onto about as than then " +
    "is are was were be been being am do does did doing done have has had having " +
    "i me my mine we us our you your yours he him his she her it its they them their " +
    "this that these those there here what which who whom whose when where why how " +
    "can could should would will shall may might must " +
    "not no yes if so too very just also any some all each every much many more most " +
    "please tell explain say says said give find mean means meant define describe show " +
    "between difference differences vs versus okay"
  ).split(" "),
);

/** Share of a question's content terms the best hit must contain; below it, not-found. */
export const NOT_FOUND_COVERAGE = 0.5;
/** Hard caps: FTS5 query size and result page. */
export const MAX_QUERY_TERMS = 32;
export const MAX_SEARCH_K = 20;

export interface QueryTerms {
  /** Every word token, lowercased, NFKC-normalized, deduplicated, in order. */
  terms: string[];
  /**
   * The terms that carry topic: not stopwords, and not single letters (the "s" of "Okonkwo's").
   * Falls back to `terms` when nothing else is left.
   */
  content: string[];
}

/** Tokenize like FTS5 unicode61: runs of letters, digits and underscore. Input is never syntax. */
export function queryTerms(query: string): QueryTerms {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  const content = terms.filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\p{N}/u.test(t)));
  return { terms, content: content.length ? content : terms };
}

/**
 * An FTS5 MATCH expression from literal terms. Every term is a quoted string, so no input can
 * become an operator. `prefix` appends `*` (typed search while the student is still typing).
 */
export function matchExpression(
  terms: readonly string[],
  mode: "or" | "and",
  prefix = false,
): string {
  return terms
    .map((t) => `"${t.replaceAll('"', '""')}"${prefix ? "*" : ""}`)
    .join(mode === "or" ? " OR " : " AND ");
}

/** The share of `content` terms present in a hit (by the matched-term set the store computed). */
export function coverage(content: readonly string[], matched: ReadonlySet<string>): number {
  if (!content.length) return 0;
  let n = 0;
  for (const t of content) if (matched.has(t)) n++;
  return n / content.length;
}

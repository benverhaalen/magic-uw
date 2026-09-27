// P13: the Anchor and Insight types (addendum §6), defined once here until the
// contracts follow-up. Every rendered insight carries at least one anchor whose
// span validates in its stated version. A superseded version is reported as
// "passage changed"; it's never fuzzy-matched to the new text (PI-17).

export interface Anchor {
  resourceId: string;
  version: number;
  start: number;
  end: number;
  label: string;
  valid: boolean;
}

export interface Insight {
  kind: "coverage" | "state" | "distractor" | "confusable" | "calibration" | "change" | "next";
  text: string;
  anchors: Anchor[];
  evidenceIds: string[];
  counts?: Record<string, number>;
}

export interface AnchorResource {
  id: string;
  version: number;
  title: string;
  text: string;
}

/** The nearest heading-like line before `start` (short, no closing period). */
function nearestHeading(text: string, start: number): string | null {
  const before = text.slice(0, start).split(/\r?\n/).reverse();
  for (const line of before) {
    const t = line.trim();
    if (t && t.length <= 80 && !/[.!?]$/.test(t)) return t;
  }
  return null;
}

/** An anchor into a resource's current version; label: title plus the nearest section heading. */
export function makeAnchor(r: AnchorResource, start: number, end: number): Anchor & { quote: string } {
  const valid = start >= 0 && end > start && end <= r.text.length;
  const heading = valid ? nearestHeading(r.text, start) : null;
  return {
    resourceId: r.id,
    version: r.version,
    start,
    end,
    label: heading && heading !== r.title ? `${r.title} · ${heading}` : r.title,
    valid,
    quote: valid ? r.text.slice(start, end) : "",
  };
}

export type AnchorCheck = { status: "valid" } | { status: "passage_changed"; text: string } | { status: "invalid" };

/**
 * Check an anchor against the resource's current state: the same version with
 * the same span text is valid; a newer version is "passage changed" (opened
 * at the current version with a notice, never matched fuzzily); anything else
 * is invalid.
 */
export function checkAnchor(anchor: Anchor, quote: string, current: AnchorResource | undefined): AnchorCheck {
  if (!current || current.id !== anchor.resourceId) return { status: "invalid" };
  if (current.version !== anchor.version) {
    return current.version > anchor.version ? { status: "passage_changed", text: "This passage changed since you studied it." } : { status: "invalid" };
  }
  if (anchor.start < 0 || anchor.end > current.text.length || anchor.end <= anchor.start) return { status: "invalid" };
  return current.text.slice(anchor.start, anchor.end) === quote ? { status: "valid" } : { status: "invalid" };
}

/** Re-check each insight's anchors; an insight left with no valid anchor isn't returned. */
export function keepAnchored(
  insights: (Insight & { quotes: string[] })[],
  resources: Map<string, AnchorResource>,
): Insight[] {
  const out: Insight[] = [];
  for (const { quotes, ...insight } of insights) {
    const anchors = insight.anchors.map((a, i) => ({ ...a, valid: checkAnchor(a, quotes[i] ?? "", resources.get(a.resourceId)).status === "valid" }));
    if (anchors.some((a) => a.valid)) out.push({ ...insight, anchors: anchors.filter((a) => a.valid) });
  }
  return out;
}

/** "Study this next": the anchor to open, plus a quick-session request for the concept (PI-17, P05). */
export function studyThisNext(conceptId: string, anchor: Anchor, minutes: 3 | 5 | 10 = 5) {
  return { anchor, quick: { op: "practice.quick" as const, conceptId, minutes } };
}

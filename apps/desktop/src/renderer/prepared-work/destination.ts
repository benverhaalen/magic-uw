import type { WorkItem, WorkTarget } from "@magic/contracts";

/**
 * The single renderer mapping from a prepared WorkTarget to what the student
 * sees: category, icon and accessible name. The actual target is authoritative.
 * A file downloaded from Canvas is a document, not Canvas; source metadata,
 * course topic or title never change the category. There are no editor or
 * terminal targets, so none are shown.
 */
export type DestinationCategory = "pdf" | "document" | "slides" | "spreadsheet" | "canvas" | "gitlab" | "web";
/** Lucide v0.468.0 generic icons; no brand marks are bundled for these sites. */
export type DestinationIcon = "file-text" | "presentation" | "file-spreadsheet" | "graduation-cap" | "git-branch" | "globe";

export interface Destination {
  category: DestinationCategory;
  icon: DestinationIcon;
  /** Short accessible name, e.g. "PDF", "Canvas", "UW GitLab", "example.org". */
  name: string;
  /** Plural noun for summaries, e.g. "2 Canvas pages". */
  noun: [singular: string, plural: string];
  opensIn: "app" | "browser";
}

/** Exact origins the app connects to; tests keep these equal to the connector constants. */
export const CANVAS_ORIGIN = "https://canvas.wisc.edu";
export const GITLAB_ORIGIN = "https://git.doit.wisc.edu";

const FILES: Record<string, Pick<Destination, "category" | "icon" | "name" | "noun">> = {
  ".pdf": { category: "pdf", icon: "file-text", name: "PDF", noun: ["PDF", "PDFs"] },
  ".ppt": { category: "slides", icon: "presentation", name: "Slides", noun: ["slide deck", "slide decks"] },
  ".pptx": { category: "slides", icon: "presentation", name: "Slides", noun: ["slide deck", "slide decks"] },
  ".odp": { category: "slides", icon: "presentation", name: "Slides", noun: ["slide deck", "slide decks"] },
  ".xls": { category: "spreadsheet", icon: "file-spreadsheet", name: "Spreadsheet", noun: ["spreadsheet", "spreadsheets"] },
  ".xlsx": { category: "spreadsheet", icon: "file-spreadsheet", name: "Spreadsheet", noun: ["spreadsheet", "spreadsheets"] },
  ".ods": { category: "spreadsheet", icon: "file-spreadsheet", name: "Spreadsheet", noun: ["spreadsheet", "spreadsheets"] },
  ".csv": { category: "spreadsheet", icon: "file-spreadsheet", name: "Spreadsheet", noun: ["spreadsheet", "spreadsheets"] },
};
const DOCUMENT = { category: "document", icon: "file-text", name: "Document", noun: ["document", "documents"] } as const;

export function destinationOf(target: WorkTarget): Destination {
  if (target.kind === "file") {
    const file = FILES[target.extension.toLowerCase()] ?? DOCUMENT;
    return { ...file, noun: [...file.noun], opensIn: "app" };
  }
  let origin = "", host = "";
  try { const url = new URL(target.url); origin = url.origin; host = url.hostname.replace(/^www\./, ""); } catch { /* unreadable link stays generic */ }
  if (origin === CANVAS_ORIGIN) return { category: "canvas", icon: "graduation-cap", name: "Canvas", noun: ["Canvas page", "Canvas pages"], opensIn: "browser" };
  if (origin === GITLAB_ORIGIN) return { category: "gitlab", icon: "git-branch", name: "UW GitLab", noun: ["UW GitLab page", "UW GitLab pages"], opensIn: "browser" };
  return { category: "web", icon: "globe", name: host || "Web page", noun: ["web page", "web pages"], opensIn: "browser" };
}

/** Where one item goes, as a clause. Instructions are opened last so they end up in front. */
export function destinationPhrase(item: Pick<WorkItem, "role" | "target">) {
  const where = destinationOf(item.target);
  const base = where.opensIn === "app" ? `Saved ${where.category === "pdf" ? "PDF" : where.noun[0]} in its usual app`
    : where.category === "web" ? `${where.name === "Web page" ? "Web page" : `Page on ${where.name}`} in your browser`
    : `${where.noun[0]} in your browser`;
  return item.role === "instructions" ? `${base}, opens in front` : base;
}

export interface DestinationGroup {
  category: DestinationCategory;
  icon: DestinationIcon;
  count: number;
  /** "2 Canvas pages". Web groups merge hosts; per-item names stay on each row. */
  label: string;
  resourceIds: string[];
}

/**
 * One icon per actual destination category, in first-seen order. A summary
 * only: it is not a control and does not imply that anything opens together.
 */
export function destinationGroups(items: readonly Pick<WorkItem, "resourceId" | "target">[]): DestinationGroup[] {
  const groups = new Map<DestinationCategory, DestinationGroup>();
  for (const item of items) {
    const where = destinationOf(item.target);
    const group = groups.get(where.category) ?? { category: where.category, icon: where.icon, count: 0, label: "", resourceIds: [] };
    group.count++;
    group.resourceIds.push(item.resourceId);
    group.label = `${group.count} ${group.count === 1 ? where.noun[0] : where.noun[1]}`;
    groups.set(where.category, group);
  }
  return [...groups.values()];
}

/** "1 PDF and 2 Canvas pages" for accessible names and tooltips. */
export function destinationSummary(groups: readonly DestinationGroup[]) {
  const labels = groups.map(group => group.label);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

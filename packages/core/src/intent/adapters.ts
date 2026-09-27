/**
 * Adapters for other lanes' plain-object actions. Each source has one small file under
 * `adapters/`; the worker passes a module only once its branch has landed, so a missing source
 * compiles out (nothing here imports another lane's package). A foreign action gets the same
 * treatment as a built-in one: code resolves and validates its arguments before it runs.
 */
import { z } from "zod";
import type { AnyAction } from "./registry";
import type { ActionContext, ResolvedArgs, SlotName } from "./types";
import { fromNotes } from "./adapters/notes";
import { fromOutlook } from "./adapters/outlook";
import { fromGuides } from "./adapters/guides";
import { fromAnalytics } from "./adapters/analytics";
import { fromPipeline } from "./adapters/pipeline";

/** What a lane's export looks like: a name, a description and a run function over plain args. */
export interface PlainAction {
  name: string;
  description: string;
  examples?: string[];
  /** Surface argument names it takes; unknown names are ignored. */
  args?: string[];
  run(args: PlainArgs, ctx: { signal: AbortSignal }): unknown;
}
/** Resolved arguments in plain form: IDs and dates code resolved, never the model's text. */
export interface PlainArgs {
  text: string;
  courseId?: string;
  accountScope?: string;
  topicIds?: string[];
  from?: string;
  to?: string;
  query?: string;
  resourceId?: string;
}

const SLOT_NAMES: SlotName[] = ["course", "assignment", "topics", "date", "query", "kind", "count", "scope"];
const anyArgs = z.custom<ResolvedArgs>((v) => !!v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string");

function isPlainAction(v: unknown): v is PlainAction {
  const a = v as Partial<PlainAction> | null;
  return !!a && typeof a.name === "string" && typeof a.description === "string" && typeof a.run === "function";
}
/** Accepts an array, a record of actions, or a single action. */
export function plainActions(value: unknown): PlainAction[] {
  if (Array.isArray(value)) return value.filter(isPlainAction);
  if (isPlainAction(value)) return [value];
  if (value && typeof value === "object") return Object.values(value).filter(isPlainAction);
  return [];
}

export function adaptPlain(action: PlainAction): AnyAction {
  const slots: AnyAction["slots"] = {};
  for (const a of action.args ?? []) if ((SLOT_NAMES as string[]).includes(a)) slots[a as SlotName] = "optional";
  return {
    name: action.name,
    description: action.description,
    slots,
    argsSchema: anyArgs,
    examples: action.examples ?? [],
    async run(args: ResolvedArgs, ctx: ActionContext) {
      const plain: PlainArgs = {
        text: args.text,
        ...(args.course ? { courseId: args.course.courseId, accountScope: args.course.accountScope } : {}),
        ...(args.topicIds?.length ? { topicIds: args.topicIds } : {}),
        ...(args.date ? { from: args.date.from, to: args.date.to } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.assignment ? { resourceId: args.assignment.resourceId } : {}),
      };
      return action.run(plain, { signal: ctx.signal });
    },
  };
}

export interface AdapterSources {
  /** packages/notes/src/actions.ts (feat/notes-connect): `notesActions`. */
  notes?: unknown;
  /** feat/outlook-graph: `mail.search`, `calendar.proposeEvent`. */
  outlook?: unknown;
  /** feat/study-guides: `guide.view` and the guide packs. */
  guides?: unknown;
  /** feat/practice-analytics: the analytics ops. */
  analytics?: unknown;
  /** feat/material-pipeline: `agenda`. */
  pipeline?: unknown;
}
/** The adapted actions for whichever sources are present; a name clash keeps the first. */
export function adaptSources(sources: AdapterSources): AnyAction[] {
  const all = [
    ...fromNotes(sources.notes),
    ...fromOutlook(sources.outlook),
    ...fromGuides(sources.guides),
    ...fromAnalytics(sources.analytics),
    ...fromPipeline(sources.pipeline),
  ];
  const seen = new Set<string>();
  return all.filter((a) => !seen.has(a.name) && seen.add(a.name));
}

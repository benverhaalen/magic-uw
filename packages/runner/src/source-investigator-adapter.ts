/** App-owned binding for an assignment click. Imported by the main-process owner, not the renderer. */
import type { Resource, Store, WorkSet } from "@magic/contracts";
import type { CourseCoreStore, GraphStore } from "../../contracts/src/course-core";
import { openSession, type Credentials, type SessionOptions } from "../../agent-api/src/session";
import { resolveAssignmentContext } from "../../core/src/assignment-context";
import { effectiveCoursePolicy } from "../../domain/src/course-policy";
import type { BackendCall } from "./types";
import { buildWorkSet } from "../../core/src/work-set";
import type { ModelBackend } from "./types";
import { runSourceInvestigator, type ExternalReadPort, type InvestigationContext, type InvestigationResult } from "./source-investigator";

export interface AssignmentClickInvestigation {
  store: Store & CourseCoreStore & Pick<GraphStore,"courseInventoryHash">;
  assignmentId: string;
  /** Magic's existing connected Claude Code or Codex backend, in its app-scoped no-tool mode. */
  backend: ModelBackend & { client: "claude" | "codex" };
  /** Existing per-client MCP/agent grant; the token is never sent to the backend. */
  grant?: Credentials;
  /** App click may supply its own fresh maySend/courseInclusion/category gate when no MCP token exists. */
  access?: () => { allowed(resource: Resource): boolean; scrubFor(resource: Resource): (text: string) => string };
  /** The Opus assignment-context producer; injected until its patch is in the integration baseline. */
  resolveContext?: (store: Store, assignmentId: string, options: { permitted: (resource: Resource) => boolean }) => InvestigationContext;
  /** Required app-owned privacy transform, preview decision and sent ledger receipt. */
  beforeModel: (call: BackendCall, resources: readonly Resource[]) => BackendCall;
  /** Optional app/connector capability, never a generic fetch. */
  external?: ExternalReadPort;
  sessionOptions?: SessionOptions;
  signal?: AbortSignal;
}
/** Rebuilds the allowed selection from trusted store state, then reopens the sharing session for each egress. */
export async function investigateAssignmentClick(input: AssignmentClickInvestigation): Promise<InvestigationResult> {
  const session = () => {
    if (input.access) return input.access();
    if (!input.grant) throw new Error("No authorized investigation access was supplied.");
    return openSession(input.store, input.grant, input.sessionOptions);
  };
  const initial = session();
  const assignment = input.store.resource(input.assignmentId);
  if (!assignment || !initial.allowed(assignment)) throw new Error("Assignment is unavailable to this connection.");
  const sources=input.store.sources();
  const account=sources.find(s=>s.id===assignment.sourceId)?.accountScope;
  if (!account) throw new Error("Assignment account is unavailable.");
  const sourceAccounts=new Map(sources.map(s=>[s.id,s.accountScope]));
  const sourceStates=new Map(sources.map(s=>[s.id,s.status]));
  const profile=input.store.courseIntelligence().filter(p=>p.accountScope===account && p.courseId===assignment.courseId).sort((a,b)=>b.version-a.version)[0];
  const inScope=(r:Resource)=>r.courseId===assignment.courseId && sourceAccounts.get(r.sourceId)===account && initial.allowed(r) && !["inaccessible","not_published"].includes(sourceStates.get(r.sourceId) ?? "error") && effectiveCoursePolicy(profile,r).mode!=="restricted";
  if (!inScope(assignment)) throw new Error("Assignment policy or source status blocks investigation.");
  const resolved = (input.resolveContext ?? resolveAssignmentContext)(input.store, input.assignmentId, { permitted: inScope });
  const context = {...resolved, sections:[...resolved.sections]};
  const workSet: WorkSet = buildWorkSet(input.store, input.assignmentId);
  const candidateIds = [input.assignmentId, ...context.sections.map(s=>s.resourceId), ...context.links.flatMap(l=>l.captured?[l.captured.resourceId]:[]), ...workSet.items.map(i=>i.resourceId), ...workSet.held.map(i=>i.resourceId), ...input.store.resources().filter(r=>r.kind!=="assignment" && !!r.text && inScope(r)).slice(0,75).map(r=>r.id)];
  const selected = [...new Set(candidateIds)].flatMap(id => { const r=input.store.resource(id); return r && inScope(r) ? [{resourceId:id,contentHash:r.contentHash}] : []; }).slice(0,100);
  return runSourceInvestigator({ store:input.store, backend:input.backend, context, workSet,
    grant:{ accountScope:context.accountScope, courseId:context.courseId, assignmentId:input.assignmentId, assignmentHash:context.contentHash, selected },
    authorizeEgress: resources => { try { const live=session(); return resources.every(r=>live.allowed(r) && input.store.resource(r.id)?.contentHash===r.contentHash); } catch { return false; } },
    project:(r,text) => ({text:session().scrubFor(r)(text)}), beforeModel:input.beforeModel, inventoryHash:input.store.courseInventoryHash({accountScope:context.accountScope,courseId:context.courseId}), external:input.external, signal:input.signal });
}

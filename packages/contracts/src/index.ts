import { z } from 'zod';

export const instant = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(256);
export const deadlineClaimSchema = z.object({
  value: instant, kind: z.enum(['due','lock','event']), quote: z.string().max(4000),
  authority: z.enum(['explicit_change','structured','document','title']), scopeConfirmed: z.boolean(),
}).strict();
export type DeadlineClaim = z.infer<typeof deadlineClaimSchema>;
export const policySchema = z.object({mode:z.enum(['allowed','coaching','restricted','unknown']), evidence:z.string().max(8000)}).strict();
export const resourceInputSchema = z.object({
  externalId:id, kind:z.enum(['assignment','material','event','message','course']),
  courseId:id, courseName:z.string().min(1).max(200), title:z.string().min(1).max(500),
  url:z.url().max(4000), text:z.string().max(200000),
  deadlines:z.array(deadlineClaimSchema).max(30).default([]),
  points:z.number().nonnegative().nullable().default(null), submitted:z.boolean().nullable().default(null),
  policy:policySchema.default({mode:'unknown',evidence:''}),
}).strict();
export type ResourceInput = z.infer<typeof resourceInputSchema>;
export const captureBatchSchema = z.object({
  source:z.object({id, label:z.string().min(1).max(200),kind:z.enum(['canvas','web','fixture']),accountScope:id,courseId:id,scope:id}).strict(),
  observedAt:instant, complete:z.boolean(), status:z.enum(['ok','partial','needs_sign_in','error']),
  resources:z.array(resourceInputSchema).max(2000),
}).strict();
export type CaptureBatch = z.infer<typeof captureBatchSchema>;
export interface Resource extends ResourceInput {id:string;sourceId:string;contentHash:string;version:number;observedAt:string;capturedAt:string;deleted:boolean;completed:boolean}
export interface SourceHealth {id:string;label:string;kind:CaptureBatch['source']['kind'];accountScope:string;courseId:string;scope:string;status:CaptureBatch['status'];lastAttemptAt:string;lastSuccessAt:string|null;complete:boolean;resourceCount:number}
export interface IngestReport {created:number;changed:number;unchanged:number;deleted:number;ignored:boolean}
export interface DeadlineResolution {dueAt:string|null;planningAt:string|null;conflict:boolean;claims:DeadlineClaim[];reason:string}
export const privacySchema=z.object({mode:z.enum(['local_only','selective_cloud']),jevEnabled:z.boolean(),hostedProvider:z.enum(['none','chatgpt','claude','gemini']),shareCourseText:z.boolean(),shareStudentWork:z.boolean()}).strict();
export type PrivacyPreferences=z.infer<typeof privacySchema>;
export const defaultPrivacy:PrivacyPreferences={mode:'local_only',jevEnabled:false,hostedProvider:'none',shareCourseText:false,shareStudentWork:false};
export interface Link {id:string;fromId:string;toId:string;type:'specifies'|'supports'|'same_as';reason:string;status:'proposed'|'accepted'|'rejected';inputHash:string}
export interface Job {id:string;kind:string;resourceId:string;inputHash:string;status:'pending'|'running'|'done'|'failed';attempts:number;runAfter:string;leaseUntil:string|null;leaseToken:string|null;error:string|null}
export interface Judgment {key:string;resourceId:string;inputHash:string;model:string;questionVersion:string;result:unknown;createdAt:string}
export interface Attempt {id:string;resourceId:string;itemId:string;skill:string;correct:boolean;assistance:'none'|'hint'|'explained';seenBefore:boolean;confidence:number|null;createdAt:string}
export interface EgressReceipt {id:string;recipient:string;purpose:string;categories:string[];resourceIds:string[];characters:number;status:'blocked'|'sent'|'failed';createdAt:string}
export interface Store {
 close():void;
 ingest(batch:CaptureBatch):IngestReport;
 resources(search?:string):Resource[];
 resource(id:string):Resource|undefined;
 sources():SourceHealth[];
 privacy():PrivacyPreferences;
 setPrivacy(value:PrivacyPreferences):void;
 setCompleted(id:string,completed:boolean):void;
 links():Link[];
 putLink(link:Link):void;
 decideLink(id:string,status:'accepted'|'rejected'):void;
 enqueue(kind:string,resourceId:string,inputHash:string,now:string):void;
 lease(now:string,leaseMs:number):Job|undefined;
 finish(job:Job,error?:string,now?:string):boolean;
 jobs():Job[];
 judgment(key:string):Judgment|undefined;
 putJudgment(value:Judgment):boolean;
 judgments():Judgment[];
 addAttempt(value:Attempt):void;
 attempts(resourceId?:string):Attempt[];
 addReceipt(value:EgressReceipt):void;
 receipts():EgressReceipt[];
 purge():void;
}
export interface ContextManifest {recipient:'jev'|'chatgpt'|'claude'|'gemini'|'local';purpose:string;categories:string[];resourceIds:string[];characters:number;allowed:boolean;reason:string;payload:{course:string;title:string;text:string;policy:string}}
export interface ResourceView extends Resource {deadline:DeadlineResolution;kindLabel:string|null}
export interface Snapshot {resources:ResourceView[];sources:SourceHealth[];privacy:PrivacyPreferences;links:Link[];jobs:Job[];receipts:EgressReceipt[];attempts:Attempt[];fixtureMode:boolean;gatewayConfigured:boolean;generatedAt:string}
export const commandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('snapshot'),search:z.string().max(500).optional()}).strict(),
 z.object({type:z.literal('import'),batch:captureBatchSchema}).strict(),
 z.object({type:z.literal('fixture')}).strict(),
 z.object({type:z.literal('complete'),id,completed:z.boolean()}).strict(),
 z.object({type:z.literal('privacy'),value:privacySchema}).strict(),
 z.object({type:z.literal('context'),id,recipient:z.enum(['jev','chatgpt','claude','gemini','local'])}).strict(),
 z.object({type:z.literal('enrich'),id}).strict(),
 z.object({type:z.literal('link'),id,status:z.enum(['accepted','rejected'])}).strict(),
 z.object({type:z.literal('purge'),confirmation:z.literal('DELETE LOCAL DATA')}).strict(),
]);
export type Command=z.infer<typeof commandSchema>;
export type CommandResult={snapshot:Snapshot;manifest?:ContextManifest;message?:string};
export interface AppBridge {execute(command:Command):Promise<CommandResult>;openExternal(url:string):Promise<void>;importFile():Promise<CommandResult|null>}
export interface Connector {id:string;pull(signal?:AbortSignal):AsyncIterable<CaptureBatch>}

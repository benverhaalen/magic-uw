import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '@magic/storage';
import { defaultPrivacy } from '@magic/contracts';
import { CONSENT_DISCLOSURE_VERSION } from '@magic/domain';
import { createMcpService } from '../packages/core/src/mcp';

test('MCP course_text grant must not reveal announcement-derived deadline text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-mcp-derived-'));
  const store = createStore(join(dir, 'db.sqlite'));
  store.setConsent!({action:'grant',recipient:'claude',disclosureVersion: CONSENT_DISCLOSURE_VERSION},'2026-09-26T12:00:00Z');
  const token = 'synthetic-local-test-token';
  store.setPrivacy({ ...defaultPrivacy, mode: 'selective_cloud', hostedProvider: 'claude', shareCourseText: true, shareCommunications: false });
  store.setMcpGrant({ id: 'g', label: 'synthetic', recipient: 'claude', enabled: true, courses: [{accountScope:'a',courseId:'c'}], categories:['course_text'], tokenHash:createHash('sha256').update(token).digest('hex') });
  for (const [scope, externalId, kind, title, text] of [
    ['assignments','hw3','assignment','HW3','Work on recursion.'],
    ['announcements','n1','message','HW3 deadline','PRIVATE_COMMUNICATION_MARKER: HW3 due September 28, 2026 at 11:59pm.'],
  ] as const) store.ingest({ source:{id:scope,label:scope,kind:'canvas',accountScope:'a',courseId:'c',scope}, observedAt:'2026-09-26T12:00:00Z',status:'ok',complete:true,readId:scope,resources:[{externalId,kind,courseId:'c',courseName:'Course',title,text,url:`https://canvas.example.test/courses/c/${scope}/${externalId}`,deadlines:[],policy:{mode:'unknown',evidence:''}}] });
  const service=createMcpService(store,'g',token);
  try {
    const assignment=store.resources().find(r=>r.externalId==='hw3')!;
    const announcement=store.resources().find(r=>r.externalId==='n1')!;
    assert.throws(()=>service.call('get_item',{id:announcement.id}));
    const result=service.call('get_item',{id:assignment.id});
    assert.equal((result as any).deadline.dueAt, null);
    assert.equal(JSON.stringify(result).includes('PRIVATE_COMMUNICATION_MARKER'),false,'Denied announcement text leaked through an allowed assignment deadline');
  } finally { await service.server.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

import { outgoingProjection, validateCitations, scrubText, rosterFor } from '../packages/core/src/identity';
test('outgoing citations retain exact send-time mapping across roster drift and reject unseen ranges', () => {
 const store=createStore(':memory:');
 store.ingest({source:{id:'s',label:'s',kind:'fixture',accountScope:'a',courseId:'c',scope:'all'},observedAt:'2026-09-26T12:00:00Z',status:'ok',complete:true,resources:[{externalId:'x',kind:'assignment',courseId:'c',courseName:'c',title:'HW1',text:'Jo Park did this. Secret second sentence.',url:'https://example.org/x',deadlines:[],policy:{mode:'unknown',evidence:''}}]});
 store.recordAutoIdentity({accountScope:'a',courseId:'c',authors:['Jo Park']});
 const r=store.resources()[0]!;
 const projection=outgoingProjection(store,r,'text',{start:0,end:21});
 store.recordAutoIdentity({accountScope:'a',courseId:'c',authors:['Amy Earlier']});
 const claim={resourceId:r.id,contentHash:r.contentHash,projectionId:projection.id,quote:'[STUDENT_1] did this.'};
 assert.equal(validateCitations(store,[claim])[0]!.original!.text,'Jo Park did this.');
 assert.equal(validateCitations(store,[{...claim,quote:'Secret second sentence.'}])[0]!.status,'unsupported');
 assert.equal(validateCitations(store,[{...claim,projectionId:undefined}])[0]!.reason,'projection_missing');
 store.close();
});
test('same course ID in another account cannot retain or scrub names in this account',()=>{
 const store=createStore(':memory:');
 store.recordAutoIdentity({accountScope:'a',courseId:'c',authors:['Jo Park']});
 store.recordAutoIdentity({accountScope:'b',courseId:'c',authors:['Alex Smith']});
 assert.equal(scrubText('Jo Park and Alex Smith',rosterFor(store,'c','a')).text,'[STUDENT_1] and Alex Smith');
 store.close();
});


test('MCP search ranks using the same account-scoped projection it returns', async () => {
  const store = createStore(':memory:');
  const token = 'synthetic-search-token';
  store.setConsent!({action:'grant',recipient:'claude',disclosureVersion: CONSENT_DISCLOSURE_VERSION}, '2026-09-26T12:00:00Z');
  store.setPrivacy({...defaultPrivacy, mode:'selective_cloud', hostedProvider:'claude', shareCourseText:true});
  store.setMcpGrant({id:'search',label:'synthetic',recipient:'claude',enabled:true,courses:[{accountScope:'a',courseId:'c'}],categories:['course_text'],tokenHash:createHash('sha256').update(token).digest('hex')});
  store.ingest({source:{id:'a-material',label:'Material',kind:'canvas',accountScope:'a',courseId:'c',scope:'pages'},observedAt:'2026-09-26T12:00:00Z',status:'ok',complete:true,resources:[{externalId:'x',kind:'material',courseId:'c',courseName:'Course',title:'Method',text:'Alex Smith method describes the procedure.',url:'https://example.org/method',deadlines:[],policy:{mode:'unknown',evidence:''}}]});
  store.recordAutoIdentity({accountScope:'b',courseId:'c',authors:['Alex Smith']});
  const service = createMcpService(store,'search',token);
  try {
    const result = service.call('search',{query:'Alex'});
    assert.match(JSON.stringify(result), /Alex Smith method/);
  } finally { await service.server.close(); store.close(); }
});

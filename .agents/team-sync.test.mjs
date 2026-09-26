import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relevant, pending } from './team-sync.mjs';

const script = fileURLToPath(new URL('./team-sync.mjs', import.meta.url));
const item = (number, label, updatedAt='2026-09-26T23:00:00Z') => ({ number, title: `Packet ${number}`, updatedAt, state:'OPEN', labels:[{name:label}], url:`https://example.invalid/${number}` });
test('topic filtering keeps team updates; a corrected acknowledged packet is pending again', () => {
  assert.deepEqual(relevant([item(1,'team'),item(2,'home'),item(3,'ingestion')],['home']).map(x=>x.number),[1,2]);
  assert.equal(pending([item(2,'home')],{'2':'2026-09-26T23:00:00Z'}).length,0);
  assert.equal(pending([item(2,'home','2026-09-27T00:00:00Z')],{'2':'2026-09-26T23:00:00Z'}).length,1);
});

test('manual check throttle, scoped receipts, stale read acknowledgement and failure isolation', {skip:process.platform==='win32'}, () => {
  const root=mkdtempSync(join(tmpdir(),'magic-team-test-'));
  try {
    execFileSync('git',['init','-q',root]);
    mkdirSync(join(root,'bin'));
    const fixture=join(root,'fixture.json'), log=join(root,'calls.jsonl');
    const fake=join(root,'bin','gh');
    writeFileSync(fake,`#!/usr/bin/env node\nconst f=require('node:fs');f.appendFileSync(process.env.TEAM_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.TEAM_TEST_FAIL)process.exit(1);const x=JSON.parse(f.readFileSync(process.env.TEAM_TEST_FIXTURE));const blob=process.argv[3].includes('/git/blobs/');process.stdout.write(JSON.stringify(blob?{encoding:'base64',content:Buffer.from('Exact bounded source').toString('base64')}:{truncated:false,tree:x.map(i=>({type:'blob',sha:i.updatedAt,path:'.agents/team/packets/'+i.labels[0].name+'/'+i.number+'-packet.md'}))}));\n`);
    chmodSync(fake,0o755);
    const env={...process.env,PATH:join(root,'bin')+delimiter+process.env.PATH,TEAM_TEST_FIXTURE:fixture,TEAM_TEST_LOG:log};
    const run=(args,input='',extra={})=>spawnSync(process.execPath,[script,...args],{cwd:root,env:{...env,...extra},input,encoding:'utf8'});
    writeFileSync(fixture,JSON.stringify([item(2,'home')]));
    const first=run(['check','--session','test-parent']);
    assert.equal(first.status,0);
    assert.match(first.stdout,/#2/);
    const count=()=>readFileSync(log,'utf8').trim().split('\n').length;
    assert.equal(count(),1);
    assert.equal(run(['check','--session','test-parent']).stdout,'');
    assert.equal(count(),1,'throttled check performs no network process');
    assert.equal(run(['ack','2','--session','test-parent']).status,1,'cannot acknowledge unread content');
    assert.match(run(['read','2','--session','test-parent']).stdout,/Exact bounded source/);
    writeFileSync(fixture,JSON.stringify([item(2,'home','2026-09-27T00:00:00Z')]));
    assert.equal(run(['ack','2','--session','test-parent']).status,0);
    assert.match(run(['check','--session','test-parent','--force']).stdout,/#2/,'ack applies to read version, not newer remote version');
    run(['read','2','--session','test-parent']);run(['ack','2','--session','test-parent']);
    assert.equal(run(['check','--session','test-parent','--force']).stdout,'');
    assert.match(run(['check','--session','another-task','--force']).stdout,/#2/,'receipts isolated by session');
    const failure=run(['check','--session','offline','--force'],'',{TEAM_TEST_FAIL:'1'});
    assert.equal(failure.status,0);assert.match(failure.stdout,/unavailable/);
    assert.equal(run(['check','--session','offline','--force'],'',{TEAM_TEST_FAIL:'1'}).stdout,'');
    const after=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'});
    assert.doesNotMatch(after,/team-sync|magic-team-sync/,'coordination state is outside tracked worktree');
  } finally {rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceTrialDispatch} from '../apps/desktop/src/voice/intent-dispatch';
import type {CommandResult} from '@magic/contracts';
test('voice trial sends only exact local page navigation and never invokes provider for other speech', async()=>{
 const calls:any[]=[]; const dispatch=createVoiceTrialDispatch(async value=>{calls.push(value); return {command:{status:'ran',action:'page.open',result:{navigate:{view:'calendar'}}}} as unknown as CommandResult});
 const operation={signal:new AbortController().signal,current:()=>true,operationId:'trial'};
 const rejected=await dispatch('solve my open assignment',{},operation);assert.equal(rejected.status,'unavailable');assert.equal(calls.length,0);
 await dispatch('Open Calendar',{},operation);assert.equal(calls.length,1);assert.deepEqual(calls[0].value.allowedActions,['page.open']);
 const controller=new AbortController();controller.abort();await assert.rejects(dispatch('Open Home',{}, {...operation,signal:controller.signal}));assert.equal(calls.length,1);
});

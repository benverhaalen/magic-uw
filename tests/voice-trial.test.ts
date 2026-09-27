import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceTrialDispatch} from '../apps/desktop/src/voice/intent-dispatch';
test('voice trial handles exact page navigation locally with no workspace call', async()=>{
 const dispatch=createVoiceTrialDispatch();
 const operation={signal:new AbortController().signal,current:()=>true,operationId:'trial'};
 const rejected=await dispatch('solve my open assignment',{},operation);assert.equal(rejected.status,'unavailable');
 const result=await dispatch('Open Calendar',{},operation);assert.deepEqual(result,{status:'ran',action:'page.open',args:{text:'Open Calendar'},result:{navigate:{view:'calendar'}},path:'code',latencyMs:0,tokens:{in:0,cached:0,out:0}});
 const controller=new AbortController();controller.abort();await assert.rejects(dispatch('Open Home',{}, {...operation,signal:controller.signal}));
 await assert.rejects(dispatch('Open Home',{}, {...operation,current:()=>false}));
});

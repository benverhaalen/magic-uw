import { useEffect, useRef, useState } from 'react';
import { VoiceMicrophone, type MicrophoneView } from './microphone';
import type { VoiceBridge, VoiceRequestContext, VoiceEvent } from '../../voice/types';
import { launcherVoice } from './launcher-voice';
declare global { interface Window { magicVoice?: VoiceBridge } }
/** Route changes preserve the session; each utterance captures its context on first speech. */
export function useDesktopVoice<T>(accountIdentity: string, capture: () => {origin: T; context: VoiceRequestContext}, result: (origin: T, event: Extract<VoiceEvent, {type: 'result'}>) => string | void) {
 const [view, setView] = useState<MicrophoneView>({phase:'idle',token:null,levels:[]});
 const [available,setAvailable]=useState(false), [missing,setMissing]=useState<string|undefined>(undefined), [feedback,setFeedback]=useState('');
 const controller=useRef<VoiceMicrophone|null>(null), handlers=useRef({capture,result}); handlers.current={capture,result};
 useEffect(()=>{
  let live=true; const origins=new Map<string,T>();
  setFeedback(''); setAvailable(false); setMissing(undefined); setView({phase:'idle',token:null,levels:[]});
  const bridge=window.magicVoice; if(!bridge)return;
  const microphone=new VoiceMicrophone(bridge,state=>{if(live){setView(state);if(!state.token)origins.clear();}},event=>{
   if(!live)return;
   if(event.type==='transcript')setFeedback(`Heard: ${event.text}`);
   if(event.type==='result'){
    const origin=origins.get(event.operationId);origins.delete(event.operationId);
    const applied=origin!==undefined ? handlers.current.result(origin,event) : undefined;
    const outcome=event.result;
    if(applied)setFeedback(applied);
    else if(outcome.status==='ran' && outcome.action==='page.open')setFeedback('Navigation requested.');
    else if(outcome.status==='clarify')setFeedback(outcome.question);
    else if(outcome.status==='unavailable')setFeedback(outcome.reason);
    else setFeedback('Request finished.');
   }
  },undefined,()=>{const {origin,context}=handlers.current.capture();const operationId=crypto.randomUUID(); origins.set(operationId,origin); if(origins.size>256)origins.delete(origins.keys().next().value!); return {operationId,context};});
  controller.current=microphone;
  void bridge.capabilities().then(value=>{if(!live)return;setAvailable(value.microphone&&value.transcription==='local-whisper');setMissing(!value.microphone?'No microphone is available to Magic on this Mac. You can type instead.':value.transcription!=='local-whisper'?'Local speech recognition is not set up on this Mac. You can type instead.':undefined);}).catch(()=>{if(live)setMissing('Magic could not check voice on this Mac. You can type instead.');});
  return()=>{live=false;microphone.dispose();if(controller.current===microphone)controller.current=null;};
 },[accountIdentity]);
 // Error vs unavailable mapping lives in launcher-voice.ts: a failed session stays retryable.
 const voice=launcherVoice(available,view,{onStart:()=>{setFeedback('');void controller.current?.start();},onStop:()=>{setFeedback('Stopped.');void controller.current?.stop();}});
 return {voice:!available&&missing?{...voice,reason:missing}:voice, feedback};
}

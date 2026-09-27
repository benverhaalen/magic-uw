import type { ipcRenderer } from 'electron';
import type { VoiceBridge, VoiceEvent } from './types';

type Ipc = Pick<typeof ipcRenderer, 'invoke' | 'on' | 'removeListener'>;
/** The renderer's voice bridge over the given IPC; Electron-free so its channels are testable. */
export function createVoiceBridge(ipcRenderer: Ipc): VoiceBridge { return {
  capabilities: () => ipcRenderer.invoke('magic:voice-capabilities'),
  start: () => ipcRenderer.invoke('magic:voice-start'),
  ready: token => ipcRenderer.invoke('magic:voice-ready', token),
  stop: reason => ipcRenderer.invoke('magic:voice-stop', reason),
  transcribe: audio => ipcRenderer.invoke('magic:voice-transcribe', audio),
  onEvent(listener) {
    const handler = (_event: unknown, event: VoiceEvent) => listener(event);
    ipcRenderer.on('magic:voice-event', handler);
    return () => { ipcRenderer.removeListener('magic:voice-event', handler); };
  },
  // owner: voice-plan
  onAgent(listener) {
    const handler = (_event: unknown, agent: Parameters<typeof listener>[0]) => listener(agent);
    ipcRenderer.on('magic:voice-agent', handler);
    return () => { ipcRenderer.removeListener('magic:voice-agent', handler); };
  },
  // owner: voice-plan: on-device streaming speech. Frames go as a typed array (structured clone), in order.
  beginStreamingTurn: token => ipcRenderer.invoke('magic:voice-stream-begin', token),
  pushStreamingPCM: (token, frame, turn) => ipcRenderer.invoke('magic:voice-stream-push', token, frame, turn ?? null),
  endStreamingTurn: audio => ipcRenderer.invoke('magic:voice-stream-end', audio),
}; }

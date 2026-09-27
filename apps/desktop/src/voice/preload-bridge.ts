import { ipcRenderer } from 'electron';
import type { VoiceBridge, VoiceEvent } from './types';

/** Expose as window.magicVoice separately; never expose raw IPC or credentials. */
export const voiceBridge: VoiceBridge = {
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
};

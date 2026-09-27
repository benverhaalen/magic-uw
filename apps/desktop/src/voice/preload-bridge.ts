import { ipcRenderer } from 'electron';
import { createVoiceBridge } from './bridge';
import type { VoiceBridge } from './types';

/** Expose as window.magicVoice separately; never expose raw IPC or credentials. */
export const voiceBridge: VoiceBridge = createVoiceBridge(ipcRenderer);

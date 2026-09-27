import { app, BrowserWindow, ipcMain, powerMonitor, screen, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { VoiceSession, type VoiceDispatch } from './session';
import { LocalWhisperTransport, localWhisperConfig } from './local-whisper';
import type { VoiceContext, VoiceEvent, VoiceReason } from './types';
import { isToken, isVoiceAudio, microphonePermission } from './policy';

const reasons = new Set<VoiceReason>(['stopped', 'permission-denied', 'device-unavailable', 'transport-unavailable', 'disconnected', 'context-changed', 'too-long']);

/** Additive host installer. Main must call stop on every account/consent transition. */
export async function installDesktopVoice(options: { window: BrowserWindow; rendererURL: string; context(): VoiceContext; dispatch: VoiceDispatch; headless?: boolean }) {
  const owner = options.window.webContents;
  const config = await localWhisperConfig();
  let floating: BrowserWindow | null = null;
  let floatingReady = false;
  let disposed = false;
  const validate = (event: IpcMainInvokeEvent) => {
    if (disposed || event.sender !== owner || event.senderFrame !== owner.mainFrame || event.senderFrame.url !== options.rendererURL) throw new Error('Voice sender unavailable');
  };
  const send = (event: VoiceEvent) => { if (!owner.isDestroyed()) owner.send('magic:voice-event', event); };
  const session = new VoiceSession({
    context: options.context,
    dispatch: options.dispatch,
    transport: () => {
      if (!config) return { start: async () => { throw new Error('unavailable'); }, transcribe: async () => '', close() {} };
      return new LocalWhisperTransport(config);
    },
    requestMicrophone: async () => {
      if (!config || options.headless) return false;
      if (process.platform !== 'darwin') return true;
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
    },
    event: event => { send(event); if (event.type === 'state') updateFloating(); },
  });
  function updateFloating() {
    if (disposed) return;
    const active = !!session.status().token;
    const ownWindowFocused = BrowserWindow.getAllWindows().some(window => window !== floating && window.isFocused());
    if (!active || ownWindowFocused || options.headless) { floating?.hide(); return; }
    if (!floating) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      floating = new BrowserWindow({ width: 148, height: 52, x: area.x + area.width - 168, y: area.y + 20, show: false, frame: false, resizable: false, maximizable: false, minimizable: false, alwaysOnTop: true, skipTaskbar: true, title: 'Stop voice', backgroundColor: '#f9f6ee', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, partition: 'magic-voice-stop' } });
      floating.setAlwaysOnTop(true, 'floating');
      floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      floating.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      floating.webContents.session.setPermissionCheckHandler(() => false);
      floating.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      floating.webContents.on('will-navigate', (event, url) => { event.preventDefault(); if (url === 'magic-voice:stop') session.stop(); });
      floating.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && (input.key === 'Escape' || input.key === ' ')) { event.preventDefault(); session.stop(); } });
      floating.on('closed', () => { floating = null; floatingReady = false; if (!disposed) session.stop(); });
      // Constant local content, no script, remote resource, app activation, or bridge.
      const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;height:100%;background:#f9f6ee}a{display:flex;align-items:center;justify-content:center;gap:9px;height:100%;color:#24241f;font:500 15px system-ui;text-decoration:none}a:focus-visible{outline:2px solid #8b4941;outline-offset:-4px}span{height:11px;width:11px;border-radius:2px;background:#8b4941}</style><a href="magic-voice:stop" aria-label="Stop voice"><span aria-hidden="true"></span>Stop voice</a>';
      void floating.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => { floatingReady = true; updateFloating(); }).catch(() => session.stop('disconnected'));
    }
    if (floatingReady && floating && !floating.isVisible()) floating.showInactive();
  }
  const focusChanged = () => { setTimeout(updateFloating, 0); };
  app.on('browser-window-focus', focusChanged); app.on('browser-window-blur', focusChanged);
  options.window.on('minimize', focusChanged); options.window.on('restore', focusChanged);
  const stopped = () => { session.stop('disconnected'); };
  owner.on('render-process-gone', stopped);
  owner.on('did-start-navigation', stopped);
  powerMonitor.on('suspend', stopped); powerMonitor.on('lock-screen', stopped);
  const handlers: [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown][] = [
    ['magic:voice-capabilities', event => { validate(event); return { microphone: !options.headless, transcription: config ? 'local-whisper' : null, externalControl: false, streamingSpeech: false }; }],
    ['magic:voice-start', event => { validate(event); if (!config) return session.stop('transport-unavailable'); return session.start(); }],
    ['magic:voice-ready', (event, token: unknown) => { validate(event); if (!isToken(token)) throw new Error('Invalid voice session'); return session.ready(token); }],
    ['magic:voice-stop', (event, reason: unknown) => { validate(event); return session.stop(typeof reason === 'string' && reasons.has(reason as VoiceReason) ? reason as VoiceReason : 'stopped'); }],
    ['magic:voice-transcribe', (event, audio: unknown) => { validate(event); if (!isVoiceAudio(audio)) throw new Error('Invalid voice audio'); return session.transcribe(audio); }],
  ];
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
  const dispose = () => {
    if (disposed) return;
    disposed = true; session.stop();
    floating?.destroy(); floating = null;
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    app.off('browser-window-focus', focusChanged); app.off('browser-window-blur', focusChanged);
    options.window.off('minimize', focusChanged); options.window.off('restore', focusChanged);
    owner.off('render-process-gone', stopped); owner.off('did-start-navigation', stopped);
    powerMonitor.off('suspend', stopped); powerMonitor.off('lock-screen', stopped);
  };
  options.window.once('closed', dispose);
  return { allowsPermission: (sender: Parameters<typeof microphonePermission>[3], permission: string, details: Parameters<typeof microphonePermission>[5]) => microphonePermission(owner, options.rendererURL, session.allowsMicrophone(), sender, permission, details), stop: (reason: VoiceReason = 'stopped') => session.stop(reason), dispose, status: () => session.status() };
}

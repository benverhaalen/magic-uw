import { app, BrowserWindow, ipcMain, powerMonitor, screen, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { bundledGeist, floatingStopHtml } from './floating-stop';
import { VoiceSession, type VoiceDispatch } from './session';
import type { AgentReadiness } from './agent-warmup'; // owner: voice-plan
import { LocalWhisperTransport, localWhisperConfig } from './local-whisper';
import type { VoiceContext, VoiceEvent, VoiceReason, VoiceRequestContext } from './types';
import { isPcmFrame, isRequestContext, isToken, isVoiceAudio, isVoiceTurn, microphonePermission } from './policy';
import { NativeStreamingSTT } from './native-streaming-adapter'; // owner: voice-plan
import { access, constants as fsConstants } from 'node:fs/promises';

const reasons = new Set<VoiceReason>(['stopped', 'permission-denied', 'device-unavailable', 'transport-unavailable', 'disconnected', 'context-changed', 'too-long']);

/** Additive host installer. Main must call stop on every account/consent transition. */
export async function installDesktopVoice(options: { window: BrowserWindow; rendererURL: string; context(): VoiceContext; dispatch: VoiceDispatch; headless?: boolean; /** owner: voice-plan: `activate` gets the open page on a mic click; `release` runs when the voice session ends */ agent?: { status(): AgentReadiness; activate(context?: VoiceRequestContext): void; release?(): void }; /** owner: voice-plan: the Apple SpeechTranscriber helper executable */ streamingHelper?: string }) {
  const owner = options.window.webContents;
  const config = await localWhisperConfig();
  // owner: voice-plan. Only an installed, executable helper is offered; nothing is spawned until a Start click.
  const helper = options.streamingHelper && process.platform === 'darwin' && !options.headless ? await access(options.streamingHelper, fsConstants.X_OK).then(() => options.streamingHelper!, () => null) : null;
  const stopHtml = floatingStopHtml(await bundledGeist(options.rendererURL));
  let floating: BrowserWindow | null = null;
  let floatingReady = false;
  let disposed = false;
  const validate = (event: IpcMainInvokeEvent) => {
    if (disposed || event.sender !== owner || event.senderFrame !== owner.mainFrame || event.senderFrame.url !== options.rendererURL) throw new Error('Voice sender unavailable');
  };
  const send = (event: VoiceEvent) => { if (!owner.isDestroyed()) owner.send('magic:voice-event', event); };
  // owner: voice-plan: the page's warm session lasts as long as the voice session (Stop, context change, exit).
  let sessionOpen = false;
  const sessionState = (event: VoiceEvent) => {
    if (event.type !== 'state') return;
    if (event.state.token) sessionOpen = true;
    else if (sessionOpen) { sessionOpen = false; options.agent?.release?.(); }
  };
  const session = new VoiceSession({
    context: options.context,
    dispatch: options.dispatch,
    transport: () => {
      if (!config) return { start: async () => { throw new Error('unavailable'); }, transcribe: async () => '', close() {} };
      return new LocalWhisperTransport(config);
    },
    requestMicrophone: async () => {
      if ((!config && !helper) || options.headless) return false;
      if (process.platform !== 'darwin') return true;
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
    },
    event: event => { send(event); sessionState(event); if (event.type === 'state') updateFloating(); },
    ...(helper ? { streaming: (onEvent: ConstructorParameters<typeof NativeStreamingSTT>[1]) => new NativeStreamingSTT(helper, onEvent) } : {}),
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
      void floating.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(stopHtml)}`).then(() => { floatingReady = true; updateFloating(); }).catch(() => session.stop('disconnected'));
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
    // owner: voice-plan: streamingSpeech is true only while this session's utterance helper reported ready.
    ['magic:voice-capabilities', event => { validate(event); const streaming = session.streamingReady(); return { microphone: !options.headless, transcription: streaming ? 'speech-transcriber' : config ? 'local-whisper' : helper ? 'speech-transcriber' : null, externalControl: false, streamingSpeech: streaming, agent: options.agent?.status() ?? null }; }],
    // owner: voice-plan: the session (and so the microphone permission) starts first; the connected agent's warm
    // for the open page is posted after, fire-and-forget; the page is passed only for a session that actually started.
    ['magic:voice-start', (event, context: unknown) => { validate(event); if (!config && !helper) { options.agent?.activate(); return session.stop('transport-unavailable'); } const started = session.start(); options.agent?.activate(session.status().token && isRequestContext(context) ? context : undefined); return started; }],
    ['magic:voice-ready', (event, token: unknown) => { validate(event); if (!isToken(token)) throw new Error('Invalid voice session'); return session.ready(token); }],
    ['magic:voice-stop', (event, reason: unknown) => { validate(event); return session.stop(typeof reason === 'string' && reasons.has(reason as VoiceReason) ? reason as VoiceReason : 'stopped'); }],
    ['magic:voice-transcribe', (event, audio: unknown) => { validate(event); if (!isVoiceAudio(audio)) throw new Error('Invalid voice audio'); return session.transcribe(audio); }],
    // owner: voice-plan: on-device streaming speech, per utterance (BRIDGE-CONTRACT).
    ['magic:voice-stream-begin', (event, token: unknown) => { validate(event); if (!isToken(token)) throw new Error('Invalid voice session'); return session.beginStream(token); }],
    ['magic:voice-stream-push', (event, token: unknown, frame: unknown, turn: unknown) => { validate(event); if (!isToken(token) || !isPcmFrame(frame) || (turn !== undefined && turn !== null && !isVoiceTurn(turn))) throw new Error('Invalid voice audio'); return session.pushStream(token, frame, turn ?? undefined); }],
    ['magic:voice-stream-end', (event, audio: unknown) => { validate(event); if (!isVoiceAudio(audio)) throw new Error('Invalid voice audio'); return session.endStream(audio); }],
  ];
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
  const dispose = () => {
    if (disposed) return;
    disposed = true; session.stop(); options.agent?.release?.();
    floating?.destroy(); floating = null;
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    app.off('browser-window-focus', focusChanged); app.off('browser-window-blur', focusChanged);
    options.window.off('minimize', focusChanged); options.window.off('restore', focusChanged);
    owner.off('render-process-gone', stopped); owner.off('did-start-navigation', stopped);
    powerMonitor.off('suspend', stopped); powerMonitor.off('lock-screen', stopped);
  };
  options.window.once('closed', dispose);
  return { allowsPermission: (sender: Parameters<typeof microphonePermission>[3], permission: string, details: Parameters<typeof microphonePermission>[5]) => microphonePermission(owner, options.rendererURL, session.allowsMicrophone(), sender, permission, details), stop: (reason: VoiceReason = 'stopped') => session.stop(reason), dispose, status: () => session.status(), announceAgent: (agent: AgentReadiness) => { if (!disposed && !owner.isDestroyed()) owner.send('magic:voice-agent', agent); } };
}

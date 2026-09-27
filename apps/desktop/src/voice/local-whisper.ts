import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { VoiceAudio } from './types';
import type { VoiceTransport } from './session';

// Our glue only. Whisper is an installed optional MIT dependency, not vendored here.
// Explicit existing model path means load_model cannot download weights.
const workerSource = String.raw`
import sys, json, base64, subprocess, os
import numpy as np
import torch, whisper
torch.set_num_threads(4)
model = whisper.load_model(sys.argv[1], device='cpu')
print(json.dumps({'type':'ready'}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        encoded = request['audio']
        if len(encoded) > 2700000: raise ValueError('size')
        raw = base64.b64decode(encoded, validate=True)
        # Decode in memory. No paths, shell interpolation, audio files, or network.
        decoded = subprocess.run(['ffmpeg','-nostdin','-threads','1','-loglevel','error','-i','pipe:0','-t','31','-f','s16le','-ac','1','-ar','16000','pipe:1'], input=raw, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True).stdout
        audio = np.frombuffer(decoded, np.int16).astype(np.float32) / 32768.0
        if len(audio) > 30 * 16000: raise ValueError('duration')
        if len(audio) == 0 or float(np.sqrt(np.mean(audio * audio))) < 0.002:
            text = ''
        else:
            result = model.transcribe(audio, language='en', fp16=False, verbose=None, temperature=0, condition_on_previous_text=False)
            segments = result.get('segments', [])
            # ASR confidence filters silence; it does not authorize actions.
            text = result['text'] if any(s.get('no_speech_prob',1) < 0.6 and s.get('avg_logprob',-99) > -1.0 for s in segments) else ''
        print(json.dumps({'type':'transcript','id':request['id'],'text':text}), flush=True)
    except Exception:
        print(json.dumps({'type':'error'}), flush=True)
`;

export interface LocalWhisperConfig { python: string; modelFile: string }
export async function localWhisperConfig(): Promise<LocalWhisperConfig | null> {
  const python = process.env.MAGIC_VOICE_PYTHON || 'python3';
  const modelFile = process.env.MAGIC_VOICE_MODEL_FILE || join(homedir(), '.cache', 'whisper', 'base.pt');
  if (!isAbsolute(modelFile)) return null;
  try { await access(modelFile); return { python, modelFile }; } catch { return null; }
}

/** One warm local worker per user-started session; stop kills the process group. */
export class LocalWhisperTransport implements VoiceTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: { resolve(text: string): void; reject(error: Error): void; id: number } | null = null;
  private sequence = 0;
  private rejectStart: ((error: Error) => void) | null = null;
  private disconnected: (() => void) | undefined;
  constructor(private readonly config: LocalWhisperConfig) {}
  start(signal: AbortSignal, disconnected?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('stopped')); return; }
      const child = spawn(this.config.python, ['-u', '-c', workerSource, this.config.modelFile], {
        stdio: 'pipe', detached: process.platform !== 'win32',
        // Deliberately do not pass provider keys or other inherited credentials.
        env: { PATH: process.env.PATH, HOME: homedir(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;
      this.disconnected = disconnected;
      this.rejectStart = reject;
      const abort = () => this.close();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => this.fail(), 60_000);
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 64_000) { this.fail(); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'ready') { clearTimeout(timer); this.rejectStart = null; resolve(); }
            else if (message.type === 'transcript' && this.pending?.id === message.id && typeof message.text === 'string' && message.text.length <= 8_000) {
              const pending = this.pending!; this.pending = null; pending.resolve(message.text);
            } else this.fail();
          } catch { this.fail(); }
        }
      });
      // Drain diagnostics without logging local paths or captured speech.
      child.stderr.resume();
      child.stdin.on('error', () => this.fail());
      child.once('error', () => this.fail());
      child.once('exit', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.fail(); });
    });
  }
  async transcribe(audio: VoiceAudio, signal: AbortSignal): Promise<string> {
    if (!this.child || signal.aborted || this.pending) throw new Error('unavailable');
    const child = this.child;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(), 60_000);
      this.pending = { id, resolve: text => { clearTimeout(timer); resolve(text); }, reject: error => { clearTimeout(timer); reject(error); } };
      child.stdin.write(JSON.stringify({ id, audio: Buffer.from(audio.bytes).toString('base64') }) + '\n');
    });
  }
  private fail(): void { const disconnected = this.disconnected; this.close(); disconnected?.(); }
  close(): void {
    this.disconnected = undefined;
    const child = this.child;
    this.child = null;
    const rejectStart = this.rejectStart; this.rejectStart = null;
    const pending = this.pending; this.pending = null;
    rejectStart?.(new Error('local-transcription-unavailable'));
    pending?.reject(new Error('local-transcription-stopped'));
    if (child && child.exitCode === null && child.pid) {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    }
  }
}

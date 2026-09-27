import { Pcm16Framer } from './pcm-framer';

/** Reuses the already-permitted MediaStream source; never opens a second microphone. */
export class MicPcmTap {
  private readonly processor: ScriptProcessorNode;
  private readonly framer: Pcm16Framer;
  private closed = false;
  constructor(private readonly context: AudioContext, private readonly source: MediaStreamAudioSourceNode,
    private readonly frame: (pcm: Int16Array) => void) {
    this.framer = new Pcm16Framer(context.sampleRate);
    // The silent output keeps the Web Audio processor scheduled without playing microphone audio.
    this.processor = context.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = event => {
      event.outputBuffer.getChannelData(0).fill(0);
      if (this.closed) return;
      for (const pcm of this.framer.push(event.inputBuffer.getChannelData(0))) this.frame(pcm);
    };
    source.connect(this.processor);
    this.processor.connect(context.destination);
  }
  /** Flush a short last PCM frame at the utterance boundary. Idempotent. */
  finish(): void {
    if (this.closed) return;
    this.close();
    const tail = this.framer.finish();
    if (tail) this.frame(tail);
  }
  /** Stop without sending a tail, used by Stop and device loss. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.processor.onaudioprocess = null;
    try { this.source.disconnect(this.processor); } catch { /* already disconnected */ }
    this.processor.disconnect();
  }
}

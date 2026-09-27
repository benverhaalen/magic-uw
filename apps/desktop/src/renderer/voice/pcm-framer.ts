/** Resample one live microphone stream to the on-device recognizer's mono 16 kHz S16LE frames. */
export class Pcm16Framer {
  private source: number[] = [];
  private position = 0;
  private pending: number[] = [];
  private readonly step: number;
  constructor(inputSampleRate: number, private readonly frameSamples = 3200) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate < 16_000 || inputSampleRate > 192_000) throw new RangeError('input sample rate');
    if (!Number.isInteger(frameSamples) || frameSamples < 1 || frameSamples > 3200) throw new RangeError('PCM frame size');
    this.step = inputSampleRate / 16_000;
  }
  push(samples: Float32Array): Int16Array[] {
    for (const value of samples) this.source.push(Number.isFinite(value) ? value : 0);
    const frames: Int16Array[] = [];
    while (this.position + 1 < this.source.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = this.source[index]! * (1 - fraction) + this.source[index + 1]! * fraction;
      this.pending.push(toPcm16(value));
      if (this.pending.length === this.frameSamples) {
        frames.push(Int16Array.from(this.pending));
        this.pending = [];
      }
      this.position += this.step;
    }
    const consumed = Math.min(Math.floor(this.position), Math.max(0, this.source.length - 1));
    if (consumed) { this.source.splice(0, consumed); this.position -= consumed; }
    return frames;
  }
  /** Send the short final frame before ending the native utterance. */
  finish(): Int16Array | null {
    const tail = this.pending.length ? Int16Array.from(this.pending) : null;
    this.pending = []; this.source = []; this.position = 0;
    return tail;
  }
}
function toPcm16(sample: number): number {
  const bounded = Math.max(-1, Math.min(1, sample));
  return Math.round(bounded < 0 ? bounded * 32768 : bounded * 32767);
}

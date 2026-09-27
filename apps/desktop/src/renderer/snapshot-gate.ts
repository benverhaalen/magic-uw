/** Coalesce slow polls and keep snapshots from crossing mutation boundaries. */
export class SnapshotGate {
  private version = 0;
  private reading = false;
  private mutating = false;
  private queued = false;
  beginRead(): number | null {
    if (this.reading || this.mutating) { this.queued = true; return null; }
    this.reading = true;
    return ++this.version;
  }
  accepts(ticket: number) { return ticket === this.version && !this.mutating; }
  endRead() { this.reading = false; }
  invalidate() { this.version++; }
  beginMutation() { this.mutating = true; this.invalidate(); }
  endMutation(needsRefresh: boolean) {
    this.mutating = false; this.invalidate();
    this.queued ||= needsRefresh;
  }
  takeQueued() {
    if (this.reading || this.mutating || !this.queued) return false;
    this.queued = false; return true;
  }
}

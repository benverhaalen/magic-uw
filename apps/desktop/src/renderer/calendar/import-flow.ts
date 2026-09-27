// owner: calendar-import. The panel's asynchronous import lifecycle, kept free of React so races are testable.
// Every bridge call carries the generation it started in. Stop and close advance the generation, so a
// prepare, open, attach or check that resolves later can never reopen, re-activate or auto-advance the export.
import type { AppBridge, CalendarImportRequest, CalendarImportResult } from '@magic/contracts';

export interface ImportFlowState { result: CalendarImportResult | null; pending: string | null; error: string }
type PrepareFile = Extract<CalendarImportRequest, { action: 'prepare' }>['files'][number];

export class ImportFlow {
  state: ImportFlowState = { result: null, pending: null, error: '' };
  private generation = 0;
  private sessionId: string | null = null;
  private ended = false;
  private closed = false;
  constructor(private readonly bridge: Pick<AppBridge, 'calendarImport'>, private readonly onChange: (state: ImportFlowState) => void) {}

  private set(patch: Partial<ImportFlowState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
  /** The live session id, known as soon as prepare returns (not on the next render). */
  get liveSession() { return this.ended ? null : this.sessionId; }
  /** Stop or close happened; the flow never starts again. */
  get stopped() { return this.ended; }

  private async call(request: CalendarImportRequest, key: string): Promise<CalendarImportResult | null> {
    const generation = this.generation;
    if (!this.bridge.calendarImport) { this.set({ error: 'Google Calendar import is unavailable in this app build.' }); return null; }
    this.set({ pending: key, error: '' });
    try {
      const next = await this.bridge.calendarImport(request);
      // A result from before Stop or close is stale: it must not change what the student sees.
      if (generation !== this.generation) return null;
      this.set({ result: next });
      return next;
    } catch (cause) {
      if (generation === this.generation) this.set({ error: cause instanceof Error ? cause.message : 'Magic couldn’t finish that step.' });
      return null;
    } finally {
      if (generation === this.generation) this.set({ pending: null });
    }
  }

  async status() {
    const generation = this.generation;
    try {
      const next = await this.bridge.calendarImport?.({ action: 'status' });
      if (next && generation === this.generation && !this.state.result) this.set({ result: next });
    } catch { /* capability stays unknown */ }
  }

  async start(mode: 'combined' | 'split', files: PrepareFile[]) {
    if (this.sessionId || this.ended || this.closed) return;
    const generation = this.generation;
    const pending = this.bridge.calendarImport?.({ action: 'prepare', mode, files });
    if (!pending) { this.set({ error: 'Google Calendar import is unavailable in this app build.' }); return; }
    this.set({ pending: 'prepare', error: '' });
    let prepared: CalendarImportResult;
    try { prepared = await pending; }
    catch (cause) { if (generation === this.generation) this.set({ pending: null, error: cause instanceof Error ? cause.message : 'Couldn’t prepare the file.' }); return; }
    const id = prepared.session?.id;
    if (generation !== this.generation) {
      // Closed or stopped while preparing: remove the files main just wrote and never open Google.
      if (id) void this.bridge.calendarImport?.({ action: 'stop', sessionId: id }).catch(() => {});
      return;
    }
    this.sessionId = id ?? null;
    this.set({ result: prepared, pending: null });
    if (id) await this.call({ action: 'open', sessionId: id }, 'open');
  }

  async run(request: Exclude<CalendarImportRequest, { action: 'prepare' | 'stop' }>) {
    if (this.closed || ('sessionId' in request && (this.ended || request.sessionId !== this.sessionId))) return;
    const generation = this.generation;
    const key = 'fileKey' in request ? `${request.action}:${request.fileKey}` : request.action;
    const before = this.state.result?.session;
    const next = await this.call(request, key);
    if (!next?.session || generation !== this.generation || this.ended) return;
    // After Google reports one file imported, Magic attaches the next file unless the student stopped.
    const done = next.session.files.find(f => f.state === 'imported' && before?.files.find(b => b.key === f.key)?.state !== 'imported');
    const following = next.session.stopped ? undefined : next.session.files.find(f => f.state === 'waiting');
    if (done && following) await this.call({ action: 'attach', sessionId: next.session.id, fileKey: following.key }, `attach:${following.key}`);
  }

  /** Terminal: invalidates every in-flight step, then shows main's stopped session. */
  async stop() {
    if (this.ended) return;
    this.ended = true;
    this.generation++;
    const id = this.sessionId;
    this.set({ pending: id ? 'stop' : null });
    if (!id) return;
    const generation = this.generation;
    try {
      const next = await this.bridge.calendarImport?.({ action: 'stop', sessionId: id });
      if (next && generation === this.generation) this.set({ result: next });
    } catch { /* main disposes on quit and sweeps; the UI stays stopped */ }
    finally { if (generation === this.generation) this.set({ pending: null }); }
  }

  /** Unmount or Close: stop the live session and ignore everything after. */
  close() {
    const live = this.liveSession;
    this.ended = true;
    this.closed = true;
    this.generation++;
    if (live) void this.bridge.calendarImport?.({ action: 'stop', sessionId: live }).catch(() => {});
  }
}

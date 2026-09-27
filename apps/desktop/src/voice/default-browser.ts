import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type BrowserCommand =
  | { action: 'open'; url: string }
  | { action: 'read' }
  | { action: 'scroll'; direction: 'up' | 'down' }
  | { action: 'back' };

export type BrowserTarget = {
  bundleId: string;
  pid: number;
  windowNumber?: number;
  url: string;
  title: string;
};

export type BrowserReceipt<Context> = {
  status: 'observed' | 'stopped' | 'unknown' | 'failed' | 'unavailable';
  phase: 'pre_dispatch' | 'dispatching' | 'dispatched' | 'observed';
  target?: BrowserTarget;
  text?: string;
  context: Context;
  reason?: string;
};

type NativeEvent = {
  event: 'ready' | 'dispatching' | 'dispatched' | 'observed' | 'error';
  bundleId?: string;
  pid?: number;
  windowNumber?: number;
  url?: string;
  title?: string;
  text?: string;
  code?: string;
};

const errors: Record<string, string> = {
  accessibility_permission_required: 'Allow Accessibility access for the Magic browser helper in macOS System Settings.',
  no_default_browser: 'No default web browser is configured.',
  invalid_or_unhandled_url: 'The HTTPS destination is invalid or has no default browser.',
  launch_failed: 'macOS could not open the destination in the default browser.',
  observation_timeout: 'The browser opened, but its URL and title could not be verified through Accessibility.',
  target_not_observed: 'The browser page is no longer observable.',
  ambiguous_target: 'Several browser windows match; open the page again to select one.',
};

function safeURL(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.hash || input.length > 2000) {
    throw new Error('Use an ordinary HTTPS page URL without credentials, a custom port, or a fragment.');
  }
  return url.toString();
}

/** Main-process transport. Caller owns intent, policy, confirmation, and generation checks. */
export class DefaultBrowserTransport<Context> {
  private active: ChildProcessWithoutNullStreams | undefined;
  private abortActive: (() => void) | undefined;
  private generation = 0;
  private phase: BrowserReceipt<Context>['phase'] = 'pre_dispatch';
  private target: BrowserTarget | undefined;

  constructor(private readonly helperPath: string) {}

  /** Cancels observation and prevents this transport from starting a queued action. */
  stop(): { status: 'stopped' | 'unknown'; phase: BrowserReceipt<Context>['phase'] } {
    const phase = this.phase;
    if (this.abortActive) this.abortActive();
    else { this.generation += 1; this.target = undefined; this.phase = 'pre_dispatch'; }
    return { status: phase === 'pre_dispatch' ? 'stopped' : 'unknown', phase };
  }

  async run(command: BrowserCommand, context: Context, signal: AbortSignal, current: () => boolean): Promise<BrowserReceipt<Context>> {
    if (signal.aborted || !current()) return { status: 'stopped', phase: 'pre_dispatch', context };
    if (process.platform !== 'darwin') return { status: 'unavailable', phase: 'pre_dispatch', context, reason: 'Default-browser observation is supported on macOS only.' };
    if (this.active) return { status: 'unavailable', phase: 'pre_dispatch', context, reason: 'A browser action is already in progress.' };
    if (command.action === 'scroll' || command.action === 'back') {
      return { status: 'unavailable', phase: 'pre_dispatch', context, reason: 'This browser does not expose a verified scroll or Back action yet. Open a specific page or read the current one.' };
    }
    let request: Record<string, unknown>;
    if (command.action === 'open') {
      try { request = { action: 'open', url: safeURL(command.url), timeoutMs: 8000 }; }
      catch (error) { return { status: 'failed', phase: 'pre_dispatch', context, reason: error instanceof Error ? error.message : 'Invalid URL.' }; }
      this.target = undefined;
    } else {
      if (!this.target) return { status: 'unavailable', phase: 'pre_dispatch', context, reason: 'Open a verified page first.' };
      request = { action: 'read', bundleId: this.target.bundleId, pid: this.target.pid,
        windowNumber: this.target.windowNumber, expectedURL: this.target.url };
    }
    const operation = ++this.generation;
    this.phase = 'pre_dispatch';
    return await new Promise<BrowserReceipt<Context>>(resolve => {
      let process: ChildProcessWithoutNullStreams;
      try { process = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) {
        resolve({ status: 'unavailable', phase: 'pre_dispatch', context, reason: error instanceof Error ? error.message : 'Browser helper could not start.' });
        return;
      }
      this.active = process;
      let done = false;
      let output = '';
      const finish = (receipt: BrowserReceipt<Context>) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        if (this.active === process) this.active = undefined;
        if (this.abortActive === abort) this.abortActive = undefined;
        if (operation === this.generation) this.phase = 'pre_dispatch';
        resolve(receipt);
      };
      const abort = () => {
        const phase = this.phase;
        process.kill('SIGKILL');
        if (operation === this.generation) {
          this.generation += 1;
          this.active = undefined;
          this.target = undefined;
          this.phase = 'pre_dispatch';
        }
        finish({ status: phase === 'pre_dispatch' ? 'stopped' : 'unknown', phase, context,
          reason: phase === 'pre_dispatch' ? undefined : 'Stop ended observation; an already dispatched browser navigation may still complete.' });
      };
      this.abortActive = abort;
      signal.addEventListener('abort', abort, { once: true });
      process.on('error', error => finish({ status: 'unavailable', phase: this.phase, context, reason: error.message }));
      process.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.length > 64_000) { process.kill('SIGKILL'); finish({ status: 'failed', phase: this.phase, context, reason: 'Browser helper response exceeded its limit.' }); return; }
        let end = output.indexOf('\n');
        while (end >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          end = output.indexOf('\n');
          let event: NativeEvent;
          try { event = JSON.parse(line) as NativeEvent; } catch { continue; }
          if (operation !== this.generation || signal.aborted || !current()) { abort(); return; }
          if (event.event === 'ready') {
            // The helper cannot invoke NSWorkspace until this second message.
            // Mark uncertain before sending it, so Stop never promises zero
            // effect once dispatch may have started.
            this.phase = 'dispatching';
            process.stdin.end('go\n');
          }
          if (event.event === 'dispatching') this.phase = 'dispatching';
          if (event.event === 'dispatched') this.phase = 'dispatched';
          if (event.event === 'error') {
            process.kill('SIGKILL');
            const status = this.phase === 'dispatched' ? 'unknown' : 'failed';
            finish({ status, phase: this.phase, context, reason: errors[event.code ?? ''] ?? event.code ?? 'Browser operation failed.' });
          }
          if (event.event === 'observed' && event.bundleId && event.pid && event.url && event.title) {
            const target: BrowserTarget = { bundleId: event.bundleId, pid: event.pid, windowNumber: event.windowNumber,
              url: event.url, title: event.title };
            this.target = target;
            process.kill('SIGKILL');
            if (command.action === 'read' && !event.text?.trim()) {
              finish({ status: 'unavailable', phase: 'observed', context, target,
                reason: 'The browser exposed its page URL and title, but no readable page text through Accessibility.' });
              return;
            }
            finish({ status: 'observed', phase: 'observed', context, target, text: command.action === 'read' ? (event.text ?? '') : undefined });
          }
        }
      });
      process.on('close', () => {
        if (!done) finish({ status: this.phase === 'pre_dispatch' ? 'failed' : 'unknown', phase: this.phase,
          context, reason: 'The browser helper exited without an observation.' });
      });
      process.stdin.write(JSON.stringify(request) + '\n');
      if (command.action === 'read') process.stdin.end();
      process.stdin.on('error', error => finish({ status: this.phase === 'pre_dispatch' ? 'failed' : 'unknown',
        phase: this.phase, context, reason: error.message }));
      if (signal.aborted || !current()) abort();
    });
  }
}

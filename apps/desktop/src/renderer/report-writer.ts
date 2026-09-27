import type { Command, CommandResult, PersonalReportChange } from '@magic/contracts';
import { personalReportState } from '@magic/contracts';

export type ReportRun = (command: Command) => Promise<CommandResult | undefined>;
export interface ReportFeedback { pending: boolean; error: string }
type ReportContext = Omit<PersonalReportChange, 'operationId' | 'handled'>;

/** A serialized, version-scoped writer. Only the parent's saved snapshot controls checked state. */
export class ReportWriter {
  private generation = 0;
  private active = false;
  private uncertain: PersonalReportChange | null = null;
  private context: ReportContext;
  constructor(context: ReportContext, private emit: (feedback: ReportFeedback) => void) { this.context = context; }

  update(context: ReportContext) {
    if (context.issueId !== this.context.issueId || context.sourceVersion !== this.context.sourceVersion) {
      this.invalidate();
    } else if (this.uncertain && context.expectedRevision > this.uncertain.expectedRevision) {
      this.uncertain = null;
      this.emit({ pending: this.active, error: '' });
    }
    this.context = context;
  }
  invalidate() {
    this.generation++;
    this.active = false;
    this.uncertain = null;
  }
  async change(handled: boolean, run: ReportRun) {
    if (this.active) return;
    this.active = true;
    const ticket = this.generation;
    const context = this.context;
    // An uncertain retry is the same intent, not a second journal event.
    const value = this.uncertain?.handled === handled && this.uncertain.expectedRevision === context.expectedRevision
      ? this.uncertain : { ...context, handled, operationId: crypto.randomUUID() };
    this.emit({ pending: true, error: '' });
    const execute = async (command: Command) => { try { return await run(command); } catch { return undefined; } };
    let result = await execute({ type: 'personal-report', value });
    if (ticket !== this.generation) return;
    if (!result) {
      this.uncertain = value;
      result = await execute({ type: 'snapshot' });
      if (ticket !== this.generation) return;
    }
    let error = 'Not confirmed. Try again.';
    if (result) {
      const saved = personalReportState(result.snapshot.personalReports, context.issueId, context.sourceVersion);
      // A concurrent later intent wins; never resurrect an older report through a retry.
      if (saved.revision > context.expectedRevision) this.uncertain = null;
      if (saved.revision >= context.expectedRevision && Boolean(saved.record) === handled) error = '';
      if (this.context.expectedRevision > saved.revision) error = ''; // Newer snapshot already won.
    }
    this.active = false;
    this.emit({ pending: false, error });
  }
}

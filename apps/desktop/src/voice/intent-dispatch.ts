import { intentCommandSchema, type CommandResult, type IntentCommandResult, type Snapshot } from '@magic/contracts';
import type { VoiceDispatch } from './session';
import { trialNavigation } from './trial-navigation';
export const INTERACTIVE_ACTIONS = ['page.open', 'course.open', 'assignment.open', 'ask', 'agenda.due', 'materials.search'];
export function createInteractiveDispatch(execute: (command: unknown, signal?: AbortSignal) => Promise<CommandResult>): VoiceDispatch {
  return async (text, context, operation): Promise<IntentCommandResult> => {
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error('Request context changed.');
    const value = intentCommandSchema.parse({ text, context, mode: 'run', allowedActions: INTERACTIVE_ACTIONS });
    const result = await execute({ type: 'command', value }, operation.signal);
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error('Request context changed.');
    if (!result.command) throw new Error('The app returned no result for this request.');
    return result.command;
  };
}

/** Early local trial: no provider request or external action is reachable from speech. */
export function createVoiceTrialDispatch(snapshot: () => Snapshot | null = () => null): VoiceDispatch {
  return async (text, context, operation) => {
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error('Request context changed.');
    // These exact local destinations need no worker snapshot or provider. In particular, a
    // queued workspace request must not turn a simple spoken page change into a timeout.
    const outcome = trialNavigation(text, snapshot());
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error('Request context changed.');
    return outcome.status === 'ran' ? { ...outcome, args: { ...outcome.args, ...context } } : outcome;
  };
}

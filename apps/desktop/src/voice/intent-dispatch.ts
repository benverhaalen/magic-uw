import { intentCommandSchema, type CommandResult, type IntentCommandResult } from '@magic/contracts';
import type { VoiceDispatch } from './session';
import { pageDestination } from '../../../../packages/core/src/intent/page-action';
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
export function createVoiceTrialDispatch(execute: (command: unknown, signal?: AbortSignal) => Promise<CommandResult>): VoiceDispatch {
  return async (text, context, operation) => {
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error('Request context changed.');
    if (!pageDestination(text)) return { status: 'unavailable', reason: 'This voice trial opens Home, Courses, Calendar, or My UW. Say “Open Calendar”. Connected-agent computer actions are still being connected.', path: 'none', latencyMs: 0, tokens: {in:0,cached:0,out:0} };
    const value = intentCommandSchema.parse({text, context, mode:'run', allowedActions:['page.open']});
    const result = await execute({type:'command',value},operation.signal);
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error('Request context changed.');
    if (!result.command) throw new Error('No navigation result was returned.');
    return result.command;
  };
}

// owner: conversation-launcher leaf. The integrator mounts one instance in the shell and binds onSubmit to the chat owner.
export {
  ConversationLauncher,
  type ConversationLauncherProps, type LauncherHere, type LauncherVoice, type LauncherVoiceState,
} from "./ConversationLauncher";
export type { LauncherEntry, SubmitOutcome } from "./model";

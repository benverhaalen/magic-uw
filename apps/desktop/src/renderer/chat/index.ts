// owner: chat lane. The integrator binds these; see the chat lane handoff for the exact contract.
export { ChatPane, type ChatInfo, type ChatPaneProps } from "./ChatPane";
export { chatCourse, chatScopeForPage, scopeLabel, type ChatCourse, type ChatScope } from "./model";
export {
  chatPromptError, continueChat, followUpHint, getChat, goneOrigin, startChat, subscribe,
  type Chat, type ChatBridge, type ChatEntry, type ChatOrigin, type ChatRuntime,
} from "./store";

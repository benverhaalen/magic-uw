// owner: chat lane. The integrator binds these; see the chat lane handoff for the exact contract.
export { ChatPane, type ChatPaneProps } from "./ChatPane";
export { chatScopeForPage, scopeLabel, type ChatScope } from "./model";
export {
  continueChat, followUpHint, getChat, startChat, subscribe,
  type Chat, type ChatBridge, type ChatEntry, type ChatOrigin, type ChatRuntime,
} from "./store";

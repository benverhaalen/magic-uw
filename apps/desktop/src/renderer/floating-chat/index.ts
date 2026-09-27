// owner: floating-chat. The app mounts FloatingChat once in the shell; the settings page shows FloatingChatSetting.
export { FloatingChat, FLOATING_CHAT_AVOID, type FloatingChatProps } from "./FloatingChat";
export { FloatingChatSetting, useFloatingChatEnabled, setFloatingChatEnabled } from "./setting";
export { defineFloatingChat, setWizardState, MagicFloatingChat, FLOATING_CHAT_TAG, type FloatingChatCloseReason, type FloatingChatEvents } from "./element";
export { createWizardRig, type WizardRig, type WizardState } from "./rig";

// owner: floating-chat. "Floating chat: on/off", default off. A display preference on this device, kept in
// localStorage beside the corner and size; no coursework and nothing sent anywhere.
import { useSyncExternalStore } from "react";
import { readEnabled, safeStorage, STORAGE_KEYS, writeEnabled } from "./model";

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  const fromOtherWindow = (event: StorageEvent) => { if (event.key === STORAGE_KEYS.enabled) listener(); };
  window.addEventListener("storage", fromOtherWindow);
  return () => { listeners.delete(listener); window.removeEventListener("storage", fromOtherWindow); };
}
export function setFloatingChatEnabled(on: boolean) {
  writeEnabled(safeStorage(), on);
  for (const listener of listeners) listener();
}
export function useFloatingChatEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => readEnabled(safeStorage()), () => false);
}

/** The settings row. Uses the settings page's existing toggle markup and classes. */
export function FloatingChatSetting() {
  const on = useFloatingChatEnabled();
  return <section className="settings-section">
    <h2>Floating chat</h2>
    <label className="setting-toggle">
      <span>
        <strong>Floating chat: {on ? "on" : "off"}</strong>
        <span>Show the wizard button in a corner of the window. It opens a chat about the page you are on.</span>
      </span>
      <input type="checkbox" role="switch" checked={on} onChange={(event) => setFloatingChatEnabled(event.target.checked)}/>
    </label>
  </section>;
}

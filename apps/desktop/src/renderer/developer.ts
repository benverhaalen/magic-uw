// owner: source-categories. Developer details (raw per-endpoint source lists, diagnostic codes) show only
// when this device's developer flag is on: localStorage "magic.developer" = "on". Students never see them.
export const DEVELOPER_KEY = "magic.developer";
export function developerMode(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(DEVELOPER_KEY) === "on";
  } catch {
    return false;
  }
}

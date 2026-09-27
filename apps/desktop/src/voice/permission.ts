// owner: voice. The one permission the app window can grant: the microphone, audio only,
// to the app's own renderer page in its main frame. Everything else (camera, screen, notifications,
// geolocation, other pages) stays refused, as before voice input.
export interface MediaRequest {
  /** The request came from the app window's own web contents. */
  fromAppWindow: boolean;
  permission: string;
  /** Electron's `details.mediaTypes` for a media request. */
  mediaTypes?: readonly string[];
  requestingUrl?: string;
  isMainFrame?: boolean;
}

/** `rendererURL`: the exact file URL the app window loads. A hash or query on it is the same page. */
export function allowsVoiceMic(request: MediaRequest, rendererURL: string): boolean {
  if (!request.fromAppWindow || request.permission !== "media" || request.isMainFrame === false) return false;
  const types = request.mediaTypes ?? [];
  if (!types.length || types.some((type) => type !== "audio")) return false;
  const url = request.requestingUrl ?? "";
  if (!url.startsWith(rendererURL)) return false;
  const rest = url.slice(rendererURL.length);
  return rest === "" || rest.startsWith("#") || rest.startsWith("?");
}

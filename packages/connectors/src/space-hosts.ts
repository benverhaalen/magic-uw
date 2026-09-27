/**
 * The host table (plan D32, D40, D41): each host a UW course links to, mapped by code to a kind,
 * to **store or link** (D40), to its access route, and to whether the app may make one plain GET
 * to check access (D41). Unknown hosts are marked for Jev, which picks a kind from the closed set.
 *
 * Evidence: `research/piece-P3/brief-uw-tools.md` (UW KB pages fetched 2026-09-26). Hosts marked
 * `verified: false` came from search summaries or vendor naming, not from fetched page bytes.
 * The launch side effects are UW's own words: Top Hat, Piazza and Gradescope enrol or create an
 * account on click, and Honorlock starts webcam, microphone and screen recording on launch.
 */
export type SpaceKind =
  | "canvas_page"
  | "canvas_file"
  | "canvas_assignment"
  | "canvas_quiz"
  | "canvas_discussion"
  | "canvas_tab"
  | "syllabus"
  | "video"
  | "code"
  | "course_site"
  | "files_share"
  | "courseware"
  | "etext"
  | "polling"
  | "qa"
  | "homework"
  | "proctoring"
  | "originality"
  | "survey"
  | "portal"
  | "lti_tool"
  | "unknown";
/** D40: text-bearing content is stored as passages; tools and platforms stay click-to-open links. */
export type SpaceTreatment = "store" | "link";
export type AccessRoute =
  | "public"
  | "uw_session"
  | "canvas_session"
  | "own_login"
  | "lti_launch";
/**
 * - session: one GET in the app's own UW session, through main's `source-fetch` (service "space")
 * - public: one GET with no credentials, through the worker's public client
 * - none: no request, ever
 */
export type AccessCheck = "session" | "public" | "none";
export interface HostRule {
  /** An exact hostname, or ".suffix" for the host and every subdomain. */
  match: string;
  name: string;
  kind: SpaceKind;
  treatment: SpaceTreatment;
  route: AccessRoute;
  check: AccessCheck;
  /** UW single sign-on host: the fix is one navigation in the app's sign-in window (D41). */
  signIn?: "app_window";
  /** false: the app offers no "open" for it (Honorlock starts proctoring on launch). */
  openable?: boolean;
  /** What opening it does, in UW's words, shown on the link card. */
  launchEffect?: string;
  verified: boolean;
}
export const CANVAS_HOST = "canvas.wisc.edu";
/** Order matters: the first match wins, so exact hosts precede the `.wisc.edu` catch-all. */
export const hostTable: readonly HostRule[] = [
  { match: CANVAS_HOST, name: "Canvas", kind: "canvas_page", treatment: "store", route: "canvas_session", check: "none", verified: true },
  // Kaltura: video pages are links (D40); captions are T32's, if probe K1 passes. Read on its own host, never via the LTI launch (D32).
  { match: "mediaspace.wisc.edu", name: "Kaltura MediaSpace", kind: "video", treatment: "link", route: "uw_session", check: "session", signIn: "app_window", verified: true },
  { match: "git.doit.wisc.edu", name: "UW GitLab", kind: "code", treatment: "store", route: "uw_session", check: "session", signIn: "app_window", verified: true },
  // No scraping of MyUW, Handshake or WIN (workspace rule); link only.
  { match: "my.wisc.edu", name: "MyUW", kind: "portal", treatment: "link", route: "uw_session", check: "none", verified: true },
  { match: ".joinhandshake.com", name: "Handshake", kind: "portal", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".qualtrics.com", name: "Qualtrics", kind: "survey", treatment: "link", route: "own_login", check: "none", launchEffect: "First use creates a UW Qualtrics account.", verified: true },
  { match: ".tophat.com", name: "Top Hat", kind: "polling", treatment: "link", route: "own_login", check: "none", launchEffect: "Opening a Top Hat link in Canvas enrols you in the Top Hat course.", verified: false },
  { match: ".piazza.com", name: "Piazza", kind: "qa", treatment: "link", route: "own_login", check: "none", launchEffect: "Opening the Canvas Piazza link adds you to the Piazza roster.", verified: false },
  { match: ".gradescope.com", name: "Gradescope", kind: "homework", treatment: "link", route: "own_login", check: "none", launchEffect: "Opening a Gradescope link can create your Gradescope account and add you to the roster.", verified: false },
  { match: ".honorlock.com", name: "Honorlock", kind: "proctoring", treatment: "link", route: "lti_launch", check: "none", openable: false, launchEffect: "Launching Honorlock starts webcam, microphone and screen recording. Open it from Canvas when you take the exam.", verified: false },
  { match: ".turnitin.com", name: "Turnitin", kind: "originality", treatment: "link", route: "lti_launch", check: "none", launchEffect: "Submitting through Turnitin generates a similarity report.", verified: false },
  { match: ".box.com", name: "Box", kind: "files_share", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".sharepoint.com", name: "OneDrive", kind: "files_share", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: "drive.google.com", name: "Google Drive", kind: "files_share", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: "docs.google.com", name: "Google Docs", kind: "files_share", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".cengage.com", name: "Cengage", kind: "courseware", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".pearson.com", name: "Pearson", kind: "courseware", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".macmillanlearning.com", name: "Macmillan Learning", kind: "courseware", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".redshelf.com", name: "Engage eText", kind: "etext", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".zybooks.com", name: "zyBooks", kind: "courseware", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".perusall.com", name: "Perusall", kind: "etext", treatment: "link", route: "own_login", check: "none", verified: false },
  { match: ".youtube.com", name: "YouTube", kind: "video", treatment: "link", route: "public", check: "none", verified: false },
  { match: "youtu.be", name: "YouTube", kind: "video", treatment: "link", route: "public", check: "none", verified: false },
  { match: "github.com", name: "GitHub", kind: "code", treatment: "store", route: "public", check: "public", verified: false },
  // Departmental course sites (for example pages.cs.wisc.edu) are read by the external-site connector.
  { match: ".wisc.edu", name: "UW site", kind: "course_site", treatment: "store", route: "public", check: "public", verified: false },
];
function matches(rule: HostRule, host: string) {
  return rule.match.startsWith(".")
    ? host === rule.match.slice(1) || host.endsWith(rule.match)
    : host === rule.match;
}
export interface HostClass {
  rule: HostRule;
  /** Code doesn't know the host: Jev picks the kind from the closed set (D32 step 2). */
  jev: boolean;
}
/** An unknown host: a link until classified; the check is the same public GET the external-site connector makes. */
const unknownRule: HostRule = {
  match: "*",
  name: "Website",
  kind: "unknown",
  treatment: "link",
  route: "public",
  check: "public",
  verified: false,
};
export function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const rule = hostTable.find((r) => matches(r, host));
  return rule ? { rule, jev: false } : { rule: unknownRule, jev: true };
}
/**
 * The LTI guard (D32): a URL that launches a tool, or would redirect into one, is never requested.
 * Canvas: `/external_tools/…` (including `sessionless_launch` and `retrieve`), module item redirects
 * (`/modules/items/:id`, which launch ExternalTool items), `/lti/…` and assignment-level launches.
 */
export function isLaunchUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return true;
  }
  const path = decodeURIComponent(url.pathname).toLowerCase();
  return (
    /\/external_tools(?:\/|$)/.test(path) ||
    /sessionless_launch/.test(path + url.search.toLowerCase()) ||
    /\/modules\/items\/\d+/.test(path) ||
    /(?:^|\/)lti(?:\/|$)/.test(path) ||
    /\/launch(?:\/|$)/.test(path)
  );
}
/**
 * Main's gate for `source-fetch` service "space" (D41): https, a host whose rule allows a
 * session check, no credentials or fragment, and never a launch. Returns the URL to GET.
 */
export function checkedSpaceProbeUrl(input: string): string {
  const url = new URL(input);
  const { rule, jev } = classifyHost(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    jev ||
    rule.check !== "session" ||
    isLaunchUrl(url.href)
  )
    throw new Error("Space check refused.");
  return url.href;
}
/** A redirect target that means "sign in first": UW's NetID login, Canvas /login, or the host's own sign-in page. */
export function isSignInTarget(
  target: string | null | undefined,
  base: string,
): boolean {
  if (!target) return false;
  try {
    const url = new URL(target, base);
    return (
      url.hostname === "login.wisc.edu" ||
      url.hostname.endsWith(".login.wisc.edu") ||
      url.hostname === "idp.wisc.edu" ||
      (url.hostname === CANVAS_HOST && /^\/login(?:\/|$)/.test(url.pathname)) ||
      /\/(?:users\/sign_in|login|signin|sign-in|saml|shibboleth|idp)(?:\/|$|\.)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

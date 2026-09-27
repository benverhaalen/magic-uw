/** One renderer-wide outage signal; original diagnostics remain inspectable in the shell. */
export const WORKSPACE_FAILURE = 'magic-workspace-failure';
export function reportWorkspaceFailure(cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  window.dispatchEvent(new CustomEvent(WORKSPACE_FAILURE, { detail }));
  return detail;
}
export function workspaceFailureMessage(detail: string) {
  return /timed? ?out|timeout/i.test(detail) ? 'Workspace is taking too long. Saved items remain available.' : 'The action could not finish. Please try again.';
}

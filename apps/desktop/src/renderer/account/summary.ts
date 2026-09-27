// owner: account-card. What the account card says, from the snapshot alone (no reads of its own): UW
// sign-in, Canvas freshness and the connected-source count come from the Sources page's own projection
// and its plain state words, so the card and that page never disagree.
import type { Snapshot } from "@magic/contracts";
import { buildSourcesModel, connectionStateWords, formatWhen } from "../sources/model";


export interface AccountSummary {
  /** The student's name when the workspace stores one; this build stores none, so it names the workspace. */
  name: string;
  uw: string;
  canvas: string;
  sources: string;
}

export function accountSummary(snapshot: Pick<Snapshot, "sources" | "syncRuns" | "planning" | "fixtureMode">, now: Date): AccountSummary {
  const model = buildSourcesModel(snapshot, { now, outlook: { icsConnected: null } });
  const canvas = model.connections.find((c) => c.id === "canvas") ?? model.connections[0]!;
  const live = model.connections.filter((c) => c.state !== "not_connected" && c.state !== "sample").length;
  const confirmed = `last confirmed ${formatWhen(canvas.newestSuccessAt, now)}`;
  const uw = canvas.state === "not_connected" || canvas.state === "sample"
    ? "Not signed in"
    : canvas.state === "needs_sign_in"
      ? `Sign in again · ${confirmed}`
      : canvas.newestSuccessAt ? `Signed in · ${confirmed}` : "Signed in · not read yet";
  return {
    name: snapshot.fixtureMode ? "Sample student" : "Your workspace",
    uw,
    canvas: canvas.state === "not_connected" ? "Not connected" : `${connectionStateWords(canvas)} · ${canvas.freshness}`,
    sources: live === 0 ? "None yet" : `${live} ${live === 1 ? "source" : "sources"}`,
  };
}

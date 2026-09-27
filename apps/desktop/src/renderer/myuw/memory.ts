import type { PlanningComparison } from "@magic/contracts";

// owner: My UW lane. Return state for Back and route changes. Renderer memory only: nothing here is
// persisted, sent anywhere or shared with another student record; an app reload starts fresh.
export type PlanStyle = "balanced" | "mornings" | "compact" | "lighter";
export interface MyUwMemory {
  term: string; style: PlanStyle; subject: string;
  comparison: { input: string; value: PlanningComparison } | null;
  openRequirements: string[]; scrollTop: number; focusId: string | null;
}
export const myUwMemory: MyUwMemory = { term: "", style: "balanced", subject: "", comparison: null, openRequirements: [], scrollTop: 0, focusId: null };
export function resetMyUwMemory() {
  Object.assign(myUwMemory, { term: "", style: "balanced", subject: "", comparison: null, openRequirements: [], scrollTop: 0, focusId: null });
}

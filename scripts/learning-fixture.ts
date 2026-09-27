// Explicit browser QA fixture only. Never imported by the desktop worker.
import type { LearningActivity, LearningSession } from "@magic/contracts";
import type { LearningBackendPorts } from "../apps/desktop/src/learning-service";

export function createLearningFixture(): LearningBackendPorts {
  const sessions = new Map<string, LearningSession>();
  const activities = new Map<string, LearningActivity>();
  return {
    sessions: {
      learningSession: id => structuredClone(sessions.get(id)),
      learningSessions: id => structuredClone([...sessions.values()].filter(s => s.resourceId === id)),
      putLearningSession(session, expected) {
        const current = sessions.get(session.id);
        if ((current?.revision ?? null) !== expected) throw new Error("Synthetic revision conflict");
        sessions.set(session.id, structuredClone(session));
      },
    },
    study: {
      selectPrepared({ sources, excludeActivityIds }) {
        const source = sources[0];
        if (!source) return undefined;
        const n = [1, 2].find(n => !excludeActivityIds.includes(`synthetic-item-${n}`));
        if (!n) return undefined;
        const quote = source.text.slice(0, 100);
        const activity: LearningActivity = {
          id: `synthetic-item-${n}`, model: "synthetic-prepared", digest: "qa-only", createdAt: new Date().toISOString(),
          format: "practice", title: `Evidence comparison ${n}`,
          content: "Synthetic prepared practice. Compare two arguments about library hours.",
          prompt: n === 1 ? "What evidence would help you compare the arguments?" : "What finding would weaken one argument?",
          reason: "Synthetic QA item linked to the permitted source below.",
          citations: [{ resourceId: source.resourceId, contentHash: source.contentHash, quote, start: 0, end: quote.length }],
        };
        activities.set(activity.id, activity);
        return activity;
      },
      hint(id) { const a = activities.get(id); return a && { text: "Synthetic saved hint: distinguish the claim from supporting observations.", citations: a.citations }; },
      grade({ activityId }) { const a = activities.get(activityId); return a && { text: "Synthetic saved feedback. This fixture does not evaluate correctness or learning.", citations: a.citations }; },
    },
    packs: {
      async explain(request, signal) {
        if (signal.aborted) throw new Error("Cancelled");
        const source = request.payload.sources[0], quote = source.text.slice(0, 100);
        return {
          activity: { id: `synthetic-explain-${Date.now()}`, model: "synthetic-pack", digest: "qa-only", createdAt: new Date().toISOString(), format: "explanation", title: "Claims and evidence", content: "Synthetic explanation: a claim states a position; evidence supports or challenges it.", prompt: "How would you distinguish a claim from its evidence?", reason: "Explicit explanation request over permitted source material.", citations: [{ resourceId: source.resourceId, contentHash: source.contentHash, quote, start: 0, end: quote.length }] },
          requestHash: request.payloadHash,
          receipt: { id: "synthetic-receipt", payloadHash: request.payloadHash, status: "sent" },
        };
      },
    },
  };
}

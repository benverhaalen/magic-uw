// The analytics ops' requests, parsed at the router boundary. Course-scoped like the practice
// ops: the renderer names the course's anchor resources and the trusted resolver authorizes each.
import { z } from "zod";

const id = z.string().min(1).max(256);
const scope = { courseId: id, anchorIds: z.array(id).min(1).max(50) };
const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) => z.object({ op: z.literal(name), ...shape }).strict();

export const analyticsRequestSchema = z.discriminatedUnion("op", [
  op("analytics.assignment", { ...scope, assignmentId: id }),
  op("analytics.course", { ...scope, sessions: z.number().int().min(1).max(20).optional() }),
  op("analytics.agendaHints", scope),
]);
export type AnalyticsRequest = z.infer<typeof analyticsRequestSchema>;

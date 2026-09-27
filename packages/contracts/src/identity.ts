import { z } from "zod";

/**
 * Local identity roster used to scrub outgoing free text before hosted
 * processing. It never leaves the device; hosted recipients only receive the
 * opaque placeholders produced from it. Scrubbing is not anonymization.
 */
const name = z.string().trim().min(2).max(200);
export const identityPersonSchema = z
  .object({
    names: z.array(name).max(10).default([]),
    emails: z.array(z.string().trim().min(3).max(320)).max(10).default([]),
    netIds: z
      .array(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,15}$/))
      .max(10)
      .default([]),
    studentIds: z
      .array(z.string().trim().regex(/^\d{6,12}$/))
      .max(10)
      .default([]),
  })
  .strict();
export type IdentityPerson = z.infer<typeof identityPersonSchema>;
export const identityRosterSchema = z
  .object({
    /** The student using the app. */
    self: identityPersonSchema.optional(),
    /** Classmates, group members, peer reviewers, discussion authors. */
    peers: z.array(identityPersonSchema).max(500).default([]),
    /** Extra instructor/author names to keep in addition to captured course teachers. */
    retain: z.array(name).max(100).default([]),
  })
  .strict();
export type IdentityRoster = z.infer<typeof identityRosterSchema>;
export const emptyIdentityRoster: IdentityRoster = { peers: [], retain: [] };

export type RedactionKind =
  | "student_name"
  | "email"
  | "netid"
  | "student_id"
  | "phone";
/** What a manifest discloses about scrubbing; never contains original values. */
export interface RedactionSummary {
  applied: boolean;
  counts: Partial<Record<RedactionKind, number>>;
  /** Hash of the effective local roster; citations resolve only against the same roster. */
  rosterVersion: string;
  note: string;
}

/**
 * A generated claim's citation. `quote` is literal text from the captured
 * source version; with basis "outgoing" it (and any offsets) refer to the
 * scrubbed text that was sent to the hosted recipient.
 */
export const citationClaimSchema = z
  .object({
    resourceId: z.string().min(1).max(256),
    contentHash: z.string().min(1).max(256),
    field: z.enum(["text", "title", "policy"]).default("text"),
    basis: z.enum(["outgoing", "original"]).default("outgoing"),
    quote: z.string().min(1).max(4000),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (c) =>
      (c.start === undefined) === (c.end === undefined) &&
      (c.start === undefined || c.end! > c.start),
    { message: "start and end must be supplied together with end > start" },
  );
export type CitationClaim = z.input<typeof citationClaimSchema>;
export type CitationFailure =
  | "source_missing"
  | "stale_version"
  | "offset_mismatch"
  | "quote_not_found"
  | "ambiguous_quote"
  | "quote_splits_redaction";
/**
 * "supported" means only that the literal span exists in that captured
 * version. Applicability, negation and semantic support need separate checks.
 */
export interface CitationResult {
  index: number;
  resourceId: string;
  contentHash: string;
  field: "text" | "title" | "policy";
  status: "supported" | "unsupported";
  reason?: CitationFailure;
  /** Span in the original captured text (local only). */
  original?: { start: number; end: number; text: string };
  /** Span in the text the claim cited (scrubbed text for basis "outgoing"). */
  cited?: { start: number; end: number };
  containsRedaction?: boolean;
}

/**
 * Identities captured automatically during a sync (never stored in resources,
 * snapshots or MCP output). One update either sets the account's own identity
 * from the Canvas profile or adds non-teacher authors seen in a course.
 */
export const autoIdentityUpdateSchema = z
  .object({
    accountScope: z.string().min(1).max(256),
    self: identityPersonSchema.optional(),
    courseId: z.string().min(1).max(256).optional(),
    authors: z.array(name).max(2000).optional(),
  })
  .strict();
export type AutoIdentityUpdate = z.input<typeof autoIdentityUpdateSchema>;
export const autoIdentityStateSchema = z
  .object({
    accounts: z.record(
      z.string().max(256),
      z
        .object({
          self: identityPersonSchema.optional(),
          authorsByCourse: z.record(z.string().max(256), z.array(name).max(2000)).default({}),
        })
        .strict(),
    ),
  })
  .strict();
export type AutoIdentityState = z.infer<typeof autoIdentityStateSchema>;

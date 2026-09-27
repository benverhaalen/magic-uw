import type { Resource, SourceHealth } from "@magic/contracts";
import { classifyHost } from "../../../../../packages/connectors/src/space-hosts";

// owner: voice-learning-media lane. Pure selection of course-posted videos for a learning reply.
// Evidence only: a video is shown when the course itself put it next to the answer's sources, by
// citation, by a link inside a cited source, or by placement in the same Canvas module. There is no
// YouTube search, no title similarity and no model choice; nothing here is a recommendation by guess.

export type VideoRelation =
  /** The answer cited the saved video item itself. */
  | { kind: "cited"; resourceId: string; title: string }
  /** A cited source links to the video. */
  | { kind: "linked"; resourceId: string; title: string; linkText: string | null }
  /** The course placed the video in the same module as a cited source. */
  | { kind: "same-module"; resourceId: string; title: string };

export interface CourseVideo {
  /** Stable per video, so youtu.be and youtube.com links to one video are shown once. */
  key: string;
  url: string;
  title: string;
  /** From the shared host table, never inferred. */
  host: string;
  hostVerified: boolean;
  /** Kaltura and other UW-session hosts can ask the student to sign in in their browser. */
  needsUwSignIn: boolean;
  /** Seconds into the video when the course's link names a start time. */
  startSeconds: number | null;
  course: { accountScope: string; courseId: string; label: string };
  relation: VideoRelation;
  /** When the evidence that ties this video to the answer was saved. */
  observedAt: string;
}

export type CourseVideoResult =
  | { status: "found"; videos: CourseVideo[] }
  | { status: "none"; reason: string }
  | { status: "unavailable"; reason: string };

export interface PermittedCourse { accountScope: string; courseId: string }

function https(url: string | undefined | null): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed : null;
  } catch {
    return null;
  }
}

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
  if (!host.endsWith("youtube.com")) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function startSeconds(url: URL): number | null {
  const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (!raw) return null;
  const parts = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!parts || !raw.length) return null;
  const total = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return total > 0 ? total : null;
}

/** A video link the shared host table knows. Unknown hosts are not guessed to be video. */
export function videoLink(raw: string | undefined | null): { url: string; key: string; host: string; verified: boolean; needsUwSignIn: boolean; startSeconds: number | null } | null {
  const url = https(raw);
  if (!url) return null;
  const { rule, jev } = classifyHost(url.hostname);
  if (jev || rule.kind !== "video") return null;
  const id = youtubeId(url);
  if (rule.name === "YouTube" && !id) return null;
  return {
    url: url.href,
    key: id ? `youtube:${id}` : `${url.hostname}${url.pathname}`,
    host: rule.name,
    verified: rule.verified,
    needsUwSignIn: rule.route === "uw_session",
    startSeconds: startSeconds(url),
  };
}

const videoOf = (r: Resource) => videoLink(r.moduleItem?.externalUrl ?? r.url);
const linksOf = (r: Resource) => (r.links ?? []).map((link) => (typeof link === "string" ? { url: link, text: null } : { url: link.url, text: link.text ?? null }));

/** Plain reading aid for display: "12:30". */
export function startLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Videos tied to the answer's sources by course evidence. `anchorIds` are the resource IDs the answer
 * actually cited or was generated from. Only anchors in a permitted account+course are read, and only
 * videos from that same account+course are returned.
 */
export function courseVideosFor(
  anchorIds: readonly string[],
  resources: readonly Resource[],
  sources: readonly Pick<SourceHealth, "id" | "accountScope">[],
  permitted: readonly PermittedCourse[],
  limit = 3,
): CourseVideoResult {
  if (!resources.length) return { status: "unavailable", reason: "Your saved course items aren't loaded yet." };
  const scopeOf = (r: Resource) => sources.find((s) => s.id === r.sourceId)?.accountScope ?? null;
  const allowed = (r: Resource) => {
    const account = scopeOf(r);
    return !r.deleted && !!account && permitted.some((c) => c.accountScope === account && c.courseId === r.courseId);
  };
  const byId = new Map(resources.map((r) => [r.id, r]));
  const anchors = [...new Set(anchorIds)].map((id) => byId.get(id)).filter((r): r is Resource => !!r && allowed(r));
  if (!anchors.length) return { status: "none", reason: "This answer has no included course source to look for videos in." };
  const found = new Map<string, CourseVideo>();
  const add = (video: NonNullable<ReturnType<typeof videoLink>>, title: string, anchor: Resource, relation: VideoRelation, observedAt: string) => {
    if (found.has(video.key)) return;
    found.set(video.key, {
      key: video.key, url: video.url, title, host: video.host, hostVerified: video.verified,
      needsUwSignIn: video.needsUwSignIn, startSeconds: video.startSeconds,
      course: { accountScope: scopeOf(anchor)!, courseId: anchor.courseId, label: anchor.courseName },
      relation, observedAt,
    });
  };
  // Strongest evidence first: cited video items, then links inside cited sources, then module placement.
  for (const anchor of anchors) {
    const video = videoOf(anchor);
    if (video) add(video, anchor.title, anchor, { kind: "cited", resourceId: anchor.id, title: anchor.title }, anchor.observedAt);
  }
  for (const anchor of anchors) for (const link of linksOf(anchor)) {
    const video = videoLink(link.url);
    if (video) add(video, link.text?.trim() || `${video.host} video`, anchor, { kind: "linked", resourceId: anchor.id, title: anchor.title, linkText: link.text }, anchor.observedAt);
  }
  for (const anchor of anchors) {
    const moduleId = anchor.moduleItem?.moduleId;
    if (!moduleId) continue;
    const account = scopeOf(anchor);
    for (const other of resources) {
      if (other.id === anchor.id || other.courseId !== anchor.courseId || other.moduleItem?.moduleId !== moduleId || !allowed(other) || scopeOf(other) !== account) continue;
      const video = videoOf(other);
      if (video) add(video, other.title, anchor, { kind: "same-module", resourceId: anchor.id, title: anchor.title }, other.observedAt);
    }
  }
  const videos = [...found.values()].slice(0, limit);
  return videos.length ? { status: "found", videos } : { status: "none", reason: "Your course hasn't linked a video to these sources. Magic doesn't search YouTube for you." };
}

/** Display-only cue for showing the empty state. It never starts a search or grants anything. */
export const asksForVideo = (prompt: string) => /\b(videos?|youtube|recordings?|watch)\b/i.test(prompt);

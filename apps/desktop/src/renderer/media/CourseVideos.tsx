import { useMemo, useState } from "react";
import type { AppBridge, Resource, SourceHealth } from "@magic/contracts";
import { Action } from "../../../../../packages/ui/src";
import { MagicGlyph } from "../../../../../packages/ui/src/glyph";
import { asksForVideo, courseVideosFor, startLabel, type CourseVideo, type CourseVideoResult, type PermittedCourse } from "./course-video";
import "./media.css";

// owner: voice-learning-media lane. Course-posted videos under a learning reply. Opening uses the
// normal default browser; Magic stays on the same reply so the student can come back to the task.

export interface CourseVideosProps {
  result: CourseVideoResult;
  /** Show the honest empty state only when the student asked for a video; otherwise stay silent. */
  showEmpty: boolean;
  /** The bridge's default-browser open (openLink, else openExternal). */
  open(url: string): Promise<void>;
}

export function CourseVideos({ result, showEmpty, open }: CourseVideosProps) {
  if (result.status !== "found") return showEmpty ? <p className="magic-media-empty">{result.reason}</p> : null;
  return <section className="magic-media" aria-label="Videos from your course">
    <p className="magic-media-label">From your course</p>
    <ul className="magic-media-list">{result.videos.map((video) => <VideoRow key={video.key} video={video} open={open} />)}</ul>
  </section>;
}

/** Chat adapter: the anchors are the resources the reply was actually generated from or cited. */
export function ReplyVideos({ anchorIds, prompt, resources, sources, courses, bridge }: {
  anchorIds: readonly string[];
  prompt: string;
  resources: readonly Resource[];
  sources: readonly Pick<SourceHealth, "id" | "accountScope">[];
  /** Included courses, read on every render so an exclusion hides its videos at once. */
  courses: readonly PermittedCourse[];
  bridge: Pick<AppBridge, "openExternal"> & Partial<Pick<AppBridge, "openLink">>;
}) {
  const key = anchorIds.join("\u0000");
  const result = useMemo(() => courseVideosFor(anchorIds, resources, sources, courses), [key, resources, sources, courses]);
  return <CourseVideos result={result} showEmpty={asksForVideo(prompt)} open={(url) => (bridge.openLink ?? bridge.openExternal)(url)} />;
}

function why(video: CourseVideo): string {
  const r = video.relation;
  if (r.kind === "cited") return "Cited in this answer";
  if (r.kind === "linked") return `Linked in ${r.title}`;
  return `Same module as ${r.title}`;
}

function VideoRow({ video, open }: { video: CourseVideo; open(url: string): Promise<void> }) {
  const [state, setState] = useState<"idle" | "opening" | "opened" | "failed">("idle");
  const meta = [video.host, video.course.label, why(video)];
  if (video.startSeconds) meta.push(`starts at ${startLabel(video.startSeconds)}`);
  return <li className="magic-media-row">
    <div className="magic-media-text">
      <p className="magic-media-title">{video.title}</p>
      <p className="magic-media-meta">{meta.join(" · ")}</p>
      {video.needsUwSignIn ? <p className="magic-media-meta">Your browser may ask you to sign in to UW.</p> : null}
      {state === "opened" ? <p className="magic-media-meta" role="status">Opened in your browser. This answer stays here.</p> : null}
      {state === "failed" ? <p className="magic-media-error" role="alert">The video couldn't be opened. The course link is unchanged; try again.</p> : null}
    </div>
    <Action tone="quiet" pending={state === "opening"} aria-label={`Watch ${video.title} in your browser`} onClick={async () => {
      setState("opening");
      try { await open(video.url); setState("opened"); } catch { setState("failed"); }
    }}>Watch<MagicGlyph className="magic-media-glyph" name="external" size={16} /></Action>
  </li>;
}

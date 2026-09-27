// Rendered markup for course videos and launcher voice controls. Static render only: no microphone,
// browser or Electron; effects (announcements, error alert after a session) are covered by pure tests.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CourseVideo } from "../apps/desktop/src/renderer/media/course-video";

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });
const { CourseVideos } = await import("../apps/desktop/src/renderer/media/CourseVideos");
const { ConversationLauncher } = await import("../apps/desktop/src/renderer/conversation-launcher/ConversationLauncher");

const video = (over: Partial<CourseVideo>): CourseVideo => ({
  key: "youtube:abc", url: "https://www.youtube.com/watch?v=abc&t=90", title: "Hash tables walkthrough", host: "YouTube", hostVerified: false,
  needsUwSignIn: false, startSeconds: 90, course: { accountScope: "uw", courseId: "c220", label: "CS 220" },
  relation: { kind: "linked", resourceId: "r1", title: "Week 3 reading", linkText: null }, observedAt: "2026-09-26T12:00:00Z", ...over,
});
const open = async () => {};

test("found videos name the host, course, evidence and start time with a browser action", () => {
  const html = renderToStaticMarkup(createElement(CourseVideos, { result: { status: "found", videos: [video({}), video({ key: "k2", host: "Kaltura MediaSpace", needsUwSignIn: true, startSeconds: null, relation: { kind: "same-module", resourceId: "r1", title: "Week 3 reading" } })] }, showEmpty: false, open }));
  assert.match(html, /aria-label="Videos from your course"/);
  assert.match(html, /YouTube · CS 220 · Linked in Week 3 reading · starts at 1:30/);
  assert.match(html, /Kaltura MediaSpace · CS 220 · Same module as Week 3 reading/);
  assert.match(html, /Your browser may ask you to sign in to UW/);
  assert.match(html, /aria-label="Watch Hash tables walkthrough in your browser"/);
  assert.doesNotMatch(html, /<iframe|autoplay/i, "no embed or autoplay");
});

test("the empty state shows only when the student asked for a video", () => {
  const none = { status: "none" as const, reason: "Your course hasn't linked a video to these sources. Magic doesn't search YouTube for you." };
  assert.equal(renderToStaticMarkup(createElement(CourseVideos, { result: none, showEmpty: false, open })), "");
  assert.match(renderToStaticMarkup(createElement(CourseVideos, { result: none, showEmpty: true, open })), /doesn&#x27;t search YouTube/);
});

test("launcher mic: error state stays pressable, unavailable explanation stays actionable, live region present", () => {
  const props = { here: { key: "home", label: "Home" }, captureOrigin: () => ({ label: "Home" }), onSubmit: () => ({ accepted: true }) };
  const error = renderToStaticMarkup(createElement(ConversationLauncher, { ...props, voice: { state: "error", reason: "Microphone access is off." } }));
  assert.match(error, /aria-label="Start voice"/);
  assert.doesNotMatch(error, /cl-mic"[^>]*aria-disabled/);
  assert.match(error, /class="cl-voice-live" role="status" aria-live="polite"/);
  const unavailable = renderToStaticMarkup(createElement(ConversationLauncher, props));
  assert.match(unavailable, /aria-label="Voice unavailable"/);
  assert.doesNotMatch(unavailable, /cl-mic"[^>]*aria-disabled/);
});

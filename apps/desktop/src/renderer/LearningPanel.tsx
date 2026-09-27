import { useEffect, useId, useRef, useState } from "react";
import type { LearningRequest, ResourceView, StudySessionView } from "@magic/contracts";
import {
  activeRequest,
  findCourseAnchor,
  readAssignmentAnalytics,
  readGuide,
  readPath,
  readResults,
  readSessions,
  runPack,
  sessionRequest,
  type ActiveStudy,
} from "./study/api";
import {
  focusTopics,
  guideForAccount,
  guideScopeLabel,
  guideStatusText,
  packNotice,
  plural,
  resultsSummary,
  resultTopicLine,
  studyActions,
  topicReason,
  when,
  type Notice,
  type StudyAction,
} from "./study/model";
import type {
  AssignmentAnalyticsData,
  Capability,
  GuideDocumentView,
  GuideQueryResult,
  PracticePathData,
  PracticeResults,
} from "./study/types";
import { SessionPractice } from "./study/SessionPractice";
import { FlashcardReview } from "./study/FlashcardReview";
import { GuideReader } from "./study/GuideReader";
import "./study/study.css";

type Activity =
  | { kind: "active"; study: ActiveStudy; label: string; course: boolean; launcher: string }
  | { kind: "guide"; launcher: string }
  | { kind: "results"; results: PracticeResults; label: string; launcher: string };

function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
const readyGuide = (
  guide: Capability<GuideQueryResult> | null,
): (GuideQueryResult & { guide: { view: GuideDocumentView } }) | null =>
  guide?.state === "ok" && (guide.data.status === "ready" || guide.data.status === "stale") && guide.data.guide?.view
    ? (guide.data as GuideQueryResult & { guide: { view: GuideDocumentView } })
    : null;

/**
 * Study for one saved course item: evidence-backed practice, flashcards, a checked study guide and
 * topic state, all through the canonical learning router, `pack` command and guide query.
 */
export function LearningPanel({ resource, accountScope }: { resource: ResourceView; accountScope?: string }) {
  const headingId = useId();
  const [path, setPath] = useState<Capability<PracticePathData> | null>(null);
  // The assignment that anchors course-wide practice: this item when it is an assignment, else one
  // confirmed saved assignment of the same course and account, else null (no practice read at all).
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sessions, setSessions] = useState<StudySessionView[]>([]);
  const [guide, setGuide] = useState<Capability<GuideQueryResult> | null>(null);
  const [assignment, setAssignment] = useState<Capability<AssignmentAnalyticsData> | null>(null);
  const [otherAccount, setOtherAccount] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState("");
  // Scope guard: `epoch` changes when this item/account unmounts or changes, and `loads` orders
  // refreshes, so an older answer can never overwrite a newer one or land on another item.
  const epoch = useRef(0);
  const loads = useRef(0);
  const live = () => {
    const at = epoch.current;
    return () => at === epoch.current;
  };
  const activityHeading = useRef<HTMLHeadingElement>(null);
  const launchers = useRef(new Map<string, HTMLElement>());
  const returnTo = useRef<string | null>(null);

  const courseId = resource.courseId;
  const courseLabel = resource.courseName;
  // Guides are read and made for the whole course. Canvas items carry `moduleItem.moduleId`, while
  // the guide selector's module filter matches `resource.module` (module header rows only), so a
  // module scope would silently cover almost nothing.
  const scopeLabel = guideScopeLabel(undefined, courseLabel);
  const restricted = resource.policy.mode === "restricted";
  const isAssignment = resource.kind === "assignment";
  const inScope = (s: { accountScope: string }) => !accountScope || s.accountScope === accountScope;

  async function refresh() {
    const at = epoch.current;
    const load = ++loads.current;
    // Per-item sessions and assignment topics resolve context from the item itself, which only an
    // assignment supports; a material page reads course practice through the confirmed anchor.
    const anchored = isAssignment ? Promise.resolve(resource.id) : findCourseAnchor(courseId, accountScope).catch(() => null);
    const [n, p, s, g, a] = await Promise.allSettled([
      anchored,
      anchored.then((id) => (id ? readPath(courseId, id) : null)),
      isAssignment ? readSessions(resource.id) : Promise.resolve([]),
      readGuide({ courseId }),
      isAssignment ? readAssignmentAnalytics(courseId, resource.id, resource.id) : Promise.resolve(null),
    ]);
    if (at !== epoch.current || load !== loads.current) return;
    setAnchor(n.status === "fulfilled" ? n.value : null);
    setPath(p.status === "fulfilled" ? p.value : { state: "failed", message: message(p.reason, "Course practice could not be read.") });
    if (s.status === "fulfilled") {
      setSessions(s.value.filter(inScope));
      setError("");
    } else setError(message(s.reason, "Saved study could not be loaded."));
    if (g.status === "fulfilled") {
      const scoped = guideForAccount(g.value, accountScope, courseId);
      setOtherAccount(scoped !== g.value);
      setGuide(scoped);
    } else {
      setOtherAccount(false);
      setGuide({ state: "failed", message: message(g.reason, "The study guide could not be read.") });
    }
    setAssignment(a.status === "fulfilled" ? a.value : { state: "failed", message: message(a.reason, "Assignment topics could not be read.") });
  }
  useEffect(() => {
    const current = live();
    setLoading(true);
    void refresh().finally(() => current() && setLoading(false));
    return () => {
      epoch.current += 1;
    };
  }, [resource.id, accountScope]);

  // Opening an activity moves focus to its heading; leaving returns focus to what opened it.
  useEffect(() => {
    if (activity) activityHeading.current?.focus();
    else if (returnTo.current) {
      const target = launchers.current.get(returnTo.current);
      returnTo.current = null;
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    }
  }, [activity?.kind, activity && "launcher" in activity ? activity.launcher : null]);

  function open(next: Activity) {
    setNotice(null);
    setError("");
    setActivity(next);
  }
  function close() {
    returnTo.current = activity?.launcher ?? null;
    setActivity(null);
    void refresh();
  }
  async function perform(key: string, work: (current: () => boolean) => Promise<void>) {
    if (pending) return;
    const current = live();
    setPending(key);
    setError("");
    setNotice(null);
    try {
      await work(current);
    } catch (cause) {
      if (current()) setError(message(cause, "Study could not continue. Your saved coursework is still available."));
    } finally {
      if (current()) setPending(null);
    }
  }
  const openSource = (url: string) =>
    void window.magic.openExternal(url).catch((cause: unknown) => setError(message(cause, "Could not open the source.")));
  const openResource = (id: string) =>
    void perform("source", async () => {
      const found = await window.magic.query?.({ view: "resource", id });
      if (!found || found.view !== "resource") throw new Error("That source is not in your saved coursework.");
      openSource(found.resource.url);
    });

  const materialSession = (session: StudySessionView, launcher: string) =>
    open({ kind: "active", study: { kind: "session", session }, label: `Practice · ${courseLabel}`, course: false, launcher });

  function startPractice(launcher: string) {
    void perform(launcher, async (current) => {
      const session = await sessionRequest({
        op: "study.plan",
        courseId,
        resourceId: resource.id,
        inputHash: resource.contentHash,
        operationId: crypto.randomUUID(),
        minutes: 15,
        difficulty: "normal",
      });
      if (current()) materialSession(session, launcher);
    });
  }
  function startTarget(launcher: string, request: Omit<Extract<LearningRequest, { op: "practice.target" }>, "op" | "courseId" | "anchorIds" | "operationId">, label: string) {
    if (!anchor) return;
    void perform(launcher, async (current) => {
      const study = await activeRequest({
        op: "practice.target",
        courseId,
        anchorIds: [anchor],
        operationId: crypto.randomUUID(),
        ...request,
      });
      if (current()) open({ kind: "active", study, label, course: true, launcher });
    });
  }
  function resume(sessionId: string, launcher: string, label: string, course: boolean) {
    void perform(launcher, async (current) => {
      const study = await activeRequest({ op: "study.resume", sessionId });
      if (current()) open({ kind: "active", study, label, course, launcher });
    });
  }
  function make(pack: "quiz" | "guide", launcher: string) {
    void perform(launcher, async (current) => {
      const outcome = await runPack(
        pack,
        pack === "quiz" ? { courseId, resourceIds: [resource.id] } : { courseId },
      );
      const next = packNotice(outcome);
      if (next.refresh) await refresh();
      if (!current()) return;
      setNotice(next);
    });
  }
  function runAction(action: StudyAction) {
    const launcher = `action:${action.id}`;
    if (action.id === "practice") {
      // An assignment gets its own saved session; a material page practices the course pool.
      if (isAssignment) startPractice(launcher);
      else
        startTarget(launcher, { mode: "learn", count: Math.min(10, pathData?.questions ?? 10) }, `Practice · ${courseLabel}`);
    }
    else if (action.id === "cards") startTarget(launcher, { mode: "flashcards", count: 20 }, `Flashcards · ${courseLabel}`);
    else if (action.id === "guide") open({ kind: "guide", launcher });
    else if (action.id === "make-practice") make("quiz", launcher);
    else make("guide", launcher);
  }

  const launcherRef = (key: string) => (element: HTMLElement | null) => {
    if (element) launchers.current.set(key, element);
    else launchers.current.delete(key);
  };

  const pathData = path && (path.state === "ok" || path.state === "unavailable") ? path.data : undefined;
  const actions = studyActions({
    path,
    guide,
    courseLabel,
    restricted,
    otherAccount,
    guideScopeLabel: scopeLabel,
    anchored: anchor !== null,
  });
  const openMaterial = sessions.filter((s) => s.status === "active" && s.currentItem);
  const knownIds = new Set(sessions.map((s) => s.id));
  const openCourse = (pathData?.openSessions ?? []).filter((s) => !knownIds.has(s.sessionId)).slice(0, 2);
  const linked = assignment?.state === "ok" && assignment.data.linkage === "linked" ? assignment.data : null;
  const topics = linked ? linked.topics.slice(0, 5) : focusTopics(pathData?.topics ?? []);
  const canPracticeTopics = pathData?.availability === "current" && !restricted;
  const guideText = guideStatusText(guide);
  const ready = readyGuide(guide);

  return (
    <section className="detail-section learning-panel study-panel" aria-labelledby={headingId}>
      <h3 id={headingId}>Study this material</h3>
      <p className="study-meta">
        {courseLabel} · saved {when(resource.observedAt)} · Practice feedback is for studying, not a grade.
      </p>
      {restricted ? (
        <p className="study-note">
          This course restricts AI help on this work, so Magic will not make new practice or guides from it. Saved
          practice stays readable.
        </p>
      ) : null}

      {activity?.kind === "active" && activity.study.kind === "session" ? (
        <SessionPractice
          ref={activityHeading}
          session={activity.study.session}
          label={activity.label}
          pausedReason={
            restricted
              ? "This course restricts AI help on this work."
              : !activity.course && activity.study.session.resourceId === resource.id && activity.study.session.inputHash !== resource.contentHash
                ? "This material changed since the session began."
                : null
          }
          onSession={(session) =>
            setActivity((a) => (a?.kind === "active" ? { ...a, study: { kind: "session", session } } : a))
          }
          onOpenSource={openSource}
          onResults={
            activity.course
              ? () =>
                  void perform("results", async (current) => {
                    const results = await readResults(activity.study.kind === "session" ? activity.study.session.id : "");
                    if (current()) open({ kind: "results", results, label: activity.label, launcher: activity.launcher });
                  })
              : undefined
          }
          onClose={close}
        />
      ) : activity?.kind === "active" && activity.study.kind === "flashcards" ? (
        <FlashcardReview
          ref={activityHeading}
          session={activity.study.flashcards}
          label={activity.label}
          onSession={(flashcards) =>
            setActivity((a) => (a?.kind === "active" ? { ...a, study: { kind: "flashcards", flashcards } } : a))
          }
          onClose={close}
        />
      ) : activity?.kind === "guide" && ready ? (
        <GuideReader
          ref={activityHeading}
          guide={ready}
          scopeLabel={scopeLabel}
          onSource={openResource}
          onRegenerate={restricted ? null : () => make("guide", activity.launcher)}
          pending={Boolean(pending)}
          onClose={close}
        />
      ) : activity?.kind === "results" ? (
        <div className="study-activity">
          <div className="study-activity-head">
            <button className="study-back" type="button" onClick={close}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
              Study overview
            </button>
            <p className="study-meta">{activity.label}</p>
          </div>
          <h4 className="study-question" tabIndex={-1} ref={activityHeading}>How your topics moved</h4>
          <p className="study-prose">{resultsSummary(activity.results)}</p>
          <p className="study-meta">Study feedback from checked items, not a course grade.</p>
          <ul className="study-topics">
            {activity.results.topics.map((t) => (
              <li key={t.conceptId}>
                <span className="study-topic-name">{t.label}</span>
                <span className={`study-state ${t.after}`}>{resultTopicLine(t)}</span>
              </li>
            ))}
          </ul>
          {activity.results.studyNext.length ? (
            <>
              <p className="study-label">Study next</p>
              <ul className="study-topics">
                {activity.results.studyNext.map((t) => (
                  <li key={t.conceptId}>
                    <span className="study-topic-name">{t.label}</span>
                    <span className="study-meta">{t.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : (
        <>
          {loading ? (
            <p className="study-meta" role="status">Loading saved study…</p>
          ) : (
            <>
              {openMaterial.length || openCourse.length ? (
                <div className="study-resume">
                  <p className="study-label">Continue where you left off</p>
                  {openMaterial.slice(0, 2).map((s) => (
                    <button
                      key={s.id}
                      ref={launcherRef(`resume:${s.id}`)}
                      type="button"
                      className="study-resume-row"
                      disabled={Boolean(pending)}
                      onClick={() => materialSession(s, `resume:${s.id}`)}
                    >
                      <span>{s.currentItem?.stem ?? "Saved practice"}</span>
                      <span className="study-meta">
                        {s.draft ? "Draft response saved · " : ""}updated {when(s.updatedAt)}
                      </span>
                    </button>
                  ))}
                  {openCourse.map((s) => (
                    <button
                      key={s.sessionId}
                      ref={launcherRef(`resume:${s.sessionId}`)}
                      type="button"
                      className="study-resume-row"
                      disabled={Boolean(pending)}
                      onClick={() =>
                        resume(
                          s.sessionId,
                          `resume:${s.sessionId}`,
                          `${s.mode === "flashcards" ? "Flashcards" : "Practice"} · ${courseLabel}`,
                          true,
                        )
                      }
                    >
                      <span>{s.mode === "flashcards" ? "Flashcard review" : s.goal || "Course practice"}</span>
                      <span className="study-meta">updated {when(s.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {actions.length ? (
                <div className="study-actions">
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      ref={launcherRef(`action:${action.id}`)}
                      type="button"
                      className={`study-action ${action.tone}`}
                      disabled={Boolean(pending) || Boolean(action.disabled)}
                      aria-describedby={`${headingId}-${action.id}`}
                      onClick={() => runAction(action)}
                    >
                      <span className="study-action-title">{action.title}</span>
                      <span className="study-action-detail" id={`${headingId}-${action.id}`}>
                        {pending === `action:${action.id}`
                          ? action.id.startsWith("make")
                            ? "Working… this can take a minute. You can keep reading."
                            : "Opening…"
                          : action.disabled ?? action.detail}
                      </span>
                      <svg className="study-action-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    </button>
                  ))}
                </div>
              ) : null}

              {!anchor ? (
                <div className="study-note">
                  <p>
                    Course practice for {courseLabel} opens from one of its assignments, and none is saved for this account
                    yet. This material is still readable at its source.
                  </p>
                  {resource.url ? (
                    <button className="study-button quiet" type="button" onClick={() => openSource(resource.url)}>
                      Open this material
                    </button>
                  ) : null}
                </div>
              ) : !isAssignment && pathData ? (
                <p className="study-meta">Practice here covers all of {courseLabel}, not only this material.</p>
              ) : null}
              {path?.state === "failed" ? (
                <p className="study-note">{path.message}</p>
              ) : path?.state === "unavailable" && !pathData ? (
                <p className="study-note">{path.message}</p>
              ) : path?.state === "unconnected" ? (
                <p className="study-note">Course practice is not connected in this build. Saved sessions stay readable.</p>
              ) : pathData && pathData.availability !== "current" ? (
                <p className="study-note">{pathData.reason} New practice waits for current course material.</p>
              ) : null}
              {pathData && !pathData.ready && !restricted ? (
                <p className="study-meta">
                  No checked practice is saved for {courseLabel} yet. Making practice sends this material to your connected
                  AI only after the privacy checks you set; nothing is sent from this page otherwise.
                </p>
              ) : null}
              {guideText ? <p className="study-meta">{guideText}</p> : null}

              {linked ? (
                <div className="study-linked">
                  <p className="study-label">Materials behind this assignment</p>
                  <ul>
                    {linked.materials.slice(0, 4).map((m) => (
                      <li key={m.resourceId}>
                        <button className="study-link" type="button" onClick={() => openResource(m.resourceId)}>
                          {m.title}
                        </button>
                        <span className="study-meta"> · {m.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : assignment?.state === "ok" && assignment.data.linkage !== "linked" ? (
                <p className="study-meta">{assignment.data.reason}</p>
              ) : null}

              {topics.length ? (
                <div className="study-topic-block">
                  <p className="study-label">
                    {linked ? "Topics behind this assignment" : `Topics in ${courseLabel}`}
                    {pathData && !linked ? (
                      <span className="study-meta">
                        {" "}· {pathData.mastered.count} of {plural(pathData.mastered.of, "topic")} solid in your practice
                      </span>
                    ) : null}
                  </p>
                  <ul className="study-topics">
                    {topics.map((topic) => (
                      <li key={topic.conceptId}>
                        <div className="study-topic-text">
                          <span className="study-topic-name">{topic.label}</span>
                          <span className="study-meta">{topicReason(topic)}</span>
                        </div>
                        <span className={`study-state ${topic.state}`}>{topic.stateLabel}</span>
                        {canPracticeTopics && topic.practiceItems > 0 ? (
                          <button
                            ref={launcherRef(`topic:${topic.conceptId}`)}
                            type="button"
                            className="study-button quiet"
                            disabled={Boolean(pending)}
                            onClick={() =>
                              startTarget(
                                `topic:${topic.conceptId}`,
                                { mode: "learn", topicIds: [topic.conceptId], count: Math.min(10, topic.practiceItems) },
                                `Practice · ${topic.label}`,
                              )
                            }
                          >
                            Practice
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : pathData ? (
                <p className="study-meta">No topics are mapped for {courseLabel} yet.</p>
              ) : null}
            </>
          )}
          {notice ? (
            <p className={notice.tone === "attention" ? "study-note" : "study-meta"} role="status">
              {notice.text}
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <div className="study-error" role="alert">
          <p>{error}</p>
          <button
            className="study-button quiet"
            type="button"
            disabled={Boolean(pending)}
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Retry loading saved study
          </button>
        </div>
      ) : null}
    </section>
  );
}

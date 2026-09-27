import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { localContextPayload, type ContextManifest } from "@magic/contracts";
import { Action } from "../../../../../packages/ui/src";
import { deadlineSurface, deadlineEmphasis, type AssignmentTypeHue } from "../../../../../packages/ui/src/deadline-emphasis";
import type { ResourceView } from "@magic/contracts";
import { localTime } from "@magic/domain";
import { answerIsStale, chatItem, coverageBlocker, coverageLine, dueParts, permittedCourses, safeWebLink, scopeCourses, scopeLabel, spanLabel, when, type ChatItem } from "./model";
import {
  answerLocally, choose, chooseCourse, continueChat, currentScope, drive, getChat, goneOrigin, openSource, retry, searchAll, setCourse, setNarrowed, stop, subscribe,
  type Chat, type ChatBridge, type ChatOrigin, type ChatRuntime, type Exchange,
} from "./store";
import { ReplyVideos } from "../media/CourseVideos";
import "./chat.css";

// owner: chat lane. One full-pane chat in the ivory workspace. The shell owns the composer and the
// route; this leaf owns the conversation, its per-exchange stop/retry and source actions.
// Real paths only: saved deadlines (renderer projection), saved-item search (query), local answers
// (localAsk, which re-reads evidence and policy in the worker) and the https source link.

/** Circled-i detail for routine provenance. Pass the shared EvidenceInfo; same props. */
export type ChatInfo = ComponentType<{ label: string; children: ReactNode }>;
export interface ChatPaneProps extends ChatRuntime {
  chatId: string;
  typeHueOf?: (resource: ResourceView) => AssignmentTypeHue | null;
  /** Integrator returns to origin: route, scroll anchor and focus key. Null when the chat and its origin are gone. */
  onBack(origin: ChatOrigin | null): void;
  /** Integrator routes to local-model setup or to Sources. */
  onOpenSetup(target: "local-model" | "sources"): void;
  /** Shared EvidenceInfo. Without it the same detail shows as one quiet line. */
  Info?: ChatInfo;
}

type IconName = "back" | "x" | "external" | "file" | "chevron";
function Icon({ name }: { name: IconName }) {
  return <MagicGlyph className="magic-chat-icon" name={name} />;
}

const itemHref = (id: string) => `#resource/${encodeURIComponent(id)}`;
function isCanvas(url: string) {
  const safe = safeWebLink(url);
  return !!safe && /instructure|canvas/i.test(new URL(safe).hostname);
}

/** Routine provenance behind the shared circled-i; without it, `brief` (or the detail) shows as quiet text. */
function Detail({ Info, label, brief, children }: { Info?: ChatInfo; label: string; brief?: ReactNode; children: ReactNode }) {
  if (Info) return <Info label={label}>{children}</Info>;
  const text = brief === undefined ? children : brief;
  return text ? <span className="magic-chat-detail">{text}</span> : null;
}

export function ChatPane(props: ChatPaneProps) {
  const { chatId, bridge, onBack, onOpenSetup, Info } = props;
  const chat = useSyncExternalStore(subscribe, () => getChat(chatId));
  useSyncExternalStore(subscribe, () => chat?.version ?? -1);
  const runtime = useRef(props);
  runtime.current = props;
  const last = useRef<HTMLHeadingElement>(null);
  const count = chat?.exchanges.length ?? 0;

  useEffect(() => { if (chat) drive(chat, runtime.current); });
  // A new exchange moves focus and view to its prompt; the first render lands on the first prompt.
  useLayoutEffect(() => {
    last.current?.focus({ preventScroll: true });
    last.current?.closest("li")?.scrollIntoView({ block: "start" });
  }, [count]);

  if (!chat) {
    const origin = goneOrigin(chatId);
    return <section className="magic-chat" aria-label="Chat">
      <header className="magic-chat-origin">
        <button className="magic-chat-back" data-focus-key="chat-back" aria-label={origin ? `Back to ${origin.label}` : "Back"} onClick={() => onBack(origin)}><Icon name="back" />{origin?.label ?? "Back"}</button>
      </header>
      <p className="magic-chat-prose">This chat is no longer open. Chats are kept only while the app is running.</p>
    </section>;
  }

  const scope = currentScope(chat);
  const courses = scopeCourses(scope);
  const originLabel = scopeLabel(chat.origin.scope);
  const blocker = coverageBlocker(courses);
  const current = chat.narrowed ? props.resources.find((r) => r.id === chat.narrowed!.id && !r.deleted) : undefined;
  const lost = chat.narrowed && props.resources.length && !current;
  const routine = [
    courses.length ? coverageLine(courses) : scope.kind === "item" ? `Saved ${when(scope.item.observedAt, true)}` : "No included courses",
    ...courses.map((c) => `${c.rawName} (${c.accountScope})`),
    bridge.localAsk ? "Answers run on this device." : "",
  ].filter(Boolean);

  return <section className="magic-chat" aria-label="Chat">
    <header className="magic-chat-origin">
      <button className="magic-chat-back" data-focus-key="chat-back" aria-label={`Back to ${chat.origin.label}`} onClick={() => onBack(chat.origin)}><Icon name="back" />{chat.origin.label}</button>
      <p className="magic-chat-meta">
        {chat.origin.scope.kind === "workspace" && !chat.course && !chat.narrowed ? <span>{originLabel}</span> : null}
        {blocker ? <span className="magic-chat-warning">{blocker}</span> : null}
        <Detail Info={Info} label="About this chat's sources" brief={blocker ? "" : routine[0]}>{routine.map((line, i) => <span key={i}>{i ? <br /> : null}{line}</span>)}</Detail>
      </p>
      {chat.course && !chat.narrowed ? <p className="magic-chat-using">
        About {chat.course.label}
        <button aria-label={`Stop using ${chat.course.label}; answer from ${originLabel} again`} onClick={() => setCourse(chat, null)}><Icon name="x" /></button>
      </p> : null}
      {chat.narrowed ? <p className="magic-chat-using">
        Using <a href={itemHref(chat.narrowed.id)}>{chat.narrowed.title}</a>
        <button aria-label={`Stop using ${chat.narrowed.title}`} onClick={() => setNarrowed(chat, null)}><Icon name="x" /></button>
        {lost ? <span className="magic-chat-warning"> No longer in your saved workspace.</span> : null}
      </p> : null}
    </header>

    <ol className="magic-chat-thread" aria-live="polite">
      {chat.exchanges.map((x, i) => <li key={x.id} className="magic-chat-exchange" data-place-anchor={`chat-${x.id}`}>
        <h2 className={`magic-chat-prompt ${x.prompt.length > 140 ? "is-long" : ""}`} tabIndex={-1} ref={i === count - 1 ? last : undefined}>{x.prompt}</h2>
        <ExchangeView chat={chat} x={x} runtime={props} onOpenSetup={onOpenSetup} Info={Info} />
      </li>)}
    </ol>
  </section>;
}

interface ViewProps { chat: Chat; x: Exchange; runtime: ChatRuntime; onOpenSetup: ChatPaneProps["onOpenSetup"]; Info?: ChatInfo }
function ExchangeView({ chat, x, runtime, onOpenSetup, Info }: ViewProps) {
  const busy = chat.exchanges.some((e) => e.state === "running");
  if (x.state === "queued" || x.state === "running") {
    const text = x.step === "ask" && x.target ? `Answering from ${x.target.title} on this device`
      : x.step === "answer" ? "Answering from your saved course materials"
      : x.step === "search" ? `Searching saved items in ${x.wide ? "all included courses" : scopeLabel(currentScope(chat))}`
      : x.step === "open" ? "Opening the source" : "Starting";
    return <p className="magic-chat-pending" role="status"><span className="magic-chat-dot" aria-hidden="true" />{text}
      <button className="magic-chat-text" onClick={() => stop(chat, x, runtime.bridge)}>Stop</button></p>;
  }
  if (x.state === "stopped") return <p className="magic-chat-meta">Stopped. Nothing from this run is shown. <button className="magic-chat-text" disabled={busy} onClick={() => retry(chat, x)}>Try again</button></p>;
  if (x.state === "failed" && x.error) return <div className="magic-chat-error" role="alert">
    <p>{x.error.text}</p>
    <div className="magic-chat-row">
      <button className="magic-chat-text" disabled={busy} onClick={() => retry(chat, x)}>Try again</button>
      {x.error.setup === "local-model" ? <button className="magic-chat-text" onClick={() => onOpenSetup("local-model")}>Set up local model</button> : null}
      {x.error.setup === "sources" ? <button className="magic-chat-text" onClick={() => onOpenSetup("sources")}>Choose courses</button> : null}
    </div>
    {x.error.detail ? <details className="magic-chat-tech"><summary>Technical details</summary><pre>{x.error.detail}</pre></details> : null}
  </div>;
  const r = x.result;
  if (!r) return null;
  if (r.kind === "note") return <p className="magic-chat-prose">{r.text}</p>;
  if (r.kind === "opened") return <p className="magic-chat-prose">Opened {r.item.title} in your browser. Opening it does not mark anything done.</p>;
  if (r.kind === "due") return <Due r={r} now={runtime.now} Info={Info} resources={runtime.resources} typeHueOf={(runtime as ChatPaneProps).typeHueOf} />;
  // Course-posted videos tied to the cited sources only; see media/course-video.ts.
  if (r.kind === "grounded") return <><Grounded chat={chat} x={x} r={r} busy={busy} Info={Info} />{r.notFound ? null : <ReplyVideos anchorIds={r.citations.map((c) => c.resourceId)} prompt={x.prompt} resources={runtime.resources} sources={runtime.sources} courses={runtime.courses} bridge={runtime.bridge} />}</>;
  if (r.kind === "unavailable") return <div className="magic-chat-body">
    <p className="magic-chat-prose">{r.reason}</p>
    <div className="magic-chat-row">
      <button className="magic-chat-text" disabled={busy} onClick={() => retry(chat, x)}>Try again</button>
      <button className="magic-chat-text" disabled={busy} onClick={() => answerLocally(chat, x)}>Answer from one saved item on this device</button>
    </div>
  </div>;
  if (r.kind === "action") return <p className="magic-chat-prose">{r.hint ? `This reads as a command: ${r.hint}.` : "This reads as a command."} Chat only reads your saved coursework, so it did not run it.</p>;
  if (r.kind === "clarify") return <div className="magic-chat-body">
    <p className="magic-chat-prose">{r.question}</p>
    {r.options.length ? <ul className="magic-chat-choices">{r.options.map(({ label, course }) => <li key={course.key}>
      <button disabled={busy} onClick={() => chooseCourse(chat, x, course)} data-focus-key={`chat-course-${course.key}`}>
        <span><span className="magic-chat-choice-title">{label}</span></span><Icon name="chevron" />
      </button></li>)}</ul> : <p className="magic-chat-meta">Ask again with the detail it needs.</p>}
  </div>;
  if (r.kind === "course") return <CourseChoice chat={chat} x={x} r={r} busy={busy} onOpenSetup={onOpenSetup} />;
  if (r.kind === "choose") return <Choices chat={chat} x={x} r={r} busy={busy} runtime={runtime} Info={Info} />;
  return <><Answer x={x} r={r} runtime={runtime} Info={Info} /><ReplyVideos anchorIds={[r.answer.resourceId]} prompt={x.prompt} resources={runtime.resources} sources={runtime.sources} courses={runtime.courses} bridge={runtime.bridge} /></>;
}

type ResultOf<K extends NonNullable<Exchange["result"]>["kind"]> = Extract<NonNullable<Exchange["result"]>, { kind: K }>;

function Due({ r, now, Info, resources, typeHueOf }: { r: ResultOf<"due">; now: string; Info?: ChatInfo; resources: ResourceView[]; typeHueOf?: ChatPaneProps["typeHueOf"] }) {
  const span = spanLabel(r.span);
  const past = r.rows.filter((row) => row.pastDue).length;
  return <div className="magic-chat-body">
    <p className="magic-chat-prose">{r.rows.length
      ? `${r.rows.length} saved due date${r.rows.length === 1 ? "" : "s"} in ${r.scopeLabel} for ${span}${past ? `, ${past} past due` : ""}.`
      : `No saved due dates in ${r.scopeLabel} for ${span}.`}{" "}
      <Detail Info={Info} label="About these due dates">From saved course dates, not a live check.{coverageBlocker(r.courses) ? "" : ` ${coverageLine(r.courses)}.`}</Detail></p>
    {r.caveat ? <p className="magic-chat-warning">{r.caveat}</p> : null}
    {r.rows.length ? <ul className="magic-chat-due">{r.rows.map((row) => {
      const when = dueParts(row.dueAt, now);
      const resource = resources.find(item => item.id === row.id);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const surface = deadlineSurface(deadlineEmphasis({today:localTime(now,zone).date,due:resource?.deadline.conflict ? null : localTime(row.dueAt,zone).date,completed:row.submitted}).bin, resource ? typeHueOf?.(resource)?.hue ?? null : null);
      return <li key={row.id}><a {...surface} className="magic-chat-due-row" href={itemHref(row.id)} data-focus-key={`chat-due-${row.id}`}>
        <span className="magic-chat-due-main">
          <span className="magic-chat-due-course">{row.courseCode ?? row.courseLabel}{row.kindLabel ? <span>{row.kindLabel}</span> : null}{row.submitted ? <span>Submitted in Canvas</span> : null}</span>
          <span className="magic-chat-due-title">{row.title}</span>
        </span>
        <span className="magic-chat-due-when"><strong>{resource?.deadline.conflict ? "Dates disagree" : row.pastDue ? `Past due · ${when.day}` : when.day}</strong>{resource?.deadline.conflict ? "Review dates" : when.time}</span>
        <Icon name="chevron" />
      </a></li>;
    })}</ul> : null}
  </div>;
}

function CourseChoice({ chat, x, r, busy, onOpenSetup }: { chat: Chat; x: Exchange; r: ResultOf<"course">; busy: boolean; onOpenSetup: ChatPaneProps["onOpenSetup"] }) {
  const codes = new Map<string, number>();
  for (const c of r.courses) codes.set(c.label, (codes.get(c.label) ?? 0) + 1);
  return <div className="magic-chat-body">
    <p className="magic-chat-prose">{r.reason === "ambiguous"
      ? `“${r.text}” fits more than one included course. Which one is this about?`
      : `${r.text} is not one of your included courses. Which course is this about?`}</p>
    <ul className="magic-chat-choices">{r.courses.map((course) => <li key={course.key}>
      <button disabled={busy} onClick={() => chooseCourse(chat, x, course)} data-focus-key={`chat-course-${course.key}`}>
        <span><span className="magic-chat-choice-title">{course.label}</span>
          {(codes.get(course.label) ?? 0) > 1 ? <span className="magic-chat-meta">{course.accountScope}</span> : null}</span>
        <Icon name="chevron" />
      </button></li>)}</ul>
    {r.reason === "unknown" ? <div className="magic-chat-row"><button className="magic-chat-text" onClick={() => onOpenSetup("sources")}>Choose courses</button></div> : null}
  </div>;
}

function Choices({ chat, x, r, busy, runtime, Info }: { chat: Chat; x: Exchange; r: ResultOf<"choose">; busy: boolean; runtime: ChatRuntime; Info?: ChatInfo }) {
  const wider = r.wider ? <button className="magic-chat-text" disabled={busy} onClick={() => searchAll(chat, x)}>Search all included courses</button> : null;
  if (!r.items.length) return <div className="magic-chat-body">
    <p className="magic-chat-prose">No saved item in {r.scopeLabel} matches this. Course-wide answers are not built yet, so name the assignment or reading, or check what is due.</p>
    <div className="magic-chat-row">
      <button className="magic-chat-text" disabled={busy} onClick={() => continueChat(chat.id, "What's due this week?", `${x.id}:due`)}>What's due this week</button>
      {wider}
    </div>
  </div>;
  const courses = new Map(permittedCourses(chat.origin.scope, runtime.courses).map((c) => [c.key, c]));
  const home = chat.course?.key ?? (chat.origin.scope.kind === "workspace" ? null : scopeCourses(chat.origin.scope)[0]?.key);
  return <div className="magic-chat-body">
    <p className="magic-chat-prose">Which saved item is this about?{" "}
      <Detail Info={Info} label="About these matches">{r.searched ? "Best matches from saved text" : "Title matches"} in {r.scopeLabel}. Magic answers from one saved item at a time.</Detail></p>
    <ul className="magic-chat-choices">{r.items.map((item) => {
      const course = item.courseKey ? courses.get(item.courseKey) ?? null : null;
      return <li key={item.id}><button disabled={busy} onClick={() => choose(chat, x, item, course && course.key !== home ? course : null)} data-focus-key={`chat-choice-${item.id}`}>
        <Icon name="file" />
        <span><span className="magic-chat-choice-title">{item.title}</span>
          <span className="magic-chat-meta">{[item.kindLabel ?? "Saved item", course?.code ?? course?.label, `saved ${when(item.observedAt, true)}`].filter(Boolean).join(" · ")}</span></span>
        <Icon name="chevron" />
      </button></li>;
    })}</ul>
    {wider ? <div className="magic-chat-row">{wider}</div> : null}
  </div>;
}

/** A grounded answer: the router kept only sentences whose quotes it found in the saved text. */
function Grounded({ chat, x, r, busy, Info }: { chat: Chat; x: Exchange; r: ResultOf<"grounded">; busy: boolean; Info?: ChatInfo }) {
  if (r.notFound) return <div className="magic-chat-body">
    <p className="magic-chat-prose">Not found in your saved course materials.</p>
    <div className="magic-chat-row">
      <button className="magic-chat-text" disabled={busy} onClick={() => answerLocally(chat, x)}>Pick one saved item to ask</button>
      <button className="magic-chat-text" disabled={busy} onClick={() => continueChat(chat.id, "What's due this week?", `${x.id}:due`)}>What's due this week</button>
    </div>
  </div>;
  const sources = [...new Map(r.citations.map((c) => [c.resourceId, c])).values()];
  return <div className="magic-chat-body">
    <p className="magic-chat-prose is-answer">{r.text}{" "}
      <Detail Info={Info} label="About this answer">{r.path === "cache" ? "A saved earlier answer from your connected AI" : r.path === "ai" ? "Written by your connected AI" : "Found without an AI call"} from your saved course text. Each quote below was found in that text.</Detail></p>
    {r.dropped ? <p className="magic-chat-warning">{r.dropped} sentence{r.dropped === 1 ? " was" : "s were"} removed because {r.dropped === 1 ? "its quote" : "their quotes"} did not match the saved text.</p> : null}
    {sources.length ? <ul className="magic-chat-quotes">{sources.map((source) => <li key={source.resourceId}>
      <p className="magic-chat-evidence"><Icon name="file" /><a href={itemHref(source.resourceId)}>{source.title}</a></p>
      {r.citations.filter((c) => c.resourceId === source.resourceId).slice(0, 3).map((c, i) => <blockquote key={i}>{c.quote}</blockquote>)}
    </li>)}</ul> : null}
  </div>;
}

function Answer({ x, r, runtime, Info }: { x: Exchange; r: ResultOf<"answer">; runtime: ChatRuntime; Info?: ChatInfo }) {
  const [opened, setOpened] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const live = runtime.resources.find((res) => res.id === r.item.id && !res.deleted);
  const stale = answerIsStale(r.answer, live ? chatItem(live, runtime.sources) : null);
  const removed = !live && runtime.resources.length > 0;
  const canvas = isCanvas(r.item.url);
  return <div className="magic-chat-body">
    <div className="magic-chat-answer">
      <div className="magic-chat-answer-text">
        <p className="magic-chat-prose is-answer">{r.answer.text}</p>
        <p className="magic-chat-evidence"><Icon name="file" /><a href={itemHref(r.answer.resourceId)}>{r.answer.sourceTitle || r.item.title}</a>
          <Detail Info={Info} label="About this answer">Saved {when(r.answer.observedAt, true)}. {r.answer.model ?? "Local model"} on this device. Coaching, not an answer key. Longer sources are excerpted, so it has not read the rest.</Detail></p>
        {r.answer.policyLimited ? <p className="magic-chat-warning">Course policy limits AI help here.</p> : null}
        {stale ? <p className="magic-chat-warning">This item has changed since. Ask again for its current text.</p> : null}
        {removed ? <p className="magic-chat-warning">This item is no longer in your saved workspace.</p> : null}
      </div>
      <div className="magic-chat-actions">
        <a className="magic-chat-action" href={itemHref(r.item.id)} data-focus-key={`chat-open-${x.id}`}>Open saved {r.item.kindLabel?.toLowerCase() ?? "item"}<Icon name="chevron" /></a>
        {safeWebLink(r.item.url) ? <Action tone="quiet" pending={opening} onClick={async () => { setOpening(true); setOpened(await openSource(r.item, runtime.bridge) ?? ""); setOpening(false); }}>
          {canvas ? "Open in Canvas" : "Open source"}<Icon name="external" /></Action> : null}
        {opened !== null ? <p className="magic-chat-meta" role="status">{opened || "Opened in your browser. This does not mark anything done."}</p> : null}
      </div>
    </div>
    <Read key={`${r.item.id}:${r.item.contentHash}:${r.item.courseKey}`} item={r.item} bridge={runtime.bridge} />
  </div>;
}

/** The exact local input, fetched only when requested. Closing remains native and reversible.
 * Failed/missing replies can retry; old bridge or unmounted requests cannot restore stale evidence.
 */
function Read({ item, bridge }: { item: ChatItem; bridge: ChatBridge }) {
  const [manifest, setManifest] = useState<ContextManifest | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const loaded = useRef(false), inFlight = useRef(false), generation = useRef(0);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    generation.current++;
    loaded.current = false;
    inFlight.current = false;
    setManifest(null); setError(""); setPending(false);
    if (details.current) details.current.open = false;
    return () => { generation.current++; };
  }, [bridge.execute]);
  async function load() {
    if (loaded.current || inFlight.current || !bridge.execute) return;
    const current = generation.current;
    inFlight.current = true;
    setPending(true); setError("");
    try {
      const result = await bridge.execute({ type: "context", id: item.id, recipient: "local" });
      if (generation.current !== current) return;
      if (!result.manifest) {
        setError("The saved input is unavailable. Try again.");
        return;
      }
      loaded.current = true;
      setManifest(result.manifest);
    } catch {
      if (generation.current === current) setError("Couldn’t load the saved input. Try again.");
    } finally {
      if (generation.current === current) { inFlight.current = false; setPending(false); }
    }
  }
  if (!bridge.execute) return null;
  const payload = manifest ? localContextPayload(manifest.payload) : null;
  return <details ref={details} className="magic-chat-read" onToggle={(e) => { if (e.currentTarget.open) void load(); }}>
    <summary>What Magic read</summary>
    {error ? <div className="magic-chat-row"><p className="magic-chat-warning" role="status">{error}</p><Action tone="quiet" onClick={() => void load()} pending={pending}>Retry</Action></div> : !manifest ? <p className="magic-chat-meta" role="status">Preparing the saved input…</p> : <>
      {!manifest.allowed ? <p className="magic-chat-warning">{manifest.reason}</p> : null}
      {payload ? <pre>{`${payload.course}\n${payload.title}\n\n${payload.text}${payload.policy ? `\n\nPolicy evidence:\n${payload.policy}` : ""}`}</pre> : null}
    </>}
  </details>;
}

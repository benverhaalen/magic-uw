import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { localContextPayload, type ContextManifest } from "@magic/contracts";
import { Action } from "../../../../../packages/ui/src";
import { courseTone } from "../Home";
import { answerIsStale, chatItem, coverageLine, dueParts, safeWebLink, scopeCourses, scopeLabel, when, type ChatItem } from "./model";
import {
  choose, continueChat, currentScope, drive, getChat, openSource, retry, setNarrowed, stop, subscribe,
  type Chat, type ChatBridge, type ChatOrigin, type ChatRuntime, type Exchange,
} from "./store";
import "./chat.css";

// owner: chat lane. One full-pane chat in the ivory workspace. The shell owns the composer and the
// route; this leaf owns the conversation, its per-exchange stop/retry and source actions.
// Real paths only: saved deadlines (renderer projection), saved-item search (query), local answers
// (localAsk, which re-reads evidence and policy in the worker) and the https source link.

export interface ChatPaneProps extends ChatRuntime {
  chatId: string;
  /** Integrator returns to origin: route, scroll anchor and focus key. */
  onBack(origin: ChatOrigin): void;
  /** Integrator routes to local-model setup or to Sources. */
  onOpenSetup(target: "local-model" | "sources"): void;
}

// Lucide v0.468.0 nodes (ISC); attribution: packages/ui/LICENSE.icons.
type IconName = "back" | "x" | "external" | "file" | "chevron";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    back: <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>,
    x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
    external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
    file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
  };
  return <svg className="magic-chat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const itemHref = (id: string) => `#resource/${encodeURIComponent(id)}`;
function isCanvas(url: string) {
  const safe = safeWebLink(url);
  return !!safe && /instructure|canvas/i.test(new URL(safe).hostname);
}

export function ChatPane(props: ChatPaneProps) {
  const { chatId, bridge, onBack, onOpenSetup } = props;
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

  if (!chat) return <section className="magic-chat">
    <p className="magic-chat-prose">This chat is no longer open. Chats are kept only while the app is running.</p>
  </section>;

  const scope = currentScope(chat);
  const courses = scopeCourses(scope);
  const originLabel = scopeLabel(chat.origin.scope);
  const coverage = courses.length ? coverageLine(courses) : scope.kind === "item" ? `Saved ${when(scope.item.observedAt, true)}` : "No included courses";
  const current = chat.narrowed ? props.resources.find((r) => r.id === chat.narrowed!.id && !r.deleted) : undefined;
  const lost = chat.narrowed && props.resources.length && !current;

  return <section className="magic-chat" aria-label="Chat">
    <header className="magic-chat-origin">
      <button className="magic-chat-back" data-focus-key="chat-back" aria-label={`Back to ${chat.origin.label}`} onClick={() => onBack(chat.origin)}><Icon name="back" />{chat.origin.label}</button>
      <p className="magic-chat-meta" title={scopeCourses(chat.origin.scope).map((c) => `${c.rawName} (${c.accountScope})`).join("\n") || undefined}>
        {chat.origin.scope.kind === "workspace" ? `${originLabel} · ` : ""}{coverage}{bridge.localAsk ? " · Answers run on this device" : ""}
      </p>
      {chat.narrowed ? <p className="magic-chat-using">
        Using <a href={itemHref(chat.narrowed.id)}>{chat.narrowed.title}</a>
        <button aria-label={`Ask about all of ${originLabel} instead`} onClick={() => setNarrowed(chat, null)}><Icon name="x" /></button>
        {lost ? <span className="magic-chat-warning"> No longer in your saved workspace.</span> : null}
      </p> : null}
    </header>

    <ol className="magic-chat-thread" aria-live="polite">
      {chat.exchanges.map((x, i) => <li key={x.id} className="magic-chat-exchange" data-place-anchor={`chat-${x.id}`}>
        <h2 className={`magic-chat-prompt ${x.prompt.length > 140 ? "is-long" : ""}`} tabIndex={-1} ref={i === count - 1 ? last : undefined}>{x.prompt}</h2>
        <ExchangeView chat={chat} x={x} runtime={props} onOpenSetup={onOpenSetup} />
      </li>)}
    </ol>
  </section>;
}

function ExchangeView({ chat, x, runtime, onOpenSetup }: { chat: Chat; x: Exchange; runtime: ChatRuntime; onOpenSetup: ChatPaneProps["onOpenSetup"] }) {
  const busy = chat.exchanges.some((e) => e.state === "running");
  if (x.state === "queued" || x.state === "running") {
    const text = x.step === "ask" && x.target ? `Answering from ${x.target.title} on this device` : x.step === "search" ? `Searching saved items in ${scopeLabel(currentScope(chat))}` : x.step === "open" ? "Opening the source" : "Starting";
    return <p className="magic-chat-pending" role="status"><span className="magic-chat-dot" aria-hidden="true" />{text}
      <button className="magic-chat-text" onClick={() => stop(chat, x, runtime.bridge)}>Stop</button></p>;
  }
  if (x.state === "stopped") return <p className="magic-chat-meta">Stopped. Nothing was kept from this run. <button className="magic-chat-text" disabled={busy} onClick={() => retry(chat, x)}>Try again</button></p>;
  if (x.state === "failed" && x.error) return <div className="magic-chat-error" role="alert">
    <p>{x.error.text}</p>
    <div className="magic-chat-row">
      <button className="magic-chat-text" disabled={busy} onClick={() => retry(chat, x)}>Try again</button>
      {x.error.setup === "local-model" ? <button className="magic-chat-text" onClick={() => onOpenSetup("local-model")}>Set up local model</button> : null}
      {x.error.setup === "sources" ? <button className="magic-chat-text" onClick={() => onOpenSetup("sources")}>Choose courses</button> : null}
    </div>
  </div>;
  const r = x.result;
  if (!r) return null;
  if (r.kind === "note") return <p className="magic-chat-prose">{r.text}</p>;
  if (r.kind === "opened") return <p className="magic-chat-prose">Opened {r.item.title} in your browser. Opening it does not mark anything done.</p>;
  if (r.kind === "due") return <Due r={r} now={runtime.now} />;
  if (r.kind === "choose") return <Choices chat={chat} x={x} r={r} busy={busy} />;
  return <Answer x={x} r={r} runtime={runtime} />;
}

function Due({ r, now }: { r: Extract<NonNullable<Exchange["result"]>, { kind: "due" }>; now: string }) {
  const span = r.days === 1 ? "today" : `the next ${r.days} days`;
  return <div className="magic-chat-body">
    <p className="magic-chat-prose">{r.rows.length
      ? `${r.rows.length} saved due date${r.rows.length === 1 ? "" : "s"} in ${r.scopeLabel} for ${span}.`
      : `No saved due dates in ${r.scopeLabel} for ${span}.`}{r.caveat ? ` ${r.caveat}` : ""}</p>
    {r.rows.length ? <ul className="magic-chat-due">{r.rows.map((row) => {
      const when = dueParts(row.dueAt, now);
      return <li key={row.id}><a className={`magic-chat-due-row is-${courseTone(row.toneKey)}`} href={itemHref(row.id)} data-focus-key={`chat-due-${row.id}`}>
        <span className="magic-chat-due-main">
          <span className="magic-chat-due-course">{row.courseCode ?? row.courseLabel}{row.kindLabel ? <span>{row.kindLabel}</span> : null}{row.submitted ? <span>Submitted in Canvas</span> : null}</span>
          <span className="magic-chat-due-title">{row.title}</span>
        </span>
        <span className="magic-chat-due-when"><strong>{when.day}</strong>{when.time}</span>
        <Icon name="chevron" />
      </a></li>;
    })}</ul> : null}
    <p className="magic-chat-meta">From saved course dates, not a live check.</p>
  </div>;
}

function Choices({ chat, x, r, busy }: { chat: Chat; x: Exchange; r: Extract<NonNullable<Exchange["result"]>, { kind: "choose" }>; busy: boolean }) {
  if (!r.items.length) return <div className="magic-chat-body">
    <p className="magic-chat-prose">Course-wide answers are not built yet, and no saved item in {r.scopeLabel} matches this. Name the assignment or reading, or check what is due.</p>
    <div className="magic-chat-row">
      <button className="magic-chat-text" disabled={busy} onClick={() => continueChat(chat.id, "What's due this week?", `${x.id}:due`)}>What's due this week</button>
    </div>
  </div>;
  const courses = new Map(scopeCourses(chat.origin.scope).map((c) => [c.key, c]));
  return <div className="magic-chat-body">
    <p className="magic-chat-prose">Magic answers from one saved item at a time; course-wide answers are not built yet. Which item is this about?</p>
    <ul className="magic-chat-choices">{r.items.map((item) => {
      const course = item.courseKey ? courses.get(item.courseKey) : null;
      return <li key={item.id}><button disabled={busy} onClick={() => choose(chat, x, item)} data-focus-key={`chat-choice-${item.id}`}>
        <Icon name="file" />
        <span><span className="magic-chat-choice-title">{item.title}</span>
          <span className="magic-chat-meta">{[item.kindLabel ?? "Saved item", course?.code ?? course?.label, `saved ${when(item.observedAt, true)}`].filter(Boolean).join(" · ")}</span></span>
        <Icon name="chevron" />
      </button></li>;
    })}</ul>
    <p className="magic-chat-meta">{r.searched ? "Best matches from saved text" : "Title matches"} in {r.scopeLabel}.</p>
  </div>;
}

function Answer({ x, r, runtime }: { x: Exchange; r: Extract<NonNullable<Exchange["result"]>, { kind: "answer" }>; runtime: ChatRuntime }) {
  const [opened, setOpened] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const live = runtime.resources.find((res) => res.id === r.item.id && !res.deleted);
  const stale = answerIsStale(r.answer, live ? chatItem(live, runtime.sources) : null);
  const canvas = isCanvas(r.item.url);
  return <div className="magic-chat-body">
    <div className="magic-chat-answer">
      <div className="magic-chat-answer-text">
        <p className="magic-chat-prose is-answer">{r.answer.text}</p>
        <p className="magic-chat-evidence"><Icon name="file" /><a href={itemHref(r.answer.resourceId)}>{r.answer.sourceTitle || r.item.title}</a>
          <span className="magic-chat-meta">saved {when(r.answer.observedAt, true)} · {r.answer.policyLimited ? "course policy limits AI help here" : `${r.answer.model ?? "local model"} on this device, coaching rather than an answer key`}</span></p>
        {stale ? <p className="magic-chat-warning">This item has changed since. Ask again for its current text.</p> : null}
      </div>
      <div className="magic-chat-actions">
        <a className="magic-chat-action" href={itemHref(r.item.id)} data-focus-key={`chat-open-${x.id}`}>Open {r.item.kindLabel?.toLowerCase() ?? "item"}<Icon name="chevron" /></a>
        {safeWebLink(r.item.url) ? <Action tone="quiet" pending={opening} onClick={async () => { setOpening(true); setOpened(await openSource(r.item, runtime.bridge) ?? ""); setOpening(false); }}>
          {canvas ? "Open in Canvas" : "Open source"}<Icon name="external" /></Action> : null}
        {opened !== null ? <p className="magic-chat-meta" role="status">{opened || "Opened in your browser. This does not mark anything done."}</p> : null}
      </div>
    </div>
    <Read item={r.item} bridge={runtime.bridge} />
  </div>;
}

/** The exact local input, fetched only when the student opens it. Transient, inline. */
function Read({ item, bridge }: { item: ChatItem; bridge: ChatBridge }) {
  const [manifest, setManifest] = useState<ContextManifest | null>(null);
  const [error, setError] = useState("");
  const loaded = useRef(false);
  async function load() {
    if (loaded.current || !bridge.execute) return;
    loaded.current = true;
    try {
      const result = await bridge.execute({ type: "context", id: item.id, recipient: "local" });
      setManifest(result.manifest ?? null);
      if (!result.manifest) setError("The app did not return the input for this item.");
    } catch (cause) {
      loaded.current = false;
      setError(cause instanceof Error && cause.message ? cause.message : "The input could not be prepared.");
    }
  }
  if (!bridge.execute) return null;
  const payload = manifest ? localContextPayload(manifest.payload) : null;
  return <details className="magic-chat-read" onToggle={(e) => { if (e.currentTarget.open) void load(); }}>
    <summary>What Magic read</summary>
    {error ? <p className="magic-chat-warning">{error}</p> : !manifest ? <p className="magic-chat-meta">Preparing the exact local input…</p> : <>
      <p className="magic-chat-meta">{manifest.allowed ? "Allowed by your data settings" : manifest.reason}. Course policy: {manifest.effectivePolicy?.mode ?? "unknown"}. Nothing here left this device.</p>
      {payload ? <pre>{`${payload.course}\n${payload.title}\n\n${payload.text}${payload.policy ? `\n\nPolicy evidence:\n${payload.policy}` : ""}`}</pre> : null}
      <p className="magic-chat-meta">Longer sources are excerpted; the answer cannot claim to have read the rest.</p>
    </>}
  </details>;
}

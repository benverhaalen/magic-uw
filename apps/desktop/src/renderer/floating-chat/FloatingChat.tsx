// owner: floating-chat. The app's mount for <magic-floating-chat>. It hosts the chat lane's ChatPane and
// store unchanged: a message starts or continues a chat with startChat/continueChat, and the store runs
// it through the same intent router path as the command bar (intent.preview, then the `command` run
// and the grounded ask). The composer reuses the conversation launcher's draft model (idempotency keys,
// kept text on failure). The element is portalled to <body> so page entrance transforms never move it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { AppBridge, ResourceView, SourceHealth } from "@magic/contracts";
import type { CourseCard, CoursePage } from "../../../../../packages/domain/src/course-page";
import { EvidenceInfo } from "../../../../../packages/ui/src/evidence-info";
import { ChatPane, chatCourse, chatScopeForPage, scopeLabel, type ChatBridge, type ChatOrigin } from "../chat";
import { continueChat, currentScope, followUpHint, getChat, startChat, subscribe } from "../chat/store";
import { beginSubmit, edit, expand, initialLauncher, isBlank, rebase, settleSubmit, type LauncherState } from "../conversation-launcher/model";
import type { DesktopView } from "../navigation";
import { defineFloatingChat, FLOATING_CHAT_TAG, type FloatingChatEvents, type MagicFloatingChat } from "./element";
import type { ChatWarmPolicy } from "./warm";
import type { WizardState } from "./rig";
import { useFloatingChatEnabled } from "./setting";
import "./floating-chat.css";

defineFloatingChat();

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "magic-floating-chat": React.DetailedHTMLProps<React.HTMLAttributes<MagicFloatingChat>, MagicFloatingChat> & { "scope-label"?: string; avoid?: string };
    }
  }
}

/** Shell regions the launcher and panel keep clear of: the header, the sidebar (a side column), a bottom composer bar. */
export const FLOATING_CHAT_AVOID = ".desktop-chrome, .desktop-sidebar, .conversation-launcher-dock > .conversation-launcher";
/** The shell's chat button asks the mounted panel to open; `detail.result` says what happened. */
const OPEN_EVENT = "magic-floating-chat-open";
export type OpenFloatingChatResult = "opened" | "hidden" | "off";
const DICTATE_EVENT = "magic-floating-chat-dictate";
/** Puts dictated text in the open chat's composer (the student sends it). False when no chat took it. */
export function dictateIntoFloatingChat(text: string): boolean {
  const detail = { text, accepted: false };
  document.dispatchEvent(new CustomEvent(DICTATE_EVENT, { detail }));
  return detail.accepted;
}
/** Opens the floating chat about the current page. "off": the setting unmounted it; "hidden": setup is showing. */
export function openFloatingChat(): OpenFloatingChatResult {
  const detail: { result: OpenFloatingChatResult } = { result: "off" };
  document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
  return detail.result;
}
const PAGE_LABELS: Partial<Record<string, string>> = { today: "Home", courses: "Courses", myuw: "My UW", calendar: "Calendar", sources: "Connected sources", privacy: "Data & AI" };

export interface FloatingChatProps {
  /** Onboarding, agreements and first-run setup: nothing to chat about yet. */
  hidden: boolean;
  /** When the router's AI path may be warmed: `chatWarmPolicy` of the student's settings (warm.ts). */
  warm: ChatWarmPolicy;
  view: DesktopView;
  resource: ResourceView | null;
  course: CoursePage | null;
  courseKey: string | null;
  cards: CourseCard[];
  bridge: ChatBridge & Partial<Pick<AppBridge, "execute">>;
  /** The same filtered resources the pages render from. */
  resources: ResourceView[];
  sources: SourceHealth[];
  now: string;
  onNavigate(view: DesktopView, resourceId: string | null, courseKey: string | null): void;
  onOpenSetup(target: "local-model" | "sources"): void;
}

// Lucide 0.468.0 arrow-up (ISC); attribution: packages/ui/LICENSE.icons.
const Send = () => <svg className="fc-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>;

export function FloatingChat(props: FloatingChatProps) {
  const enabled = useFloatingChatEnabled();
  if (!enabled || typeof document === "undefined") return null;
  return createPortal(<FloatingChatHost {...props}/>, document.body);
}

function FloatingChatHost({ hidden, warm: warmPolicy, view, resource, course, courseKey, cards, bridge, resources, sources, now, onNavigate, onOpenSetup }: FloatingChatProps) {
  const host = useRef<MagicFloatingChat>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const chat = useSyncExternalStore(subscribe, () => getChat(chatId));
  const version = useSyncExternalStore(subscribe, () => chat?.version ?? -1);

  const label = view === "resource" ? resource?.title ?? "Saved item" : view === "courses" && course ? course.code || course.courseName : PAGE_LABELS[view] ?? "Workspace";
  const pageScope = chatScopeForPage({ page: label, resource, course, cards, sources });
  const shownScope = chat ? currentScope(chat) : pageScope;
  const scopeText = scopeLabel(shownScope);
  const pageKey = `${view}|${resource?.id ?? ""}|${courseKey ?? ""}`;

  // The page as it is when a message is sent. A new chat always takes the page shown in the Scope chip.
  const latest = useRef({ view, resource, courseKey, label, pageScope, pageKey });
  latest.current = { view, resource, courseKey, label, pageScope, pageKey };
  const capture = useCallback(() => {
    const page = latest.current;
    const pane = document.querySelector<HTMLElement>(".desktop-workspace");
    const origin: ChatOrigin = { view: page.view, resourceId: page.resource?.id ?? null, courseKey: page.courseKey, label: page.label,
      focusKey: null, anchor: null, offset: 0, scroll: pane?.scrollTop ?? 0, scope: page.pageScope };
    return { origin, originKey: page.pageKey };
  }, []);

  // Composer state: the conversation launcher's pure draft model, always open here.
  const [draft, setDraft] = useState<LauncherState<ChatOrigin>>(initialLauncher);
  const live = useRef(draft);
  const apply = (next: LauncherState<ChatOrigin>) => { live.current = next; setDraft(next); };
  const onEdit = (text: string) => apply(edit(live.current.open ? live.current : expand(live.current, capture), text));

  const submit = (text?: string) => {
    let state = live.current;
    if (text !== undefined) state = edit(state.open ? state : expand(state, capture), text);
    else if (!state.open) return;
    const current = getChat(chatId);
    if (!current) state = rebase(state, capture);
    const begun = beginSubmit(state, () => crypto.randomUUID());
    if (!begun) return apply(state);
    apply(begun.state);
    const { entry } = begun;
    let accepted = false;
    if (current) accepted = continueChat(current.id, entry.prompt, entry.idempotencyKey);
    else {
      const started = startChat(entry);
      if (started) { setChatId(started.chat.id); accepted = true; }
    }
    apply(settleSubmit(live.current, entry.idempotencyKey, accepted ? { accepted: true } : { accepted: false }));
    // ChatPane moves focus to the new prompt for its full-pane layout; in the panel the composer keeps it.
    if (accepted) requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  // Element events: warm the router once per session, end the chat on Close. A hover warms only when
  // the policy is "hover"; otherwise the first open does ("open"), or nothing does ("never").
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const warm = (event: FloatingChatEvents["floating-chat-warm"]) => {
      if (warmPolicy === "never" || (warmPolicy === "open" && event.detail.trigger !== "open")) { event.preventDefault(); return; }
      void bridge.execute?.({ type: "command", value: { text: "", context: { view: "chat" }, mode: "prewarm" } }).catch(() => undefined);
    };
    const closed = (event: FloatingChatEvents["floating-chat-close"]) => { if (event.detail.reason === "end") setChatId(null); };
    node.addEventListener("floating-chat-warm", warm as EventListener);
    node.addEventListener("floating-chat-close", closed as EventListener);
    return () => {
      node.removeEventListener("floating-chat-warm", warm as EventListener);
      node.removeEventListener("floating-chat-close", closed as EventListener);
    };
  }, [bridge, warmPolicy]);

  // The shell's chat button opens the panel about the current page (the Scope chip shows which).
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ result: OpenFloatingChatResult }>).detail;
      if (hidden) { detail.result = "hidden"; return; }
      detail.result = "opened";
      const node = host.current;
      if (node?.isOpen) node.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
      else node?.open();
    };
    document.addEventListener(OPEN_EVENT, open);
    return () => document.removeEventListener(OPEN_EVENT, open);
  }, [hidden]);

  // Dictation (renderer/voice) fills the composer; the student reads it and sends it.
  useEffect(() => {
    const dictated = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string; accepted: boolean }>).detail;
      if (hidden || !detail.text) return;
      const current = live.current.draft?.text ?? "";
      onEdit(current.trim() ? `${current.trimEnd()} ${detail.text}` : detail.text);
      detail.accepted = true;
      requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    };
    document.addEventListener(DICTATE_EVENT, dictated);
    return () => document.removeEventListener(DICTATE_EVENT, dictated);
  });

  // Hidden during onboarding and setup; an open panel closes without taking focus.
  useLayoutEffect(() => { if (hidden && host.current?.isOpen) host.current.close("minimise", false); }, [hidden]);

  // The chat store drives the wizard: a question in flight thinks, its outcome answers or tilts.
  const last = useRef<{ id: string; state: string } | null>(null);
  useEffect(() => {
    const node = host.current;
    const x = chat?.exchanges.at(-1) ?? null;
    const before = last.current;
    last.current = x ? { id: x.id, state: x.state } : null;
    if (!node) return;
    let next: WizardState = "idle";
    if (x && (x.state === "running" || x.state === "queued")) next = "thinking";
    else if (x && before?.id === x.id && (before.state === "running" || before.state === "queued"))
      next = x.state === "done" ? "answered" : x.state === "failed" ? "error" : "idle";
    if (next === "answered" || next === "error") node.setWizardState("idle");
    node.setWizardState(next);
  }, [chat, version]);

  // Resource links in the conversation open the saved item behind the panel, like links in the page.
  const onBodyClick = (event: React.MouseEvent) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#resource/"]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // The portal still bubbles through the React tree; the shell's own link handler must not open it twice.
    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent("magic-resource-open", { bubbles: true, detail: decodeURIComponent(link.hash.slice(10)) }));
  };

  const blank = !draft.draft || isBlank(draft.draft.text);
  const sending = !!draft.sending;
  const courses = cards.map((card) => chatCourse(card));

  return <magic-floating-chat ref={host} hidden={hidden} scope-label={scopeText} avoid={FLOATING_CHAT_AVOID}>
    <div slot="body" className="fc-body" onClick={onBodyClick}>
      {chat ? <ChatPane chatId={chat.id} bridge={bridge} resources={resources} sources={sources} courses={courses} now={now} Info={EvidenceInfo}
        onBack={(origin) => {
          if (origin && `${origin.view}|${origin.resourceId ?? ""}|${origin.courseKey ?? ""}` !== pageKey) onNavigate(origin.view as DesktopView, origin.resourceId, origin.courseKey);
          host.current?.close("minimise");
        }}
        onOpenSetup={onOpenSetup}/>
        : <div className="fc-empty">
          <p className="fc-empty-lead">Ask about {scopeText}.</p>
          <p className="fc-empty-note">Answers come from your saved course materials. Chat never submits work or marks anything done.</p>
          <button type="button" className="fc-suggest" onClick={() => submit("What's due this week?")}>What's due this week</button>
        </div>}
    </div>
    <form slot="footer" className="fc-composer" onSubmit={(event) => { event.preventDefault(); if (!blank && !sending) submit(); }}>
      {draft.error ? <p className="fc-error" role="alert">{draft.error}</p> : null}
      <div className="fc-row">
        <textarea ref={field} data-autofocus className="fc-field" rows={1} value={draft.draft?.text ?? ""} readOnly={sending}
          aria-label={chat ? "Follow-up message" : "Message"} placeholder={chat ? followUpHint(chat) : `Ask about ${scopeText}`}
          onChange={(event) => onEdit(event.target.value)} onKeyDown={onKey}/>
        <button type="submit" className="fc-send" aria-label={chat ? "Send follow-up" : "Send"} aria-disabled={blank || sending || undefined}><Send/></button>
      </div>
    </form>
  </magic-floating-chat>;
}

export { FLOATING_CHAT_TAG };

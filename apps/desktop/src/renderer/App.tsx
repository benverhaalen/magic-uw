import { MagicGlyph } from '../../../../packages/ui/src/glyph';
import { CoursesViewHeader } from './courses/CoursesViewToggle';
import { CoursesWorkList, type WorkReportResult } from './courses/CoursesWorkView';
import { projectCourseWork, isCourseWorkActionCurrent, type CourseWorkRow } from './courses/course-work-model';
import { useDesktopVoice } from "./voice/useDesktopVoice";
import { acceptVoiceResult, currentScope } from "./chat/store";
import { scopeCourses } from "./chat/model";
import { ConversationLauncher } from "./conversation-launcher";
import { ChatPane, chatCourse, chatScopeForPage, chatPromptError, startChat, continueChat, getChat, type ChatOrigin } from "./chat";
import { resetChats } from "./chat/store";
import { EvidenceInfo } from "../../../../packages/ui/src/evidence-info";
import { requirePlanSave } from "./today-plan-save";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type {
  AppNotification,
  Command,
  CommandResult,
  ContextManifest,
  PrivacyPreferences,
  ResourceView,
  Snapshot,
  SourceHealth,
} from "@magic/contracts";
import { createAssignmentTypeHues } from "../../../../packages/ui/src/deadline-emphasis";
import { SourcesPage } from "./sources";
import { MyUw } from "./MyUw";
import { CoursePageView } from "./courses/CoursePage";
import { CoursesIndex } from "./courses/CoursesIndex";
import { compactCourseTerm } from "./courses/course-index-view";
import { buildCourseCards, buildCoursePage, courseKey } from "../../../../packages/domain/src/course-page";
import { LocalAiPanel } from "./LocalAiPanel";
import { LearningPanel } from "./LearningPanel";
import { ProviderGuidance } from "./ProviderGuidance";
import { IngestionControls, McpConnections } from "./IngestionControls";
// owner: T06
import { ConsentSetup, hasUwConsent, missingConsents } from "./consent/ConsentSetup";
// owner: T81
import { Onboarding, needsFirstRunSetup } from "./onboarding";
import { signInMessage } from "./sign-in";
import { CalendarPage } from "./CalendarPage";
import { canonicalHomeResources } from "./home/projection";
import { DesktopShell, Glyph } from "./DesktopShell";
import { CanvasMark } from "./prepared-work/canvas-mark";
import { Home, ObjectLink } from "./Home";
import { SnapshotGate } from "./snapshot-gate";
import { startSnapshotPolling } from "./snapshot-poll";
import { StartWork, preparedWorkRevision } from "./StartWork";
import { WORKSPACE_FAILURE, workspaceFailureMessage } from "./workspace-feedback";
import { PersonalReport } from "./PersonalReport";
import { Action, Disclosure } from "../../../../packages/ui/src";
import { useDesktopNavigation, type DesktopView } from "./navigation";
import { CourseSpaceDetails } from "./CourseSpaceDetails";
import { NotificationsMenu, notificationDestination, type NotificationDestination } from "./notifications";
import { AccountSection } from "./AccountSection"; // owner: accounts
import { RememberSignIn } from "./RememberSignIn"; // owner: T05e

function ShellFeedback({ error, notice, view, onDismiss }: { error: string; notice: string; view: DesktopView; onDismiss: () => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (details.current) details.current.open = false; };
  useEffect(() => { close(); }, [view]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!details.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  if (!error && !notice) return null;
  const message = error ? workspaceFailureMessage(error) : notice;
  const summary = error ? message.split(". ")[0]
    : notice === signInMessage({ status: "cancelled", service: "canvas" }) ? "Sign-in cancelled · nothing read"
    : notice;
  return <div className={`desktop-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
    <details ref={details} onToggle={event => setOpen(event.currentTarget.open)}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(); }}
      onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); close(); event.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary title={message}>{summary}</summary>
      <div className="desktop-feedback-content"><span>{message}</span>{error && <details><summary>Error details</summary><p>{error}</p></details>}</div>
    </details>
    <button aria-label={error ? "Dismiss error" : "Dismiss notice"} onClick={event => {
      const shell = event.currentTarget.closest(".desktop-chrome");
      const target = shell?.querySelector<HTMLButtonElement>(".desktop-source-action") ?? shell?.querySelector<HTMLButtonElement>("button");
      onDismiss();
      target?.focus();
    }}>×</button>
  </div>;
}
import { ResourceDetailHeader, ResourceProvenance } from "./ResourceDetailHeader";
import { effectiveCoursePolicy } from "../../../../packages/domain/src/course-policy";
import { ResourceAssignment } from "./ResourceAssignment";
import { DeadlineReview } from "./DeadlineReview";

type View = DesktopView;
// owner: T05b. Route slots, each rendering nothing until its task fills it: the notebook (T43),
// practice and insights (P17), settings (T40) and the workspace command bar (D40).
function NotebookSlot(_: { snapshot: Snapshot | null }) {
  return null; // owner: T43
}
function PracticeSlot(_: { snapshot: Snapshot | null }) {
  return null; // owner: P17
}
function InsightsSlot(_: { snapshot: Snapshot | null }) {
  return null; // owner: P17
}
function SettingsSlot(_: { snapshot: Snapshot | null }) {
  return null; // owner: T40
}
function WorkspaceCommandBarSlot(_: { snapshot: Snapshot | null }) {
  return null; // owner: the D40 command bar
}
// end owner: T05b
type Recipient = ContextManifest["recipient"];
type Run = (
  command: Command,
  message?: string,
) => Promise<CommandResult | undefined>;
const recipientLabels: Record<Recipient, string> = {
  local: "Local model",
  jev: "Jev · TypeSafe",
  chatgpt: "ChatGPT",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};
const statusLabels: Record<SourceHealth["status"], string> = {
  ok: "Checked",
  partial: "Partial capture",
  needs_sign_in: "Sign in needed",
  error: "Could not refresh",
  inaccessible: "Access restricted",
  not_published: "Not published",
  needs_attention: "Needs review",
};

function formatDate(value: string | null, full = false): string {
  if (!value) return "Not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(
    undefined,
    full
      ? {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(date);
}

function Icon({ name }: { name: "today" | "courses" | "myuw" | "sources" | "privacy" | "search" | "arrow" | "file" | "check" }) {
  if (name === "myuw") return <img className="uw-nav-mark" src={new URL("./assets/uw-crest.svg", import.meta.url).href} alt="" aria-hidden="true" />;
  const semantic = { today: 'calendar', courses: 'book', sources: 'sources', privacy: 'privacy', search: 'search', arrow: 'upRight', file: 'file', check: 'check' } as const;
  return <MagicGlyph name={semantic[name]} size={18} />;
}

export function App() {
  const navigation = useDesktopNavigation();
  const { view, selectedId } = navigation;
  const setView = (next: View) => navigation.navigate(next);
  const setSelectedId = (id: string | null) => id ? navigation.navigate("resource", id) : navigation.back();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const chatAccountKey = snapshot ? `${snapshot.fixtureMode ? 'sample' : 'live'}:${[...new Set(snapshot.sources.map(source => source.accountScope ?? source.id))].sort().join('|')}` : 'loading';
  const previousChatAccount = useRef(chatAccountKey);
  useLayoutEffect(() => {
    if (previousChatAccount.current === chatAccountKey) return;
    const hadAccount = previousChatAccount.current !== 'loading';
    previousChatAccount.current = chatAccountKey;
    resetChats();
    if (hadAccount) { void window.magic.cancelLocal?.(); if (view === 'chat') navigation.navigate('today'); }
  }, [chatAccountKey]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [signInStage, setSignInStage] = useState<"idle" | "signin" | "checking">("idle");
  const [query, setQuery] = useState("");

  const snapshotGate = useRef(new SnapshotGate());
  const busyRef = useRef(false);
  const mounted = useRef(true);
  // Opening an item tells the worker, which reads the item's `read_once` links once.
  useEffect(() => {
    if (selectedId) void window.magic.execute({ type: "ui_event", value: { kind: "open", subject: selectedId } }).catch(() => {});
  }, [selectedId]);

  useEffect(() => {
    const handle = (event: Event) => navigation.navigate("resource", (event as CustomEvent<string>).detail);
    document.addEventListener("magic-resource-open", handle);
    return () => document.removeEventListener("magic-resource-open", handle);
  }, [navigation]);

  const refresh = useCallback(async (queueIfBusy = true) => {
    const version = snapshotGate.current.beginRead(queueIfBusy);
    if (version === null) return;
    try {
      if (!window.magic)
        throw new Error(
          "The desktop connection is unavailable. Open My Magic UW from the desktop app.",
        );
      const result = await window.magic.execute({ type: "snapshot" });
      if (mounted.current && snapshotGate.current.accepts(version)) {
        setSnapshot(result.snapshot);
        setError(previous => /timed? ?out|timeout/i.test(previous) ? '' : previous);
      }
    } catch (cause) {
      if (mounted.current && snapshotGate.current.accepts(version))
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read local data. Try again.",
        );
    } finally {
      snapshotGate.current.endRead();
      if (mounted.current && snapshotGate.current.takeQueued()) void refresh();
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopPolling: () => void;
    const onChanged = window.magic?.onChanged;
    if (onChanged) {
      // owner: stall-audit. The worker says when the workspace changed; read then, at most every
      // 2 s (the gate keeps one read at a time and queues one behind it). Hidden, a change is read
      // on return. Idle, nothing is read. Without onChanged, the idle-time poll below stays.
      let pending = false,
        lastRead = Date.now(),
        trailing: number | undefined;
      const pull = () => {
        pending = true;
        if (document.hidden || trailing !== undefined) return;
        const wait = lastRead + 2000 - Date.now();
        if (wait > 0) {
          trailing = window.setTimeout(() => {
            trailing = undefined;
            if (pending) pull();
          }, wait);
          return;
        }
        pending = false;
        lastRead = Date.now();
        void refresh();
      };
      const onVisible = () => {
        if (!document.hidden && pending) pull();
      };
      const unsubscribe = onChanged(pull);
      document.addEventListener('visibilitychange', onVisible);
      void refresh();
      stopPolling = () => {
        unsubscribe();
        document.removeEventListener('visibilitychange', onVisible);
        window.clearTimeout(trailing);
      };
    } else
      stopPolling = startSnapshotPolling(() => refresh(false), {
        hidden: () => document.hidden,
        schedule: callback => window.setTimeout(callback, 2000),
        cancel: timer => window.clearTimeout(timer),
        onVisibility: callback => {
          document.addEventListener('visibilitychange', callback);
          return () => document.removeEventListener('visibilitychange', callback);
        },
      });
    return () => {
      mounted.current = false;
      snapshotGate.current.invalidate();
      stopPolling();
    };
  }, [refresh]);

  useEffect(() => {
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    const setup = () => setView('consent');
    window.addEventListener(WORKSPACE_FAILURE, failed);
    window.addEventListener('magic-open-setup', setup);
    return () => { window.removeEventListener(WORKSPACE_FAILURE, failed); window.removeEventListener('magic-open-setup', setup); };
  }, []);

  const perform = useCallback(
    async (
      operation: () => Promise<CommandResult | null | void>,
      message?: string,
    ): Promise<CommandResult | undefined> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      snapshotGate.current.beginMutation();
      let suppliedSnapshot = false;
      try {
        const result = await operation();
        if (!mounted.current) return;
        if (result) {
          suppliedSnapshot = true;
          setSnapshot(result.snapshot);
        }
        if (result?.message || message)
          setNotice(result?.message || message || "");
        return result || undefined;
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "The action could not finish. Try again.",
          );
        return undefined;
      } finally {
        busyRef.current = false;
        snapshotGate.current.endMutation(!suppliedSnapshot);
        if (mounted.current) {
          setBusy(false);
          if (snapshotGate.current.takeQueued()) void refresh();
        }
      }
    },
    [refresh],
  );

  const run: Run = useCallback(
    (command, message) => perform(() => window.magic.execute(command), message),
    [perform],
  );
  const importFile = () => perform(() => window.magic.importFile());
  // owner: T06. Consent wiring: no UW contact until the setup checkbox is agreed; a Data & AI
  // change that would start sharing with a recipient without an agreement waits for one.
  const [consentPending, setConsentPending] = useState<PrivacyPreferences | null>(null);
  const privacyReturnFocus = useRef<string | null>(null);
  const consentReturnToPrivacy = useRef(false);
  useLayoutEffect(() => {
    if (view !== "privacy" || !privacyReturnFocus.current) return;
    const key = privacyReturnFocus.current;
    privacyReturnFocus.current = null;
    const target = document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }, [view]);
  const uwConsented = hasUwConsent(snapshot);
  const openConsent = (pending: PrivacyPreferences | null = null) => {
    consentReturnToPrivacy.current = view === "privacy";
    if (view === "privacy")
      privacyReturnFocus.current = (document.activeElement as HTMLElement | null)?.dataset.focusKey ?? null;
    setConsentPending(pending);
    setView("consent");
  };
  const runAll = (commands: Command[]) =>
    perform(async () => {
      let result: CommandResult | undefined;
      for (const command of commands) result = await window.magic.execute(command);
      return result;
    });
  const signIn = async (service: "canvas" | "gitlab" = "canvas") => {
    if (!uwConsented) return openConsent();
    return startSignIn(service);
  };
  // end owner: T06
  const startSignIn = async (service: "canvas" | "gitlab" = "canvas") => {
    if (!window.magic.signInUW) return;
    setSignInStage("signin");
    try {
      await perform(async () => {
        const outcome = await window.magic.signInUW!(service);
        if (!outcome || outcome.status !== "confirmed") {
          setNotice(outcome ? signInMessage(outcome) : "Sign-in was not confirmed. Try again.");
          return;
        }
        setSignInStage("checking");
        return window.magic.syncCanvas ? window.magic.syncCanvas() : undefined;
      });
      await refresh();
    } finally { setSignInStage("idle"); }
  };
  const sync = () =>
    window.magic.syncCanvas
      ? perform(() => window.magic.syncCanvas!())
      : undefined;
  const signOut = () =>
    window.magic.signOutUW
      ? perform(
          () => window.magic.signOutUW!(),
          "UW session cleared and Outlook calendar disconnected. Saved course records are still on this device; use Delete local data to remove them.",
        )
      : undefined;
  const open = (url: string) => {
    void perform(() => window.magic.openExternal(url));
  };
  const resources =
    snapshot?.resources.filter((resource) => {
      if (resource.deleted) return false;
      const source = snapshot.sources.find((s) => s.id === resource.sourceId);
      const override = snapshot.courseOverrides?.find(
        (o) =>
          o.accountScope === source?.accountScope &&
          o.courseId === resource.courseId,
      );
      const course = snapshot.resources.find(
        (r) =>
          r.kind === "course" &&
          r.course &&
          r.courseId === resource.courseId &&
          snapshot.sources.find((s) => s.id === r.sourceId)?.scope ===
            "course" &&
          snapshot.sources.find((s) => s.id === r.sourceId)?.accountScope ===
            source?.accountScope,
      );
      if (
        course?.course?.accessRestricted ||
        (course?.course?.accessState && course.course.accessState !== "open")
      )
        return false;
      if (
        course?.course?.selection?.reasons.some((reason) =>
          /absent|no longer|not returned/i.test(reason),
        )
      )
        return false;
      const term = snapshot.ingestionSettings?.selectedTerm;
      if (
        term &&
        course?.course &&
        term !== course.course.termName &&
        term !== course.course.termId
      )
        return false;
      if (override?.included != null) return override.included;
      return course?.course?.selection?.included ?? true;
    }) ?? [];
  const accountBySource = new Map(snapshot?.sources.map((source) => [source.id, source.accountScope]));
  const courseInput = { resources, sources: snapshot?.sources ?? [], courseIntelligence: snapshot?.courseIntelligence, now: snapshot?.generatedAt ?? new Date().toISOString() };
  const typeHueOf = createAssignmentTypeHues(snapshot?.resources ?? [], snapshot?.sources ?? []);
  const courseCards = buildCourseCards(courseInput);
  const courseWorkModel = snapshot?.courseWorkAdmission ? projectCourseWork({resources, sources:snapshot.sources, admission:snapshot.courseWorkAdmission, links:snapshot.links, personalWorkReports:snapshot.personalWorkReports, generatedAt:snapshot.generatedAt, timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}) : null;
  const currentWorkModel=useRef(courseWorkModel);currentWorkModel.current=courseWorkModel;
  async function reportCourseWork(row:CourseWorkRow, checked:boolean, operationId:string):Promise<WorkReportResult> {
    const current=currentWorkModel.current?.rows.find(item=>item.key===row.key);
    if (!current?.report || !row.report || current.scopeKey!==row.scopeKey) return {status:'conflict',reason:'scope-changed'};
    if (current.report.obligationVersion!==row.report.obligationVersion) return {status:'conflict',reason:'obligation-changed'};
    const result=await run({type:'personal-work',value:{...row.report.descriptor,checked,operationId,expectedRevision:row.report.revision}});
    const fresh=result ?? await run({type:'snapshot'});
    const saved=fresh?.snapshot.personalWorkReports?.find(item=>item.issueId===row.report!.issueId);
    if(saved && saved.sourceVersion===row.report.obligationVersion && saved.checked===checked && saved.revision>row.report.revision)
      return {status:'saved',issueId:saved.issueId,revision:saved.revision,checked:saved.checked,reportedAt:saved.reportedAt};
    return saved && saved.revision!==row.report.revision ? {status:'conflict',reason:'revision'} : {status:'unavailable',reason:'storage'};
  }
  function openCourseWork(row:CourseWorkRow) {
    const model=currentWorkModel.current;
    if(!model || !isCourseWorkActionCurrent(row,model) || !row.resourceId) throw new Error('This item is no longer available.');
    setSelectedId(row.resourceId);
  }
  const coursePage = navigation.courseKey ? buildCoursePage(courseInput, navigation.courseKey) : null;
  // Notification rows route by stable IDs: the saved item, its course page, Outlook or Sources.
  const notificationTarget = (item: AppNotification) => notificationDestination(item, {
    resource: id => resources.find(resource => resource.id === id),
    courseKey: (sourceId, courseId) => {
      const key = courseKey(accountBySource.get(sourceId) ?? sourceId, courseId);
      return courseCards.some(card => card.key === key) ? key : null;
    },
  });
  const openNotification = (target: NotificationDestination) => {
    if (target.kind === "resource") navigation.navigate("resource", target.id);
    else if (target.kind === "course") navigation.navigate("courses", null, target.key);
    else if (target.kind === "sources") setView("sources");
    else open(target.url);
  };
  const selected =
    canonicalHomeResources(resources, snapshot?.sources ?? [], snapshot?.links ?? [], snapshot?.courseWorkAdmission?.aliases).find((resource) => resource.id === selectedId) ??
    resources.find((resource) => resource.id === selectedId) ?? null;
  const unavailableSources =
    snapshot?.sources.filter(
      (source) => source.status !== "ok" || !source.complete,
    ) ?? [];
  const needsSignIn = unavailableSources.some(
    (source) => source.status === "needs_sign_in",
  );
  const pageTitle = view === "chat" ? "Chat" : view === "resource" ? selected?.kind === "assignment" ? "Assignment" : selected?.kind === "material" ? "Saved material" : "Saved item" : view === "courses" && coursePage ? coursePage.code || coursePage.courseName : ({today:"Home", courses:"Courses", myuw:"My UW", calendar:"Calendar", sources:"Connected sources", privacy:"Data & AI", consent:"Agreements"} as Partial<Record<View,string>>)[view] ?? "Workspace";
  const captureChatOrigin = (): ChatOrigin => {
    const place = navigation.capturePlace();
    return { view, resourceId: selectedId, courseKey: navigation.courseKey, label: pageTitle, focusKey: place.focus, anchor: place.anchor, offset: place.offset, scroll: place.scroll,
      scope: view === 'chat' && selectedId && getChat(selectedId) ? currentScope(getChat(selectedId)!) : chatScopeForPage({page:pageTitle, resource:selected, course:coursePage, cards:courseCards, sources:snapshot?.sources ?? []}) };
  };
  // Voice (adopted from voice-shared-path): one session per account; each utterance captures the page on first speech,
  // runs through the same intent router as typed chat, and navigates immediately for ordinary page/course/item opens.
  const navigateFromIntent = (target: {view: string; resourceId?: string; courseId?: string; accountScope?: string}) => {
    if (target.view === 'course') { const course = courseCards.find(card => card.courseId === target.courseId && chatCourse(card).accountScope === target.accountScope); if (!course) return false; navigation.navigate('courses', null, course.key); }
    else if (target.view === 'assignment' && target.resourceId) navigation.navigate('resource', target.resourceId);
    else if (['today','courses','calendar','myuw'].includes(target.view)) setView(target.view as View);
    else return false;
    return true;
  };
  const desktopVoice = useDesktopVoice(chatAccountKey, () => {
    const origin = captureChatOrigin(), courses = scopeCourses(origin.scope);
    return {origin: {chat: origin, followUpId: view === 'chat' ? selectedId ?? undefined : undefined}, context: {view: origin.view, ...(courses.length === 1 ? {courseId: courses[0]!.key} : {}), ...(origin.scope.kind === 'item' ? {resourceId: origin.scope.item.id} : {})}};
  }, (captured, event) => {
    if (!snapshot) return;
    let navigated = false;
    const chat = acceptVoiceResult({origin: captured.chat, prompt: event.text, idempotencyKey: event.operationId}, event.result, {bridge: window.magic, resources, sources: snapshot.sources, courses: courseCards.map(card => chatCourse(card)), now: new Date().toISOString(), onNavigate: target => { navigated = navigateFromIntent(target); }}, captured.followUpId);
    if (chat && !(event.result.status === 'ran' && ['page.open','course.open','assignment.open'].includes(event.result.action))) navigation.navigate('chat', chat.id);
    if (event.result.status === 'ran' && event.result.action === 'page.open') return navigated ? 'Opened the requested page.' : 'That page is no longer available.';
  });
  // owner: T81. First run, or setup still incomplete: the onboarding flow replaces the shell
  // (and T06's in-Home consent entry) until the student opens the workspace.
  if (snapshot && needsFirstRunSetup(snapshot))
    return (
      <Onboarding
        snapshot={snapshot}
        busy={busy}
        error={error}
        onDismissError={() => setError("")}
        run={run}
        runAll={runAll}
        canSignIn={Boolean(window.magic.signInUW)}
        signIn={startSignIn}
        openExternal={open}
        onLoadSample={() => run({ type: "fixture" })}
        onFinish={() => {
          setView("today");
          void refresh();
        }}
      />
    );
  // end owner: T81
  return (
    <DesktopShell view={view} title={pageTitle}
      courses={courseCards} selectedCourseKey={navigation.courseKey} sample={snapshot?.fixtureMode ?? false} busy={busy && signInStage === "idle"}
      canBack={navigation.canBack} canForward={navigation.canForward} onBack={navigation.back} onForward={navigation.forward}
      onNavigate={setView} onCourse={key => navigation.navigate("courses", null, key)}
      status={<>
        {snapshot?.sources.some(source => source.kind === "canvas" && source.status === "needs_sign_in") && window.magic.signInUW ?
          <button className="desktop-source-action desktop-canvas-action" aria-label="Sign in to Canvas" aria-busy={signInStage !== "idle" || undefined} aria-disabled={busy || undefined} onClick={() => { if (!busy) void signIn(); }}>
            <span>{signInStage === "signin" ? "Opening…" : signInStage === "checking" ? "Checking…" : "Sign in to"}</span><CanvasMark/>
          </button> : needsSignIn ? <button className="desktop-source-action" onClick={() => setView("sources")}><Glyph name="settings"/><span>Review sign-in</span></button> : null}
        <ShellFeedback error={error} notice={notice} view={view} onDismiss={() => { setError(""); setNotice(""); }}/>
      </>}
      trailing={<NotificationsMenu feed={snapshot?.notifications} busy={busy} run={run} destinationOf={notificationTarget} onOpen={openNotification} onOpenSources={() => setView("sources")} onOpenPrivacy={() => navigation.navigate("privacy", null, null, undefined, snapshot?.privacy.mode === "local_only" ? undefined /* the mode choice at the top unlocks Jev */ : { focus: "privacy-jev", anchor: "privacy-models" })}/>}
      launcher={snapshot ? <ConversationLauncher<ChatOrigin> key={chatAccountKey} voice={desktopVoice.voice} feedback={desktopVoice.feedback || undefined} here={{key:`${view}:${selectedId ?? ''}:${navigation.courseKey ?? ''}`,label:pageTitle}} captureOrigin={captureChatOrigin} mode={view === 'chat' && selectedId ? 'follow-up' : 'new-chat'} chatId={view === 'chat' ? selectedId ?? undefined : undefined} onSubmit={entry => {
        const invalid = chatPromptError(entry.prompt); if (invalid) return {accepted:false,message:invalid};
        if (entry.destination.kind === 'follow-up') {
          if (!continueChat(entry.destination.chatId, entry.prompt, entry.idempotencyKey)) return {accepted:false,message:'This chat is no longer open. Start a new chat.'};
          navigation.navigate('chat',entry.destination.chatId); return {accepted:true};
        }
        const result = startChat(entry); if (!result) return {accepted:false,message:'Enter a message to start a chat.'};
        navigation.navigate('chat',result.chat.id); return {accepted:true};
      }}/> : undefined}
      onCompose={() => { const toggle=document.querySelector<HTMLButtonElement>('.cl-toggle'); if(toggle?.getAttribute('aria-expanded') === 'true')document.querySelector<HTMLTextAreaElement>('.conversation-launcher textarea,.cl-root textarea')?.focus(); else toggle?.click(); }}>
        <WorkspaceCommandBarSlot snapshot={snapshot} /* owner: T05b */ />
        {!snapshot ? (
          <section className="initial-state">
            <h1>Your classes, in one place.</h1>
            <p className="muted">
              {error
                ? "The local workspace could not be opened."
                : "Opening your local workspace…"}
            </p>
            {error ? (
              <button className="button" onClick={() => void refresh()}>
                Try again
              </button>
            ) : null}
          </section>
        ) : view === "today" ? (
          <>
            {resources.length === 0 && !uwConsented ? (
              // owner: T06: the first-run screen replaces the empty workspace until agreed.
              <ConsentSetup
                snapshot={snapshot}
                busy={busy}
                pending={null}
                canSignIn={Boolean(window.magic.signInUW)}
                runAll={runAll}
                onAgreedToSetup={() => void startSignIn()}
                onSample={() => run({ type: "fixture" })}
                onClose={null}
                embedded
              />
            ) : resources.length === 0 ? (
              <EmptyWorkspace
                busy={busy}
                canSignIn={Boolean(window.magic.signInUW)}
                onSignIn={signIn}
                onImport={importFile}
                onSample={() => run({ type: "fixture" })}
              />
            ) : (
              <Home onOpenSource={open} todayCount={navigation.homeTodayCount} onTodayCountChange={navigation.updateHomeTodayCount} upcomingCount={navigation.homeUpcomingCount} onUpcomingCountChange={navigation.updateHomeUpcomingCount} snapshot={snapshot} resources={resources} onSelect={setSelectedId} onCourses={() => { setQuery(""); setView("courses"); }} onSources={() => setView("sources")} onMyUw={target => { setView("myuw"); requestAnimationFrame(() => requestAnimationFrame(() => { const section = document.getElementById(`myuw-${target}`); const heading = section?.querySelector<HTMLElement>('h2') ?? document.getElementById('myuw-title'); const pane = heading?.closest<HTMLElement>('.desktop-workspace'); if (heading && pane) pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24; heading?.focus({ preventScroll: true }); })); }} onPlan={command => requirePlanSave(run, command)} onJoin={window.magic.openLink ? url => { void perform(() => window.magic.openLink!(url)); } : undefined} reviewDates={resource => <DeadlineReview resource={resource} run={run} onInspect={()=>setSelectedId(resource.id)}/>} report={(resource, summary) => <PersonalReport resource={resource} snapshot={snapshot} run={run} compactWhenHandled summary={summary}/>} onSetup={() => openConsent()} onNotice={setNotice} />
            )}
          </>
        ) : view === "chat" ? (
          <ChatPane onNavigate={navigateFromIntent} typeHueOf={typeHueOf} chatId={selectedId ?? ''} bridge={window.magic} resources={resources} sources={snapshot.sources} courses={courseCards.map(card => chatCourse(card))} now={new Date().toISOString()} Info={EvidenceInfo} onBack={() => navigation.canBack ? navigation.back() : setView('today')} onOpenSetup={target => setView(target === 'sources' ? 'sources' : 'privacy')}/>
        ) : view === "resource" ? (
          selected ? <ResourceDetail key={selected.id} resource={selected} snapshot={snapshot} busy={busy} run={run} open={open} onClose={navigation.back} onSetup={() => openConsent()} onNotice={setNotice} />
            : <section className="initial-state"><h1 tabIndex={-1}>This item is no longer available.</h1><p>The saved item may have been removed or excluded. Your previous page is still available.</p><button className="button" onClick={navigation.back}>Go back</button></section>
        ) : view === "calendar" ? (
          <section className="desktop-calendar"><CalendarPage resources={resources} sources={snapshot.sources} links={snapshot.links} aliases={snapshot.courseWorkAdmission?.aliases} plan={snapshot.dayPlan ?? []} planning={snapshot.planning} personalEvents={snapshot.personalCalendarEvents ?? []}
            state={navigation.calendarState} onStateChange={navigation.updateCalendar} restoreFocusId={navigation.calendarFocus}
            onSelect={navigation.openCalendarResource} formatCourseLabel={(id, fallback) => { const resource = resources.find(r => r.id === id); const account = resource && accountBySource.get(resource.sourceId); const card = resource && courseCards.find(c => c.key === courseKey(account ?? resource.sourceId, resource.courseId)); return card?.code ?? card?.courseName ?? fallback; }} onPlan={async command => { const result = await run(command); if (!result) throw new Error("Calendar change was not saved"); return result; }}/></section>
        ) : view === "myuw" ? (
          <MyUw snapshot={snapshot} busy={busy} run={run} open={open}
            refresh={() => perform(async () => window.magic.syncPlanning?.())}
            signIn={(service) => uwConsented /* owner: T06 */ ? void perform(async () => { const outcome = await window.magic.signInUW?.(service); if (outcome?.status !== "confirmed") { setNotice(outcome ? signInMessage(outcome) : "Sign-in was not confirmed. Try again."); return; } return window.magic.syncPlanning?.(); }) : openConsent()} />
        ) : view === "courses" ? (
          <section className="desktop-courses">
            {navigation.courseKey ? coursePage ? <CoursePageView typeHueOf={typeHueOf} key={coursePage.key} page={coursePage} selectedId={null} onSelect={setSelectedId} onBack={() => navigation.navigate("courses")} open={open} detail={null}/> : <><h1 tabIndex={-1}>Course unavailable</h1><p>This course is no longer included in the saved workspace.</p><Action onClick={() => navigation.navigate("courses")}>View courses</Action></> : <><CoursesViewHeader termLabel={compactCourseTerm(courseWorkModel?.scope.term.label ?? "Courses")} mode={navigation.coursesMode} onChange={navigation.switchCoursesMode}/>{navigation.coursesMode === 'list' && courseWorkModel ? <CoursesWorkList model={courseWorkModel} state={navigation.courseWorkState} onStateChange={navigation.updateCourseWorkState} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} onOpen={openCourseWork} onAction={openCourseWork} onReport={reportCourseWork} onSources={()=>setView('sources')}/> : <CoursesIndex showHeader={false} resources={resources} sources={snapshot.sources} cards={courseCards} now={courseInput.now} typeHueOf={typeHueOf} onOpen={key => navigation.navigate("courses", null, key)} onSources={() => setView("sources")}/>}</>}
          </section>
        ) : view === "consent" ? (
          // owner: T06. Consent route: setup, a new recipient's consent, or Agreements.
          <ConsentSetup
            snapshot={snapshot}
            busy={busy}
            pending={consentPending}
            canSignIn={Boolean(window.magic.signInUW)}
            runAll={runAll}
            onAgreedToSetup={() => {
              const next = consentPending;
              setConsentPending(null);
              const returnToPrivacy = Boolean(next) || consentReturnToPrivacy.current;
              setView(returnToPrivacy ? "privacy" : "today");
              if (!returnToPrivacy) void startSignIn();
            }}
            onSample={() => {
              setView("today");
              void run({ type: "fixture" });
            }}
            onClose={() => {
              const back = consentPending || consentReturnToPrivacy.current ? "privacy" : "today";
              setConsentPending(null);
              setView(back);
            }}
          />
        ) : /* owner: T05b: route slots */ view === "notebook" ? (
          <NotebookSlot snapshot={snapshot} />
        ) : view === "practice" ? (
          <PracticeSlot snapshot={snapshot} />
        ) : view === "insights" ? (
          <InsightsSlot snapshot={snapshot} />
        ) : view === "settings" ? (
          <SettingsSlot snapshot={snapshot} />
        ) : /* end owner: T05b */ view === "sources" ? (
          <SourcesPage snapshot={snapshot} run={run} busy={busy}
            onSignIn={signIn} onSync={sync} onSignOut={signOut} onImport={importFile}
            onSample={() => run({ type: "fixture" })} uwConsented={uwConsented}
            onOpenMyUw={() => setView("myuw")} onOpenPrivacy={() => setView("privacy")}
            onSourcesChanged={refresh}
            courseLabels={courseCards.map(card => ({ key: card.key, label: card.code ?? card.courseName }))}
            readingSettings={<IngestionControls snapshot={snapshot} busy={busy} run={run}/>}
            accessDetails={<CourseSpaceDetails sources={snapshot.sources} revision={snapshot.sources.map(source => source.lastAttemptAt).join("|")}/>}
          />
        ) : (
          <Privacy
            snapshot={snapshot}
            busy={busy}
            run={run}
            open={open}
            onConsent={openConsent /* owner: T06 */}
            onSources={() => {
              privacyReturnFocus.current = "privacy-connected-sources";
              setView("sources");
            }}
          />
        )}
    </DesktopShell>
  );
}

function EmptyWorkspace({
  busy,
  canSignIn,
  onSignIn,
  onImport,
  onSample,
}: {
  busy: boolean;
  canSignIn: boolean;
  onSignIn: () => unknown;
  onImport: () => unknown;
  onSample: () => unknown;
}) {
  return (
    <section className="empty-workspace">
      <div className="empty-icon">
        <Icon name="sources" />
      </div>
      <h2>Bring your classes into focus.</h2>
      <p>
        Connect UW to read your coursework, or import a saved capture. Your
        course records stay in the local workspace. Reading Canvas content may
        mark it viewed, including “must view” requirements.
      </p>
      <div className="empty-actions">
        {canSignIn ? (
          <button className="button primary" disabled={busy} onClick={onSignIn}>
            Sign in to UW <span aria-hidden="true">→</span>
          </button>
        ) : null}
        <button className="button" disabled={busy} onClick={onImport}>
          Import capture
        </button>
      </div>
      <div className="sample-divider">
        <span>Explore first</span>
      </div>
      <button
        className="subtle-button sample-button"
        disabled={busy}
        onClick={onSample}
      >
        Load sample course <span aria-hidden="true">↗</span>
      </button>
      <p className="small muted">Synthetic coursework. No account required.</p>
    </section>
  );
}

function ResourceList({
  resources,
  sources,
  query,
  selectedId,
  busy,
  onSelect,
  onComplete,
}: {
  resources: ResourceView[];
  sources: SourceHealth[];
  query: string;
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onComplete: (resource: ResourceView, checked: boolean) => void;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = resources
    .filter(
      (resource) =>
        !needle ||
        `${resource.title} ${resource.courseName} ${resource.text}`
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort(
      (a, b) =>
        Number(a.completed || a.submitted === true) -
          Number(b.completed || b.submitted === true) ||
        (a.deadline.planningAt ?? "9999").localeCompare(
          b.deadline.planningAt ?? "9999",
        ) ||
        a.title.localeCompare(b.title),
    );
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return (
    <div className="resource-list">
      <div className="list-heading">
        <span>Coursework & materials</span>
        <span>{visible.length}</span>
      </div>
      {visible.length === 0 ? (
        <div className="no-results">No coursework matches “{query}”.</div>
      ) : (
        visible.map((resource) => {
          const done = resource.completed || resource.submitted === true;
          const source = sourceById.get(resource.sourceId);
          return (
            <div
              key={resource.id}
              className={`resource-row ${selectedId === resource.id ? "selected" : ""} ${done ? "is-complete" : ""}`}
            >
              {resource.kind === "assignment" ? (
                <input
                  className="complete-checkbox"
                  type="checkbox"
                  aria-label={`Mark ${resource.title} complete`}
                  checked={done}
                  disabled={busy || resource.submitted === true}
                  onChange={(event) =>
                    onComplete(resource, event.target.checked)
                  }
                  title={
                    resource.submitted === true
                      ? "Submission reported by source"
                      : "Mark complete locally"
                  }
                />
              ) : (
                <span className="resource-kind-icon">
                  <Icon name="file" />
                </span>
              )}
              <button
                className="resource-select"
                aria-pressed={selectedId === resource.id}
                onClick={() => onSelect(resource.id)}
              >
                <span className="resource-course">{resource.courseName}</span>
                <span className="resource-title">{resource.title}</span>
                <span
                  className={`resource-subline ${resource.deadline.conflict ? "attention-text" : ""}`}
                >
                  {done
                    ? resource.submitted === true
                      ? "Submitted · reported by source"
                      : "Marked complete"
                    : resource.deadline.conflict
                      ? `Conflicting dates · plan for ${formatDate(resource.deadline.planningAt)}`
                      : resource.deadline.dueAt
                        ? `Due ${formatDate(resource.deadline.dueAt)}`
                        : resource.kind === "assignment"
                          ? "Due date not found"
                          : (resource.kindLabel ?? resource.kind)}
                  {source && source.status !== "ok"
                    ? ` · ${statusLabels[source.status]}`
                    : ""}
                </span>
              </button>
              <span className="row-chevron" aria-hidden="true">
                ›
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function ResourceDetail({
  resource,
  snapshot,
  busy,
  run,
  open,
  onClose,
  onSetup,
  onNotice,
}: {
  resource: ResourceView;
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
  open: (url: string) => void;
  onClose: () => void;
  onSetup: () => void;
  onNotice: (text: string) => void;
}) {
  const [recipient, setRecipient] = useState<Recipient>("local");
  const [manifest, setManifest] = useState<ContextManifest | null>(null);
  const initialVersion = useRef(resource.contentHash);
  const changedWhileReading = initialVersion.current !== resource.contentHash;
  const source = snapshot.sources.find(
    (candidate) => candidate.id === resource.sourceId,
  );
  const courseProfile = source && snapshot.courseIntelligence?.find(profile =>
    profile.accountScope === source.accountScope && profile.courseId === resource.courseId);
  const effectivePolicy = effectiveCoursePolicy(courseProfile, resource, courseProfile?.freshness);
  const policyResource = { ...resource, policy: { mode: effectivePolicy.mode, evidence: effectivePolicy.evidence } };
  const policyRevision = JSON.stringify([effectivePolicy.inputHash, effectivePolicy.mode, effectivePolicy.conflict]);
  const links = snapshot.links.filter(
    (link) => link.fromId === resource.id || link.toId === resource.id,
  );
  const sameDestinationLinks = links.length > 0 && links.every(link => {
    const otherId = link.fromId === resource.id ? link.toId : link.fromId;
    const other = snapshot.resources.find(candidate => candidate.id === otherId);
    return Boolean(other && other.url === resource.url && other.title === resource.title);
  });
  const preview = async () => {
    const result = await run({ type: "context", id: resource.id, recipient });
    setManifest(result?.manifest ?? null);
  };
  // A preview applies only to the exact resource version and privacy choices it was made for.
  useEffect(() => {
    setManifest(null);
  }, [
    resource.contentHash,
    policyRevision,
    snapshot.privacy.mode,
    snapshot.privacy.jevEnabled,
    snapshot.privacy.hostedProvider,
    snapshot.privacy.shareCourseText,
    snapshot.privacy.shareStudentWork,
  ]);
  const policyDetails = (
<Disclosure label={`Course AI policy · ${effectivePolicy.mode}`} placeKey={`resource-policy:${resource.id}`}>
        {effectivePolicy.conflict && <p className="attention-text">Saved policy sources disagree. The more restrictive policy applies.</p>}
        <p className="source-text">
          {effectivePolicy.evidence ||
            "No AI policy was found in the captured material. Coaching is the default."}
        </p>
        {courseProfile?.freshness !== undefined && courseProfile.freshness !== "current_capture" && <p className="small muted">Course policy sources are {courseProfile.freshness}. The effective saved policy applies here.</p>}
        {effectivePolicy.resourceIds.length > 0 && <ul className="evidence-list">{effectivePolicy.resourceIds.map(id => {
          const evidence = snapshot.resources.find(candidate => candidate.id === id);
          return <li key={id}>{evidence ? <ObjectLink resource={evidence} /> : "Policy source is unavailable"}</li>;
        })}</ul>}
      </Disclosure>
  );
  return (
    <section className="resource-detail" aria-label="Selected item">
      <ResourceDetailHeader resource={resource} snapshot={snapshot} open={open} changedWhileReading={changedWhileReading}
        deadlineReview={resource.deadline.conflict ? <DeadlineReview resource={resource} run={run} onInspect={() => {
        const target = document.getElementById(`deadline-evidence-${resource.id}`);
        const disclosure = target?.querySelector('details');
        if (disclosure) disclosure.open = true;
        target?.querySelector('summary')?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest' });
      }} /> : null} />
      {resource.kind === "assignment" ? <ResourceAssignment resource={resource} snapshot={snapshot} policy={policyDetails} onSetup={onSetup} onNotice={onNotice} onOpenOriginal={() => open(resource.url)}
        provenance={<ResourceProvenance resource={resource} snapshot={snapshot} />} /> : <>
        {resource.text ? <section className="detail-section">
          <h3>Source content</h3>
          <p className="source-text">{resource.text}</p>
        </section> : <p className="muted small">{resource.kind === "material" ? "This capture saved a link. Open the material to read its content." : "This capture has no saved text. Open the original to read its content."}</p>}
        <ResourceProvenance resource={resource} snapshot={snapshot} />
      </>}
      {links.length ? (
        <section className="detail-section">
          <Disclosure label={sameDestinationLinks ? "Linked source evidence" : "Related material"} defaultOpen={!sameDestinationLinks} placeKey={`resource-links:${resource.id}`}>
          {links.map((link) => {
            const otherId =
              link.fromId === resource.id ? link.toId : link.fromId;
            const other = snapshot.resources.find(
              (candidate) => candidate.id === otherId,
            );
            return (
              <div key={link.id} className="link-evidence">
                <strong>{other ? <ObjectLink resource={other}/> : "Related source is unavailable"}</strong>
                <span className="small muted">
                  {link.type.replaceAll("_", " ")} · {link.status}
                </span>
                <p>{link.reason}</p>
                <div className="inline-actions">
                  {link.status !== "accepted" ? (
                    <button
                      className="button small-button"
                      disabled={busy}
                      onClick={() =>
                        void run({
                          type: "link",
                          id: link.id,
                          status: "accepted",
                        })
                      }
                    >
                      Accept link
                    </button>
                  ) : null}
                  {link.status !== "rejected" ? (
                    <button
                      className="button small-button"
                      disabled={busy}
                      onClick={() =>
                        void run({
                          type: "link",
                          id: link.id,
                          status: "rejected",
                        })
                      }
                    >
                      {link.status === "accepted" ? "Undo link" : "Reject link"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
          </Disclosure>
        </section>
      ) : null}
      {(resource.kind === "assignment" || resource.deadline.conflict || resource.deadline.claims.length > 0) && <section id={`deadline-evidence-${resource.id}`}><Disclosure label="Deadline evidence" placeKey={`resource-deadline:${resource.id}`}>
        <p className="muted small">Saved source interpretation: {resource.deadline.reason}</p>
        {resource.deadline.claims.length ? (
          <ul className="evidence-list">
            {resource.deadline.claims.map((claim, index) => (
              <li key={`${claim.kind}-${claim.value}-${index}`}>
                <div>
                  <span className="badge">{claim.kind}</span>
                  <span>{formatDate(claim.value, true)}</span>
                </div>
                <blockquote>
                  {claim.quote || "Structured source field"}
                </blockquote>
                {!claim.scopeConfirmed ? (
                  <span className="small attention-text">
                    Not confirmed to apply to this item
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">
            No date claims are available in this capture.
          </p>
        )}
      </Disclosure></section>}
      {resource.kind !== "assignment" && policyDetails}
      <LearningPanel key={`${resource.id}:${source?.accountScope}:${resource.contentHash}:${JSON.stringify(snapshot.privacy)}`} resource={policyResource} accountScope={source?.accountScope} />
      <LocalAiPanel
        key={`${resource.contentHash}:${policyRevision}:${JSON.stringify(snapshot.privacy)}`}
        resource={policyResource}
        privacyKey={`${policyRevision}:${JSON.stringify(snapshot.privacy)}`}
      />

      <section className="detail-section">
        <h3>Data preview</h3>
        <p className="small muted">
          Inspect the exact context prepared for a model. Previewing does not
          send it.
        </p>
        <label className="field-label" htmlFor="recipient">
          Recipient
        </label>
        <div className="inline-actions">
          <select
            id="recipient"
            disabled={busy}
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value as Recipient);
              setManifest(null);
            }}
          >
            {Object.entries(recipientLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="button"
            disabled={busy}
            onClick={() => void preview()}
          >
            Preview data
          </button>
        </div>
        {manifest ? <Manifest manifest={manifest} /> : null}
        <div className="classification-action">
          <button
            className="button"
            disabled={
              busy ||
              !snapshot.gatewayConfigured ||
              snapshot.privacy.mode !== "selective_cloud" ||
              !snapshot.privacy.jevEnabled ||
              !snapshot.privacy.shareCourseText
            }
            onClick={() => void run({ type: "enrich", id: resource.id })}
          >
            Classify with Jev
          </button>
          <p className="small muted">
            {!snapshot.gatewayConfigured
              ? "The shared Jev gateway is not configured."
              : snapshot.privacy.mode !== "selective_cloud" ||
                  !snapshot.privacy.jevEnabled ||
                  !snapshot.privacy.shareCourseText
                ? "Enable Jev and course text sharing in Data & AI to send this context."
                : "Sends the permitted context to TypeSafe through the shared gateway."}
          </p>
        </div>
      </section>
    </section>
  );
}

function Manifest({ manifest }: { manifest: ContextManifest }) {
  return (
    <div className="manifest">
      <div className="manifest-status">
        <strong>
          {manifest.allowed
            ? "Allowed by your settings"
            : "Blocked by your settings"}
        </strong>
        <span>{manifest.characters.toLocaleString()} characters</span>
      </div>
      <p className="small">{manifest.reason}</p>
      <dl className="manifest-facts">
        <div>
          <dt>Recipient</dt>
          <dd>{recipientLabels[manifest.recipient]}</dd>
        </div>
        <div>
          <dt>Purpose</dt>
          <dd>{manifest.purpose}</dd>
        </div>
        <div>
          <dt>Categories</dt>
          <dd>{manifest.categories.join(", ") || "None"}</dd>
        </div>
      </dl>
      <details>
        <summary>Exact prepared payload</summary>
        <pre>{JSON.stringify(manifest.payload, null, 2)}</pre>
      </details>
    </div>
  );
}

function OutlookCalendar({
  busy,
  onSync,
}: {
  busy: boolean;
  onSync: () => unknown;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [link, setLink] = useState("");
  const [status, setStatus] = useState("");
  const available = Boolean(window.magic?.setOutlookCalendar);
  useEffect(() => {
    void window.magic?.outlookCalendarStatus?.().then((s) => setConnected(s.connected));
  }, []);
  const save = async (value: string | null) => {
    setStatus("");
    try {
      const result = await window.magic.setOutlookCalendar!(value);
      setConnected(result.connected);
      setLink("");
      setStatus(result.connected ? "Saved. Refreshing your calendar…" : "Outlook calendar disconnected.");
      await onSync();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "The link could not be saved.");
    }
  };
  return (
    <section className="settings-section">
      <div className="section-heading">
        <div>
          <h2>Outlook calendar</h2>
          <p>
            Adds your meetings and appointments, including Microsoft Teams
            meetings, to Today. In Outlook on the web: Settings → Calendar →
            Shared calendars → Publish a calendar, choose “Can view titles and
            locations,” then paste the ICS link here. Anyone with that link can
            see those titles and locations, so it is stored encrypted on this
            device and never shared. Published calendars don’t include Teams
            join links; open the meeting in Outlook or Teams to join.
          </p>
        </div>
      </div>
      {!available ? (
        <p className="small muted">Available in the desktop app.</p>
      ) : connected ? (
        <div className="inline-actions">
          <span className="small">Connected</span>
          <button className="subtle-button" disabled={busy} onClick={() => void save(null)}>
            Disconnect
          </button>
        </div>
      ) : (
        <form
          className="inline-actions"
          onSubmit={(event) => {
            event.preventDefault();
            void save(link);
          }}
        >
          <input
            className="text-input"
            aria-label="Published Outlook calendar ICS link"
            placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="button" type="submit" disabled={busy || !link.trim()}>
            Connect
          </button>
        </form>
      )}
      {status ? (
        <p className="small muted" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function Sources({
  snapshot,
  run,
  busy,
  canSignIn,
  canSync,
  canSignOut,
  onSignIn,
  onSync,
  onSignOut,
  onImport,
  onSample,
}: {
  snapshot: Snapshot;
  run: Run;
  busy: boolean;
  canSignIn: boolean;
  canSync: boolean;
  canSignOut: boolean;
  onSignIn: () => unknown;
  onSync: () => unknown;
  onSignOut: () => unknown;
  onImport: () => unknown;
  onSample: () => unknown;
}) {
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Local evidence</p>
          <h1>Sources</h1>
        </div>
        <button className="button" disabled={busy} onClick={onImport}>
          Import capture
        </button>
      </div>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <h2>UW Canvas</h2>
            <p>
              Sign in in the app’s browser. The session stays on this device.
              Reading content may mark it viewed or satisfy a “must view”
              requirement in Canvas. My Magic UW does not submit work, post,
              enroll, or send explicit completion commands.
            </p>
          </div>
        </div>
        <div className="inline-actions">
          {canSignIn ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={onSignIn}
            >
              Sign in to UW
            </button>
          ) : null}
          {canSync ? (
            <button className="button" disabled={busy} onClick={onSync}>
              Refresh Canvas
            </button>
          ) : null}
          {canSignOut ? (
            <button
              className="subtle-button"
              disabled={busy}
              onClick={onSignOut}
            >
              Clear UW session
            </button>
          ) : null}
        </div>
        {/* owner: T05c. Keep me signed in toggle. */}
        <KeepSignedInToggle busy={busy} />
        {/* end owner: T05c */}
        {/* owner: T05e. Remember my sign-in: Forget my sign-in. */}
        <RememberSignIn busy={busy} />
        {/* end owner: T05e */}
        <p className="small muted">
          If UW requests Duo or a new sign-in, complete it in the browser.
          Previously captured records remain available when a session expires.
          Clearing the UW session also disconnects a published Outlook calendar
          and deletes a saved sign-in.
        </p>
      </section>
      <OutlookCalendar busy={busy} onSync={onSync} />
      <IngestionControls snapshot={snapshot} busy={busy} run={run} />
      <section className="settings-section">
        <h2>Captured sources</h2>
        <CourseSpaceDetails sources={snapshot.sources} revision={snapshot.sources.map(s => s.lastAttemptAt).join("|")} />
        <p className="muted">
          A successful check describes that capture. It does not guarantee that
          the source is still unchanged.
        </p>
        {snapshot.sources.length === 0 ? (
          <div className="empty-source">
            <p>No sources captured yet.</p>
            <button
              className="subtle-button"
              disabled={busy}
              onClick={onSample}
            >
              Load sample course
            </button>
            <span className="small muted">Synthetic data only</span>
          </div>
        ) : (
          <div className="source-list">
            {snapshot.sources.map((source) => (
              <article className="source-row" key={source.id}>
                <div className="source-title">
                  <h3>{source.label}</h3>
                  <span
                    className={`badge ${source.status !== "ok" ? "attention-badge" : ""}`}
                  >
                    {statusLabels[source.status]}
                  </span>
                  {source.kind === "fixture" ? (
                    <span className="badge">Synthetic</span>
                  ) : null}
                </div>
                <dl className="source-facts">
                  <div>
                    <dt>Last attempt</dt>
                    <dd>{formatDate(source.lastAttemptAt, true)}</dd>
                  </div>
                  <div>
                    <dt>Last successful capture</dt>
                    <dd>{formatDate(source.lastSuccessAt, true)}</dd>
                  </div>
                  <div>
                    <dt>Coverage</dt>
                    <dd>
                      {source.complete
                        ? "Complete for this scope"
                        : "Incomplete"}{" "}
                      · {source.resourceCount} records
                    </dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{source.scope}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>Background processing</h2>
        <p className="muted">
          Changes are processed locally. Hosted judgments require your data
          settings to allow them.
        </p>
        <div className="job-summary">
          {(["pending", "running", "done", "failed"] as const).map((status) => (
            <div key={status}>
              <strong>
                {snapshot.jobs.filter((job) => job.status === status).length}
              </strong>
              <span>
                {status === "done"
                  ? "Finished"
                  : status[0].toUpperCase() + status.slice(1)}
              </span>
            </div>
          ))}
        </div>
        {snapshot.jobs.some((job) => job.status === "failed") ? (
          <p className="small attention-text">
            Some processing failed. Your original captures remain available.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Privacy({
  snapshot,
  busy,
  run,
  open,
  onConsent,
  onSources,
}: {
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
  open: (url: string) => void;
  onConsent: (pending?: PrivacyPreferences | null) => void;
  onSources: () => void;
}) {
  const [deleteText, setDeleteText] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const value = snapshot.privacy;
  const jumpTo = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault();
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: "start" });
    section?.querySelector("h2")?.focus({ preventScroll: true });
  };
  // owner: T06: a change that would start sharing with a recipient lacking an agreement
  // opens that agreement first; it is saved only after the student agrees.
  const update = (patch: Partial<PrivacyPreferences>) => {
    const next = { ...value, ...patch };
    if (missingConsents(next, snapshot.consents).length)
      return onConsent(next);
    return run({ type: "privacy", value: next }, "Data settings saved.");
  };
  // end owner: T06
  const erase = async () => {
    if (deleteText !== "DELETE LOCAL DATA") return;
    const result = await run(
      { type: "purge", confirmation: "DELETE LOCAL DATA" },
      "Local coursework and activity deleted.",
    );
    if (result) {
      setDeleteText("");
      setShowDelete(false);
    }
  };
  return (
    <div className="settings-page privacy-page">
      <header className="privacy-intro">
        <p className="eyebrow">Your information</p>
        <h1>Data & AI</h1>
        <p className="privacy-intro-copy">Coursework and activity are saved on this device. You choose what context AI tools can use or receive. School and calendar connections are managed separately.</p>
        <nav className="privacy-jump-links" aria-label="Data and AI sections">
          <a className="magic-fb-pill" href="#privacy-cloud" onClick={(event) => jumpTo(event, "privacy-cloud")}>Cloud access</a>
          <a className="magic-fb-pill" href="#privacy-information" onClick={(event) => jumpTo(event, "privacy-information")}>Information</a>
          <a className="magic-fb-pill" href="#privacy-tools" onClick={(event) => jumpTo(event, "privacy-tools")}>AI tools</a>
          <a className="magic-fb-pill" href="#privacy-activity" onClick={(event) => jumpTo(event, "privacy-activity")}>Activity and deletion</a>
        </nav>
        <p className="privacy-save-note" role="status" aria-live="polite">{value.mode === "local_only" ? "Cloud AI sharing is off." : "Selective cloud access is on."}</p>
      </header>
      <section className="settings-section" id="privacy-cloud">
        <h2 tabIndex={-1}>Cloud access</h2>
        <p>Choose whether AI context can leave this device. School and calendar connections are managed separately.</p>
        <div className="privacy-source-action"><button type="button" className="magic-fb-pill" data-focus-key="privacy-connected-sources" onClick={onSources}>Connected sources</button></div>
        <fieldset className="mode-choices" disabled={busy}>
          <legend className="visually-hidden">Cloud access choice</legend>
          <label
            className={
              value.mode === "local_only"
                ? "mode-choice selected-mode"
                : "mode-choice"
            }
          >
            <input
              type="radio"
              name="cloud-mode"
              data-focus-key="privacy-mode-local"
              checked={value.mode === "local_only"}
              onChange={() => void update({ mode: "local_only" })}
            />
            <span>
              <strong>Keep AI context local</strong>
              <span>
                Block context from being sent to all hosted AI, including Jev.
              </span>
            </span>
          </label>
          <label
            className={
              value.mode === "selective_cloud"
                ? "mode-choice selected-mode"
                : "mode-choice"
            }
          >
            <input
              type="radio"
              name="cloud-mode"
              data-focus-key="privacy-mode-selective"
              checked={value.mode === "selective_cloud"}
              onChange={() => void update({ mode: "selective_cloud" })}
            />
            <span>
              <strong>Choose what can be shared</strong>
              <span>
                Allow only the services and categories you turn on below.
              </span>
            </span>
          </label>
        </fieldset>
        <p className="small muted">
          Local data settings control AI sharing. Refreshing Canvas still
          contacts UW, and opening an original source contacts that website.
        </p>
        <details className="privacy-local-details"><summary>What stays on this device</summary><p>Course records, source history, completion state, and practice records are stored locally. UW sign-in sessions stay in the app’s local browser. Degree audits, holds, course history, and planning records also stay local; this build does not send them to hosted AI or expose them through coursework MCP connections.</p></details>
        {/* owner: T06 */}
        <button className="subtle-button" data-focus-key="privacy-agreements" disabled={busy} onClick={() => onConsent(null)}>
          Review agreements
        </button>
      </section>
      <section className="settings-section" id="privacy-information">
        <h2 tabIndex={-1}>Information AI can use</h2>
        <p>These permissions apply to future AI requests. Turn them off at any time.</p>
        <SettingToggle
          label="Course text"
          focusKey="privacy-course-text"
          description="Relevant course name, item title, instructions, and policy evidence. Preview the exact selection from an item before sending."
          checked={value.shareCourseText}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareCourseText: checked })}
        />
        <SettingToggle
          label="Your work"
          focusKey="privacy-student-work"
          description="Allow student-authored material, including connected GitLab content, when a feature or MCP connection requests it."
          checked={value.shareStudentWork}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareStudentWork: checked })}
        />
        <SettingToggle
          label="Grades"
          focusKey="privacy-grades"
          description="Scores and grading status. Stored locally; sharing is off by default."
          checked={!!value.shareGrades}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareGrades: checked })}
        />
        <SettingToggle
          label="Grader comments"
          focusKey="privacy-comments"
          description="Feedback that can help explain mistakes. Keeping comments locally does not enable cloud sharing."
          checked={!!value.shareComments}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareComments: checked })}
        />
        <SettingToggle
          label="Course communications"
          focusKey="privacy-communications"
          description="Selected announcements and messages, and the subject and Outlook preview of email. With Jev on, these help sort Notifications; the sender is described only by role, such as advisor. These may contain personal information."
          checked={!!value.shareCommunications}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareCommunications: checked })}
        />
        <p className="small muted">
          UW sign-in credentials, login cookies, and the shared Jev key are not
          part of model context. Turning off access prevents future sends; it
          cannot recall data already sent.
        </p>
      </section>
      <section className="settings-section" id="privacy-tools" data-place-anchor="privacy-models">
        <h2 tabIndex={-1}>AI tools</h2>
        <p>Select which tools may use the information you allowed above.</p>
        <SettingToggle
          focusKey="privacy-jev"
          label="Jev judgments"
          description="Classifies course material with TypeSafe, and can raise new announcements and email in Notifications when Course communications is also on. Permitted context goes to TypeSafe directly from this app, which contains our shared key, or through our gateway when one is set up. We pay for usage."
          checked={value.jevEnabled}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ jevEnabled: checked })}
        />
        <p className="setting-note">
          {snapshot.gatewayConfigured
            ? "Jev is available in this build."
            : "Jev isn't set up in this build; code rules still sort Notifications."}
        </p>
        <div className="provider-setting">
          <label className="field-label" htmlFor="provider">
            Preferred AI
          </label>
          <select
            id="provider"
            data-focus-key="privacy-provider"
            disabled={busy || value.mode === "local_only"}
            value={value.hostedProvider}
            onChange={(event) =>
              void update({
                hostedProvider: event.target
                  .value as PrivacyPreferences["hostedProvider"],
              })
            }
          >
            <option value="none">Local model</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>{/* owner: client-detection: the client a student can pick in onboarding */}
            <option value="gemini">Gemini</option>
          </select>
          <p className="small muted">
            This is a data preference, not an account connection. Hosted account
            handoff and automatic model installation are not available in this
            build. Installed local models can be used below.
          </p>
        </div>
      </section>
      <LocalAiPanel privacyKey={JSON.stringify(value)} />
      <ProviderGuidance open={open} disabled={busy} />
      <McpConnections snapshot={snapshot} busy={busy} run={run} />
      <section className="settings-section" id="privacy-activity">
        <h2 tabIndex={-1}>AI sharing activity</h2>
        <p className="muted">
          Receipts record the destination and amount of context, without storing
          a second copy of the sent text.
        </p>
        {snapshot.receipts.length ? (
          <ul className="receipt-list">
            {snapshot.receipts
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, 30)
              .map((receipt) => (
                <li key={receipt.id}>
                  <div>
                    <strong>
                      {recipientLabels[receipt.recipient as Recipient] ??
                        receipt.recipient}
                    </strong>
                    <span className="badge">
                      {receipt.status === "sent"
                        ? "Send attempted"
                        : receipt.status}
                    </span>
                  </div>
                  <p>{receipt.purpose}</p>
                  <span className="small muted">
                    {formatDate(receipt.createdAt, true)} ·{" "}
                    {receipt.characters.toLocaleString()} characters ·{" "}
                    {receipt.categories.join(", ") || "No categories"}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <div className="no-activity">No recorded AI data activity.</div>
        )}
      </section>
      <AccountSection /> {/* owner: accounts */}
      <section className="settings-section danger-section">
        <h2>Delete local data</h2>
        <p>
          Remove saved coursework, source history, judgments, links, and
          learning activity from this workspace. This does not delete anything
          from UW or from a hosted provider.
        </p>
        {!showDelete ? (
          <button
            className="button danger-button"
            disabled={busy}
            onClick={() => setShowDelete(true)}
          >
            Delete local data…
          </button>
        ) : (
          <div className="delete-confirm">
            <label className="field-label" htmlFor="delete-confirm">
              Type DELETE LOCAL DATA to confirm
            </label>
            <input
              id="delete-confirm"
              autoComplete="off"
              spellCheck={false}
              value={deleteText}
              onChange={(event) => setDeleteText(event.target.value)}
            />
            <div className="inline-actions">
              <button
                className="button danger-button"
                disabled={busy || deleteText !== "DELETE LOCAL DATA"}
                onClick={() => void erase()}
              >
                Permanently delete
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  setShowDelete(false);
                  setDeleteText("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <p className="small muted">
          Deleting local data also clears app-owned UW sessions, a saved sign-in,
          calendar feed secrets, downloaded documents, and exported MCP connections. It does
          not delete UW records.
        </p>
      </section>
      <p className="small muted settings-affiliation">
        My Magic UW is an independent student project. It is not affiliated with, sponsored by or endorsed by the University of Wisconsin–Madison.
      </p>
    </div>
  );
}

// owner: T05c. "Keep me signed in" (P1-D1, on by default). Main owns the setting; the
// toggle hides where the bridge has no keepSignedIn (the browser preview).
function KeepSignedInToggle({ busy }: { busy: boolean }) {
  const bridge = window.magic;
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    bridge.keepSignedIn?.()
      .then((current) => {
        if (live) setValue(current);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bridge]);
  if (!bridge.keepSignedIn || value === null) return null;
  return (
    <SettingToggle
      label="Keep me signed in"
      description="Closing the window keeps My Magic UW running, and it starts with your computer, so your UW session stays open. Quit or Sign out ends the session."
      checked={value}
      disabled={busy || saving}
      onChange={(next) => {
        setSaving(true);
        bridge.keepSignedIn!(next)
          .then(setValue)
          .catch(() => {})
          .finally(() => setSaving(false));
      }}
    />
  );
}
// end owner: T05c

function SettingToggle({
  focusKey,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  focusKey?: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`setting-toggle ${disabled ? "disabled-setting" : ""}`}>
      <span>
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        data-focus-key={focusKey}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

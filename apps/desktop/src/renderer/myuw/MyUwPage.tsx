import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuditNode, Command, CommandResult, PlanningComparison, Snapshot, StoredPlanningRecord } from "@magic/contracts";
import { decodeUwTerm } from "../../../../../packages/domain/src/planning";
import { planningPolicies } from "../../../../../packages/domain/src/planning-policy";
import { Action, Disclosure } from "../../../../../packages/ui/src";
import { Icon, type IconName } from "./Icon";
import { GpaSection } from "./Gpa"; // owner: gpa
import { myUwMemory, type PlanStyle } from "./memory";
import type { RefreshProgress } from "./refresh-flow";
import { RefreshStep } from "./RefreshStep";
import {
  attentionDomId, courseDomId, offeringsLoaded, offeringsToLoad, projectMyUw, recordNeedsVerification, refreshOutcome, requirementDomId, requirementToneLabel,
  type AttentionItem, type AuditView, type BriefPart, type MyUwModel, type RequirementView, type Service, type SourceSummary,
} from "./model";
import "./myuw.css";

// owner: My UW lane. Normal entry: sidebar My UW. The student sees where they stand from saved UW
// evidence, what needs attention, what remains in the audit, and next-term options. Every school
// change happens in UW's own tools; this page only reads, compares and links to the source.

export type MyUwProps = {
  snapshot: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
  open: (url: string) => void;
  signIn: (service: Service) => void;
  /** Reads the planning sources, opening the app's UW window when a read needs sign-in (refresh-flow). */
  refresh: (before: Record<string, string>, progress: (update: RefreshProgress) => void) => Promise<CommandResult | undefined>;
};
type ObjectRef = Extract<BriefPart, { target: string }>;
type Target = ObjectRef["target"];
const UW = { myuw: "https://my.wisc.edu/", enroll: "https://enroll.wisc.edu/", dars: "https://enroll.wisc.edu/dars" };
const stamp = (value: string | null, withTime = true) => value
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) })
  : "Not checked";
const termLabel = (code: string) => { try { return decodeUwTerm(code).label; } catch { return code; } };
const styles: { value: PlanStyle; label: string }[] = [
  { value: "balanced", label: "Balanced days" }, { value: "mornings", label: "Mornings only" },
  { value: "compact", label: "Compact days" }, { value: "lighter", label: "Fewer credits per course" },
];
const sourceStateLabel: Record<SourceSummary["state"], string> = {
  current: "Current", partial: "Partly read", stale: "Needs refresh", failed: "Couldn’t refresh", blocked: "Blocked", unsupported: "Not supported yet",
};

/** Scroll only the workspace pane; scrollIntoView would also shift the fixed desktop frame. */
function scrollTo(element: HTMLElement, place: "start" | "center") {
  const pane = element.closest<HTMLElement>(".desktop-workspace");
  if (!pane) return;
  const offset = element.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  pane.scrollTo({ top: pane.scrollTop + offset - (place === "center" ? Math.max(24, (pane.clientHeight - element.offsetHeight) / 2) : 24), behavior: reduce ? "auto" : "smooth" });
}
function go(target: Target) {
  const section = document.getElementById(`myuw-${target}`);
  if (!section) return;
  if (target === "sources") section.querySelector("details")?.setAttribute("open", "");
  scrollTo(section, "start");
  section.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
}
/** Scroll to one named object and move focus there so Tab continues from it. */
function reach(id: string) {
  const element = document.getElementById(id);
  if (!element) return false;
  scrollTo(element, "center");
  element.focus({ preventScroll: true });
  return true;
}
function Source({ url, label = "Source", open }: { url: string; label?: string; open: MyUwProps["open"] }) {
  return <button type="button" className="myuw-link" onClick={() => open(url)}>{label}<Icon name="external" /></button>;
}
function Checked({ record, snapshot, open, now }: { record: StoredPlanningRecord; snapshot: Snapshot; open: MyUwProps["open"]; now: number }) {
  const stale = recordNeedsVerification(record, snapshot.planning?.sources ?? [], now);
  return <p className="myuw-meta">
    <Source url={record.provenance.sourceUrl} open={open} />
    <span>{stale ? `Saved ${stamp(record.provenance.observedAt)} · needs refresh to confirm` : `Checked ${stamp(record.provenance.observedAt)}`}</span>
  </p>;
}
function Tile({ tone, icon = "arrow", children, onClick, disabled }: { tone: "blue" | "rose" | "coral" | "amber"; icon?: IconName; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className={`myuw-tile myuw-tile--${tone}`} onClick={onClick} disabled={disabled}><span>{children}</span><Icon name={icon} /></button>;
}

export function MyUwPage({ snapshot, busy, run, open, signIn, refresh }: MyUwProps) {
  const model = useMemo(() => projectMyUw(snapshot), [snapshot]);
  const root = useRef<HTMLDivElement>(null);
  const [termChoice, setTerm] = useState(myUwMemory.term);
  const [style, setStyle] = useState<PlanStyle>(myUwMemory.style);
  const [subject, setSubject] = useState(myUwMemory.subject);
  const [comparison, setComparison] = useState(myUwMemory.comparison);
  const [openRequirements, setOpenRequirements] = useState(() => new Set(myUwMemory.openRequirements));
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<{ pending: boolean; outcome: ReturnType<typeof refreshOutcome> | null; unconfirmed: boolean; progress: RefreshProgress | null } | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const termCode = model.terms.some((term) => term.code === termChoice) ? termChoice : model.defaultPlanTerm;
  const sources = snapshot.planning?.sources ?? [];
  const input = JSON.stringify([termCode, style, sources.map((source) => [source.id, source.observedAt])]);
  const current = comparison?.input === input ? comparison.value : null;

  // Keep choices, expanded requirements and position for Back or a return from sign-in/consent.
  useEffect(() => { Object.assign(myUwMemory, { term: termChoice, style, subject, comparison, openRequirements: [...openRequirements] }); }, [termChoice, style, subject, comparison, openRequirements]);
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>(".desktop-workspace");
    if (scroller && myUwMemory.scrollTop) scroller.scrollTop = myUwMemory.scrollTop;
    const focusId = myUwMemory.focusId;
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    return () => {
      myUwMemory.scrollTop = scroller?.scrollTop ?? 0;
      const active = document.activeElement;
      myUwMemory.focusId = active instanceof HTMLElement && root.current?.contains(active) && active.id ? active.id : null;
    };
  }, []);
  async function act(key: string, command: Command, onResult?: (result: CommandResult) => void) {
    if (operation.current || busy) return;
    operation.current = true;
    setPending(key); setFailure(null);
    try {
      const result = await run(command);
      if (!mounted.current) return;
      if (!result) { setFailure(key); return; }
      onResult?.(result);
    } catch {
      if (mounted.current) setFailure(key);
    } finally {
      operation.current = false;
      if (mounted.current) setPending(null);
    }
  }
  const compare = () => {
    const request = input;
    void act("compare", { type: "planning-compare", termCode, style }, (result) => {
      if (result.planningComparison) setComparison({ input: request, value: result.planningComparison });
      else setFailure("compare");
    });
  };
  const loadOfferings = (code: string) => void act(`offerings:${code}`, { type: "planning-search", subjectCode: code, termCode, page: 1 });
  const startRefresh = async () => {
    if (operation.current || busy) return;
    operation.current = true;
    const before = Object.fromEntries(model.sources.map((source) => [source.id, source.observedAt]));
    let last: RefreshProgress | null = null;
    setRefreshing({ pending: true, outcome: null, unconfirmed: false, progress: null });
    const progress = (update: RefreshProgress) => {
      last = update;
      if (mounted.current) setRefreshing((previous) => previous && { ...previous, progress: update });
    };
    try {
      const result = await refresh(before, progress);
      if (mounted.current) setRefreshing({ pending: false, outcome: result ? refreshOutcome(before, projectMyUw(result.snapshot).sources) : null, unconfirmed: !result, progress: last });
    } catch {
      if (mounted.current) setRefreshing({ pending: false, outcome: null, unconfirmed: true, progress: last });
    } finally {
      operation.current = false;
    }
  };
  const toggleRequirement = (id: string, isOpen: boolean) => setOpenRequirements((previous) => {
    if (previous.has(id) === isOpen) return previous;
    const next = new Set(previous); if (isOpen) next.add(id); else next.delete(id); return next;
  });
  // A requirement named in the briefing opens in place; a named hold goes to its detailed row.
  const reveal = (part: ObjectRef) => {
    if (part.target === "degree" && part.ref) {
      const ref = part.ref;
      toggleRequirement(ref, true);
      requestAnimationFrame(() => { if (!reach(requirementDomId(ref))) go("degree"); });
    } else if (!(part.ref && reach(part.target === "term" ? courseDomId(part.ref) : attentionDomId(part.ref)))) go(part.target);
  };
  const canSignIn = Boolean(window.magic.signInUW);
  const outcome = refreshing?.outcome;
  // A failed first attempt creates source rows too. Historical success distinguishes setup
  // from returning-session recovery; the latter belongs to the shell notification.
  const establishedEnroll = sources.some((source) => (source.source === "uw_enroll" || source.source === "uw_dars") && (source.lastSuccessAt || (source.status === "complete" && source.completeness === "complete")));
  const hasAcademicRecords = Boolean(model.summary || model.audits.length || model.thisTerm || model.history.length || model.attention.length || model.advisors.length);
  const firstConnection = model.state !== "multiple_accounts" && !establishedEnroll && !hasAcademicRecords;
  const problems = model.privateSources.filter((source) => source.state !== "current");

  return <div className={`myuw-page${firstConnection ? " myuw-page--connect" : ""}`} ref={root}>
    <div className="myuw-main">
      {snapshot.planning?.unreadable ? <p role="status" className="myuw-outcome">Some saved planning records cannot be opened on this device. Refresh planning to read them again; this view is incomplete until then.</p> : null}
      {firstConnection ? <ConnectionEntry busy={busy} canSignIn={canSignIn} signIn={signIn} />
        : <Briefing model={model} establishedEnroll={establishedEnroll} busy={busy} canSignIn={canSignIn} signIn={signIn} reveal={reveal} />}
      {!firstConnection || model.checkedAt ? <div className="myuw-status" role="status">
        {model.checkedAt ? <span>{problems.length ? `Checked ${stamp(model.checkedAt)} · ${problems.length} ${problems.length === 1 ? "source needs" : "sources need"} attention` : `Checked ${stamp(model.checkedAt)}`}</span> : <span>Nothing checked from UW yet</span>}
        {window.magic.syncPlanning && model.state !== "not_connected" ? <Action id="myuw-refresh" tone="quiet" disabled={busy} pending={refreshing?.pending} onClick={() => void startRefresh()}><Icon name="refresh" />{refreshing?.pending ? "Refreshing" : "Refresh"}</Action> : null}
        {problems.length ? <button type="button" className="myuw-quiet" onClick={() => go("sources")}>See sources</button> : null}
        <RefreshStep step={refreshing?.progress ?? null} pending={Boolean(refreshing?.pending)} canSignIn={canSignIn} show={(service) => void window.magic.signInUW?.(service).catch(() => {})} />
        {outcome ? <span className="myuw-outcome">{outcome.checked === 0 ? "Refresh finished without new UW information. Saved records are unchanged." : `${outcome.current} of ${outcome.checked} sources updated${outcome.problems.length ? `; ${outcome.problems.map((source) => `${source.label} ${sourceStateLabel[source.state].toLowerCase()}`).join(", ")}` : ""}.`}</span> : null}
        {refreshing?.unconfirmed ? <span className="myuw-outcome">The refresh didn’t finish. Your saved records remain available; try again.</span> : null}
      </div> : null}

      {model.attention.length ? <section className="myuw-section" id="myuw-attention" aria-labelledby="myuw-attention-title">
        <h2 id="myuw-attention-title" tabIndex={-1}>Needs attention</h2>
        <div className="myuw-attention">{model.attention.map((item) => <Attention key={item.key} item={item} open={open} />)}</div>
      </section> : null}

      {!firstConnection ? <section className="myuw-section" id="myuw-degree" aria-labelledby="myuw-degree-title">
        <div className="myuw-section-head"><h2 id="myuw-degree-title" tabIndex={-1}>Degree progress</h2>{model.audits.length ? <Source url={model.audits[0].record.provenance.sourceUrl} label="Degree audit" open={open} /> : null}</div>
        {!model.audits.length ? <p className="myuw-lead">{model.state === "not_connected"
          ? "After you connect Course Search & Enroll, your saved degree audits appear here with what remains. Catalog descriptions alone can’t show degree progress."
          : "No saved degree audit was found. Run an audit in UW’s degree audit tool, then refresh here to see what remains."}
          {model.state !== "not_connected" ? <> <Source url={UW.dars} label="Open degree audit" open={open} /></> : null}</p>
          : model.audits.map((audit) => <Audit key={audit.record.localId} audit={audit} model={model} termCode={termCode} busy={busy} pending={pending}
            openIds={openRequirements} onToggle={toggleRequirement} onLoad={loadOfferings} open={open} snapshot={snapshot} />)}
      </section> : null}

      {!firstConnection ? <section className="myuw-section" id="myuw-plan" aria-labelledby="myuw-plan-title">
        <div className="myuw-section-head"><h2 id="myuw-plan-title" tabIndex={-1}>Plan next term</h2><Source url={UW.enroll} label="Course Search & Enroll" open={open} /></div>
        <p className="myuw-lead">Courses that may count toward an open requirement, each checked on its own against your saved schedule. You choose and enroll in Course Search & Enroll.</p>
        {model.state === "not_connected" ? <p className="myuw-note">Comparing needs your degree audit and current enrollment, so it starts after you sign in to Course Search & Enroll.</p> : <Planner model={model} termCode={termCode} style={style} busy={busy} pending={pending} failure={failure}
          setTerm={setTerm} setStyle={setStyle} compare={compare} loadOfferings={loadOfferings} comparison={comparison} current={current} open={open} />}
      </section> : null}

      {!firstConnection ? <GpaSection model={model} /> : null /* owner: gpa */}
      <section className="myuw-section myuw-more" aria-label="Records and sources">
        {model.history.length ? <Disclosure label={`Course history · ${model.history.length} source records`}>
          <p className="myuw-note">Completed, in-progress, planned and dropped records stay separate. Overlapping sources may describe the same attempt; this list isn’t a transcript or a credit total.</p>
          {model.history.slice().sort((a, b) => (b.termCode || "").localeCompare(a.termCode || "")).map((course) => <article className="myuw-row" key={course.localId}>
            <strong title={course.courseKey}>{model.courseLabel(course.courseKey)}</strong>
            <p>{course.termCode ? termLabel(course.termCode) : "Term unknown"} · {course.state.replaceAll("_", " ")}{course.grade ? ` · ${course.grade}` : ""}{course.credits !== null ? ` · ${course.credits} credits` : ""}</p>
            <Checked record={course} snapshot={snapshot} open={open} now={model.now} />
          </article>)}
        </Disclosure> : null}
        {!firstConnection && model.state !== "not_connected" ? <Reconciliation snapshot={snapshot} model={model} open={open} /> : null}
        {model.subjects.length ? <Disclosure label="Browse the course catalog">
          <p className="myuw-note">Public Guide descriptions. Term availability, seats and eligibility need their own records.</p>
          <div className="myuw-controls">
            <label>Subject<select value={subject} onChange={(event) => setSubject(event.target.value)} disabled={busy}><option value="">Choose a subject</option>{model.subjects.map((row) => <option key={row.localId} value={row.code}>{row.shortName} · {row.formalName}</option>)}</select></label>
            <button type="button" className="myuw-button" disabled={busy || !subject} onClick={() => void act("guide", { type: "planning-guide", subjectCode: subject })}>Load descriptions</button>
            <button type="button" className="myuw-button" disabled={busy || !subject || !termCode} onClick={() => loadOfferings(subject)}>Load {termCode ? termLabel(termCode) : "term"} offerings</button>
          </div>
          {failure === "guide" ? <p className="myuw-error" role="alert">Descriptions didn’t load. Your subject choice is kept; try again.</p> : null}
          {model.catalog.length ? <Disclosure label={`${model.catalog.length} saved course descriptions`}>{model.catalog.map((course) => <article key={course.localId} className="myuw-row">
            <strong title={course.courseKey}>{course.title || model.courseCode(course.courseKey)}</strong>
            <p className="myuw-note">{model.courseCode(course.courseKey)}{course.termCode ? ` · ${termLabel(course.termCode)}` : " · Guide"}</p>
            <p>{course.description}</p><p className="myuw-note">Requisites: {course.prerequisiteText ?? "Not found"}</p>
            {course.id.startsWith("course:") && course.termCode ? <button type="button" className="myuw-button" disabled={busy} onClick={() => void act(`sections:${course.localId}`, { type: "planning-sections", recordId: course.localId })}>Load section options · {termLabel(course.termCode)}</button> : null}
            <Checked record={course} snapshot={snapshot} open={open} now={model.now} />
          </article>)}</Disclosure> : null}
        </Disclosure> : null}
        <Disclosure label="UW planning rules">{planningPolicies.map((policy) => <article className="myuw-row" key={policy.id}>
          <strong>{policy.title}</strong><p>{policy.text}</p><p className="myuw-note">{policy.scope} · Reviewed {policy.checkedAt}</p>
          <Source url={policy.sourceUrl} label="Read the official policy" open={open} />
        </article>)}</Disclosure>
        <div id="myuw-sources"><h2 tabIndex={-1} className="myuw-visually-hidden">Sources</h2>
          {model.sources.length ? <Disclosure label={`Planning sources · ${model.sources.length}${problems.length ? ` · ${problems.length} need attention` : ""}`}>
            {model.sources.slice().sort((a, b) => Number(a.state === "current") - Number(b.state === "current") || Number(b.privateSource) - Number(a.privateSource)).map((source) => <article className="myuw-row" key={source.id}>
              <strong>{source.label}</strong>
              <p><span className={`myuw-tag myuw-tag--${source.state === "current" ? "met" : source.state === "partial" || source.state === "stale" ? "progress" : "open"}`}>{sourceStateLabel[source.state]}</span> Checked {stamp(source.observedAt)}{source.lastSuccessAt && source.lastSuccessAt !== source.observedAt ? ` · last complete ${stamp(source.lastSuccessAt)}` : ""}</p>
              {source.notes.map((note) => <p className="myuw-note" key={note}>{note}</p>)}
              <div className="myuw-inline">
                <Source url={source.url} label="Open source" open={open} />
              </div>
            </article>)}
          </Disclosure> : null}
        </div>
      </section>
    </div>

    <aside className="myuw-rail" aria-label={firstConnection ? "UW tools" : "This term and contacts"}>
      {!firstConnection ? <section id="myuw-term" aria-labelledby="myuw-term-title">
        <h2 id="myuw-term-title" tabIndex={-1}>{model.thisTerm ? model.thisTerm.label : "This term"}</h2>
        {!model.thisTerm ? <p className="myuw-note">Your current enrollment appears here after Course Search & Enroll is connected.</p> : <>
          {!model.thisTerm.complete ? <p className="myuw-caution"><Icon name="alert" />Saved enrollment may be out of date. Refresh to confirm.</p> : null}
          {!model.thisTerm.courses.length ? <p className="myuw-note">{model.thisTerm.complete ? "No enrolled courses were listed." : "No enrolled courses are saved."}</p> : null}
          {model.thisTerm.courses.map((course) => <article className="myuw-rail-row" key={course.record.localId} id={courseDomId(course.record.localId)} tabIndex={-1}>
            <strong title={course.record.courseKey}>{course.label}</strong>
            {model.catalog.find((row) => row.courseKey === course.record.courseKey)?.title ? <span className="myuw-note">{model.courseLabel(course.record.courseKey)}</span> : null}
            {course.meetings.map((meeting, index) => <span className="myuw-note" key={index}>{meeting}</span>)}
            <span className="myuw-note">Section {course.record.sections.join(", ")}</span>
          </article>)}
        </>}
      </section> : null}
      {model.advisors.length ? <section aria-labelledby="myuw-advisors-title"><h2 id="myuw-advisors-title">Advisors</h2>
        {model.advisors.map((advisor) => <article className="myuw-rail-row" key={advisor.localId}>
          <strong>{advisor.displayName}</strong><span className="myuw-note">{advisor.role}</span>
          {advisor.contactUrl ? <Source url={advisor.contactUrl} label="Contact" open={open} /> : null}
        </article>)}
      </section> : null}
      <section aria-labelledby="myuw-tools-title"><h2 id="myuw-tools-title">UW tools</h2>
        <p className="myuw-note">Open UW’s tools to enroll, manage your record or run a new degree audit.</p>
        <div className="myuw-rail-links">
          <Source url={UW.enroll} label="Course Search & Enroll" open={open} />
          <Source url={UW.myuw} label="Open My UW" open={open} />
          <Source url={UW.dars} label="Degree audit" open={open} />
        </div>
      </section>
    </aside>
  </div>;
}

function ConnectionEntry({ busy, canSignIn, signIn }: Pick<MyUwProps, "busy" | "signIn"> & { canSignIn: boolean }) {
  return <section className="myuw-connect" aria-labelledby="myuw-title">
    <h1 id="myuw-title" tabIndex={-1}>Where you stand</h1>
    <p className="myuw-connect-intro">Bring your UW records together to see what remains in your degree audit and compare courses for next term.</p>
    <div className="myuw-connect-action">
      <Action id="myuw-connect-enroll" disabled={busy || !canSignIn} onClick={() => signIn("enroll")} aria-describedby="myuw-connect-scope">
        <span><span className="myuw-connect-title">Connect Course Search &amp; Enroll</span><span className="myuw-connect-description">Saved degree audits, current enrollment and student records.</span></span>
        <Icon name="arrow" />
      </Action>
    </div>
    {!canSignIn ? <p className="myuw-note">UW sign-in is available in the desktop app.</p> : null}
    <p className="myuw-note" id="myuw-connect-scope">Records are read on this device. You choose and enroll in UW’s own tools.</p>
  </section>;
}

function Briefing({ model, establishedEnroll, busy, canSignIn, signIn, reveal }: { model: MyUwModel; establishedEnroll: boolean; busy: boolean; canSignIn: boolean; signIn: MyUwProps["signIn"]; reveal: (part: ObjectRef) => void }) {
  return <section className="myuw-brief" aria-labelledby="myuw-title">
    <h1 id="myuw-title" tabIndex={-1}>Where you stand</h1>
    <div className="myuw-brief-body">
      <div className="myuw-brief-text">
        {model.state === "multiple_accounts" ? <p>Records from more than one student are saved on this device, so personal planning is hidden to keep them apart. Clear local data in Data & AI before connecting a different student.</p>
          : model.state === "not_connected" ? <>
            <p>Connect Course Search & Enroll to read your saved degree audits, current enrollment and student records.</p>
            <p>My Magic UW reads these records on this device. It never enrolls, drops or submits anything for you.</p>
            {!canSignIn ? <p className="myuw-note">UW sign-in is available in the desktop app.</p> : null}
          </>
            : model.brief.map((line, index) => <p key={index}>{line.map((part, at) => typeof part === "string" ? part
              : "time" in part ? <span key={at} className="myuw-time">{part.time}</span>
                : <button type="button" key={at} className="myuw-object-link" onClick={() => reveal(part)}>{part.text}</button>)}</p>)}
      </div>
      <div className="myuw-brief-actions">
        {canSignIn && model.state !== "multiple_accounts" ? model.signIn.filter((service) => service === "enroll" && !establishedEnroll).map((service) => <Tile key={service} tone="blue" disabled={busy} onClick={() => signIn(service)}>
          {"Connect Course Search & Enroll"}</Tile>) : null}
        {model.state !== "multiple_accounts" && model.state !== "not_connected" && model.defaultPlanTerm ? <Tile tone="amber" onClick={() => go("plan")}>Compare {termLabel(model.defaultPlanTerm)} courses</Tile> : null}
      </div>
    </div>
  </section>;
}

function Attention({ item, open }: { item: AttentionItem; open: MyUwProps["open"] }) {
  const checked = <span>{item.stale ? `Saved ${stamp(item.record.provenance.observedAt)} · may have changed, refresh to confirm` : `Checked ${stamp(item.record.provenance.observedAt)}`}</span>;
  if (item.kind === "hold") return <article className="myuw-alert myuw-alert--hold" id={attentionDomId(item.key)} tabIndex={-1} aria-label={item.record.title}>
    <div><strong>{item.record.title}</strong>{item.record.description ? <p>{item.record.description}</p> : null}
      <p className="myuw-meta"><span className="myuw-tag myuw-tag--on-fill">{item.blocks === true ? "Blocks enrollment" : item.blocks === false ? "Doesn’t block enrollment" : "Enrollment impact unknown"}</span>{checked}</p></div>
    <div className="myuw-alert-actions">
      {item.record.resolutionUrl ? <button type="button" className="myuw-alert-action" onClick={() => open(item.record.resolutionUrl!)}>How to resolve<Icon name="external" /></button>
        : <span className="myuw-note">No resolution link was listed. Open the source for details.</span>}
      <Source url={item.record.provenance.sourceUrl} open={open} />
    </div>
  </article>;
  return <article className="myuw-alert myuw-alert--window" id={attentionDomId(item.key)} tabIndex={-1} aria-label={`${item.termLabel} enrollment window`}>
    <div><strong>{item.open ? `${item.termLabel} enrollment window is open` : `${item.termLabel} enrollment window`}</strong>
      <p>{item.opensAt ? `Opens ${stamp(item.opensAt)}` : "Opening time not listed"}{item.closesAt ? ` · closes ${stamp(item.closesAt)}` : ""}</p>
      <p className="myuw-meta">{checked}</p></div>
    <div className="myuw-alert-actions">
      <button type="button" className="myuw-alert-action" onClick={() => open(UW.enroll)}>Course Search & Enroll<Icon name="external" /></button>
      <Source url={item.record.provenance.sourceUrl} open={open} />
    </div>
  </article>;
}

function Audit({ audit, model, termCode, busy, pending, openIds, onToggle, onLoad, open, snapshot }: {
  audit: AuditView; model: MyUwModel; termCode: string; busy: boolean; pending: string | null; openIds: Set<string>;
  onToggle: (id: string, isOpen: boolean) => void; onLoad: (code: string) => void; open: MyUwProps["open"]; snapshot: Snapshot;
}) {
  const loaded = new Set(offeringsLoaded(model, termCode).map((row) => row.code));
  const counts = ([["open", "open"], ["progress", "in progress"], ["planned", "planned"], ["unknown", "not interpreted"], ["met", "met in audit"]] as const)
    .filter(([tone]) => audit.counts[tone]).map(([tone, label]) => `${audit.counts[tone]} ${label}`);
  return <div className="myuw-audit">
    <div className="myuw-audit-head">
      <h3 title={audit.record.programKey}>{audit.title}</h3>
      <p className="myuw-note">{audit.generatedAt ? `Audit run ${stamp(audit.generatedAt, false)}` : "Audit date not verified"} · {counts.join(" · ") || "No requirements read"}</p>
    </div>
    {audit.coverage !== "complete" || audit.staleReason ? <p className="myuw-caution"><Icon name="alert" />{[audit.coverage !== "complete" ? "Parts of this audit couldn’t be read, so some requirements show as not interpreted." : "",
      audit.staleReason === "old" ? "This audit run is more than a term old. Run a new audit in UW’s tool before relying on it."
        : audit.staleReason === "unconfirmed" ? "The last refresh couldn’t reconfirm this saved audit. Refresh, or check the audit in UW’s tool, before relying on it." : ""].filter(Boolean).join(" ")}</p> : null}
    <ul className="myuw-requirements">{audit.remaining.map((view) => <Requirement key={view.node.nodeId} id={`${audit.record.localId}:${view.node.nodeId}`} view={view} audit={audit} model={model}
      termCode={termCode} loaded={loaded} busy={busy} pending={pending} isOpen={openIds.has(`${audit.record.localId}:${view.node.nodeId}`)} onToggle={onToggle} onLoad={onLoad} />)}</ul>
    {!audit.remaining.length ? <p className="myuw-note">The audit lists no open requirements it could read. That isn’t a graduation check; confirm with your advisor or the official audit.</p> : null}
    {audit.met.length ? <Disclosure label={`${audit.met.length} ${audit.met.length === 1 ? "requirement" : "requirements"} met in this audit`}>
      <ul className="myuw-met">{audit.met.map((view) => <li key={view.node.nodeId}>{view.node.title || "Untitled requirement"}{view.node.appliedCourses.length ? <span className="myuw-note"> · {view.node.appliedCourses.map((course) => course.courseKey ? model.courseCode(course.courseKey) : course.rawCourse).join(", ")}</span> : null}</li>)}</ul>
    </Disclosure> : null}
    <Checked record={audit.record} snapshot={snapshot} open={open} now={model.now} />
  </div>;
}

function Requirement({ id, view, audit, model, termCode, loaded, busy, pending, isOpen, onToggle, onLoad }: {
  id: string; view: RequirementView; audit: AuditView; model: MyUwModel; termCode: string; loaded: Set<string>; busy: boolean; pending: string | null;
  isOpen: boolean; onToggle: (id: string, isOpen: boolean) => void; onLoad: (code: string) => void;
}) {
  const children = audit.record.nodes.filter((node) => node.parentId === view.node.nodeId).sort((a, b) => a.index - b.index);
  const domId = requirementDomId(id);
  return <li className="myuw-requirement">
    <details open={isOpen} onToggle={(event) => onToggle(id, event.currentTarget.open)}>
      <summary id={domId} data-focus-key={domId}>
        <span className="myuw-requirement-title">{view.node.title || "Untitled requirement"}{view.needs ? <span className="myuw-note">{view.needs}</span> : null}</span>
        <span className={`myuw-tag myuw-tag--${view.tone}`}>{view.label}</span>
        <Icon name="chevron" />
      </summary>
      <div className="myuw-requirement-body">
        {view.node.evidence.length ? <div className="myuw-quotes"><p className="myuw-label">From the audit</p>{view.node.evidence.slice(0, 4).map((evidence) => <blockquote key={evidence.blockId}>{evidence.quote}</blockquote>)}</div> : null}
        {children.length ? <ul className="myuw-subrequirements">{children.map((child) => <SubRequirement key={child.nodeId} node={child} />)}</ul> : null}
        {view.node.appliedCourses.length ? <p className="myuw-note">Applied so far: {view.node.appliedCourses.map((course) => `${course.courseKey ? model.courseCode(course.courseKey) : course.rawCourse}${course.termCode ? ` (${termLabel(course.termCode)})` : ""}`).join(", ")}</p> : null}
        {view.optionCount ? <div className="myuw-options">
          <p className="myuw-note">The audit lists {view.optionCount} course {view.optionCount === 1 ? "option" : "options"}{view.subjects.length ? ` in ${view.subjects.slice(0, 4).map((subject) => subject.name).join(", ")}${view.subjects.length > 4 ? ` and ${view.subjects.length - 4} more subjects` : ""}` : ""}.</p>
          {termCode ? <div className="myuw-inline">{view.subjects.slice(0, 3).map((subject) => loaded.has(subject.code)
            ? <span key={subject.code} className="myuw-note">{subject.name} {termLabel(termCode)} offerings saved</span>
            : <button type="button" key={subject.code} className="myuw-button" disabled={busy} aria-busy={pending === `offerings:${subject.code}` || undefined} onClick={() => onLoad(subject.code)}>
              <Icon name="search" />{pending === `offerings:${subject.code}` ? `Loading ${subject.name}…` : `Load ${termLabel(termCode)} ${subject.name} offerings`}</button>)}</div> : null}
        </div> : view.tone !== "met" ? <p className="myuw-note">No course list was read for this requirement. Check the audit for what counts.</p> : null}
      </div>
    </details>
  </li>;
}
function SubRequirement({ node }: { node: AuditNode }) {
  const tone = node.status === "completed" && node.coverage !== "complete" ? "unknown" : ({ incomplete: "open", in_progress: "progress", planned: "planned", completed: "met", unknown: "unknown" } as const)[node.status];
  return <li><span>{node.title || "Untitled part"}{node.needsCourses !== null || node.needsCredits !== null ? <span className="myuw-note"> · {[node.needsCourses !== null ? `${node.needsCourses} ${node.needsCourses === 1 ? "course" : "courses"}` : "", node.needsCredits !== null ? `${node.needsCredits} ${node.needsCredits === 1 ? "credit" : "credits"}` : ""].filter(Boolean).join(", ")} needed</span> : null}</span>
    <span className={`myuw-tag myuw-tag--${tone}`}>{requirementToneLabel(tone)}</span></li>;
}

function Planner({ model, termCode, style, busy, pending, failure, setTerm, setStyle, compare, loadOfferings, comparison, current, open }: {
  model: MyUwModel; termCode: string; style: PlanStyle; busy: boolean; pending: string | null; failure: string | null;
  setTerm: (value: string) => void; setStyle: (value: PlanStyle) => void; compare: () => void; loadOfferings: (code: string) => void;
  comparison: { input: string; value: PlanningComparison } | null; current: PlanningComparison | null; open: MyUwProps["open"];
}) {
  const loaded = termCode ? offeringsLoaded(model, termCode) : [];
  const suggested = offeringsToLoad(model, termCode);
  const blocked = model.state === "multiple_accounts";
  const [focusFirst, setFocusFirst] = useState(false);
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusFirst && current) { results.current?.focus({ preventScroll: false }); setFocusFirst(false); } }, [focusFirst, current]);
  const important = current?.warnings.filter((warning) => !warning.startsWith("Each option is checked")) ?? [];
  return <>
    <div className="myuw-controls">
      <label>Term<select id="myuw-term-select" data-focus-key="myuw-term-select" value={termCode} onChange={(event) => setTerm(event.target.value)} disabled={busy || !model.terms.length}>
        <option value="">{model.terms.length ? "Choose a term" : "Term list not saved"}</option>
        {model.terms.map((term) => <option key={term.code} value={term.code}>{term.label}{term.past ? " (past)" : ""}</option>)}</select></label>
      <label>Schedule preference<select id="myuw-style-select" data-focus-key="myuw-style-select" value={style} onChange={(event) => setStyle(event.target.value as PlanStyle)} disabled={busy}>
        {styles.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <button type="button" id="myuw-compare" data-focus-key="myuw-compare" className="myuw-button myuw-button--primary" disabled={busy || !termCode || blocked} aria-busy={pending === "compare" || undefined}
        onClick={() => { setFocusFirst(true); compare(); }}>{pending === "compare" ? "Comparing…" : current ? "Compare again" : "Compare courses"}</button>
    </div>
    {!model.terms.length ? <p className="myuw-note">A UW term list is needed before comparing. Refresh to save it.</p> : null}
    {termCode ? <p className="myuw-note">{loaded.length ? `Saved ${termLabel(termCode)} offerings: ${loaded.map((row) => `${row.name} (${row.count})`).join(", ")}. Each search saves up to 50 courses.` : `No ${termLabel(termCode)} offerings are saved yet. Options come only from offerings you load.`}</p> : null}
    {termCode && suggested.length ? <div className="myuw-inline">
      <span className="myuw-note">Subjects your open requirements list:</span>
      {suggested.map((subject) => <button type="button" key={subject.code} className="myuw-button" disabled={busy} aria-busy={pending === `offerings:${subject.code}` || undefined} onClick={() => loadOfferings(subject.code)}>
        <Icon name="search" />{pending === `offerings:${subject.code}` ? `Loading ${subject.name}…` : `Load ${subject.name}`}</button>)}
    </div> : null}
    {failure?.startsWith("offerings:") ? <p className="myuw-error" role="alert">Those offerings didn’t load. Saved offerings are unchanged; try again.</p> : null}
    {failure === "compare" ? <p className="myuw-error" role="alert">The comparison didn’t finish. Your term and preference are kept; try again.</p> : null}
    {comparison && !current ? <p className="myuw-caution"><Icon name="alert" />Your choices or saved records changed since the last comparison. Compare again to use them.</p> : null}
    {current ? <div className="myuw-results" ref={results} tabIndex={-1} aria-label={`${current.candidates.length} options for ${termLabel(current.termCode)}`}>
      {important.length ? <div className="myuw-caution myuw-caution--list"><Icon name="alert" /><div><p className="myuw-label">Before you choose</p>{important.map((warning) => <p key={warning}>{warning}</p>)}</div></div> : null}
      <p className="myuw-note">Compared {stamp(current.createdAt)}. Options are separate, not a combined schedule, and matching several requirements doesn’t mean a course can count twice.</p>
      {!current.candidates.length ? <p className="myuw-empty">No saved {termLabel(current.termCode)} offering matches an open requirement yet. Load offerings for a subject your requirements list, then compare again.</p>
        : current.candidates.map((candidate) => <Candidate key={`${candidate.courseKey}:${candidate.packageId}`} candidate={candidate} model={model} open={open} />)}
    </div> : null}
  </>;
}

const prerequisiteLabel = { met: "Prerequisites met", conditional: "Prerequisites need a check", unmet: "Prerequisites not met", unknown: "Prerequisites unknown" } as const;
const scheduleLabel = { clear: "Fits saved schedule", conflict: "Time conflict", unknown: "Schedule fit unknown" } as const;
const tagTone = (value: string) => value === "met" || value === "clear" ? "met" : value === "unmet" || value === "conflict" ? "open" : "unknown";
function Candidate({ candidate, model, open }: { candidate: PlanningComparison["candidates"][number]; model: MyUwModel; open: MyUwProps["open"] }) {
  const readable = (reason: string) => reason.replace(/uw:\d+:[A-Z0-9]+/g, model.courseCode);
  const credits = candidate.creditMin === null ? null : candidate.creditMax !== null && candidate.creditMax !== candidate.creditMin ? `${candidate.creditMin}–${candidate.creditMax} credits` : `${candidate.creditMin} ${candidate.creditMin === 1 ? "credit" : "credits"}`;
  const reasons = [...candidate.prerequisiteReasons, ...candidate.scheduleReasons].map(readable).filter(Boolean);
  return <article className="myuw-candidate">
    <div className="myuw-candidate-main">
      <p className="myuw-candidate-code" title={candidate.courseKey}>{model.courseCode(candidate.courseKey)}{credits ? <span>{credits}</span> : null}</p>
      <h3>{candidate.title}</h3>
      <p>May count toward {candidate.requirements.join(" · ") || "a requirement in your audit"}{candidate.multipleRequirements ? ". Counting it for more than one needs confirmation." : "."}</p>
      <p className="myuw-tags">
        <span className={`myuw-tag myuw-tag--${tagTone(candidate.prerequisite)}`}>{prerequisiteLabel[candidate.prerequisite]}</span>
        <span className={`myuw-tag myuw-tag--${tagTone(candidate.schedule)}`}>{scheduleLabel[candidate.schedule]}</span>
        <span className="myuw-tag myuw-tag--unknown">{candidate.seatStatus}{candidate.seatsAvailable !== null ? ` · ${candidate.seatsAvailable} seats when checked` : ""}</span>
      </p>
      {reasons.length ? <Disclosure label="Why"><ul className="myuw-reasons">{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></Disclosure> : null}
      {candidate.historicalAverage !== null ? <p className="myuw-note">Past grade average {candidate.historicalAverage.toFixed(2)} from {candidate.historicalCount} grades. Not a prediction.</p> : null}
      <p className="myuw-meta">{candidate.evidence.map((evidence, index) => <Source key={`${evidence.url}:${index}`} url={evidence.url} label={evidence.label} open={open} />)}<span>Observed {stamp(candidate.observedAt)}</span></p>
    </div>
    <button type="button" className="myuw-tile myuw-tile--coral myuw-candidate-open" data-focus-key={`myuw-open-${candidate.courseKey}`} onClick={() => open(candidate.sourceUrl)}><span>View in Course Search & Enroll</span><Icon name="external" /></button>
  </article>;
}

function Reconciliation({ snapshot, model, open }: { snapshot: Snapshot; model: MyUwModel; open: MyUwProps["open"] }) {
  const reconciliation = snapshot.planning?.reconciliation;
  if (!reconciliation) return null;
  const differing = reconciliation.status === "available" ? reconciliation.attempts.filter((row) => row.differences.length).length : 0;
  return <Disclosure label={`Compare Canvas and UW records${reconciliation.status === "available" ? ` · ${differing} ${differing === 1 ? "difference" : "differences"}` : ""}`}>
    {reconciliation.warnings.map((warning) => <p className="myuw-note" key={warning}>{warning}</p>)}
    {reconciliation.status === "available" ? <>
      <p className="myuw-note">{reconciliation.attempts.filter((row) => row.coverage === "matched").length} attempts matched across Canvas and academic records · {reconciliation.attempts.filter((row) => row.coverage === "academic_only").length} academic attempts without a matched Canvas course · {reconciliation.unresolvedCanvasCourses} Canvas spaces without an exact course and term match</p>
      {reconciliation.attempts.map((attempt) => <details className="myuw-row" key={`${attempt.courseKey}:${attempt.termCode}`}>
        <summary>{model.courseLabel(attempt.courseKey)} · {termLabel(attempt.termCode)}{attempt.differences.length ? ` · ${attempt.differences.map((value) => value === "applied_credits" ? "credits applied in the audit" : value).join(", ")} differ` : ` · ${attempt.coverage.replaceAll("_", " ")}`}</summary>
        {attempt.claims.map((claim, index) => <p key={index}><Source url={claim.url} label={claim.source === "canvas" ? "Canvas gradebook" : claim.source === "audit" ? "Audit applied course" : "Student course history"} open={open} /> · {claim.grade ? `${claim.source === "canvas" ? "Final letter: " : ""}${claim.grade}` : "No final letter reported"}{claim.source === "canvas" && claim.currentGrade ? ` · Current letter: ${claim.currentGrade}` : ""}{claim.source === "canvas" && claim.score != null ? ` · Canvas final calculation ${claim.score}%` : ""}{claim.source === "canvas" && claim.currentScore != null ? ` · Canvas current calculation ${claim.currentScore}%` : ""}{claim.credits !== null ? ` · ${claim.credits} ${claim.creditBasis === "audit_application" ? "credits applied in this audit" : "attempt credits"}` : ""} · {claim.state.replaceAll("_", " ")} · Observed {stamp(claim.observedAt)}{claim.needsRefresh ? " · needs refresh" : ""}</p>)}
      </details>)}
    </> : null}
  </Disclosure>;
}

/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Home-like briefing specimen for inline context. Uses the desktop's actual Home
 * stylesheets and shared components with synthetic data. `?v=before` renders the
 * current Home.tsx briefing structure; the default renders the proposed one.
 * The resource route and Back below are an in-page stub, not the app router.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Action, Confirmation, EvidenceLink, type ConfirmationRecord } from '../src';
import { InlineEntity, InlineTime, destinationAction, presentationLabel, sourceDates } from '../src/inline-context';
import '../../../apps/desktop/src/renderer/styles.css';
import '../src/styles.css';
import '../src/inline-context/inline-context.css';
import '../../../apps/desktop/src/renderer/desktop.css';
import '../../../apps/desktop/src/renderer/home/Home.css';
import '../../../apps/desktop/src/renderer/StartWork.css';

// Synthetic records shaped like ResourceView fields the briefing reads. Not coursework.
const P1 = { id: 'r-p1', title: 'COMPSCI 574: P1 (MySQL)', course: 'COMPSCI 574', hash: 'h1', due: '2026-09-28T13:00:00-05:00',
  quote: 'Submit your schema file and a short write-up explaining each foreign key you chose.' };
const READINGS = { id: 'r-readings', title: 'COMPSCI 639: Assigned readings', course: 'COMPSCI 639', hash: 'h2',
  quote: 'Read sections 3.1 to 3.4 before Thursday; the in-class quiz covers these pages.' };
const QUIZ = { id: 'r-quiz', title: 'HISTORY 205: T-shirt cart request - Step 1: Draft the checkout flow and upload three annotated screenshots', course: 'HISTORY 205', hash: 'h3' };
// Deadline claims as the domain resolves them: two sources disagree; a title-derived date must not appear.
const QUIZ_CLAIMS = [
  { value: '2026-10-01T23:59:00-05:00', kind: 'due', authority: 'structured', scopeConfirmed: true, origin: 'canvas' },
  { value: '2026-10-03T23:59:00-05:00', kind: 'due', authority: 'document', scopeConfirmed: true, origin: 'syllabus' },
  { value: '2026-10-06T23:59:00-05:00', kind: 'due', authority: 'title', scopeConfirmed: true, origin: 'title' },
] as const;
const fmtDay = (v: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago' }).format(new Date(v));
const fmtTime = (v: string) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }).format(new Date(v));
// ?report=saved|pending|error renders the nested Confirmation in that state (synthetic).
const reportState = new URLSearchParams(location.search).get('report');
// One verified destination each: the assignment page. Two for the Start work comparison state.
const P1_ITEMS = [{ role: 'instructions', target: { kind: 'web' } }] as const;

const href = (id: string) => `#resource/${encodeURIComponent(id)}`;
function Link({ r, children }: { r: { id: string; hash: string; course: string }; children: ReactNode }) {
  return <EvidenceLink source={{ resourceId: r.id, version: r.hash, href: href(r.id), sourceLabel: r.course, capturedAt: null }}>{children}</EvidenceLink>;
}
const Arrow = () => <svg className="magic-ui-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>;

function Before() {
  const [record, setRecord] = useState<ConfirmationRecord | null>(null);
  return <section className="home-briefing" aria-labelledby="briefing-title"><h1 id="briefing-title" tabIndex={-1}>Briefing</h1>
    <div className="briefing-passage"><p>The saved dates for <Link r={QUIZ}>{QUIZ.title}</Link> disagree. Plan for <strong>Thu, Oct 1, 11:59 PM</strong> until you confirm the date.</p>
      <div className="briefing-action briefing-review"><Action onClick={() => { location.hash = href(QUIZ.id); }}>Review dates <Arrow/></Action>
        <Confirmation issueId="quiz-date" sourceVersion="v1" record={record} onChange={c => setRecord(c.handled ? { issueId: c.issueId, sourceVersion: c.sourceVersion, reportedAt: '' } : null)}/></div></div>
    <div className="briefing-passage"><p><span className="briefing-context">{P1.course} · <Link r={P1}>{P1.title}</Link> · due tomorrow 1:00 PM</span><q>{P1.quote}</q></p>
      <div className="briefing-action"><section className="magic-start-work magic-start-work--action"><Action onClick={() => { location.hash = href(P1.id); }}><span>Start work<small>Opens the assignment page</small></span><Arrow/></Action></section></div></div>
    <div className="briefing-passage"><p><span className="briefing-context">{READINGS.course} · <Link r={READINGS}>{READINGS.title}</Link></span><q>{READINGS.quote}</q></p></div>
  </section>;
}

function After() {
  const [record, setRecord] = useState<ConfirmationRecord | null>(reportState === 'saved' ? { issueId: 'quiz-date', sourceVersion: 'v1', reportedAt: '' } : null);
  // Each passage names its course in the sentence, so only that exact prefix may be dropped.
  const quiz = presentationLabel(QUIZ.title, { shownPrefixes: [QUIZ.course] });
  const dates = sourceDates(QUIZ_CLAIMS);
  const p1 = presentationLabel(P1.title, { shownPrefixes: [P1.course] });
  const readings = presentationLabel(READINGS.title, { shownPrefixes: [READINGS.course] });
  const open = destinationAction(P1_ITEMS);
  return <section className="home-briefing" aria-labelledby="briefing-title"><h1 id="briefing-title" tabIndex={-1}>Briefing</h1>
    <div className="briefing-passage"><p>Check the due date for {QUIZ.course} <InlineEntity name={quiz}><Link r={QUIZ}>{quiz.label}</Link></InlineEntity>: {dates.map((d, i) => <span key={d.value}>{i > 0 && ' and '}{d.sources.join(' and ')} says <InlineTime dateTime={d.value} parts={d.precision === 'day' ? [fmtDay(d.value)] : [fmtDay(d.value), fmtTime(d.value)]} after={i === dates.length - 1 ? '.' : undefined}/></span>)}</p>
      <div className="briefing-action briefing-review"><Action onClick={() => { location.hash = href(QUIZ.id); }}>Review dates <Arrow/></Action>
        <Confirmation issueId="quiz-date" sourceVersion="v1" record={record} pending={reportState === 'pending'} error={reportState === 'error' ? 'Change not confirmed. Showing the last saved report.' : undefined}
          onChange={c => setRecord(c.handled ? { issueId: c.issueId, sourceVersion: c.sourceVersion, reportedAt: '' } : null)}/></div></div>
    <div className="briefing-passage"><p>{P1.course} <InlineEntity name={p1}><Link r={P1}>{p1.label}</Link></InlineEntity> is due <InlineTime dateTime={P1.due} parts={['tomorrow', '1 PM']} after="."/> <q>{P1.quote}</q></p>
      {open.label && <div className="briefing-action"><Action onClick={() => { location.hash = href(P1.id); }}>{open.label} <Arrow/></Action></div>}</div>
    <div className="briefing-passage"><p>{READINGS.course} <InlineEntity name={readings}><Link r={READINGS}>{readings.label}</Link></InlineEntity>: <q>{READINGS.quote}</q></p></div>
  </section>;
}

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const r = [P1, READINGS, QUIZ].find(x => x.id === id);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return <section className="home-briefing" aria-labelledby="detail-title">
    <button type="button" className="magic-ui-action magic-ui-action--quiet" onClick={onBack}>Back</button>
    <h1 id="detail-title" ref={heading} tabIndex={-1}>{r?.title ?? 'Not found'}</h1>
    <p className="magic-ui-meta">Specimen stub for resource {id}. The app renders requirements and materials here.</p>
  </section>;
}

function App() {
  const variant = new URLSearchParams(location.search).get('v') === 'before' ? 'before' : 'after';
  const [route, setRoute] = useState(location.hash);
  const origin = useRef<string | null>(null);
  useEffect(() => {
    const remember = (e: MouseEvent | KeyboardEvent) => { if (location.hash.startsWith('#resource/')) return; const a = (e.target as Element).closest?.('a[href^="#resource/"],button'); if (a) origin.current = a.getAttribute('href') ?? a.textContent; };
    const change = () => setRoute(location.hash);
    addEventListener('click', remember, true); addEventListener('keydown', remember, true); addEventListener('hashchange', change);
    return () => { removeEventListener('click', remember, true); removeEventListener('keydown', remember, true); removeEventListener('hashchange', change); };
  }, []);
  useLayoutEffect(() => {
    if (route.startsWith('#resource/') || !origin.current) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>('.home-briefing a, .home-briefing button')).find(el => el.getAttribute('href') === origin.current || el.textContent === origin.current);
    target?.focus();
  }, [route]);
  const id = route.startsWith('#resource/') ? decodeURIComponent(route.slice('#resource/'.length)) : null;
  return <div className="specimen-shell" data-variant={variant}><main className="desktop-workspace"><div className="home-layout specimen-layout"><div className="home-reading">
    {id ? <Detail id={id} onBack={() => history.back()}/> : variant === 'before' ? <Before/> : <After/>}
  </div></div></main></div>;
}

createRoot(document.getElementById('root')!).render(<App/>);

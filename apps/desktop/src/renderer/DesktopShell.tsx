import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CourseCard } from '../../../../packages/domain/src/course-page';
import type { DesktopView } from './navigation';
// Lucide v0.468.0 nodes from lucide-static; ISC attribution: packages/ui/LICENSE.icons.
// Existing vendor originals: docs/design/lab/vendor. Remaining nodes from the same pinned release.
export function Glyph({ name }: { name: 'home' | 'book' | 'calendar' | 'panel' | 'back' | 'forward' | 'compose' | 'chevron' | 'external' | 'settings' | 'school' | 'user' }) {
  const paths = {
    home: <> <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/> <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/> </>,
    book: <> <path d="M12 7v14"/> <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/> </>,
    calendar: <> <path d="M8 2v4"/> <path d="M16 2v4"/> <rect width="18" height="18" x="3" y="4" rx="2"/> <path d="M3 10h18"/> </>,
    panel: <> <rect width="18" height="18" x="3" y="3" rx="2"/> <path d="M9 3v18"/> </>,
    back: <> <path d="m12 19-7-7 7-7"/> <path d="M19 12H5"/> </>,
    forward: <> <path d="M5 12h14"/> <path d="m12 5 7 7-7 7"/> </>,
    compose: <> <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/> <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/> </>,
    chevron: <> <path d="m9 18 6-6-6-6"/> </>,
    external: <> <path d="M15 3h6v6"/> <path d="M10 14 21 3"/> <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/> </>,
    settings: <> <ellipse cx="12" cy="5" rx="9" ry="3"/> <path d="M3 5V19A9 3 0 0 0 21 19V5"/> <path d="M3 12A9 3 0 0 0 21 12"/> </>,
    school: <> <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/> <path d="M14 2v4a2 2 0 0 0 2 2h4"/> <path d="M10 9H8"/> <path d="M16 13H8"/> <path d="M16 17H8"/> </>,
    user: <> <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/> <circle cx="12" cy="7" r="4"/> </>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
// No verified display name or photo reaches the renderer yet (the Canvas profile feeds only the
// local scrubbing roster), so the account shows a neutral glyph, never a guessed initial or name.
export const profileLabel = (sample: boolean) => sample ? 'Sample student' : 'Your account';
export function DesktopShell({ view, title, courses, selectedCourseKey, sample, busy, canBack, canForward, onBack, onForward, onNavigate, onCourse, onCompose, status, launcher, children }: {
  view: DesktopView; title: string; courses: CourseCard[]; selectedCourseKey: string | null; sample: boolean; busy: boolean; canBack: boolean; canForward: boolean;
  onBack: () => void; onForward: () => void; onNavigate: (view: DesktopView) => void; onCourse: (key: string) => void; onCompose: () => void; status?: ReactNode; launcher?: ReactNode; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false), [expanded, setExpanded] = useState(true);
  const launcherRef = useRef<HTMLDivElement>(null);
  const [launcherHeight, setLauncherHeight] = useState(0);
  const hasLauncher = Boolean(launcher);
  useLayoutEffect(() => {
    const element = launcherRef.current;
    if (!element) return;
    const measure = () => setLauncherHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasLauncher]);
  const launcherClearance = Math.max(72, launcherHeight + 32);
  const backRef = useRef<HTMLButtonElement>(null);
  const forwardRef = useRef<HTMLButtonElement>(null);
  const composeRef = useRef<HTMLButtonElement>(null);
  // A focused history action can disappear at an endpoint. Keep keyboard users in
  // the toolbar; route restoration elsewhere retains ownership of content focus.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if ((!canBack && active === backRef.current) || (!canForward && active === forwardRef.current)) {
      (canBack ? backRef.current : canForward ? forwardRef.current : composeRef.current)?.focus();
    }
  }, [canBack, canForward]);
  return <div className={`desktop-shell ${collapsed ? 'is-collapsed' : ''} ${launcher ? 'has-launcher' : ''}`}>
    <header className="desktop-chrome"><div className="desktop-brand">My Magic UW</div><div className="desktop-history">
      <button aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><Glyph name="panel"/></button>
      <button ref={composeRef} aria-label="New context chat" onClick={onCompose}><Glyph name="compose"/></button>
      <span className="desktop-history-slot" data-available={canBack}>
        <button ref={backRef} aria-label="Go back" aria-hidden={!canBack} tabIndex={canBack ? 0 : -1} onClick={() => { if (canBack) onBack(); }}><Glyph name="back"/></button>
      </span>
      <span className="desktop-history-slot" data-available={canForward}>
        <button ref={forwardRef} aria-label="Go forward" aria-hidden={!canForward} tabIndex={canForward ? 0 : -1} onClick={() => { if (canForward) onForward(); }}><Glyph name="forward"/></button>
      </span>
    </div><span className="desktop-page-title" title={title}>{title}</span><div className="desktop-status">{status}<span className="desktop-state">{sample ? 'Sample data' : busy ? 'Working…' : ''}</span></div></header>
    <aside className="desktop-sidebar" aria-label="Workspace">
      <nav aria-label="Main navigation">{([
        ['today', 'Home', 'home'], ['courses', 'Courses', 'book'], ['myuw', 'My UW', 'school'], ['calendar', 'Calendar', 'calendar'],
      ] as const).map(([key, label, icon]) => <div key={key}><div className="desktop-nav-row"><button className={`desktop-nav ${view === key ? 'active' : ''}`} aria-label={label} aria-current={view === key ? 'page' : undefined} onClick={() => onNavigate(key)}><Glyph name={icon}/><span className="magic-motion-fade" data-faded={collapsed ? '' : undefined}>{label}</span></button>{key === 'courses' && <button className={`desktop-expand magic-motion-fade ${expanded ? 'expanded' : ''}`} data-faded={collapsed ? '' : undefined} inert={collapsed} aria-label={expanded ? 'Collapse courses' : 'Expand courses'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Glyph name="chevron"/></button>}</div>{key === 'courses' && <div className="magic-motion-rows" data-open={expanded && !collapsed} inert={!expanded || collapsed}><div className="desktop-course-list"><div className="desktop-course-list-content">{courses.map(course => <button key={course.key} data-focus-key={`sidebar-course-${course.key}`} aria-current={selectedCourseKey === course.key ? "page" : undefined} className={selectedCourseKey === course.key ? "active" : undefined} onClick={() => onCourse(course.key)} title={course.rawCourseName}><span className="desktop-course-title">{course.courseName}</span>{course.code && course.code !== course.courseName && <span className="desktop-course-code">{course.code}</span>}</button>)}</div></div></div>}</div>)}</nav>
      <div className="desktop-profile"><button className="desktop-profile-button" aria-label={`${profileLabel(sample)}, Data & AI settings`} title={`${profileLabel(sample)} · Data & AI settings`} data-focus-key="sidebar-profile" aria-current={view === 'privacy' ? 'page' : undefined} onClick={() => onNavigate('privacy')}><span className="desktop-avatar" aria-hidden="true">{sample ? 'S' : <Glyph name="user"/>}</span><span className="magic-motion-fade" data-faded={collapsed ? '' : undefined}>{profileLabel(sample)}</span></button><button className="desktop-source-shortcut magic-motion-fade" data-faded={collapsed ? '' : undefined} inert={collapsed} onClick={() => onNavigate('sources')} aria-label="Connected sources" title="Connected sources" data-focus-key="sidebar-sources" aria-current={view === 'sources' ? 'page' : undefined}><Glyph name="settings"/></button></div>
    </aside>
    <main className="desktop-workspace" style={hasLauncher ? { paddingBottom: launcherClearance, scrollPaddingBottom: launcherClearance } : undefined} onClick={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#resource/"]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); link.dispatchEvent(new CustomEvent('magic-resource-open', { bubbles: true, detail: decodeURIComponent(link.hash.slice(10)) }));
    }}>{children}</main>
    {launcher && <div ref={launcherRef} className="desktop-launcher">{launcher}</div>}
  </div>;
}

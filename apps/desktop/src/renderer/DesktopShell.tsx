import { MagicGlyph } from '../../../../packages/ui/src/glyph';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CourseCard } from '../../../../packages/domain/src/course-page';
import type { DesktopView } from './navigation';
const defaultAvatar = new URL('../../../../marketing/logo/head-color.svg', import.meta.url).href;
export function Glyph({ name }: { name: 'home' | 'book' | 'calendar' | 'panel' | 'back' | 'forward' | 'compose' | 'chevron' | 'external' | 'settings' | 'school' | 'user' }) {
  return <MagicGlyph name={name} className="desktop-glyph" />;
}
// No verified display name or photo reaches the renderer yet (the Canvas profile feeds only the
// local scrubbing roster), so the account shows a neutral glyph, never a guessed initial or name.
export const profileLabel = (sample: boolean) => sample ? 'Sample student' : 'Your account';
export function DesktopShell({ view, title, courses, selectedCourseKey, sample, busy, canBack, canForward, onBack, onForward, onNavigate, onCourse, onCompose, status, launcher, trailing, children }: {
  view: DesktopView; title: string; courses: CourseCard[]; selectedCourseKey: string | null; sample: boolean; busy: boolean; canBack: boolean; canForward: boolean;
  onBack: () => void; onForward: () => void; onNavigate: (view: DesktopView) => void; onCourse: (key: string) => void; onCompose: () => void; status?: ReactNode; launcher?: ReactNode; trailing?: ReactNode; children: ReactNode;
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
    </div><span className="desktop-page-title" title={title}>{title}</span><div className="desktop-status">{status}<span className="desktop-state">{sample ? 'Sample data' : busy ? 'Working…' : ''}</span>{trailing}</div></header>
    <aside className="desktop-sidebar" aria-label="Workspace">
      <nav aria-label="Main navigation">{([
        ['today', 'Home', 'home'], ['courses', 'Courses', 'book'], ['study', 'Study & Learn', 'book'], /* owner: study-prep */ ['myuw', 'My UW', 'school'], ['calendar', 'Calendar', 'calendar'],
      ] as const).map(([key, label, icon]) => <div key={key}><div className="desktop-nav-row"><button className={`desktop-nav ${view === key ? 'active' : ''}`} aria-label={label} aria-current={view === key ? 'page' : undefined} onClick={() => onNavigate(key)}><Glyph name={icon}/><span className="magic-motion-fade" data-faded={collapsed ? '' : undefined}>{label}</span></button>{key === 'courses' && <button className={`desktop-expand magic-motion-fade ${expanded ? 'expanded' : ''}`} data-faded={collapsed ? '' : undefined} inert={collapsed} aria-label={expanded ? 'Collapse courses' : 'Expand courses'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Glyph name="chevron"/></button>}</div>{key === 'courses' && <div className="magic-motion-rows" data-open={expanded && !collapsed} inert={!expanded || collapsed}><div className="desktop-course-list"><div className="desktop-course-list-content">{courses.map(course => <button key={course.key} data-focus-key={`sidebar-course-${course.key}`} aria-current={selectedCourseKey === course.key ? "page" : undefined} className={selectedCourseKey === course.key ? "active" : undefined} onClick={() => onCourse(course.key)} title={course.rawCourseName}><span className="desktop-course-title">{course.courseName}</span>{course.code && course.code !== course.courseName && <span className="desktop-course-code">{course.code}</span>}</button>)}</div></div></div>}</div>)}</nav>
      <div className="desktop-profile"><button className="desktop-profile-button" aria-label={`${profileLabel(sample)}, Data & AI settings`} title={`${profileLabel(sample)} · Data & AI settings`} data-focus-key="sidebar-profile" aria-current={view === 'privacy' ? 'page' : undefined} onClick={() => onNavigate('privacy')}><span className="desktop-avatar" aria-hidden="true"><img src={defaultAvatar} alt=""/></span><span className="magic-motion-fade" data-faded={collapsed ? '' : undefined}>{profileLabel(sample)}</span></button><button className="desktop-source-shortcut magic-motion-fade" data-faded={collapsed ? '' : undefined} inert={collapsed} onClick={() => onNavigate('sources')} aria-label="Connected sources" title="Connected sources" data-focus-key="sidebar-sources" aria-current={view === 'sources' ? 'page' : undefined}><Glyph name="settings"/></button></div>
    </aside>
    <main className="desktop-workspace" style={hasLauncher ? { paddingBottom: launcherClearance, scrollPaddingBottom: launcherClearance } : undefined} onClick={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#resource/"]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); link.dispatchEvent(new CustomEvent('magic-resource-open', { bubbles: true, detail: decodeURIComponent(link.hash.slice(10)) }));
    }}>{children}</main>
    {launcher && <div ref={launcherRef} className="desktop-launcher">{launcher}</div>}
  </div>;
}

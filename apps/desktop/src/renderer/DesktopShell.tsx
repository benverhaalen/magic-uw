import { useState, type ReactNode } from 'react';
import type { ResourceView } from '@magic/contracts';
import type { DesktopView } from './navigation';
// Exact Lucide paths; ISC attribution: packages/ui/LICENSE.icons.
export function Glyph({ name }: { name: 'home' | 'book' | 'calendar' | 'panel' | 'back' | 'forward' | 'compose' | 'chevron' | 'external' | 'settings' | 'school' }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/></>,
    book: <><path d="M12 7v14M3 18V3c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2Z"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></>,
    panel: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></>,
    back: <path d="m12 19-7-7 7-7m-7 7h14"/>, forward: <path d="m12 5 7 7-7 7M5 12h14"/>,
    compose: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5M10 14l3-1 9-9-3-3-9 9Z"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>, external: <><path d="M15 3h6v6m0-6L10 14"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></>,
    settings: <><path d="M12 8v8m-4-4h8"/><circle cx="12" cy="12" r="9"/></>,
    school: <><path d="m3 9 9-6 9 6v12H3Zm6 12v-7h6v7M3 9h18"/></>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function DesktopShell({ view, title, courses, sample, busy, canBack, canForward, onBack, onForward, onNavigate, onCourse, onCompose, children }: {
  view: DesktopView; title: string; courses: ResourceView[]; sample: boolean; busy: boolean; canBack: boolean; canForward: boolean;
  onBack: () => void; onForward: () => void; onNavigate: (view: DesktopView) => void; onCourse: (course: ResourceView) => void; onCompose: () => void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false), [expanded, setExpanded] = useState(true);
  return <div className={`desktop-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <header className="desktop-chrome"><div className="desktop-history">
      <button aria-label="Go back" disabled={!canBack} onClick={onBack}><Glyph name="back"/></button>
      <button aria-label="Go forward" disabled={!canForward} onClick={onForward}><Glyph name="forward"/></button>
      <button aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><Glyph name="panel"/></button>
      <button aria-label="New context chat" onClick={onCompose}><Glyph name="compose"/></button>
    </div><span className="desktop-page-title" title={title}>{title}</span><span className="desktop-state">{sample ? 'Sample data' : busy ? 'Working…' : ''}</span></header>
    <aside className="desktop-sidebar" aria-label="Workspace"><div className="desktop-brand">Magic Canvas</div>
      <nav aria-label="Main navigation">{([
        ['today', 'Home', 'home'], ['courses', 'Courses', 'book'], ['myuw', 'My UW', 'school'], ['calendar', 'Calendar', 'calendar'],
      ] as const).map(([key, label, icon]) => <div key={key}><div className="desktop-nav-row"><button className={`desktop-nav ${view === key ? 'active' : ''}`} aria-label={label} aria-current={view === key ? 'page' : undefined} onClick={() => onNavigate(key)}><Glyph name={icon}/><span>{label}</span></button>{key === 'courses' && !collapsed && <button className={`desktop-expand ${expanded ? 'expanded' : ''}`} aria-label={expanded ? 'Collapse courses' : 'Expand courses'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Glyph name="chevron"/></button>}</div>{key === 'courses' && expanded && !collapsed && <div className="desktop-course-list">{courses.map(course => <button key={`${course.sourceId}:${course.courseId}`} onClick={() => onCourse(course)} title={course.courseName}>{course.courseName}</button>)}</div>}</div>)}</nav>
      <div className="desktop-profile"><button className="desktop-profile-button" aria-label="Workspace settings" onClick={() => onNavigate('privacy')}><span className="desktop-avatar" aria-hidden="true">{sample ? 'S' : 'Y'}</span><span>{sample ? 'Sample student' : 'Your workspace'}</span></button><button className="desktop-source-shortcut" onClick={() => onNavigate('sources')} aria-label="Connected sources"><Glyph name="settings"/></button></div>
    </aside>
    <main className="desktop-workspace" onClick={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#resource/"]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); link.dispatchEvent(new CustomEvent('magic-resource-open', { bubbles: true, detail: decodeURIComponent(link.hash.slice(10)) }));
    }}>{children}</main>
  </div>;
}

import { useRef, type ReactNode } from 'react';
import './courses-work-view.css';

export type CoursesMode = 'cards' | 'list';
/** Controlled selection: the navigation owner captures/restores a separate place for each mode. */
export function CoursesViewToggle({ mode, onChange }: { mode: CoursesMode; onChange: (mode: CoursesMode) => void }) {
  const choices = useRef<Array<HTMLButtonElement | null>>([]);
  const options = [{ value: 'cards', label: 'Courses', icon: 'grid' }, { value: 'list', label: 'Work by day', icon: 'list' }] as const;
  return <div className="cw-view-toggle" role="radiogroup" aria-label="Courses view">
    {options.map((option, index) => <button key={option.value} ref={node => { choices.current[index] = node; }}
      type="button" role="radio" aria-checked={mode === option.value} aria-label={option.label}
      title={option.label} tabIndex={mode === option.value ? 0 : -1} data-focus-key={`courses-view-${option.value}`}
      onClick={() => { if (mode !== option.value) onChange(option.value); }}
      onKeyDown={event => {
        let next: number;
        if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % options.length;
        else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + options.length - 1) % options.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = options.length - 1;
        else return;
        event.preventDefault(); choices.current[next]?.focus({ preventScroll: true }); onChange(options[next]!.value);
      }}><WorkGlyph name={option.icon}/></button>)}
  </div>;
}

/** One identical centered heading for both modes. Render the cards body without its old header. */
export function CoursesViewHeader({ termLabel, mode, onChange, evidence }: {
  termLabel: string; mode: CoursesMode; onChange: (mode: CoursesMode) => void; evidence?: ReactNode;
}) {
  return <header className="cw-header"><div className="cw-term"><h1 tabIndex={-1}>{termLabel}</h1>{evidence}</div>
    <CoursesViewToggle mode={mode} onChange={onChange}/></header>;
}

// Lucide paths, ISC. Same 24px coordinate system and 1.65 stroke as DesktopShell Glyph.
// Attribution: packages/ui/LICENSE.icons; no separate icon package or emoji substitution.
export function WorkGlyph({ name }: { name: 'grid' | 'list' | 'lecture' | 'prep' | 'assignment' | 'exam' | 'chevron' | 'check' }) {
  const paths: Record<typeof name, ReactNode> = {
    grid: <><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></>,
    lecture: <><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M7 21h10M12 17v4M7 7h10M7 11h6"/></>,
    prep: <><path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></>,
    assignment: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M8 13h8M8 17h6"/></>,
    exam: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M9 16l2 2 4-4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    check: <path d="m20 6-11 11-5-5"/>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

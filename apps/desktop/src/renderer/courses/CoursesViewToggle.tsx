import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
import { useRef, type ReactNode } from 'react';
import './courses-work-view.css';

export type CoursesMode = 'cards' | 'list';
/** Controlled selection: the navigation owner captures/restores a separate place for each mode. */
export function CoursesViewToggle({ mode, onChange }: { mode: CoursesMode; onChange: (mode: CoursesMode) => void }) {
  const choices = useRef<Array<HTMLButtonElement | null>>([]);
  const options = [{ value: 'cards', label: 'Courses', icon: 'grid' }, { value: 'list', label: 'Work by day', icon: 'list' }] as const;
  return <div className="cw-view-toggle" data-mode={mode} role="radiogroup" aria-label="Courses view">
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

export function WorkGlyph({ name }: { name: 'grid' | 'list' | 'lecture' | 'prep' | 'assignment' | 'exam' | 'chevron' | 'check' }) {
  return <MagicGlyph name={name} />;
}

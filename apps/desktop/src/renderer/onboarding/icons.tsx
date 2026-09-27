import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
export type IconName = 'back' | 'check' | 'external' | 'alert' | 'terminal' | 'clock' | 'refresh';
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <MagicGlyph name={name} size={20} className={`onb-icon${className ? ` ${className}` : ""}`} />;
}
export function Spinner({ idle = false }: { idle?: boolean }) {
  return <span className={idle ? "onb-spinner idle" : "onb-spinner"} aria-hidden="true" />;
}

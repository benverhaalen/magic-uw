import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
export type IconName = 'arrow' | 'external' | 'refresh' | 'chevron' | 'alert' | 'clock' | 'search';
export function Icon({ name }: { name: IconName }) {
  return <MagicGlyph className="myuw-icon" size={18} name={name === 'arrow' ? 'forward' : name} />;
}

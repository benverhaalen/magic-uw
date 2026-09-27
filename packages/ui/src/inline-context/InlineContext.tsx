/** @jsxRuntime automatic @jsxImportSource react */
// Pragma: the root tsconfig does not include packages/**/*.tsx, so tsx tests would otherwise use classic JSX.
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { PresentationLabel } from './labels';

/**
 * Colors come from the palette producer's role pairs as plain CSS values
 * (fill with its paired ink, optional outline). Omitted values keep the
 * canonical tag tokens. This is a seam, not a palette.
 */
export interface InlineColors { fill?: string; ink?: string; line?: string; fillHover?: string }

const colorVars = (colors?: InlineColors) => colors && ({
  '--magic-inline-time-fill': colors.fill, '--magic-inline-time-ink': colors.ink,
  '--magic-inline-time-line': colors.line, '--magic-inline-time-fill-hover': colors.fillHover,
} as CSSProperties);

function Parts({ parts }: { parts: readonly string[] }) {
  // Each part stays whole; a tag wider than its line may break only at a separator,
  // so 200% text in a narrow window wraps inside the tag instead of overflowing.
  return <>{parts.map((part, i) => <Fragment key={i}>{i > 0 && ' · '}<span className="magic-inline-time__part">{part}</span></Fragment>)}</>;
}

/**
 * A time inside a sentence, at the sentence's own size. Static by default: a plain
 * <time> with a filled tag that extends outward without changing line height and
 * nothing that invites a click. Pass `destination` only for a real calendar or
 * deadline route; it becomes a native link whose name says where it goes.
 */
export function InlineTime({ dateTime, parts, destination, colors, after }: {
  dateTime: string;
  parts: readonly string[];
  destination?: { href: string; name: string };
  colors?: InlineColors;
  /** Punctuation that directly follows the tag; kept on the tag's line so it never starts a line alone. */
  after?: string;
}) {
  const tag = !destination
    ? <time className="magic-inline-time" dateTime={dateTime} style={colorVars(colors)}><Parts parts={parts}/></time>
    : <a className="magic-inline-time magic-inline-time--link" href={destination.href} style={colorVars(colors)}>
      <time dateTime={dateTime}><Parts parts={parts}/></time><span className="magic-inline-sr">, {destination.name}</span>
    </a>;
  return after ? <span className="magic-inline-time-group">{tag}{after}</span> : tag;
}

/**
 * Inline object name. The child is the consumer's own link (EvidenceLink with the
 * exact resource route) whose text is `name.label`. When the label is a shortened
 * literal slice, the full source title stays inspectable on hover; Info remains
 * the keyboard path. The source title is never rewritten.
 */
export function InlineEntity({ name, children }: { name: PresentationLabel; children: ReactNode }) {
  return <span className="magic-inline-entity" title={name.shortened ? name.raw : undefined}
    data-label-rule={name.shortened ? name.rule : undefined}>{children}</span>;
}

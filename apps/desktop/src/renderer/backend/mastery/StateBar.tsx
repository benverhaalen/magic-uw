// The four evidence-defined states as one stacked bar with counts (spec H4/H7): no percentage,
// no ability number. Colour is never the only signal: every segment is named in the legend or the
// accessible label, and Iffy also carries a hatch.
import type { StateCounts } from "../../../../../../packages/learning/src/mastery/types";

export const STATES = [
  { key: "solid", label: "Mastered" },
  { key: "getting_there", label: "Getting there" },
  { key: "iffy", label: "Iffy" },
  { key: "not_seen", label: "Not seen yet" },
] as const;

export function countsText(counts: StateCounts): string {
  return STATES.filter((s) => counts[s.key] > 0)
    .map((s) => `${counts[s.key]} ${s.label}`)
    .join(" · ");
}

export function StateBar({ counts, legend = false, size = "full" }: { counts: StateCounts; legend?: boolean; size?: "full" | "mini" }) {
  const total = STATES.reduce((n, s) => n + counts[s.key], 0);
  const label = total ? STATES.map((s) => `${s.label} ${counts[s.key]}`).join(", ") : "No topics";
  return (
    <div className={`mastery-statebar mastery-statebar--${size}`}>
      <div className="mastery-bar" role="img" aria-label={label}>
        {total ? (
          STATES.filter((s) => counts[s.key] > 0).map((s) => (
            <span key={s.key} className={`mastery-seg mastery-seg--${s.key}`} style={{ flexGrow: counts[s.key] }} />
          ))
        ) : (
          <span className="mastery-seg mastery-seg--empty" style={{ flexGrow: 1 }} />
        )}
      </div>
      {legend ? (
        <ul className="mastery-legend" aria-hidden="true">
          {STATES.map((s) => (
            <li key={s.key}>
              <span className={`mastery-swatch mastery-seg--${s.key}`} />
              {s.label} <strong>{counts[s.key]}</strong>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

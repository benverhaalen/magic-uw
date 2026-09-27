/** Match the rem-based month cell geometry in calendar.css; omitted items stay in the day disclosure. */
export function monthVisibleItemCount(total: number, rowHeight: number, rem = 16): number {
  // Cell padding/border + day number, then one gap per event or disclosure.
  const available = rowHeight - .625 * rem - 1.5 * rem;
  const event = 2.5 * rem, disclosure = 1.5 * rem, gap = .1875 * rem;
  const limit = Math.min(total, 2);
  if (total <= 2 && available >= limit * (event + gap)) return limit;
  return Math.max(0, Math.min(limit, Math.floor((available - disclosure - gap) / (event + gap))));
}

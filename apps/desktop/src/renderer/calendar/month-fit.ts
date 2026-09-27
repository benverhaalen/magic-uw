/** Match the one-line month preview geometry in calendar.css; omitted items stay in the day disclosure. */
export function monthVisibleItemCount(total: number, rowHeight: number, rem = 16): number {
  // The disclosure shares the date row, leaving space below for titled previews.
  const available = rowHeight - .375 * rem - 1.125 * rem - 1; // bottom border
  const event = 1.25 * rem, gap = .125 * rem;
  const limit = Math.min(total, 2);
  return Math.max(0, Math.min(limit, Math.floor(available / (event + gap))));
}

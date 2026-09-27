/** Keep the latest actual ASR text, rather than audio-derived placeholder words. */
export function rollingTranscript(previous: string, finalText: string, limit = 100): string {
  const next = finalText.trim();
  if (!next) return previous;
  return Array.from(`${previous}${previous ? ' ' : ''}${next}`).slice(-limit).join('');
}

/** A changing ASR hypothesis replaces its own span; only finalized text enters history. */
export function visibleTranscript(finalized: string, partial: string, limit = 100): string {
  const text = partial.trim();
  return Array.from(`${finalized}${finalized && text ? ' ' : ''}${text}`).slice(-limit).join('');
}

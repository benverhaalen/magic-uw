/* Component seam: source snapshot and request state are independent.
   refresh() supplies a confirmed snapshot; failure leaves the saved snapshot intact.
   The fixture below performs no network request and uses an explicit scenario clock. */
export function mountConnection(root, { snapshot, refresh }) {
  const button = root.querySelector('[data-refresh]');
  const label = root.querySelector('[data-refresh-label]');
  const feedback = root.querySelector('[data-feedback]');
  const captured = root.querySelector('[data-captured-at]');
  const items = root.querySelector('[data-saved-items]');
  let saved = snapshot;
  let pending = false;
  let disposed = false;
  const formatTime = value => {
    const date = new Date(value);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Chicago', timeZoneName: 'short'
    }).format(date);
  };
  function renderSaved() {
    captured.dateTime = saved.capturedAt;
    captured.textContent = formatTime(saved.capturedAt);
    root.querySelector('[data-saved-count]').textContent = `${saved.items.length} items`;
    items.replaceChildren(...saved.items.map(item => {
      const li = document.createElement('li');
      const title = document.createElement('span');
      const context = document.createElement('span');
      title.textContent = item.title;
      context.textContent = item.context;
      context.className = 'mc-meta';
      li.append(title, context);
      return li;
    }));
  }
  async function onRefresh() {
    if (pending || disposed) return;
    pending = true;
    // aria-disabled keeps the same focused control in the tab order.
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    label.textContent = 'Refreshing';
    feedback.removeAttribute('data-tone');
    feedback.textContent = 'Refreshing… Your saved coursework remains available.';
    try {
      const next = await refresh(saved);
      if (disposed) return;
      if (!next || !Array.isArray(next.items) || !Number.isFinite(Date.parse(next.capturedAt))) {
        throw new Error('Incomplete snapshot');
      }
      saved = next;
      renderSaved();
      feedback.textContent = 'Refresh complete. Saved copy updated.';
      label.textContent = 'Refresh';
    } catch {
      if (disposed) return;
      feedback.dataset.tone = 'error';
      feedback.textContent = 'Refresh failed. Your saved coursework is still available. Try again.';
      label.textContent = 'Retry';
    } finally {
      if (!disposed) {
        pending = false;
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
      }
    }
  }
  renderSaved();
  button.addEventListener('click', onRefresh);
  return () => { disposed = true; button.removeEventListener('click', onRefresh); };
}

// Documentation fixture: all records and timestamps are invented.
const fixtureItems = [
  { id: 'demo-assignment-1', title: 'Interface exercise', context: 'Software Design · Assignment' },
  { id: 'demo-reading-1', title: 'Testing & APIs', context: 'Software Design · Reading' }
];
let attempts = 0;
mountConnection(document.querySelector('[data-connection]'), {
  snapshot: { capturedAt: '2026-09-26T09:12:00-05:00', items: fixtureItems },
  refresh: () => new Promise((resolve, reject) => {
    attempts += 1;
    const attempt = attempts;
    setTimeout(() => {
      if (attempt === 1) reject(new Error('Synthetic refresh failure'));
      else resolve({ capturedAt: '2026-09-26T09:43:00-05:00', items: fixtureItems });
    }, 1600);
  })
});

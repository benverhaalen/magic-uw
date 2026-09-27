import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Confirmation } from '../packages/ui/src/components';

const record = { issueId: 'issue', sourceVersion: 'v1', reportedAt: '2026-09-27' };
const render = (props: Partial<Parameters<typeof Confirmation>[0]>) => renderToStaticMarkup(createElement(Confirmation, { issueId: 'issue', sourceVersion: 'v1', record: null, compactWhenHandled: true, onChange() {}, ...props }));

test('pending or failed unsaved report stays expanded and retains its checkbox', () => {
  for (const props of [{ pending: true }, { error: 'Not confirmed. Try again.' }]) {
    const html = render(props);
    assert.doesNotMatch(html, /magic-ui-confirmation--compact/);
    assert.match(html, /<label><input/);
    assert.match(html, /magic-ui-confirmation__reserve/);
  }
});
test('only current persisted evidence produces compact Undo; newer evidence reopens', () => {
  const saved = render({ record, summary: 'Dates for Homework 1: reported handled.' });
  assert.match(saved, /magic-ui-confirmation--compact/); assert.match(saved, /data-report-undo/); assert.match(saved, /<label hidden=""/);
  const changed = render({ record, sourceVersion: 'v2' });
  assert.doesNotMatch(changed, /magic-ui-confirmation--compact/); assert.doesNotMatch(changed, /checked=""/);
});
test('failed Undo remains compact with feedback and a focusable retry control', () => {
  const html = render({ record, pending: true, error: 'Not confirmed. Try again.' });
  assert.match(html, /magic-ui-confirmation--compact/); assert.match(html, /aria-disabled="true"/);
  assert.match(html, /Not confirmed. Try again./); assert.doesNotMatch(html, / disabled=""/);
});

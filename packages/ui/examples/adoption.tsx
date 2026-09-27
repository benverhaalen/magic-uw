import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Action, Confirmation, Disclosure, EvidenceLink, NavigationPopover, createOperationScope } from '../src';
import type { ConfirmationRecord } from '../src';
import '../src/styles.css';

function Example() {
  const [version, setVersion] = useState('v1');
  const [record, setRecord] = useState<ConfirmationRecord | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const scope = useRef(createOperationScope());
  useEffect(() => () => scope.current.invalidate(), []);
  return <main>
    <h1>Shared component adoption example</h1>
    <p>Synthetic, in-memory example. No course or external service is connected.</p>
    <p><EvidenceLink source={{ resourceId: 'exam-conflict', version, sourceLabel: 'Synthetic course notice', capturedAt: null, href: '#source' }}>Review the exam notice</EvidenceLink></p>
    <Confirmation issueId="exam-conflict" sourceVersion={version} record={record}
      onChange={change => setRecord(change.handled ? { issueId: change.issueId, sourceVersion: change.sourceVersion, reportedAt: new Date().toISOString() } : null)} />
    <Action tone="quiet" onClick={() => setVersion(v => v === 'v1' ? 'v2' : 'v1')}>Change source version</Action>
    <p>Current source: {version}; last report: {record?.sourceVersion ?? 'none'}</p>
    <Disclosure label="What does handled mean?"><p>A student report, not an instructor confirmation or proof of understanding.</p></Disclosure>
    <div><NavigationPopover label="Go to example" links={[{ label: 'Source notice', href: '#source' }, { label: 'Note', href: '#note' }]} /></div>
    <section id="source" tabIndex={-1}><h2>Source notice</h2><p>Synthetic schedule conflict. Capture time is unknown. Version {version}.</p></section>
    <label htmlFor="note">Study note</label><input id="note" value={note} onChange={e => setNote(e.target.value)} aria-describedby="save-status" />
    <Action pending={pending} onClick={async () => {
      const ticket = scope.current.start(), submitted = note;
      setPending(true); setStatus('Saving example…');
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!ticket.isCurrent()) return;
      setStatus(`Example saved: ${submitted}. Later edits are not included.`); setPending(false);
    }}>Save example</Action>
    <Action tone="quiet" onClick={() => { scope.current.invalidate(); setNote(''); setStatus('Reset.'); setPending(false); }}>Reset example</Action>
    <p id="save-status" role="status">{status}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Example />);

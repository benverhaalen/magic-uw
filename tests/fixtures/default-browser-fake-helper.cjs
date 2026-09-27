#!/usr/bin/env node
let pending = '';
let request;
process.stdin.on('data', part => {
  pending += String(part);
  let end = pending.indexOf('\n');
  while (end >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    end = pending.indexOf('\n');
    if (!request) {
      request = JSON.parse(line);
      if (process.env.FAKE_MODE === 'before') return;
      if (request.action === 'read') {
        process.stdout.write(JSON.stringify({ event: 'observed', bundleId: request.bundleId, pid: request.pid,
          windowNumber: request.windowNumber, url: 'https://example.com/', title: 'Example', text: 'Page text' }) + '\n');
        return;
      }
      process.stdout.write(JSON.stringify({ event: 'ready', bundleId: 'org.mozilla.firefox' }) + '\n');
    } else if (line === 'go') {
      process.stdout.write(JSON.stringify({ event: 'dispatching', bundleId: 'org.mozilla.firefox' }) + '\n');
      process.stdout.write(JSON.stringify({ event: 'dispatched', bundleId: 'org.mozilla.firefox' }) + '\n');
      if (process.env.FAKE_MODE === 'after') { setTimeout(() => {}, 3000); return; }
      process.stdout.write(JSON.stringify({ event: 'observed', bundleId: 'org.mozilla.firefox', pid: 123,
        windowNumber: 8, url: 'https://example.com/', title: 'Example' }) + '\n');
    }
  }
});

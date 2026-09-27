import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The binary belongs beside main.cjs so the main process can locate it with
// __dirname. The source ships with the desktop app; no cached CLI is required.
// owner: voice-plan: the observed-action helper (observe + target-bound AXPress) is built the same way.
if (process.platform === 'darwin') {
  for (const name of ['default-browser-helper', 'observed-action-helper']) {
    execFileSync('xcrun', [
      'swiftc',
      join('apps', 'desktop', 'native', `${name}.swift`),
      '-o',
      join('apps', 'desktop', 'dist', name),
    ], { stdio: 'inherit' });
  }
  // owner: voice-plan: the on-device streaming speech helper (Apple SpeechTranscriber; source by the Sol6 lane).
  execFileSync('xcrun', ['swiftc', '-parse-as-library', join('apps', 'desktop', 'native', 'native-streaming-stt.swift'), '-o', join('apps', 'desktop', 'dist', 'native-streaming-stt')], { stdio: 'inherit' });
}

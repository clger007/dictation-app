// Compile the keytap event-tap helper (macOS only). Skips quietly on other
// platforms or when clang is missing — the app then falls back to Electron's
// globalShortcut (no Fn key, no hold-to-talk, no press-to-record).
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'scripts', 'keytap.c');
const OUT = join(ROOT, 'assets', 'keytap');

if (process.platform !== 'darwin') {
  console.log('[keytap] non-macOS platform, skipping');
  process.exit(0);
}
if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SRC).mtimeMs) {
  console.log('[keytap] up to date');
  process.exit(0);
}
try {
  execFileSync('clang', [
    '-O2',
    '-o', OUT,
    SRC,
    '-framework', 'ApplicationServices',
    '-framework', 'CoreFoundation',
  ], { stdio: 'inherit' });
  console.log('[keytap] built assets/keytap');
} catch (e) {
  console.warn('[keytap] build failed (clang missing?) — native hotkeys disabled:', e.message);
}

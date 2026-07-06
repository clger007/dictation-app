// Copy non-TypeScript renderer assets (HTML/CSS/JS/images) into dist/ after
// tsc has emitted the compiled JS. tsc only handles .ts files, so the renderer
// HTML pages and any static assets must be copied alongside the compiled output
// so BrowserWindows can load them from dist/renderer/... at runtime.
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_RENDERER = join(ROOT, 'src', 'renderer');
const DIST_RENDERER = join(ROOT, 'dist', 'renderer');

// Extensions copied verbatim (everything tsc does NOT emit).
const COPY_EXTS = new Set(['.html', '.css', '.js', '.png', '.svg', '.ico', '.woff', '.woff2']);

async function copyTree(srcDir, destDir) {
  if (!existsSync(srcDir)) return 0;
  let count = 0;
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(src, dest);
    } else if (COPY_EXTS.has(extname(entry.name))) {
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
      count += 1;
    }
  }
  return count;
}

const copied = await copyTree(SRC_RENDERER, DIST_RENDERER);
console.log(`[copy-assets] copied ${copied} renderer asset(s) to dist/renderer`);

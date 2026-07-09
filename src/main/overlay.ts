// Overlay — the status "pill": a small frameless, transparent, click-through,
// always-on-top window that shows recording state + mic level without ever
// stealing focus (cross_plat_design §5). Main pushes {state,text,rms} over
// IPC.overlay.state; dismiss triggers the fade-out before the window hides.
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from './ipc';
import { log } from './logger';

export type OverlayPosition = 'bottom' | 'cursor';
export type OverlayStateName = 'listening' | 'transcribing' | 'info' | 'error';

const WIDTH = 360;
const HEIGHT = 64;
const FADE_MS = 220;

let win: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;
let position: OverlayPosition = 'bottom';

/** Set where the pill appears (from [ui].overlay_position). */
export function configureOverlay(pos: OverlayPosition): void {
  position = pos;
}

async function ensureWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload require()s shared ipc.js (see dashboard.ts)
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true); // click-through
  win.on('closed', () => {
    win = null;
  });
  await win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
  return win;
}

/** Bottom-center of the active display, or next to the cursor. */
function place(w: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;
  let x: number;
  let y: number;
  if (position === 'cursor') {
    x = Math.min(Math.max(cursor.x + 16, wa.x), wa.x + wa.width - WIDTH);
    y = Math.min(Math.max(cursor.y + 20, wa.y), wa.y + wa.height - HEIGHT);
  } else {
    x = wa.x + Math.round((wa.width - WIDTH) / 2);
    y = wa.y + wa.height - HEIGHT - 24;
  }
  w.setPosition(Math.round(x), Math.round(y));
}

export type OverlayVariant = 'dictate' | 'translate';

/** Show (or update) the pill with a state + label. */
export async function overlayState(
  state: OverlayStateName,
  text: string,
  variant: OverlayVariant = 'dictate',
): Promise<void> {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  try {
    const w = await ensureWindow();
    place(w);
    w.webContents.send(IPC.overlay.state, { state, text, variant });
    if (!w.isVisible()) w.showInactive();
  } catch (e) {
    log.warn('overlay show failed:', e);
  }
}

/** Push a live mic level (0..~1) while the pill is visible. */
export function overlayLevel(rms: number): void {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.webContents.send(IPC.overlay.state, { rms });
  }
}

/** Flash a result message, then fade the pill away. */
export async function overlayResult(
  state: 'info' | 'error',
  text: string,
  ms = 2000,
): Promise<void> {
  await overlayState(state, text);
  hideTimer = setTimeout(() => overlayHide(), ms);
}

/** Fade out and hide. */
export function overlayHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.overlay.dismiss);
    const w = win;
    setTimeout(() => {
      if (w && !w.isDestroyed() && w.isVisible()) w.hide();
    }, FADE_MS);
  }
}

/** Whether the pill is currently on screen (selftest probe). */
export function isOverlayVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible();
}

/** PNG snapshot of the pill's own content (selftest probe; no screen perms). */
export async function captureOverlay(): Promise<Buffer | null> {
  if (!win || win.isDestroyed()) return null;
  const img = await win.webContents.capturePage();
  return img.toPNG();
}

export function destroyOverlay(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  try {
    win?.destroy();
  } catch {
    /* quitting */
  }
  win = null;
}

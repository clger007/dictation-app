// Main-process bootstrap: single-instance lock, app lifecycle, tray + menu, and
// wiring of the Controller. Port of the daemon's `Dictation.run()` startup and
// `StatusTray`. M0 = skeleton: tray + config + history + logging, no audio.
import { app, Tray, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { Config } from './config';
import { Controller, type State } from './controller';
import { initLogger, log } from './logger';

// Tray state -> icon file (assets/tray-<state>.png). Ported from StatusTray.ICONS.
const TRAY_ICONS: Record<State | 'error', string> = {
  idle: 'tray-idle.png',
  listening: 'tray-listening.png',
  transcribing: 'tray-transcribing.png',
  error: 'tray-error.png',
};

let tray: Tray | null = null;
let controller: Controller | null = null;

// Single-instance lock: a second launch just exits (the first keeps running).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function iconFor(state: State | 'error'): Electron.NativeImage {
  const file = TRAY_ICONS[state] ?? TRAY_ICONS.idle;
  const img = nativeImage.createFromPath(join(app.getAppPath(), 'assets', file));
  // macOS: template images auto-adapt to light/dark menu bars.
  if (process.platform === 'darwin' && !img.isEmpty()) img.setTemplateImage(true);
  return img;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

function buildMenu(ctrl: Controller): Menu {
  const items: MenuItemConstructorOptions[] = [
    { label: `Status: ${ctrl.state}`, enabled: false },
    { type: 'separator' },
    { label: 'Recent (click to copy):', enabled: false },
  ];

  const recent = ctrl.history.recent(ctrl.history.maxMenu);
  if (recent.length) {
    for (const entry of recent) {
      const full = entry.text || '';
      items.push({ label: `  ${truncate(full, 50)}`, click: () => ctrl.copy(full) });
    }
  } else {
    items.push({ label: '  (none yet)', enabled: false });
  }

  items.push(
    { type: 'separator' },
    {
      label: 'LLM cleanup',
      type: 'checkbox',
      checked: ctrl.cleaner.enabled,
      click: (item) => ctrl.setCleanupEnabled(item.checked),
    },
  );

  if (ctrl.config.get().ui.dashboard) {
    items.push({
      label: 'Dashboard / Settings',
      click: () => log.info('Dashboard window lands in M3'),
    });
  }

  items.push(
    {
      label: 'Open history file',
      click: () => {
        void shell.openPath(ctrl.history.path).then((err) => {
          if (err) log.warn('open history failed:', err);
        });
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => quit() },
  );

  return Menu.buildFromTemplate(items);
}

function refreshMenu(): void {
  if (tray && controller) tray.setContextMenu(buildMenu(controller));
}

function setTrayState(state: State): void {
  if (!tray) return;
  tray.setImage(iconFor(state));
  tray.setToolTip(`Dictation — ${state}`);
}

async function bootstrap(): Promise<void> {
  initLogger(app.getPath('logs'));
  log.info(`Dictation starting (${process.platform}); logs: ${log.file()}`);

  const configPath = Config.resolvePath(app.getPath('userData'));
  const config = await Config.load(configPath);
  log.info(`Config: ${config.path}`);

  controller = await Controller.create(config);
  controller.onStateChange((s) => {
    setTrayState(s);
    refreshMenu();
  });
  controller.onMenuChange(() => refreshMenu());

  // Tray. If the desktop has no StatusNotifierItem host (e.g. GNOME without the
  // AppIndicator extension) or no display, degrade gracefully — the app still
  // runs (overlay-only, as the daemon does).
  try {
    tray = new Tray(iconFor('idle'));
    tray.setToolTip('Dictation — idle');
    tray.setContextMenu(buildMenu(controller));
  } catch (e) {
    log.warn('Tray unavailable; continuing without it:', e);
    tray = null;
  }

  controller.startListening();
  log.info('Ready.');
}

app.whenReady().then(bootstrap).catch((e) => {
  log.error('bootstrap failed:', e);
  app.quit();
});

// Tray agent: closing all (there are none in M0) must NOT quit the app.
app.on('window-all-closed', () => {
  /* keep running as a background agent */
});

// macOS: menu-bar agent, no Dock icon (also enforced via LSUIElement in build).
if (process.platform === 'darwin') {
  app.dock?.hide();
}

let quitting = false;
function quit(): void {
  if (quitting) return;
  quitting = true;
  try {
    controller?.quit();
  } catch (e) {
    log.warn('controller quit error:', e);
  }
  tray?.destroy();
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  try {
    controller?.quit();
  } catch {
    /* ignore */
  }
});

// Quit cleanly on Ctrl+C / SIGTERM (parity with the daemon's signal handlers).
process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());

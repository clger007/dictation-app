// Main-process bootstrap: single-instance lock, app lifecycle, tray + menu, and
// wiring of the Controller. Port of the daemon's `Dictation.run()` startup and
// `StatusTray`. M0 = skeleton: tray + config + history + logging, no audio.
import {
  app,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { join } from 'node:path';
import { Config } from './config';
import { Controller, type State } from './controller';
import { openDashboard, registerDashboardIpc } from './dashboard';
import { captureOverlay, isOverlayVisible } from './overlay';
import { getClipboard, setClipboard } from './clipboard';
import { initLogger, log } from './logger';

// --selftest: exercise the full pipeline against fake audio + a mock endpoint
// (see scripts/selftest). Isolated userData so the installed app can keep
// running (the single-instance lock lives in userData).
const SELFTEST = process.argv.includes('--selftest');
if (SELFTEST) {
  app.setPath('userData', join(app.getPath('temp'), 'dictation-selftest'));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

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
      click: () => openDashboard(),
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
  registerDashboardIpc(controller);

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

  if (SELFTEST) void selftest(controller);
}

/**
 * End-to-end selftest: dashboard IPC round-trip through a real window, then
 * record ~1.5s of fake audio, transcribe via the configured (mock) endpoint,
 * and confirm the transcript reached the clipboard + history. Exits 0/1.
 */
async function selftest(ctrl: Controller): Promise<void> {
  const fail = (msg: string): never => {
    log.error(`SELFTEST FAIL: ${msg}`);
    app.exit(1);
    throw new Error(msg);
  };
  try {
    // 1. Dashboard: window loads, preload bridge answers over IPC.
    const win = openDashboard();
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`dashboard load: ${code} ${desc}`)),
      );
    });
    const settings = (await win.webContents.executeJavaScript(
      'window.api.getSettings()',
    )) as { engine?: string };
    if (!settings || !settings.engine) fail('dashboard getSettings returned nothing');
    log.info(`selftest: dashboard ok (engine=${settings.engine})`);

    // 1b. Saving an API key through the dashboard bridge persists + reloads.
    const saved = (await win.webContents.executeJavaScript(
      "window.api.saveSettings({ api_key: 'selftest-fake-key-not-real' })",
    )) as { ok?: boolean; error?: string | null };
    if (!saved?.ok) fail(`saveSettings failed: ${saved?.error ?? 'no response'}`);
    const after = (await win.webContents.executeJavaScript(
      'window.api.getSettings()',
    )) as { api_key_masked?: string };
    if (!after.api_key_masked) fail('saved API key did not persist');
    log.info(`selftest: settings save ok (key=${after.api_key_masked})`);

    // 1c. Hotkey rebind through the dashboard bridge (validate + persist).
    const rebound = (await win.webContents.executeJavaScript(
      "window.api.saveSettings({ hotkey_key: 'f10', hotkey_mode: 'toggle' })",
    )) as { ok?: boolean; error?: string | null };
    if (!rebound?.ok) fail(`hotkey rebind failed: ${rebound?.error ?? 'no response'}`);
    const keyed = (await win.webContents.executeJavaScript(
      'window.api.getSettings()',
    )) as { hotkey_key?: string };
    if (keyed.hotkey_key !== 'f10') fail(`hotkey did not persist (got ${keyed.hotkey_key})`);
    const badKey = (await win.webContents.executeJavaScript(
      "window.api.saveSettings({ hotkey_key: 'not a key!!' })",
    )) as { ok?: boolean };
    if (badKey?.ok) fail('invalid hotkey was accepted');
    log.info('selftest: hotkey rebind ok (f10; invalid key rejected)');

    // 1d. Translate + language + tuning settings persist (also exercises the
    // append path for configs that predate the [translate] section).
    const tset = (await win.webContents.executeJavaScript(
      "window.api.saveSettings({ translate_key: 'f12', translate_target: 'English', language_mode: 'bilingual', cleanup_level: 'fluent' })",
    )) as { ok?: boolean; error?: string | null };
    if (!tset?.ok) fail(`translate settings save failed: ${tset?.error ?? 'no response'}`);
    const s2 = (await win.webContents.executeJavaScript(
      'window.api.getSettings()',
    )) as { translate_key?: string; language_mode?: string; cleanup_level?: string };
    if (s2.translate_key !== 'f12' || s2.language_mode !== 'bilingual' || s2.cleanup_level !== 'fluent') {
      fail(`translate/language settings did not persist (${JSON.stringify(s2)})`);
    }
    log.info('selftest: translate/bilingual/tuning settings ok');

    // 2. Long-dictation pipeline: ~5 s of fake mic at chunk_seconds=2 must be
    // split into parallel chunk requests and merged in order.
    setClipboard('(selftest sentinel)');
    await ctrl.start();
    if (ctrl.state !== 'listening') fail('did not enter listening (mic)');
    await new Promise((r) => setTimeout(r, 400));
    if (!isOverlayVisible()) fail('overlay pill not visible while listening');
    log.info('selftest: overlay pill ok (visible while listening)');
    const shotPath = process.env.SELFTEST_SHOT;
    if (shotPath) {
      const png = await captureOverlay();
      if (png) await require('node:fs/promises').writeFile(shotPath, png);
      log.info(`selftest: pill snapshot -> ${shotPath}`);
    }
    await new Promise((r) => setTimeout(r, 4800));
    await ctrl.stop();
    if (ctrl.state !== 'idle') fail(`expected idle after stop, got ${ctrl.state}`);
    const clip = getClipboard() || '';
    if (clip === '(selftest sentinel)' || !clip) fail('transcript never reached the clipboard');
    const segs = clip.split(/\s+/).filter((w) => w === 'seg').length;
    if (segs < 2) fail(`expected >=2 merged chunks, got "${clip}"`);
    log.info(`selftest: chunked pipeline ok (${segs} chunks merged: "${clip}")`);
    const recent = ctrl.history.recent(1);
    if (!recent.length || recent[0].text !== clip) fail('history entry missing/mismatched');

    // 3. Translate mode: transcript goes through /chat/completions and the
    // translation (not the transcript) is delivered.
    setClipboard('(selftest sentinel 2)');
    await ctrl.start('translate');
    if (ctrl.state !== 'listening') fail('translate: did not enter listening');
    await new Promise((r) => setTimeout(r, 1200));
    await ctrl.stop();
    const clip2 = getClipboard() || '';
    if (clip2 !== 'TRANSLATED OK') fail(`translate: expected "TRANSLATED OK", got "${clip2}"`);
    log.info('selftest: translate mode ok');

    log.info('SELFTEST PASS');
    app.exit(0);
  } catch (e) {
    log.error('SELFTEST FAIL:', e);
    app.exit(1);
  }
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Quit cleanly on Ctrl+C / SIGTERM (parity with the daemon's signal handlers).
process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());

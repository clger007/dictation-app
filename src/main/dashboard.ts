// Dashboard/settings window + its IPC backend. Replaces the daemon's HTTP
// dashboard (:8765) with a BrowserWindow over typed IPC (cross_plat_design §6).
// The window is a singleton: reopening from the tray focuses the existing one.
import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { Controller } from './controller';
import { dailyStats, readHistory } from './history';
import { IPC } from './ipc';
import { log } from './logger';

let win: BrowserWindow | null = null;
let ipcRegistered = false;

/** Register the dashboard IPC handlers (once). */
export function registerDashboardIpc(ctrl: Controller): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(IPC.dashboard.stats, async () => dailyStats(ctrl.history.path));

  ipcMain.handle(IPC.dashboard.history, async (_e, limit?: number) => {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const items = await readHistory(ctrl.history.path, n);
    return items.reverse(); // newest first
  });

  ipcMain.handle(IPC.dashboard.getSettings, async () => ctrl.dashboardSettings());

  ipcMain.handle(
    IPC.dashboard.saveSettings,
    async (_e, input: Parameters<Controller['dashboardUpdate']>[0]) =>
      ctrl.dashboardUpdate(input || {}),
  );

  ipcMain.handle(IPC.dashboard.captureHotkey, async () => ctrl.captureHotkey());
}

/** Open (or focus) the dashboard window. */
export function openDashboard(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    title: 'Dictation — Dashboard',
    backgroundColor: '#0e1014',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/dashboard.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The compiled preload require()s shared modules (dist/main/ipc.js), which
      // the renderer sandbox forbids — preloads keep Node access, page does not.
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(join(__dirname, '../renderer/dashboard/index.html')).catch((e) => {
    log.error('dashboard load failed:', e);
  });
  return win;
}

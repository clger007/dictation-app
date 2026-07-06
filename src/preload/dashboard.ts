// Preload for the dashboard/settings renderer. Replaces the daemon's HTTP
// `fetch('/api/*')` with a contextBridge `window.api.*` over IPC
// (cross_plat_design §6). M0 stub: the dashboard window lands in M3; this defines
// the bridge the ported HTML will call (stats/history/getSettings/saveSettings).
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc';

export interface SaveSettingsInput {
  engine?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
}

const api = {
  stats: () => ipcRenderer.invoke(IPC.dashboard.stats),
  history: (limit = 100) => ipcRenderer.invoke(IPC.dashboard.history, limit),
  getSettings: () => ipcRenderer.invoke(IPC.dashboard.getSettings),
  saveSettings: (input: SaveSettingsInput) =>
    ipcRenderer.invoke(IPC.dashboard.saveSettings, input),
};

contextBridge.exposeInMainWorld('api', api);

export type DashboardApi = typeof api;

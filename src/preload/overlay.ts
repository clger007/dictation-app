// Preload for the overlay (pill) renderer. Exposes a minimal, typed API over the
// contextBridge — contextIsolation:true, nodeIntegration:false, no Node in the
// renderer. Main pushes full state changes and rms-only level updates on the
// same channel; either field may be absent.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc';

export interface OverlayState {
  state?: 'listening' | 'transcribing' | 'info' | 'error';
  text?: string;
  rms?: number;
  variant?: 'dictate' | 'translate';
}

const api = {
  onState(cb: (s: OverlayState) => void): void {
    ipcRenderer.on(IPC.overlay.state, (_e, s: OverlayState) => cb(s));
  },
  onDismiss(cb: () => void): void {
    ipcRenderer.on(IPC.overlay.dismiss, () => cb());
  },
};

contextBridge.exposeInMainWorld('overlay', api);

export type OverlayApi = typeof api;

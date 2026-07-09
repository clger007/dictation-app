// Preload for the hidden recorder renderer (the only place that may call
// getUserMedia — cross_plat_design §3.1/§5). Exposes a typed bridge for main to
// start/stop capture and for the renderer to return a WAV buffer + live RMS.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc';

export interface RecorderStartOptions {
  device: string; // "default" or a device label substring
  tailMs: number; // keep capturing this long after stop
}

const api = {
  // main -> renderer
  onStart(cb: (opts: RecorderStartOptions) => void): void {
    ipcRenderer.on(IPC.recorder.start, (_e, opts: RecorderStartOptions) => cb(opts));
  },
  onStop(cb: () => void): void {
    ipcRenderer.on(IPC.recorder.stop, () => cb());
  },
  // renderer -> main
  sendStarted(): void {
    ipcRenderer.send(IPC.recorder.started);
  },
  sendWav(buffer: ArrayBuffer): void {
    ipcRenderer.send(IPC.recorder.wav, buffer);
  },
  sendRms(level: number): void {
    ipcRenderer.send(IPC.recorder.rms, level);
  },
  sendError(message: string): void {
    ipcRenderer.send(IPC.recorder.error, message);
  },
};

contextBridge.exposeInMainWorld('recorder', api);

export type RecorderApi = typeof api;

// Preload for the hidden recorder renderer (the only place that may call
// getUserMedia — cross_plat_design §3.1/§5). Exposes a typed bridge for main to
// start/stop capture and for the renderer to return a WAV buffer + live RMS.
// M0 stub: the getUserMedia + AudioWorklet pipeline lands in M1.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc';

const api = {
  // main -> renderer
  onStart(cb: () => void): void {
    ipcRenderer.on(IPC.recorder.start, () => cb());
  },
  onStop(cb: () => void): void {
    ipcRenderer.on(IPC.recorder.stop, () => cb());
  },
  // renderer -> main
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

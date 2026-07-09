// Recorder — owns the hidden getUserMedia window and exposes a promise-based
// start()/stop() surface to the controller (cross_plat_design §5). The renderer
// does the capture + WAV encode; this side just routes IPC and hands back bytes.
import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { IPC } from './ipc';
import { log } from './logger';

export interface RecorderStartOptions {
  device: string;
  tailMs: number;
}

export class Recorder {
  /** Live mic level consumer (the overlay meter). */
  onRms: ((rms: number) => void) | null = null;

  private win: BrowserWindow | null = null;
  private startWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private stopWaiter: { resolve: (wav: Buffer) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    ipcMain.on(IPC.recorder.started, () => {
      this.startWaiter?.resolve();
      this.startWaiter = null;
    });
    ipcMain.on(IPC.recorder.wav, (_e, buf: ArrayBuffer) => {
      this.stopWaiter?.resolve(Buffer.from(buf));
      this.stopWaiter = null;
    });
    ipcMain.on(IPC.recorder.error, (_e, message: string) => {
      const err = new Error(message);
      this.startWaiter?.reject(err);
      this.startWaiter = null;
      this.stopWaiter?.reject(err);
      this.stopWaiter = null;
    });
    ipcMain.on(IPC.recorder.rms, (_e, rms: number) => {
      this.onRms?.(rms);
    });
  }

  /** Create (once) the hidden capture window and wait until it has loaded. */
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      show: false,
      width: 80,
      height: 60,
      webPreferences: {
        preload: join(__dirname, '../preload/recorder.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Same sandbox caveat as the dashboard: the preload require()s ipc.js.
        sandbox: false,
      },
    });
    this.win.on('closed', () => {
      this.win = null;
    });
    await this.win.loadFile(join(__dirname, '../renderer/recorder/index.html'));
    return this.win;
  }

  /** Begin capture. Resolves once audio is actually flowing; rejects on mic errors. */
  async start(opts: RecorderStartOptions): Promise<void> {
    const win = await this.ensureWindow();
    return new Promise<void>((resolve, reject) => {
      this.startWaiter = { resolve, reject };
      const timer = setTimeout(() => {
        if (this.startWaiter) {
          this.startWaiter = null;
          reject(new Error('recorder did not start within 10s (mic permission?)'));
        }
      }, 10_000);
      const orig = this.startWaiter;
      this.startWaiter = {
        resolve: () => {
          clearTimeout(timer);
          orig.resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          orig.reject(e);
        },
      };
      win.webContents.send(IPC.recorder.start, opts);
    });
  }

  /** End capture (after the configured tail) and return the finished WAV bytes. */
  async stop(): Promise<Buffer> {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('recorder window is not running');
    }
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.stopWaiter) {
          this.stopWaiter = null;
          reject(new Error('recorder did not return audio within 15s'));
        }
      }, 15_000);
      this.stopWaiter = {
        resolve: (wav) => {
          clearTimeout(timer);
          resolve(wav);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.win!.webContents.send(IPC.recorder.stop);
    });
  }

  destroy(): void {
    try {
      this.win?.destroy();
    } catch (e) {
      log.warn('recorder window destroy failed:', e);
    }
    this.win = null;
  }
}

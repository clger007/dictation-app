// Controller — the recording state machine (port of dictate.py's `Dictation`).
//
// Because Node/JS is single-threaded, the daemon's `_busy`/`_lock` serialization
// collapses into a plain state flag + a `busy` boolean (cross_plat_design §3.1):
//   idle -> listening -> transcribing -> idle
// Overlapping triggers are refused while busy, exactly as today.
//
// M0: the lifecycle (start/stop/finish), engine build/reload, and dashboard
// backend are wired, but audio capture (recorder renderer, M1), the overlay
// (M1), and real transcription/insertion (M1/M2) are stubs. `transcribe()`
// throwing is handled the same way the daemon handles a failed engine: flash and
// return to idle without losing anything.
import { Config, type AppConfig } from './config';
import { History } from './history';
import { Cleaner } from './engines/cleaner';
import { CloudEngine } from './engines/cloud';
import { LocalEngine } from './engines/local';
import type { Engine } from './engines/types';
import { createPlatformAdapter, type FocusTarget, type PlatformAdapter } from './platform';
import { Hotkeys } from './hotkeys';
import { setClipboard } from './clipboard';
import { log } from './logger';

export type State = 'idle' | 'listening' | 'transcribing';

export interface DashboardSettings {
  engine: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  local_model: string;
}

/** Port of `mask_key`: show a hint without revealing the secret. */
export function maskKey(k: string): string {
  const key = (k || '').trim();
  if (!key) return '';
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : 'set';
}

export class Controller {
  readonly config: Config;
  readonly history: History;
  readonly cleaner: Cleaner;
  readonly adapter: PlatformAdapter;
  readonly hotkeys: Hotkeys;

  private cfg: AppConfig;
  engine!: Engine;
  engineName!: string;

  private stateValue: State = 'idle';
  private busy = false; // a finish() is still running
  private capturedTarget: FocusTarget | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stateListeners = new Set<(s: State) => void>();
  private menuListeners = new Set<() => void>();

  private constructor(config: Config, history: History) {
    this.config = config;
    this.history = history;
    this.cfg = config.get();
    this.cleaner = new Cleaner(this.cfg);
    this.adapter = createPlatformAdapter();
    this.hotkeys = new Hotkeys(this.cfg.keys.mode, this.cfg.keys.key);
    this.buildEngine();
    this.hotkeys.register({
      onStart: () => this.start(),
      onStop: () => this.stop(),
    });
  }

  static async create(config: Config): Promise<Controller> {
    const history = new History(config.get(), pathDir(config.path));
    await history.loadRecent();
    return new Controller(config, history);
  }

  // -- lifecycle wiring ----------------------------------------------------- //
  /** Begin listening for the hotkey (no-op binding in M0). */
  startListening(): void {
    this.hotkeys.start();
    const k = this.cfg.keys.key;
    if (this.cfg.keys.mode === 'hold') {
      log.info(`Dictation ready — hold [${k}] to talk.`);
    } else {
      log.info(`Dictation ready — press [${k}] to start/stop.`);
    }
  }

  get state(): State {
    return this.stateValue;
  }

  onStateChange(fn: (s: State) => void): void {
    this.stateListeners.add(fn);
  }

  /** Register a callback fired when the tray menu should be rebuilt. */
  onMenuChange(fn: () => void): void {
    this.menuListeners.add(fn);
  }

  private setState(s: State): void {
    this.stateValue = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private refreshMenu(): void {
    for (const fn of this.menuListeners) fn();
  }

  // -- engine (re)build, shared by startup and dashboard reload ------------- //
  private buildEngine(): void {
    this.engineName = this.cfg.general.engine;
    this.engine =
      this.engineName === 'cloud' ? new CloudEngine(this.cfg) : new LocalEngine(this.cfg);
  }

  // -- recording lifecycle (port of start/stop/_finish) --------------------- //
  async start(): Promise<void> {
    if (this.stateValue !== 'idle') return; // already listening
    if (this.busy) {
      log.info('Still finishing the previous dictation…');
      return;
    }
    // Capture focus/window now, so guard_focus can compare at delivery time.
    this.capturedTarget = await this.adapter.getFocusedTarget();
    this.setState('listening');
    log.info('Listening… (audio capture lands in M1)');
    const maxMs = Math.max(1, this.cfg.audio.max_seconds) * 1000;
    this.watchdog = setTimeout(() => this.autoStop(), maxMs);
  }

  private autoStop(): void {
    if (this.stateValue === 'listening') {
      log.info('Max length reached, stopping.');
      void this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stateValue !== 'listening') return;
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.busy = true;
    const target = this.capturedTarget;
    await this.finish(target);
  }

  private async finish(target: FocusTarget | null): Promise<void> {
    try {
      this.setState('transcribing');
      log.info('Transcribing… (engine not wired until M1)');

      // M1 provides the WAV path from the recorder renderer.
      let raw: string;
      try {
        raw = await this.engine.transcribe('/tmp/dictation_rec.wav');
      } catch (e) {
        log.warn('Transcription unavailable in M0:', e);
        return;
      }
      if (!raw) {
        log.info('(nothing recognized)');
        return;
      }

      // Optional LLM cleanup; fall back to raw on failure (daemon behavior).
      let cleaned = false;
      let text = raw;
      if (this.cleaner.enabled) {
        try {
          text = await this.cleaner.clean(raw);
          cleaned = text !== raw;
        } catch (e) {
          log.warn('Cleanup failed, using raw text:', e);
          text = raw;
        }
      }

      let destination = 'failed';
      try {
        destination = await this.adapter.insert(text, {
          mode: this.cfg.output.mode,
          guardWindow: this.cfg.output.guard_focus ? target?.id : undefined,
        });
      } catch (e) {
        log.error('deliver() error:', e);
      }
      log.info(`${destination}: ${text.slice(0, 60)}`);
      await this.history.add({
        raw,
        text,
        cleaned,
        destination,
        engine: this.engineName,
      });
    } finally {
      this.setState('idle');
      this.refreshMenu();
      this.busy = false;
    }
  }

  // -- tray helpers --------------------------------------------------------- //
  copy(text: string): void {
    setClipboard(text);
    log.info('Copied to clipboard');
  }

  setCleanupEnabled(enabled: boolean): void {
    this.cleaner.enabled = enabled;
    log.info(`LLM cleanup ${enabled ? 'on' : 'off'}`);
  }

  // -- dashboard backend (port of dashboard_settings/dashboard_update) ------ //
  dashboardSettings(): DashboardSettings {
    const cc = this.cfg.cloud;
    return {
      engine: this.cfg.general.engine,
      base_url: cc.base_url,
      model: cc.model,
      api_key_masked: maskKey(cc.api_key),
      local_model: this.cfg.local.model,
    };
  }

  /** Apply dashboard settings to config.toml (comment-preserving) + reload engine. */
  async dashboardUpdate(
    data: Partial<{ engine: string; base_url: string; model: string; api_key: string }>,
  ): Promise<{ ok: boolean; error: string | null }> {
    const engine = (data.engine || '').trim().toLowerCase();
    if (engine && engine !== 'local' && engine !== 'cloud') {
      return { ok: false, error: `invalid engine '${engine}'` };
    }
    try {
      if (engine) await this.config.setValue('general', 'engine', engine);
      if ('base_url' in data)
        await this.config.setValue('cloud', 'base_url', (data.base_url || '').trim());
      if ('model' in data)
        await this.config.setValue('cloud', 'model', (data.model || '').trim());
      const key = (data.api_key || '').trim();
      if (key) await this.config.setValue('cloud', 'api_key', key);
    } catch (e) {
      return { ok: false, error: `writing config: ${String(e)}` };
    }
    try {
      this.cfg = await this.config.reload();
      this.buildEngine();
    } catch (e) {
      return { ok: false, error: `reloading engine: ${String(e)}` };
    }
    log.info(`Engine reloaded: ${this.engineName}`);
    this.refreshMenu();
    return { ok: true, error: null };
  }

  quit(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.hotkeys.stop();
  }
}

/** Directory containing the config file — used to place history.jsonl by default. */
function pathDir(configPath: string): string {
  const idx = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  return idx > 0 ? configPath.slice(0, idx) : '.';
}

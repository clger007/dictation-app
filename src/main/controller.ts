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
import { Notification, app } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Config, type AppConfig, type CleanupLevel } from './config';
import { History } from './history';
import { Cleaner } from './engines/cleaner';
import { CloudEngine } from './engines/cloud';
import { LocalEngine } from './engines/local';
import { Translator } from './engines/translator';
import type { Engine } from './engines/types';
import { createPlatformAdapter, type FocusTarget, type PlatformAdapter } from './platform';
import { Hotkeys, parseKey, type HotkeyMode } from './hotkeys';
import { NativeKeyMonitor } from './keymonitor';
import { Recorder } from './recorder';
import {
  configureOverlay,
  destroyOverlay,
  overlayLevel,
  overlayResult,
  overlayState,
} from './overlay';
import { setClipboard } from './clipboard';
import { log } from './logger';

export type State = 'idle' | 'listening' | 'transcribing';
export type DictationMode = 'dictate' | 'translate';

// Prompt lever for mixed-language (code-switching) recordings: naming both
// languages and including CJK characters nudges the model to keep BOTH instead
// of collapsing to one. (Same trick the Python daemon used.)
export const BILINGUAL_PROMPT =
  'The speaker may mix English and Chinese (中文) in the same sentence. ' +
  'Transcribe each part in the language it was spoken — 保留中英文混合，不要翻译。';

export type LanguageMode = 'auto' | 'en' | 'zh' | 'bilingual';

export interface DashboardSettings {
  engine: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  local_model: string;
  hotkey: string; // display, e.g. "f9 (toggle)"
  hotkey_key: string; // editable
  hotkey_mode: string; // editable
  translate_key: string; // editable; "" = unbound
  translate_target: string; // editable
  language_mode: LanguageMode; // editable
  cleanup_enabled: boolean; // editable
  cleanup_level: CleanupLevel; // editable
  native_keys: boolean; // whether press-to-record / fn / hold are available
  output_mode: string; // display-only
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
  cleaner: Cleaner;
  translator!: Translator;
  readonly adapter: PlatformAdapter;
  readonly monitor: NativeKeyMonitor;
  hotkeys: Hotkeys;
  translateHotkeys: Hotkeys | null = null;
  readonly recorder: Recorder;

  private cfg: AppConfig;
  engine!: Engine;
  engineName!: string;

  private stateValue: State = 'idle';
  private activeMode: DictationMode = 'dictate';
  private busy = false; // a finish() is still running
  private capturedTarget: FocusTarget | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stateListeners = new Set<(s: State) => void>();
  private menuListeners = new Set<() => void>();

  private constructor(config: Config, history: History, monitor: NativeKeyMonitor) {
    this.config = config;
    this.history = history;
    this.monitor = monitor;
    this.cfg = config.get();
    this.cleaner = new Cleaner(this.cfg);
    this.adapter = createPlatformAdapter();
    this.hotkeys = new Hotkeys(this.cfg.keys.mode, this.cfg.keys.key, this.nativeMonitor);
    this.recorder = new Recorder();
    this.recorder.onRms = (rms) => {
      if (this.cfg.ui.overlay) overlayLevel(rms);
    };
    configureOverlay(this.cfg.ui.overlay_position);
    this.buildEngine();
    this.hotkeys.register(this.hotkeyHandlers('dictate'));
    if (this.cfg.translate.key) {
      this.translateHotkeys = new Hotkeys(
        this.cfg.keys.mode,
        this.cfg.translate.key,
        this.nativeMonitor,
      );
      this.translateHotkeys.register(this.hotkeyHandlers('translate'));
    }
  }

  /** The native monitor, or null when it failed to start (fallback binding). */
  private get nativeMonitor(): NativeKeyMonitor | null {
    return this.monitor.available ? this.monitor : null;
  }

  static async create(config: Config): Promise<Controller> {
    const history = new History(config.get(), pathDir(config.path));
    await history.loadRecent();
    const monitor = new NativeKeyMonitor();
    const native = await monitor.start();
    log.info(
      native
        ? 'Native key monitor active (fn key, hold-to-talk, press-to-record).'
        : 'Native key monitor unavailable — using basic hotkeys (no fn key). Grant Accessibility and restart to enable it.',
    );
    return new Controller(config, history, monitor);
  }

  // -- lifecycle wiring ----------------------------------------------------- //
  /** Bind the global hotkeys. */
  startListening(): void {
    this.hotkeys.start();
    this.translateHotkeys?.start();
    const k = this.cfg.keys.key;
    const verb = this.cfg.keys.mode === 'hold' ? `hold [${k}] to talk` : `press [${k}] to start/stop`;
    const tk = this.cfg.translate.key;
    log.info(`Dictation ready — ${verb}${tk ? `; [${tk}] to translate` : ''}.`);
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
    this.cleaner = new Cleaner(this.cfg);
    this.translator = new Translator(this.cfg);
  }

  /** User-facing error surface: pill flash + notification (if enabled) + log. */
  private notifyError(message: string): void {
    log.warn(message);
    if (this.cfg.ui.overlay) void overlayResult('error', message, 3500);
    if (this.cfg.general.notifications && Notification.isSupported()) {
      new Notification({ title: 'Dictation', body: message }).show();
    }
  }

  /** Short pill label for a delivery destination. */
  private static resultLabel(destination: string, text: string): string {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (destination === 'pasted' || destination === 'typed') return `Inserted ✓ (${words} words)`;
    if (destination.startsWith('clipboard (needs Accessibility'))
      return 'Copied — grant Accessibility to auto-insert';
    if (destination.startsWith('clipboard (focus changed'))
      return 'Copied — window changed mid-dictation';
    if (destination.startsWith('clipboard')) return `Copied to clipboard (${words} words)`;
    return 'Delivery failed';
  }

  // -- recording lifecycle (port of start/stop/_finish) --------------------- //
  async start(mode: DictationMode = 'dictate'): Promise<void> {
    if (this.stateValue !== 'idle') return; // already listening
    if (this.busy) {
      log.info('Still finishing the previous dictation…');
      return;
    }
    this.activeMode = mode;
    // Capture focus/window now, so guard_focus can compare at delivery time.
    this.capturedTarget = await this.adapter.getFocusedTarget();
    try {
      await this.recorder.start({
        device: this.cfg.audio.device,
        tailMs: this.cfg.audio.tail_ms,
      });
    } catch (e) {
      this.notifyError(`Microphone unavailable: ${e instanceof Error ? e.message : e}`);
      return;
    }
    this.setState('listening');
    if (this.cfg.ui.overlay) {
      const label =
        mode === 'translate' ? `Listening → ${this.translator.target}…` : 'Listening…';
      void overlayState('listening', label, mode);
    }
    log.info(mode === 'translate' ? `Listening (translate → ${this.translator.target})…` : 'Listening…');
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
    const mode = this.activeMode;
    let delivered: string | null = null; // pill label, shown on success
    try {
      this.setState('transcribing');
      if (this.cfg.ui.overlay) {
        const label = mode === 'translate' ? `Translating → ${this.translator.target}…` : 'Transcribing…';
        void overlayState('transcribing', label, mode);
      }
      log.info(mode === 'translate' ? 'Transcribing + translating…' : 'Transcribing…');

      // Collect the finished WAV from the recorder and stage it for the engine.
      let wavPath: string;
      try {
        const wav = await this.recorder.stop();
        wavPath = join(app.getPath('temp'), 'dictation_rec.wav');
        await writeFile(wavPath, wav);
      } catch (e) {
        this.notifyError(`Recording failed: ${e instanceof Error ? e.message : e}`);
        return;
      }

      let raw: string;
      try {
        raw = await this.engine.transcribe(wavPath);
      } catch (e) {
        this.notifyError(`Transcription failed: ${e instanceof Error ? e.message : e}`);
        return;
      }
      if (!raw) {
        log.info('(nothing recognized)');
        if (this.cfg.ui.overlay) void overlayResult('info', 'Nothing recognized');
        return;
      }

      // Translate mode: deliver the translation instead of the transcript.
      let cleaned = false;
      let text = raw;
      if (mode === 'translate') {
        try {
          text = await this.translator.translate(raw);
          cleaned = true;
        } catch (e) {
          this.notifyError(`Translation failed: ${e instanceof Error ? e.message : e}`);
          return;
        }
      } else if (this.cleaner.enabled) {
        // Optional LLM cleanup; fall back to raw on failure (daemon behavior).
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
          restoreClipboard: this.cfg.output.restore_clipboard,
          pasteWaitMs: this.cfg.output.paste_wait_ms,
        });
      } catch (e) {
        log.error('deliver() error:', e);
      }
      log.info(`${destination}: ${text.slice(0, 60)}`);
      delivered = Controller.resultLabel(destination, text);
      if (mode === 'translate') delivered = `🌐 ${delivered}`;
      await this.history.add({
        raw,
        text,
        cleaned,
        destination,
        engine: mode === 'translate' ? `${this.engineName}+translate` : this.engineName,
      });
    } finally {
      this.setState('idle');
      // Every failure path above flashed its own pill message; flash success here.
      if (this.cfg.ui.overlay && delivered) {
        void overlayResult(delivered.startsWith('Delivery') ? 'error' : 'info', delivered);
      }
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
    void this.config.setValue('cleanup', 'enabled', enabled).catch((e) => {
      log.warn('could not persist cleanup toggle:', e);
    });
    log.info(`LLM cleanup ${enabled ? 'on' : 'off'}`);
  }

  // -- dashboard backend (port of dashboard_settings/dashboard_update) ------ //
  /** Current language mode, derived from [general].language + [cloud].prompt. */
  private languageMode(): LanguageMode {
    if (this.cfg.cloud.prompt === BILINGUAL_PROMPT) return 'bilingual';
    if (this.cfg.general.language === 'en') return 'en';
    if (this.cfg.general.language === 'zh') return 'zh';
    return 'auto';
  }

  dashboardSettings(): DashboardSettings {
    const cc = this.cfg.cloud;
    return {
      engine: this.cfg.general.engine,
      base_url: cc.base_url,
      model: cc.model,
      api_key_masked: maskKey(cc.api_key),
      local_model: this.cfg.local.model,
      hotkey: `${this.cfg.keys.key} (${this.cfg.keys.mode})`,
      hotkey_key: this.cfg.keys.key,
      hotkey_mode: this.cfg.keys.mode,
      translate_key: this.cfg.translate.key,
      translate_target: this.cfg.translate.target,
      language_mode: this.languageMode(),
      cleanup_enabled: this.cleaner.enabled,
      cleanup_level: this.cfg.cleanup.level,
      native_keys: this.monitor.available,
      output_mode: this.cfg.output.mode,
    };
  }

  /** The hotkey press handlers, shared by startup binding and live rebinds. */
  private hotkeyHandlers(mode: DictationMode) {
    return {
      onStart: () => void this.start(mode),
      onStop: () => void this.stop(),
      isActive: () => this.stateValue !== 'idle',
    };
  }

  /**
   * Re-bind a global hotkey live. Validates + registers the new key before
   * anything is persisted; on failure the previous binding is restored.
   * An empty key unbinds (allowed for translate only).
   */
  private rebindHotkey(
    which: DictationMode,
    key: string,
    mode: HotkeyMode,
  ): { ok: boolean; error: string | null } {
    const current = which === 'dictate' ? this.hotkeys : this.translateHotkeys;
    if (!key) {
      if (which === 'dictate') {
        return { ok: false, error: 'the dictation hotkey cannot be empty' };
      }
      current?.stop();
      this.translateHotkeys = null;
      return { ok: true, error: null };
    }
    if (!parseKey(key)) {
      return {
        ok: false,
        error: `invalid hotkey '${key}' — try f1–f24, fn, a letter, or ctrl+shift+d`,
      };
    }
    current?.stop();
    const next = new Hotkeys(mode, key, this.nativeMonitor);
    next.register(this.hotkeyHandlers(which));
    if (!next.start()) {
      current?.start(); // roll back to the old binding
      return { ok: false, error: `could not bind '${key}' (reserved, in use, or needs Accessibility)` };
    }
    if (which === 'dictate') this.hotkeys = next;
    else this.translateHotkeys = next;
    return { ok: true, error: null };
  }

  /** Press-to-record: capture the next combo the user presses (or null). */
  async captureHotkey(): Promise<string | null> {
    if (!this.monitor.available) return null;
    return this.monitor.captureNext(10_000);
  }

  /** Apply dashboard settings to config.toml (comment-preserving) + reload engine. */
  async dashboardUpdate(
    data: Partial<{
      engine: string;
      base_url: string;
      model: string;
      api_key: string;
      hotkey_key: string;
      hotkey_mode: string;
      translate_key: string;
      translate_target: string;
      language_mode: string;
      cleanup_enabled: boolean;
      cleanup_level: string;
    }>,
  ): Promise<{ ok: boolean; error: string | null }> {
    const engine = (data.engine || '').trim().toLowerCase();
    if (engine && engine !== 'local' && engine !== 'cloud') {
      return { ok: false, error: `invalid engine '${engine}'` };
    }
    const level = (data.cleanup_level || '').trim().toLowerCase();
    if (level && !['light', 'standard', 'fluent'].includes(level)) {
      return { ok: false, error: `invalid cleanup level '${level}'` };
    }
    const langMode = (data.language_mode || '').trim().toLowerCase();
    if (langMode && !['auto', 'en', 'zh', 'bilingual'].includes(langMode)) {
      return { ok: false, error: `invalid language mode '${langMode}'` };
    }

    // Hotkeys: validate + bind BEFORE persisting, so a bad key never sticks.
    const wantKey = (data.hotkey_key || '').trim().toLowerCase();
    const wantMode = ((data.hotkey_mode || '').trim().toLowerCase() ||
      this.cfg.keys.mode) as HotkeyMode;
    const hotkeyChanged =
      wantKey && (wantKey !== this.cfg.keys.key || wantMode !== this.cfg.keys.mode);
    if (hotkeyChanged) {
      const bound = this.rebindHotkey('dictate', wantKey, wantMode);
      if (!bound.ok) return bound;
    }
    const wantTKey = ('translate_key' in data ? data.translate_key || '' : this.cfg.translate.key)
      .trim()
      .toLowerCase();
    const tkeyChanged = 'translate_key' in data && wantTKey !== this.cfg.translate.key;
    if (tkeyChanged) {
      if (wantTKey && wantTKey === (hotkeyChanged ? wantKey : this.cfg.keys.key)) {
        return { ok: false, error: 'translate hotkey must differ from the dictation hotkey' };
      }
      const bound = this.rebindHotkey('translate', wantTKey, wantMode);
      if (!bound.ok) return bound;
    }

    try {
      if (engine) await this.config.setValue('general', 'engine', engine);
      if ('base_url' in data)
        await this.config.setValue('cloud', 'base_url', (data.base_url || '').trim());
      if ('model' in data)
        await this.config.setValue('cloud', 'model', (data.model || '').trim());
      const key = (data.api_key || '').trim();
      if (key) await this.config.setValue('cloud', 'api_key', key);
      if (hotkeyChanged) {
        await this.config.setValue('keys', 'key', wantKey);
        await this.config.setValue('keys', 'mode', wantMode);
      }
      if (tkeyChanged) await this.config.setValue('translate', 'key', wantTKey);
      if ('translate_target' in data) {
        await this.config.setValue(
          'translate',
          'target',
          (data.translate_target || 'English').trim() || 'English',
        );
      }
      if (langMode) {
        // Language mode maps onto [general].language + the [cloud].prompt lever.
        const language = langMode === 'en' ? 'en' : langMode === 'zh' ? 'zh' : '';
        await this.config.setValue('general', 'language', language);
        const wasBilingual = this.cfg.cloud.prompt === BILINGUAL_PROMPT;
        if (langMode === 'bilingual') {
          await this.config.setValue('cloud', 'prompt', BILINGUAL_PROMPT);
        } else if (wasBilingual) {
          await this.config.setValue('cloud', 'prompt', '');
        }
      }
      if ('cleanup_enabled' in data) {
        await this.config.setValue('cleanup', 'enabled', !!data.cleanup_enabled);
      }
      if (level) await this.config.setValue('cleanup', 'level', level);
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
    this.translateHotkeys?.stop();
    this.monitor.destroy();
    this.recorder.destroy();
    destroyOverlay();
  }
}

/** Directory containing the config file — used to place history.jsonl by default. */
function pathDir(configPath: string): string {
  const idx = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  return idx > 0 ? configPath.slice(0, idx) : '.';
}

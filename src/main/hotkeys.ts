// Global hotkey binding with two backends:
//  - NativeKeyMonitor (keytap event tap): any combo incl. the Fn/Globe key,
//    true keydown/keyup so 'hold' (push-to-talk) works.
//  - Electron globalShortcut fallback: toggle only, no Fn, no bare modifiers.
//
// Combos are canonical lowercase strings ("f9", "fn", "ctrl+shift+d").
import { globalShortcut } from 'electron';
import { canonicalCombo, type NativeKeyMonitor } from './keymonitor';
import { log } from './logger';

export type HotkeyMode = 'toggle' | 'hold';

export interface HotkeyHandlers {
  onStart(): void; // begin recording
  onStop(): void; // end recording
  /** Current recording state, so toggle presses can't drift out of sync. */
  isActive?(): boolean;
}

/** Canonical combo -> Electron accelerator, or null if inexpressible (fn…). */
export function toAccelerator(combo: string): string | null {
  if (combo === 'fn' || combo.includes('fn+')) return null;
  const MAP: Record<string, string> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    cmd: 'Cmd',
    enter: 'Return',
    backspace: 'Backspace',
    escape: 'Escape',
    space: 'Space',
    tab: 'Tab',
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    delete: 'Delete',
  };
  return combo
    .split('+')
    .map((p) => MAP[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join('+');
}

/** Validate + canonicalize user input ("F9", "Ctrl + D", "fn"). Null = invalid. */
export function parseKey(name: string): string | null {
  return canonicalCombo((name || '').trim());
}

export class Hotkeys {
  private readonly mode: HotkeyMode;
  private readonly combo: string | null;
  private handlers: HotkeyHandlers | null = null;
  private running = false;
  private backend: 'native' | 'electron' | null = null;
  private monitor: NativeKeyMonitor | null;

  constructor(mode: HotkeyMode, key: string, monitor: NativeKeyMonitor | null) {
    this.mode = mode;
    this.combo = parseKey(key);
    this.monitor = monitor;
  }

  register(handlers: HotkeyHandlers): void {
    this.handlers = handlers;
  }

  /** Bind the hotkey. Returns whether it is actually bound. */
  start(): boolean {
    if (this.running) return true;
    if (!this.combo) {
      log.error('Hotkeys: invalid or empty key — hotkey disabled');
      return false;
    }

    if (this.monitor?.available) {
      this.monitor.bind({
        combo: this.combo,
        onDown: () => this.onDown(),
        onUp: (clean) => this.onUp(clean),
      });
      this.backend = 'native';
      this.running = true;
      log.info(`Hotkeys: bound [${this.combo}] (${this.mode}, native)`);
      return true;
    }

    // Fallback: Electron accelerator (no fn, keydown only -> toggle).
    const acc = toAccelerator(this.combo);
    if (!acc) {
      log.error(
        `Hotkeys: [${this.combo}] needs the native key monitor (grant Accessibility, then restart)`,
      );
      return false;
    }
    if (this.mode === 'hold') {
      log.warn("Hotkeys: 'hold' needs the native monitor — falling back to toggle.");
    }
    try {
      const ok = globalShortcut.register(acc, () => this.togglePress());
      if (!ok) {
        log.error(`Hotkeys: could not register [${acc}] (taken by another app?)`);
        return false;
      }
      this.backend = 'electron';
      this.running = true;
      log.info(`Hotkeys: bound [${acc}] (toggle, fallback)`);
      return true;
    } catch (e) {
      log.error('Hotkeys: register failed:', e);
      return false;
    }
  }

  stop(): void {
    if (!this.running || !this.combo) {
      this.running = false;
      return;
    }
    if (this.backend === 'native') {
      this.monitor?.unbind(this.combo);
    } else if (this.backend === 'electron') {
      const acc = toAccelerator(this.combo);
      if (acc) {
        try {
          globalShortcut.unregister(acc);
        } catch {
          /* app may be quitting */
        }
      }
    }
    this.backend = null;
    this.running = false;
  }

  // --- native backend press/release routing --------------------------------
  private onDown(): void {
    if (!this.handlers) return;
    if (this.mode === 'hold') {
      this.handlers.onStart();
      return;
    }
    // toggle: bare fn acts on clean release (fn+arrow must not toggle);
    // everything else acts on press.
    if (this.combo !== 'fn') this.togglePress();
  }

  private onUp(clean: boolean): void {
    if (!this.handlers) return;
    if (this.mode === 'hold') {
      this.handlers.onStop();
      return;
    }
    if (this.combo === 'fn' && clean) this.togglePress();
  }

  private togglePress(): void {
    if (!this.handlers) return;
    if (this.handlers.isActive?.()) {
      this.handlers.onStop();
    } else {
      this.handlers.onStart();
    }
  }
}

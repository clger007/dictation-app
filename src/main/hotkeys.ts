// Global hotkey wrapper (port of the daemon's pynput listener).
//
// Target backend is `uiohook-napi` (native keydown/keyup, supports hold-to-talk,
// unlike Electron's toggle-only globalShortcut — cross_plat_design §4.2). M0
// STUB: no native binding yet (M1 adds uiohook). This defines the key-parsing +
// toggle/hold press/release plumbing so the controller can be wired now.
import { log } from './logger';

export type HotkeyMode = 'toggle' | 'hold';

export interface HotkeyHandlers {
  onStart(): void; // begin recording
  onStop(): void; // end recording
}

/**
 * Normalize a config key name (e.g. "f9", "a") to a canonical form. In M1 this
 * maps to a uiohook keycode; for now it just lowercases/trims so downstream code
 * has a stable value and invalid keys are visible in logs.
 */
export function parseKey(name: string): string {
  return (name || '').trim().toLowerCase();
}

export class Hotkeys {
  private readonly mode: HotkeyMode;
  private readonly key: string;
  private handlers: HotkeyHandlers | null = null;
  private running = false;
  private keyHeld = false; // ignore auto-repeat in toggle mode
  private recording = false; // local view of state for toggle logic

  constructor(mode: HotkeyMode, key: string) {
    this.mode = mode;
    this.key = parseKey(key);
  }

  /** Register the start/stop handlers. Does not bind the key until start(). */
  register(handlers: HotkeyHandlers): void {
    this.handlers = handlers;
  }

  /** Begin listening for the global hotkey. M0: logs only (no native binding). */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info(
      `Hotkeys stub: would bind [${this.key}] in '${this.mode}' mode (uiohook lands in M1)`,
    );
  }

  /** Stop listening and release the native hook. */
  stop(): void {
    this.running = false;
    this.keyHeld = false;
  }

  // --- Press/release logic (ported from on_press/on_release) ----------------
  // These are the callbacks uiohook will drive in M1; exposed now so the wiring
  // and its unit behavior exist and can be tested without the native module.

  handlePress(): void {
    if (!this.handlers) return;
    if (this.mode === 'hold') {
      this.handlers.onStart(); // guarded against auto-repeat by the controller
      return;
    }
    // toggle: act once per physical press, ignore auto-repeat.
    if (this.keyHeld) return;
    this.keyHeld = true;
    if (this.recording) {
      this.recording = false;
      this.handlers.onStop();
    } else {
      this.recording = true;
      this.handlers.onStart();
    }
  }

  handleRelease(): void {
    if (!this.handlers) return;
    if (this.mode === 'hold') {
      this.handlers.onStop();
    } else {
      this.keyHeld = false;
    }
  }
}

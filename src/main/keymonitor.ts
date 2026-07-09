// NativeKeyMonitor — wraps the keytap CGEventTap helper (scripts/keytap.c).
//
// Gives the app what globalShortcut can't: press-to-record hotkey capture,
// binding the Fn/Globe key, and real keydown/keyup (hold-to-talk). Combos are
// canonical lowercase strings: "f9", "fn", "ctrl+shift+d", "cmd+space".
//
// Fn semantics: laptops report fn+F9 as F9-with-fn-flag, so the fn flag is
// ignored when the main key is an F-key. A bare "fn" binding triggers on
// release-without-other-keys (toggle) or down/up (hold), so fn+arrow combos
// don't false-trigger it.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { log } from './logger';

// macOS virtual keycode -> canonical key name (common subset).
const KEYCODES: Record<number, string> = {
  0: 'a', 1: 's', 2: 'd', 3: 'f', 4: 'h', 5: 'g', 6: 'z', 7: 'x', 8: 'c', 9: 'v',
  11: 'b', 12: 'q', 13: 'w', 14: 'e', 15: 'r', 16: 'y', 17: 't',
  18: '1', 19: '2', 20: '3', 21: '4', 22: '6', 23: '5', 24: '=', 25: '9', 26: '7',
  27: '-', 28: '8', 29: '0', 30: ']', 31: 'o', 32: 'u', 33: '[', 34: 'i', 35: 'p',
  36: 'enter', 37: 'l', 38: 'j', 39: "'", 40: 'k', 41: ';', 42: '\\', 43: ',',
  44: '/', 45: 'n', 46: 'm', 47: '.', 48: 'tab', 49: 'space', 50: '`',
  51: 'backspace', 53: 'escape',
  96: 'f5', 97: 'f6', 98: 'f7', 99: 'f3', 100: 'f8', 101: 'f9', 103: 'f11',
  105: 'f13', 107: 'f14', 109: 'f10', 111: 'f12', 113: 'f15', 118: 'f4',
  120: 'f2', 122: 'f1',
  114: 'help', 115: 'home', 116: 'pageup', 117: 'delete', 119: 'end', 121: 'pagedown',
  123: 'left', 124: 'right', 125: 'down', 126: 'up',
};

// CGEventFlags modifier bits.
const FLAG = {
  shift: 0x20000,
  ctrl: 0x40000,
  alt: 0x80000,
  cmd: 0x100000,
  fn: 0x800000,
} as const;

const FN_KEYCODE = 63;
const MODIFIER_KEYCODES = new Set([54, 55, 56, 57, 58, 59, 60, 61, 62, FN_KEYCODE]);

export interface KeyBinding {
  combo: string;
  onDown(): void;
  /** clean=false means other keys were pressed while this one was held (fn+arrow). */
  onUp(clean: boolean): void;
}

interface TapEvent {
  t: 'ready' | 'denied' | 'd' | 'u' | 'f';
  k?: number;
  f?: number;
}

function isFKey(key: string): boolean {
  return /^f\d{1,2}$/.test(key);
}

/** Canonicalize "Shift + Ctrl+D" -> "ctrl+shift+d" (modifiers sorted, key last). */
export function canonicalCombo(raw: string): string | null {
  const parts = raw.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods.push('ctrl');
    else if (p === 'alt' || p === 'option' || p === 'opt') mods.push('alt');
    else if (p === 'shift') mods.push('shift');
    else if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super') mods.push('cmd');
    else if (p === 'fn' || p === 'function' || p === 'globe') mods.push('fn');
    else if (key) return null; // two non-modifier keys
    else key = p;
  }
  const order = ['ctrl', 'alt', 'shift', 'cmd', 'fn'];
  const sorted = order.filter((m) => mods.includes(m));
  if (!key) {
    // A bare modifier is only allowed for fn (the macOS dictation convention).
    return sorted.length === 1 && sorted[0] === 'fn' ? 'fn' : null;
  }
  return [...sorted, key].join('+');
}

function comboFromEvent(keycode: number, flags: number): string | null {
  const key = KEYCODES[keycode];
  if (!key) return null;
  const mods: string[] = [];
  if (flags & FLAG.ctrl) mods.push('ctrl');
  if (flags & FLAG.alt) mods.push('alt');
  if (flags & FLAG.shift) mods.push('shift');
  if (flags & FLAG.cmd) mods.push('cmd');
  // fn is noise on F-keys (laptop fn+F9 == F9); meaningful on letter keys.
  if (flags & FLAG.fn && !isFKey(key) && keycode !== FN_KEYCODE) mods.push('fn');
  return [...mods, key].join('+');
}

/** Resolve the helper path in dev (repo) and packaged (asar-unpacked) runs. */
function helperPath(): string {
  const base = join(app.getAppPath(), 'assets', 'keytap');
  return base.includes('app.asar')
    ? base.replace('app.asar', 'app.asar.unpacked')
    : base;
}

export class NativeKeyMonitor {
  private proc: ChildProcessByStdio<null, Readable, null> | null = null;
  private bindings = new Map<string, KeyBinding>();
  private capture: ((combo: string) => void) | null = null;
  private readyState: 'starting' | 'ready' | 'failed' = 'starting';

  // Bare-fn tracking (trigger on clean tap, not fn+other-key).
  private fnHeld = false;
  private fnUsedWithKey = false;

  /** Spawn the helper. Resolves true when the tap is installed. */
  async start(): Promise<boolean> {
    const bin = helperPath();
    if (process.platform !== 'darwin' || !existsSync(bin)) {
      this.readyState = 'failed';
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          this.readyState = ok ? 'ready' : 'failed';
          resolve(ok);
        }
      };
      try {
        this.proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        log.warn('keytap spawn failed:', e);
        settle(false);
        return;
      }
      this.proc.on('exit', (code) => {
        if (this.readyState === 'ready') log.warn(`keytap exited (${code})`);
        this.proc = null;
        settle(false);
      });
      this.proc.on('error', () => settle(false));
      let buf = '';
      this.proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let ev: TapEvent;
          try {
            ev = JSON.parse(line) as TapEvent;
          } catch {
            continue;
          }
          if (ev.t === 'ready') settle(true);
          else if (ev.t === 'denied') settle(false);
          else this.handleEvent(ev);
        }
      });
      setTimeout(() => settle(false), 3000); // helper never came up
    });
  }

  get available(): boolean {
    return this.readyState === 'ready';
  }

  /** Register (or replace) a binding for a canonical combo. */
  bind(binding: KeyBinding): void {
    this.bindings.set(binding.combo, binding);
  }

  unbind(combo: string): void {
    this.bindings.delete(combo);
  }

  /** Capture the next combo the user presses (press-to-record UX). */
  captureNext(timeoutMs = 10_000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.capture = null;
        resolve(null);
      }, timeoutMs);
      this.capture = (combo) => {
        clearTimeout(timer);
        this.capture = null;
        resolve(combo);
      };
    });
  }

  private handleEvent(ev: TapEvent): void {
    const k = ev.k ?? -1;
    const flags = ev.f ?? 0;

    if (ev.t === 'f') {
      if (k === FN_KEYCODE) {
        const down = (flags & FLAG.fn) !== 0;
        if (down && !this.fnHeld) {
          this.fnHeld = true;
          this.fnUsedWithKey = false;
          if (!this.capture) this.bindings.get('fn')?.onDown();
        } else if (!down && this.fnHeld) {
          this.fnHeld = false;
          const clean = !this.fnUsedWithKey;
          if (this.capture) {
            if (clean) this.capture('fn');
            return;
          }
          this.bindings.get('fn')?.onUp(clean);
        }
      }
      return;
    }

    if (MODIFIER_KEYCODES.has(k)) return;
    const combo = comboFromEvent(k, flags);
    if (!combo) return;
    if (this.fnHeld) this.fnUsedWithKey = true;

    if (ev.t === 'd') {
      if (this.capture) {
        this.capture(combo);
        return;
      }
      this.bindings.get(combo)?.onDown();
    } else if (ev.t === 'u') {
      this.bindings.get(combo)?.onUp(true);
    }
  }

  destroy(): void {
    this.bindings.clear();
    this.capture = null;
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }
}

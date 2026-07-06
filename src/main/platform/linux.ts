// LinuxAdapter — X11 focus/window/insertion via xdotool/xprop/xclip.
//
// M0 STUB: interface-complete, no real injection yet. The real port of the
// daemon's Inserter (xdotool type/paste, xprop WM_CLASS, terminal detection,
// guard_focus) lands in M2. For now insert() falls back to the clipboard so the
// contract ("never lose a transcript") holds even before injection exists.
import { setClipboard } from '../clipboard';
import { log } from './../logger';
import type {
  FocusTarget,
  InsertOptions,
  PermissionState,
  PlatformAdapter,
} from './adapter';

// Terminal emulators (by X WM_CLASS) that paste with Ctrl+Shift+V, not Ctrl+V.
// Ported verbatim from dictate.py — used by the M2 insertion logic.
export const TERMINAL_WM_CLASSES = new Set<string>([
  'gnome-terminal', 'gnome-terminal-server', 'konsole', 'xterm', 'uxterm',
  'alacritty', 'kitty', 'terminator', 'tilix', 'xfce4-terminal', 'lxterminal',
  'st', 'urxvt', 'rxvt', 'wezterm', 'foot', 'qterminal', 'termite', 'ptyxis',
  'io.elementary.terminal', 'deepin-terminal', 'mate-terminal', 'guake',
  'kgx', 'console', 'blackbox', 'contour', 'cool-retro-term', 'sakura',
  'warp', 'dev.warp.warp', 'warpterminal', 'ghostty', 'rio', 'wave',
]);

/** Port of `is_terminal_class` (matches full class or reverse-DNS last segment). */
export function isTerminalClass(cls: string): boolean {
  if (!cls) return false;
  if (TERMINAL_WM_CLASSES.has(cls)) return true;
  const last = cls.split('.').pop() || '';
  if (TERMINAL_WM_CLASSES.has(last)) return true;
  return cls.includes('terminal') || cls.includes('console');
}

export class LinuxAdapter implements PlatformAdapter {
  readonly name = 'linux';

  async getFocusedTarget(): Promise<FocusTarget> {
    // M2: `xdotool getwindowfocus` + `xprop WM_CLASS`.
    return { id: '', appId: '', isTerminal: false, isEditable: null };
  }

  async insert(text: string, _opts: InsertOptions): Promise<string> {
    // M2: xdotool type/paste with guard_focus. For now, clipboard-only so the
    // transcript is never lost.
    log.warn('LinuxAdapter.insert stub — copying to clipboard (M2 will inject)');
    return setClipboard(text) ? 'clipboard' : 'failed';
  }

  async checkPermissions(): Promise<PermissionState> {
    // Linux/X11 needs no TCC prompts; injection just needs xdotool/xclip/xprop.
    return { microphone: 'unknown', accessibility: 'not-required', tools: 'unknown' };
  }

  async requestPermissions(): Promise<void> {
    // No-op on Linux (nothing to grant); M2 may surface a "install xdotool" hint.
  }
}

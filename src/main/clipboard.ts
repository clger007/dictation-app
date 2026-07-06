// Clipboard wrapper around Electron's cross-platform, Unicode-safe clipboard.
//
// Replaces the daemon's xclip helpers (`set_clipboard`/`get_clipboard`). Because
// Electron's clipboard handles any Unicode, paste-mode delivery no longer fights
// `xdotool type` — this is what dissolves gotcha #2 (CJK/emoji dropped) on all
// platforms (cross_plat_design §4).
import { clipboard } from 'electron';
import { log } from './logger';

/** Put text on the clipboard. Returns true on success. */
export function setClipboard(text: string): boolean {
  try {
    clipboard.writeText(text);
    return true;
  } catch (e) {
    log.error('clipboard write failed', e);
    return false;
  }
}

/** Read the clipboard text, or null on failure. */
export function getClipboard(): string | null {
  try {
    return clipboard.readText();
  } catch (e) {
    log.error('clipboard read failed', e);
    return null;
  }
}

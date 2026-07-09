// DarwinAdapter — macOS focus detection + text insertion.
//
// Insertion = clipboard + synthesized ⌘V ("keystroke v using command down" via
// System Events), which is Unicode-safe (CJK/emoji) where AppleScript's
// `keystroke <text>` is not — so "type" mode also delivers via paste on macOS
// (⌘V is universal here; no terminal special-case, cross_plat_design §4.1).
// Synthetic keystrokes need the Accessibility permission; without it (or when
// guard_focus sees the frontmost app changed) we fall back to the clipboard and
// report why in the destination label.
import { systemPreferences, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getClipboard, setClipboard } from '../clipboard';
import { log } from './../logger';
import type {
  FocusTarget,
  InsertOptions,
  PermissionState,
  PlatformAdapter,
} from './adapter';

const run = promisify(execFile);

async function osascript(script: string): Promise<string> {
  const { stdout } = await run('/usr/bin/osascript', ['-e', script], { timeout: 5000 });
  return stdout.trim();
}

/** Bundle id of the frontmost app ('' when it can't be determined). */
async function frontmostBundleId(): Promise<string> {
  try {
    return await osascript(
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true',
    );
  } catch (e) {
    log.warn('frontmost app lookup failed:', e);
    return '';
  }
}

export class DarwinAdapter implements PlatformAdapter {
  readonly name = 'darwin';
  private axPromptShown = false;

  async getFocusedTarget(): Promise<FocusTarget> {
    const bundleId = await frontmostBundleId();
    return { id: bundleId, appId: bundleId, isTerminal: false, isEditable: null };
  }

  async insert(text: string, opts: InsertOptions): Promise<string> {
    if (!setClipboard(text)) return 'failed';
    if (opts.mode === 'clipboard') return 'clipboard';

    // guard_focus: only inject if the same app is still frontmost.
    if (opts.guardWindow) {
      const now = await frontmostBundleId();
      if (now && now !== opts.guardWindow) {
        log.info(`guard_focus: frontmost changed (${opts.guardWindow} -> ${now}); clipboard only`);
        return 'clipboard (focus changed)';
      }
    }

    // Synthetic ⌘V needs Accessibility. Prompt once, fall back to clipboard.
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      if (!this.axPromptShown) {
        this.axPromptShown = true;
        systemPreferences.isTrustedAccessibilityClient(true); // system prompt
      }
      return 'clipboard (needs Accessibility permission)';
    }

    const previous = opts.restoreClipboard ? getClipboard() : null;
    try {
      await osascript('tell application "System Events" to keystroke "v" using command down');
    } catch (e) {
      log.error('synthetic paste failed:', e);
      return 'clipboard (paste failed)';
    }
    if (opts.restoreClipboard && previous !== null) {
      await new Promise((r) => setTimeout(r, Math.max(50, opts.pasteWaitMs ?? 150)));
      setClipboard(previous);
    }
    return 'pasted';
  }

  async checkPermissions(): Promise<PermissionState> {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    return {
      microphone:
        mic === 'granted' ? 'granted' : mic === 'denied' ? 'denied' : 'unknown',
      accessibility: systemPreferences.isTrustedAccessibilityClient(false)
        ? 'granted'
        : 'denied',
      tools: 'not-required', // osascript ships with macOS
    };
  }

  async requestPermissions(): Promise<void> {
    systemPreferences.isTrustedAccessibilityClient(true);
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  }
}

// DarwinAdapter — macOS focus/window/insertion via osascript / AXUIElement.
//
// M0 STUB: interface-complete, no real injection yet. The real port lands in M2
// (osascript "keystroke v using command down" or nut.js ⌘V; frontmost app via
// AXUIElement). On macOS ⌘V is universal, so there is no terminal special-case
// (cross_plat_design §4.1). insert() falls back to the clipboard for now.
import { setClipboard } from '../clipboard';
import { log } from './../logger';
import type {
  FocusTarget,
  InsertOptions,
  PermissionState,
  PlatformAdapter,
} from './adapter';

export class DarwinAdapter implements PlatformAdapter {
  readonly name = 'darwin';

  async getFocusedTarget(): Promise<FocusTarget> {
    // M2: frontmost app bundle id via AXUIElement / osascript.
    return { id: '', appId: '', isTerminal: false, isEditable: null };
  }

  async insert(text: string, _opts: InsertOptions): Promise<string> {
    // M2: osascript/nut.js ⌘V with guard_focus. Clipboard-only for now.
    log.warn('DarwinAdapter.insert stub — copying to clipboard (M2 will inject)');
    return setClipboard(text) ? 'clipboard' : 'failed';
  }

  async checkPermissions(): Promise<PermissionState> {
    // M5 onboarding wires these to systemPreferences.getMediaAccessStatus /
    // isTrustedAccessibilityClient. Unknown until then.
    return { microphone: 'unknown', accessibility: 'unknown', tools: 'not-required' };
  }

  async requestPermissions(): Promise<void> {
    // M5: deep-link to the Microphone / Accessibility Settings panes.
  }
}

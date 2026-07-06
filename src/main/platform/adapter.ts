// Platform Adapter interface — the seam that isolates every OS-specific behavior
// (focus/window detection, text insertion, permissions). `process.platform`
// selects the implementation. This is where the daemon's `Inserter` + focus/
// window helpers move (cross_plat_design §4).
//
// M0 defines the types only; LinuxAdapter/DarwinAdapter are stubs. The real
// xdotool/xprop (Linux) and osascript/AXUIElement (macOS) logic lands in M2.
import type { OutputMode } from '../config';

/** The app/window that had focus when recording started. */
export interface FocusTarget {
  id: string; // X window id (linux) | window ref / bundle id (mac)
  appId: string; // WM_CLASS (linux) | bundle identifier (mac)
  isTerminal: boolean; // choose the paste shortcut
  isEditable: boolean | null; // for output.mode="auto"; null = unknown
}

export interface InsertOptions {
  mode: OutputMode;
  guardWindow?: string; // divert to clipboard if focus moved (guard_focus)
}

/** Granted/denied/not-applicable state for each capability we need. */
export type Permission = 'granted' | 'denied' | 'unknown' | 'not-required';

export interface PermissionState {
  microphone: Permission;
  accessibility: Permission; // global hotkey + synthetic keystrokes
  tools: Permission; // required CLIs present (xdotool/xprop, osascript)
}

export interface PlatformAdapter {
  /** Human name, for logs/onboarding. */
  readonly name: string;

  /** The currently-focused app/window. */
  getFocusedTarget(): Promise<FocusTarget>;

  /**
   * Deliver `text` to the focused app. Returns a destination label for
   * logging/history (e.g. "typed", "pasted", "clipboard",
   * "clipboard (focus changed)") — same contract as the daemon's `Inserter`.
   */
  insert(text: string, opts: InsertOptions): Promise<string>;

  /** Query current permission state (mic / accessibility / required tools). */
  checkPermissions(): Promise<PermissionState>;

  /** Open the relevant OS settings pane(s) to grant missing permissions. */
  requestPermissions(): Promise<void>;
}

// Configuration: load/save config.toml with smol-toml.
//
// Port of the Python daemon's `load_config()` + `set_toml_value()` (dictate.py).
// The schema is the exact config.toml from the existing daemon; see
// ARCHITECTURE.md §6 for the reference. Two write paths, matching the daemon:
//   - setValue(): rewrite a single `key = ...` inside a [section], preserving
//     the rest of the file (comments, ordering) — the comment-preserving path
//     used by the dashboard. Direct port of `set_toml_value`.
//   - save(): serialize the whole config object via smol-toml (loses comments;
//     only used when there is no prior file to preserve).
//
// Config path: app.getPath('userData')/config.toml, overridable with the
// DICTATION_CONFIG env var for parity with the daemon.
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'smol-toml';
import { log } from './logger';

// --------------------------------------------------------------------------- //
// Typed schema (mirrors config.toml section-by-section)
// --------------------------------------------------------------------------- //
export interface GeneralConfig {
  engine: 'local' | 'cloud';
  language: string; // "" = auto
  multilingual: boolean; // per-segment lang detect (local only)
  notifications: boolean;
}

export interface KeysConfig {
  mode: 'toggle' | 'hold';
  key: string; // e.g. "f9"
}

export interface AudioConfig {
  device: string; // "default" or a device name/id
  max_seconds: number;
  latency_msec: number;
  tail_ms: number;
}

export interface LocalConfig {
  model: string;
  device: string; // "cuda" | "cpu"
  compute_type: string;
}

export interface CloudConfig {
  model: string;
  prompt: string; // bilingual hint (gotcha #5)
  base_url: string; // OpenAI-compatible endpoint; "" = real OpenAI
  api_key: string;
}

export type OutputMode = 'type' | 'paste' | 'clipboard' | 'auto';

export interface OutputConfig {
  mode: OutputMode;
  type_delay_ms: number;
  guard_focus: boolean;
  paste_key: string;
  terminal_paste_key: string;
  auto_insert: 'type' | 'paste';
  restore_clipboard: boolean;
  paste_wait_ms: number;
}

export interface CleanupConfig {
  enabled: boolean;
  provider: string; // currently only "openai"
  model: string;
  prompt: string; // "" = built-in default
}

export interface HistoryConfig {
  enabled: boolean;
  path: string; // "" = default under userData
  max_entries_in_menu: number;
}

export interface UiConfig {
  tray: boolean;
  overlay: boolean;
  overlay_position: 'bottom' | 'cursor';
  dashboard: boolean;
  dashboard_port: number;
}

export interface AppConfig {
  general: GeneralConfig;
  keys: KeysConfig;
  audio: AudioConfig;
  local: LocalConfig;
  cloud: CloudConfig;
  output: OutputConfig;
  cleanup: CleanupConfig;
  history: HistoryConfig;
  ui: UiConfig;
}

// --------------------------------------------------------------------------- //
// Default config.toml (written on first run). Comment-rich, mirrors the daemon's
// config.toml — but ships with an EMPTY api_key and empty base_url so no secret
// is ever baked into the app or committed.
// --------------------------------------------------------------------------- //
export const DEFAULT_CONFIG_TOML = `# Dictation app configuration

[general]
# "local"  -> local whisper.cpp engine (offline; landed in a later milestone)
# "cloud"  -> OpenAI-compatible transcription API (see [cloud]); needs internet
engine = "cloud"

# "" = auto-detect language, or force one e.g. "en"
language = ""

# Detect language per segment so a SINGLE recording can mix languages
# (code-switching, e.g. English + Mandarin). Local engine only, and only when
# language = "" (auto). Different languages across separate recordings already
# work regardless of this setting.
multilingual = false

# Show the in-app status overlay / messages
notifications = true

[keys]
# "toggle" = press once to start, press again to stop
# "hold"   = hold the key while speaking, release to transcribe
mode = "toggle"
# The trigger key (e.g. f9, f10, or a single letter).
key = "f9"

[audio]
# Input device. "default" = system default input.
device = "default"
# Safety cap so a stuck key can't record forever.
max_seconds = 120
# Capture latency in ms (legacy tuning; the Electron audio path owns its buffer).
latency_msec = 50
# Keep recording this many ms after you press stop, so trailing words are kept.
tail_ms = 250

[local]
model = "large-v3"       # large-v3, medium, small, base, tiny
device = "cuda"          # "cuda" or "cpu"
compute_type = "float16" # float16 (GPU), int8_float16, or int8 (CPU)

[cloud]
model = "gpt-4o-transcribe"
# Optional prompt that biases the model's vocabulary AND language mix. For mixed
# English+Chinese, naming both languages (and including a few Chinese characters)
# strongly nudges it to keep BOTH instead of collapsing to one. Clear it ("")
# for single-language use.
prompt = ""
# Point at any OpenAI-compatible transcription endpoint (e.g. a reseller).
# Leave base_url empty for real OpenAI. Needs the https:// scheme.
base_url = ""
# API key: paste it here (the file is chmod 600 on save) or leave it "" and set
# the OPENAI_API_KEY environment variable instead.
api_key = ""

[output]
# How the transcribed text is delivered:
#   "type"      -> synthesize keystrokes at the cursor.
#   "paste"     -> copy + press paste (Ctrl+V, or Ctrl+Shift+V in a terminal).
#   "clipboard" -> just copy it; you paste manually.
#   "auto"      -> insert into editable fields (accessibility), else copy.
mode = "paste"
# Per-character delay for "type" mode (ms).
type_delay_ms = 6
# Only insert if focus is still on the window you started dictating in; otherwise
# the text is copied to the clipboard so it can't land in the wrong app.
guard_focus = true
# Paste shortcuts for "paste" mode. Terminals use Ctrl+Shift+V, GUI apps Ctrl+V.
paste_key = "ctrl+v"
terminal_paste_key = "ctrl+shift+v"
# In "auto" mode, how to insert when the field is editable: "type" or "paste".
auto_insert = "type"
# For "paste"/"auto": put your previous clipboard back after pasting (best-effort).
restore_clipboard = false
# How long to wait before restoring the clipboard, so the paste lands first (ms).
paste_wait_ms = 150

[cleanup]
# Post-process the raw transcript with an LLM (fix punctuation, drop fillers).
# Toggle live from the tray icon.
enabled = false
provider = "openai"       # currently only "openai"
model = "gpt-4o-mini"
# Leave prompt = "" to use the built-in cleanup instruction.
prompt = ""

[history]
# Append every transcript to an append-only JSONL log.
enabled = true
# "" = <userData>/history.jsonl
path = ""
# How many recent transcripts to list in the tray menu.
max_entries_in_menu = 5

[ui]
# Show a system-tray icon.
tray = true
# In-app status overlay pill (click-through, never steals focus).
overlay = true
# Where it appears: "bottom" or "cursor".
overlay_position = "bottom"
# In-app dashboard/settings window.
dashboard = true
dashboard_port = 8765
`;

// --------------------------------------------------------------------------- //
// Coercion helpers — smol-toml returns `unknown`-ish values; normalize with
// defaults so a hand-edited or partial file never produces `undefined` fields.
// --------------------------------------------------------------------------- //
type Raw = Record<string, unknown>;

function section(root: Raw, name: string): Raw {
  const v = root[name];
  return v && typeof v === 'object' ? (v as Raw) : {};
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

function normalize(root: Raw): AppConfig {
  const g = section(root, 'general');
  const k = section(root, 'keys');
  const a = section(root, 'audio');
  const l = section(root, 'local');
  const c = section(root, 'cloud');
  const o = section(root, 'output');
  const cl = section(root, 'cleanup');
  const h = section(root, 'history');
  const u = section(root, 'ui');
  return {
    general: {
      engine: oneOf(g.engine, ['local', 'cloud'] as const, 'cloud'),
      language: str(g.language, ''),
      multilingual: bool(g.multilingual, false),
      notifications: bool(g.notifications, true),
    },
    keys: {
      mode: oneOf(k.mode, ['toggle', 'hold'] as const, 'toggle'),
      key: str(k.key, 'f9'),
    },
    audio: {
      device: str(a.device, 'default'),
      max_seconds: num(a.max_seconds, 120),
      latency_msec: num(a.latency_msec, 50),
      tail_ms: num(a.tail_ms, 250),
    },
    local: {
      model: str(l.model, 'large-v3'),
      device: str(l.device, 'cuda'),
      compute_type: str(l.compute_type, 'float16'),
    },
    cloud: {
      model: str(c.model, 'gpt-4o-transcribe'),
      prompt: str(c.prompt, ''),
      base_url: str(c.base_url, ''),
      api_key: str(c.api_key, ''),
    },
    output: {
      mode: oneOf(o.mode, ['type', 'paste', 'clipboard', 'auto'] as const, 'paste'),
      type_delay_ms: num(o.type_delay_ms, 6),
      guard_focus: bool(o.guard_focus, true),
      paste_key: str(o.paste_key, 'ctrl+v'),
      terminal_paste_key: str(o.terminal_paste_key, 'ctrl+shift+v'),
      auto_insert: oneOf(o.auto_insert, ['type', 'paste'] as const, 'type'),
      restore_clipboard: bool(o.restore_clipboard, false),
      paste_wait_ms: num(o.paste_wait_ms, 150),
    },
    cleanup: {
      enabled: bool(cl.enabled, false),
      provider: str(cl.provider, 'openai'),
      model: str(cl.model, 'gpt-4o-mini'),
      prompt: str(cl.prompt, ''),
    },
    history: {
      enabled: bool(h.enabled, true),
      path: str(h.path, ''),
      max_entries_in_menu: num(h.max_entries_in_menu, 5),
    },
    ui: {
      tray: bool(u.tray, true),
      overlay: bool(u.overlay, true),
      overlay_position: oneOf(u.overlay_position, ['bottom', 'cursor'] as const, 'bottom'),
      dashboard: bool(u.dashboard, true),
      dashboard_port: num(u.dashboard_port, 8765),
    },
  };
}

// --------------------------------------------------------------------------- //
// set_toml_value port: replace `key = ...` inside [section], preserving the file
// (comments, ordering, other keys). Returns the new text and whether a matching
// key was found & replaced. Faithful to dictate.py's regex-based rewriter,
// including its one documented quirk (drops an inline comment on the edited line).
// --------------------------------------------------------------------------- //
function tomlQuote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function setTomlValue(
  text: string,
  sectionName: string,
  key: string,
  value: string,
): { text: string; done: boolean } {
  const out: string[] = [];
  let cur: string | null = null;
  let done = false;
  const keyRe = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  // splitlines(keepends=True) equivalent: keep the trailing newline on each line.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let line of lines) {
    const s = line.trim();
    const m = /^\[([^\]]+)\]/.exec(s);
    if (m) cur = m[1];
    if (!done && cur === sectionName && keyRe.test(s)) {
      line = `${key} = ${tomlQuote(value)}\n`;
      done = true;
    }
    out.push(line);
  }
  return { text: out.join(''), done };
}

// --------------------------------------------------------------------------- //
// Config: stateful wrapper around the file + parsed object.
// --------------------------------------------------------------------------- //
export class Config {
  readonly path: string;
  private data: AppConfig;

  private constructor(path: string, data: AppConfig) {
    this.path = path;
    this.data = data;
  }

  /** Resolve the config path (DICTATION_CONFIG override, else userData). */
  static resolvePath(userDataDir: string): string {
    const override = (process.env.DICTATION_CONFIG || '').trim();
    if (override) return override;
    return `${userDataDir}/config.toml`;
  }

  /** Load config from `path`, writing the default template if it doesn't exist. */
  static async load(path: string): Promise<Config> {
    if (!existsSync(path)) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, DEFAULT_CONFIG_TOML, 'utf-8');
        await chmod(path, 0o600).catch(() => undefined);
        log.info(`wrote default config: ${path}`);
      } catch (e) {
        log.error('failed to write default config', e);
      }
    }
    let parsed: Raw = {};
    try {
      const raw = await readFile(path, 'utf-8');
      parsed = parse(raw) as Raw;
    } catch (e) {
      log.error('failed to read/parse config; using defaults', e);
    }
    return new Config(path, normalize(parsed));
  }

  /** The current parsed config object. */
  get(): AppConfig {
    return this.data;
  }

  /** Re-read the file from disk (used after a dashboard write). */
  async reload(): Promise<AppConfig> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      this.data = normalize(parse(raw) as Raw);
    } catch (e) {
      log.error('config reload failed', e);
    }
    return this.data;
  }

  /**
   * Rewrite a single key inline, preserving comments (dashboard save path).
   * Reloads the in-memory config afterward and locks the file to 0600 (it may
   * contain the API key). Returns whether the key existed and was replaced.
   */
  async setValue(sectionName: string, key: string, value: string): Promise<boolean> {
    const raw = await readFile(this.path, 'utf-8');
    const { text, done } = setTomlValue(raw, sectionName, key, value);
    await writeFile(this.path, text, 'utf-8');
    await chmod(this.path, 0o600).catch(() => undefined);
    await this.reload();
    return done;
  }
}

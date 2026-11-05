<div align="center">

# 🎙️ Dictation

**English** · [中文](README.zh-CN.md)

**Cross-platform, hotkey-driven speech-to-text for macOS and Linux.**

Press a key, speak, and your words are transcribed and inserted right at the cursor —
or copied to the clipboard. Powered by cloud or on-device transcription, with an
optional LLM cleanup pass that fixes punctuation and drops filler words.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#prerequisites)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Status](https://img.shields.io/badge/status-M0%20skeleton-orange.svg)](#roadmap)

</div>

---

## Overview

Dictation is a lightweight background agent that lives in your system tray/menu bar.
Hold or tap a global hotkey to record, and it transcribes your speech and delivers
the text to whatever app you're using — an editor, a terminal, a chat box, anywhere
your cursor is.

It is an **Electron + TypeScript port of a Linux Python daemon** (`dictate.py`), rebuilt
to run natively on both **macOS** and **Linux** while preserving the daemon's behavior:
the same config schema, the same JSONL history format, the same focus-aware insertion
logic, and the same bilingual/code-switching support. Moving to Electron dissolves the
old platform-specific pain points — notably, Electron's Unicode-safe clipboard means CJK
and emoji survive paste-mode delivery on every platform.

> **Project status:** The **M0 skeleton** is complete — the app boots, shows a tray
> icon, loads config, and writes history. Audio capture, global hotkeys, transcription,
> and text insertion are interface-complete **stubs** wired for the upcoming milestones.
> See the [roadmap](#roadmap) for what lands when.

## Features

- 🎧 **Global hotkey dictation** — `F9` by default, in **toggle** (tap to start/stop) or
  **hold-to-talk** mode.
- ☁️ **Cloud transcription** — any OpenAI-compatible endpoint (`gpt-4o-transcribe` by
  default); point `base_url` at OpenAI or a compatible reseller.
- 💻 **Local transcription** *(planned)* — offline `whisper.cpp` (Metal on macOS, CUDA on
  Linux), so audio never leaves your machine.
- ✨ **Optional LLM cleanup** — a post-processing pass fixes capitalization/punctuation and
  strips fillers (`um`, `uh`, `like`), toggleable live from the tray.
- 🎯 **Focus-aware delivery** — `type`, `paste`, `clipboard`, or `auto` modes. A
  `guard_focus` check diverts text to the clipboard if you switch windows mid-dictation,
  so it never lands in the wrong app.
- 🖥️ **Terminal-aware pasting** — detects terminal emulators by window class and uses
  `Ctrl+Shift+V` instead of `Ctrl+V`.
- 🌏 **Bilingual & code-switching** — a prompt lever biases the model to preserve mixed
  languages (e.g. English + Mandarin) in a single recording; CJK-aware word counting in
  stats.
- 📋 **Tray menu** — recent transcripts (click to copy), live cleanup toggle, quick access
  to the history file and dashboard.
- 🫧 **Status overlay** — a click-through pill that shows recording state and audio level
  without ever stealing focus.
- 📊 **Dashboard & settings** *(planned)* — productivity stats, searchable history, and
  engine/endpoint configuration in-app.
- 🗂️ **Append-only history** — every transcript logged as JSONL with per-day word and
  dictation counts.
- 🔒 **Privacy-conscious** — the config file holding your API key is written `0600`; no
  secrets are ever baked into the build.
- 🧩 **Well-behaved agent** — single-instance lock, menu-bar-only on macOS (no Dock icon),
  graceful degradation when no tray host is available.

## Architecture

Dictation follows Electron's standard three-tier split, with two key seams that keep
OS-specific and engine-specific behavior isolated behind stable interfaces.

```
                        ┌──────────────────────────────────────────────┐
                        │                Main process                   │
                        │                                               │
   Global hotkey  ──▶   │   Hotkeys ──▶ Controller (state machine)      │
   (uiohook)            │                 idle → listening →            │
                        │                 transcribing → idle           │
                        │                    │        │        │        │
                        │            ┌───────┘        │        └──────┐  │
                        │            ▼                ▼               ▼  │
                        │        Engine           Platform         History /
                        │     (cloud|local)        Adapter          Config /
                        │      + Cleaner        (linux|darwin)       Logger  │
                        └───────┬──────────────────┬──────────────────┬─────┘
                                │ IPC (contextBridge, contextIsolation)│
                        ┌───────▼──────────┬────────▼────────┬─────────▼─────┐
                        │  Recorder        │   Overlay       │   Dashboard   │
                        │  (hidden window, │   (pill canvas, │  (settings &  │
                        │   getUserMedia)  │   click-through) │   stats)      │
                        └──────────────────┴─────────────────┴───────────────┘
                                              Renderers
```

**Controller** — the recording state machine (`idle → listening → transcribing → idle`),
a port of the daemon's `Dictation` class. Because Node is single-threaded, the daemon's
locking collapses into a simple state flag plus a `busy` guard; overlapping triggers are
refused, and a failed transcription flashes and returns to idle without losing anything.

**Engine seam** — `CloudEngine` and `LocalEngine` share one `transcribe(wavPath) → text`
interface, so the controller can swap them without caring which is active. `Cleaner` is an
optional LLM post-processor layered on top.

**Platform adapter seam** — a single `PlatformAdapter` interface abstracts every
OS-specific behavior (focus/window detection, text insertion, permissions). `process.platform`
selects `LinuxAdapter` (xdotool/xprop/xclip) or `DarwinAdapter` (osascript/AXUIElement).
Until injection lands, both fall back to the clipboard so a transcript is never lost.

**Renderer isolation** — every renderer runs with `contextIsolation: true` and
`nodeIntegration: false`. The only window that touches `getUserMedia` is the hidden
recorder; all main↔renderer traffic flows over typed `contextBridge` APIs. The dashboard
replaces the daemon's HTTP server with IPC.

## Tech stack

| Area | Technology |
|------|------------|
| Runtime | [Electron](https://www.electronjs.org/) 33 |
| Language | [TypeScript](https://www.typescriptlang.org/) 5.7 (strict) |
| Config | [`smol-toml`](https://github.com/squirrelchat/smol-toml) (comment-preserving TOML) |
| Packaging | [`electron-builder`](https://www.electron.build/) (DMG/ZIP · AppImage/deb) |
| Package manager | [pnpm](https://pnpm.io/) |
| Platform (Linux) | `xdotool` · `xprop` · `xclip` *(insertion, planned)* |
| Global hotkeys | `uiohook-napi` *(planned — keydown/keyup for hold-to-talk)* |
| Transcription | OpenAI-compatible API · `whisper.cpp` *(local, planned)* |

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** ≥ 9 (`corepack enable` or `npm i -g pnpm`)
- **macOS** or **Linux (X11)**
- **Linux only:** `xdotool`, `xprop`, and `xclip` for keystroke/paste insertion
  *(needed once insertion lands; the app runs without them in clipboard-only mode)*
- **Cloud engine:** an OpenAI-compatible API key
- **macOS:** microphone and accessibility permissions (for the global hotkey and
  synthetic keystrokes)

## Quick start

```bash
# 1. Install dependencies (pnpm runs Electron's postinstall to fetch the binary)
pnpm install

# 2. Compile TypeScript and copy renderer assets into dist/
pnpm build

# 3. Launch the app (builds first, then starts Electron)
pnpm start

# …or run with verbose Electron logging during development
pnpm dev
```

On first launch, a tray/menu-bar icon appears and a default `config.toml` is written to
your user-data directory. Add your API key (see [Configuration](#configuration)) and,
once M1 lands, press **F9** to dictate.

Other scripts:

```bash
pnpm typecheck     # type-check without emitting
pnpm clean         # remove dist/
pnpm dist          # package for the current OS
pnpm dist:mac      # build macOS DMG + ZIP (universal)
pnpm dist:linux    # build Linux AppImage + deb
```

## Configuration

A commented `config.toml` is created on first run at:

- **macOS:** `~/Library/Application Support/Dictation/config.toml`
- **Linux:** `~/.config/Dictation/config.toml`

Override the location with the `DICTATION_CONFIG` environment variable. The file is written
with `0600` permissions because it may hold your API key. You can edit it by hand, from the
dashboard (once available), or key-by-key via the app — comments and ordering are preserved
on write.

| Section | Key settings |
|-----------|--------------|
| `[general]` | `engine` (`cloud`/`local`), `language` (`""` = auto), `multilingual`, `notifications` |
| `[keys]` | `mode` (`toggle`/`hold`), `key` (e.g. `f9`) |
| `[audio]` | `device`, `max_seconds`, `latency_msec`, `tail_ms` |
| `[local]` | `model` (`large-v3`…), `device` (`cuda`/`cpu`), `compute_type` |
| `[cloud]` | `model`, `prompt` (bilingual hint), `base_url`, `api_key` |
| `[output]` | `mode` (`type`/`paste`/`clipboard`/`auto`), `guard_focus`, `paste_key`, `terminal_paste_key`, `restore_clipboard` |
| `[cleanup]` | `enabled`, `provider`, `model`, `prompt` |
| `[history]` | `enabled`, `path`, `max_entries_in_menu` |
| `[ui]` | `tray`, `overlay`, `overlay_position`, `dashboard` |

**API key:** paste it into `[cloud].api_key`, or leave it empty and set the
`OPENAI_API_KEY` environment variable instead.

**Bilingual tip:** for mixed English + Chinese, set `[cloud].prompt` naming both languages
(and a few Chinese characters) to nudge the model into preserving both rather than
collapsing to one.

## Project structure

```
dictation-app/
├── src/
│   ├── main/                    # Main process (Node)
│   │   ├── index.ts             # Bootstrap: single-instance lock, tray, wiring
│   │   ├── controller.ts        # Recording state machine (port of Dictation)
│   │   ├── config.ts            # Comment-preserving TOML load/save
│   │   ├── history.ts           # JSONL history, CJK-aware word counts, daily stats
│   │   ├── hotkeys.ts           # Global hotkey wrapper (uiohook — stub)
│   │   ├── clipboard.ts         # Unicode-safe clipboard wrapper
│   │   ├── logger.ts            # File + console logger
│   │   ├── ipc.ts               # Shared IPC channel constants
│   │   ├── engines/             # Transcription engines behind one interface
│   │   │   ├── types.ts         #   Engine contract
│   │   │   ├── cloud.ts         #   OpenAI-compatible engine (stub)
│   │   │   ├── local.ts         #   whisper.cpp engine (stub)
│   │   │   └── cleaner.ts       #   Optional LLM cleanup pass (stub)
│   │   └── platform/            # OS-specific behavior behind one interface
│   │       ├── adapter.ts       #   PlatformAdapter / FocusTarget types
│   │       ├── linux.ts         #   xdotool/xprop/xclip adapter (stub)
│   │       ├── darwin.ts        #   osascript/AXUIElement adapter (stub)
│   │       └── index.ts         #   Adapter factory
│   ├── preload/                 # Typed contextBridge APIs (isolated renderers)
│   │   ├── recorder.ts          #   getUserMedia bridge
│   │   ├── overlay.ts           #   Overlay state bridge
│   │   └── dashboard.ts         #   Settings/stats bridge
│   └── renderer/                # UI windows
│       ├── recorder/            #   Hidden audio-capture window
│       ├── overlay/             #   Status pill (canvas)
│       └── dashboard/           #   Settings & stats
├── assets/                      # Tray icons (idle/listening/transcribing/error)
├── build/                       # Info.plist, macOS entitlements
├── scripts/copy-assets.mjs      # Copy renderer assets into dist/ after tsc
├── electron-builder.yml         # Packaging config (macOS + Linux)
├── tsconfig.json
└── package.json
```

## Roadmap

The project is built in milestones. The Python daemon is the source of truth for behavior;
each milestone ports a slice of it into the cross-platform Electron architecture.

| Milestone | Scope | Status |
|:---------:|-------|:------:|
| **M0** | **Skeleton** — Electron scaffold, tray, config, JSONL history, logging, interface stubs | ✅ Done |
| **M1** | **Cloud vertical slice** — `F9` hotkey (uiohook), audio capture (getUserMedia + WAV), overlay, cloud STT, clipboard delivery | 🔜 Next |
| **M2** | **Insertion & adapters** — focus-aware `type`/`paste` with `guard_focus`; Linux & macOS platform adapters | ⏳ Planned |
| **M3** | **Dashboard / settings window** — stats, history, engine configuration over IPC | ⏳ Planned |
| **M4** | **Local engine** — offline `whisper.cpp` (Metal / CUDA) | ⏳ Planned |
| **M5** | **Productionization** — LLM cleanup, permissions onboarding, code signing & notarization | ⏳ Planned |

## Contributing

Contributions are welcome. Please ensure `pnpm typecheck` passes (the project builds with
TypeScript `strict` mode) and that Electron launches cleanly before opening a pull request.
When porting behavior, match the existing daemon's semantics and keep the engine/platform
seams intact.

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).

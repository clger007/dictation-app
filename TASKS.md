# M0 — Skeleton (Electron Port)

Port the existing Linux dictation daemon to Electron cross-platform.

## ⚠️ Read these first

1. `/home/cheligeer/dictation/ARCHITECTURE.md` — full architecture, gotchas, config reference
2. `/home/cheligeer/dictation/dictate.py` — the entire 1456-line Python daemon to port
3. `/home/cheligeer/dictation/iterations/cross_plat_design.md` — Electron port design plan
4. `/home/cheligeer/dictation/config.toml` — real config for reference
5. `/home/cheligeer/dictation/CLAUDE.md` — project conventions

All five files above are **required reading** before writing any code. The Python
daemon is the source of truth for behavior; the design doc is the architecture
guide for the Electron port.

## What to build

An Electron + TypeScript project in this directory. M0 = skeleton only (no audio,
no hotkeys, no platform adapters yet).

### Source layout

```
dictation-app/
  package.json
  electron-builder.yml
  tsconfig.json
  src/
    main/
      index.ts              # bootstrap, single-instance, tray, wiring
      controller.ts         # recording state machine (port of Dictation class)
      config.ts             # TOML load/save (comment-preserving)
      history.ts            # JSONL history
      hotkeys.ts            # uiohook wrapper (stub: no actual binding yet)
      clipboard.ts          # Electron clipboard wrapper
      engines/
        cloud.ts            # CloudEngine stub (port of CloudEngine)
        local.ts             # LocalEngine stub (port of LocalEngine)
        cleaner.ts           # Cleaner stub (port of Cleaner)
      platform/
        adapter.ts          # PlatformAdapter interface
        linux.ts            # LinuxAdapter stub (port existing xdotool/xprop logic)
        darwin.ts           # DarwinAdapter stub
        index.ts            # factory
      ipc.ts                # IPC channel constants
    preload/
      overlay.ts
      recorder.ts
      dashboard.ts
    renderer/
      overlay/              # pill canvas
      recorder/             # getUserMedia
      dashboard/            # settings + stats
  build/                    # icons, Info.plist
```

### Key requirements

**1. Config (`config.ts`)**
- Port the exact `config.toml` schema from the existing daemon
- Use `smol-toml` for parsing (comment-preserving on write)
- Config path: `app.getPath('userData')/config.toml`
- All sections: `[audio]`, `[cloud]`, `[local]`, `[cleanup]`, `[output]`, `[overlay]`, `[dashboard]`
- Port `set_toml_value` logic for writing individual keys inline

**2. History (`history.ts`)**
- JSONL append at `app.getPath('userData')/history.jsonl`
- Schema: `{ts, text, raw, cleaned, destination, engine}` — same as existing
- Port `count_words` (CJK-aware) from dictate.py
- Port `daily_stats` logic

**3. Controller (`controller.ts`)**
- State machine: `idle | listening | transcribing`
- Port the Dictation class state logic (start/stop/finish flow from dictate.py)
- Stub methods for now (real implementation in M1)

**4. Platform adapter interfaces (stubs only in M0)**
- `FocusTarget`, `PlatformAdapter`, `PermissionState` types
- Match the design in `cross_plat_design.md` §4

**5. Tray**
- System tray with basic menu (Quit)
- macOS: template icon
- Linux: PNG fallback

**6. Logging**
- Simple file logger, `app.getPath('logs')/dictation.log`
- Port log format from dictate.py

### Constraints

- Use **pnpm** as package manager
- TypeScript throughout
- `contextIsolation: true`, `nodeIntegration: false`
- `tsc` must compile without errors
- Electron must launch cleanly (tray icon visible)
- No audio, no hotkeys, no platform adapters yet — just stubs
- Study the existing Python code patterns and port them faithfully
- Commit and push to `origin/main`

### Reference code structure

The existing `dictate.py` has these key classes to port:
- `Dictation` — main controller / state machine
- `Hotkey` (F9 toggle/hold)
- `AudioRecorder` (parecord → ffmpeg)
- `CloudEngine` / `LocalEngine` / `Cleaner`
- `Inserter` (xdotool/xclip focus-aware insertion)
- `StatusOverlay` (GTK pill)
- `Tray` (Ayatana AppIndicator)
- `DashboardServer` (HTTP on :8765)
- `Config` (TOML load/save)

The design doc (`cross_plat_design.md`) has the target Electron architecture.
Use it as the blueprint; use `dictate.py` as the implementation reference.

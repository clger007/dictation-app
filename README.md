# Dictation App

Cross-platform (macOS + Linux) dictation app built with Electron.

## Status

Active development. See [design doc](/home/cheligeer/dictation/iterations/cross_plat_design.md) for architecture.

## Milestones

- **M0** — Skeleton (Electron scaffold, tray, config, JSONL history)
- **M1** — Cloud vertical slice (F9 hotkey, audio capture, overlay, cloud STT, clipboard delivery)
- **M2** — Insertion + adapters (paste with guard_focus, Linux/macOS platform adapters)
- **M3** — Dashboard/Settings window
- **M4** — Local engine (whisper.cpp)
- **M5** — Cleanup pass + productionization

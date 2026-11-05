<div align="center" markdown="1">

# 🎙️ Dictation

[English](README.md) · **中文**

**跨平台、用快捷键触发的语音转文字，支持 macOS 和 Linux。**

按一个键，说话，你说的话就会被转写出来，插到光标所在的位置，
或者复制到剪贴板。转写可以用云端，也可以在本机跑，还可以加一道
LLM 清理，修正标点、去掉口头禅。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#许可证)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#前置要求)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Status](https://img.shields.io/badge/status-M0%20skeleton-orange.svg)](#路线图)

[![speech-to-text](https://img.shields.io/badge/speech--to--text-57606a?style=flat-square)](https://github.com/topics/speech-to-text) [![dictation](https://img.shields.io/badge/dictation-57606a?style=flat-square)](https://github.com/topics/dictation) [![electron](https://img.shields.io/badge/electron-57606a?style=flat-square)](https://github.com/topics/electron) [![macos](https://img.shields.io/badge/macos-57606a?style=flat-square)](https://github.com/topics/macos) [![linux](https://img.shields.io/badge/linux-57606a?style=flat-square)](https://github.com/topics/linux)

</div>

**目录：** [概览](#概览) · [功能](#功能) · [架构](#架构) · [技术栈](#技术栈) · [前置要求](#前置要求) · [快速开始](#快速开始) · [配置](#配置) · [项目结构](#项目结构) · [路线图](#路线图) · [参与贡献](#参与贡献) · [许可证](#许可证)

---

## 概览

Dictation 是一个轻量的后台程序，待在系统托盘 / 菜单栏里。
按住或点一下全局快捷键开始录音，它把你说的话转写出来，再把文字送到你正在用的应用里：
编辑器、终端、聊天框，光标在哪就送到哪。

它是一个 Linux Python 守护进程（`dictate.py`）的 **Electron + TypeScript 移植版**，重写后能在
**macOS** 和 **Linux** 上原生运行，同时保留守护进程的行为：
同样的配置结构、同样的 JSONL 历史格式、同样的按焦点插入逻辑、同样的双语 / 中英夹杂支持。
换成 Electron 后，原来各平台特有的麻烦都没了，尤其是 Electron 的剪贴板对 Unicode 安全，中日韩文字
和 emoji 在每个平台上用粘贴模式送出都不会坏。

> **项目状态：** **M0 骨架**已经完成：应用能启动、显示托盘图标、读取配置、写历史。
> 录音、全局快捷键、转写和插入文字的接口都齐了，但还是 **stub**，等后面的里程碑接上。
> 什么时候做什么，见[路线图](#路线图)。

## 功能

- 🎧 **全局快捷键听写**：默认 `F9`，可以用**切换**（点一下开始 / 停止）或
  **按住说话**模式。
- ☁️ **云端转写**：任何 OpenAI 兼容的接口（默认 `gpt-4o-transcribe`）；
  把 `base_url` 指向 OpenAI 或兼容的转售商就行。
- 💻 **本地转写** *（计划中）*：离线 `whisper.cpp`（macOS 上用 Metal，Linux 上用
  CUDA），音频不离开你的机器。
- ✨ **可选的 LLM 清理**：后处理一遍，修正大小写 / 标点，
  去掉口头禅（`um`、`uh`、`like`），可以在托盘里随时开关。
- 🎯 **按焦点送出**：`type`、`paste`、`clipboard` 或 `auto` 模式。听写中途切了窗口，
  `guard_focus` 检查会把文字转到剪贴板，
  不会落到错的应用里。
- 🖥️ **认得终端的粘贴**：按窗口 class 认出终端模拟器，用
  `Ctrl+Shift+V` 代替 `Ctrl+V`。
- 🌏 **双语和中英夹杂**：用一个提示词让模型在一段录音里保留混合的语言
  （比如英文 + 普通话）；统计里的字数计算认得中日韩文字。
- 📋 **托盘菜单**：最近的转写（点一下复制）、清理开关、快速打开
  历史文件和 dashboard。
- 🫧 **状态浮层**：一个可以点穿的小胶囊，显示录音状态和音量，
  从不抢焦点。
- 📊 **Dashboard 和设置** *（计划中）*：效率统计、可搜索的历史，
  以及在应用里配置引擎 / 接口。
- 🗂️ **只追加的历史**：每条转写都记成 JSONL，带每天的字数和
  听写次数。
- 🔒 **注意隐私**：存 API key 的配置文件以 `0600` 写入；构建里
  从不打包任何密钥。
- 🧩 **守规矩的后台程序**：单实例锁，macOS 上只在菜单栏（没有 Dock 图标），
  没有托盘宿主时也能降级运行。

## 架构

Dictation 用 Electron 标准的三层划分，另有两个关键的接缝，把跟操作系统相关
和跟引擎相关的行为隔在稳定的接口后面。

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

**Controller**：录音状态机（`idle → listening → transcribing → idle`），
移植自守护进程的 `Dictation` 类。Node 是单线程，所以守护进程里的
加锁简化成一个状态标志加一个 `busy` 守卫；重叠的触发会被拒绝，
转写失败会闪一下、回到 idle，什么都不丢。

**引擎接缝**：`CloudEngine` 和 `LocalEngine` 共用一个 `transcribe(wavPath) → text`
接口，controller 可以换着用，不用管当前是哪个。`Cleaner` 是叠在上面的
可选 LLM 后处理。

**平台适配器接缝**：一个 `PlatformAdapter` 接口抽象了所有
跟操作系统相关的行为（焦点 / 窗口检测、插入文字、权限）。`process.platform`
选 `LinuxAdapter`（xdotool/xprop/xclip）或 `DarwinAdapter`（osascript/AXUIElement）。
插入功能做好之前，两个都退回到剪贴板，所以转写的文字永远不会丢。

**Renderer 隔离**：每个 renderer 都以 `contextIsolation: true` 和
`nodeIntegration: false` 运行。唯一碰 `getUserMedia` 的窗口是隐藏的
recorder；main↔renderer 之间的所有通信都走有类型的 `contextBridge` API。dashboard
用 IPC 代替了守护进程的 HTTP 服务。

## 技术栈

| 方面 | 技术 |
|------|------------|
| 运行时 | [Electron](https://www.electronjs.org/) 33 |
| 语言 | [TypeScript](https://www.typescriptlang.org/) 5.7（strict） |
| 配置 | [`smol-toml`](https://github.com/squirrelchat/smol-toml)（保留注释的 TOML） |
| 打包 | [`electron-builder`](https://www.electron.build/)（DMG/ZIP · AppImage/deb） |
| 包管理器 | [pnpm](https://pnpm.io/) |
| 平台（Linux） | `xdotool` · `xprop` · `xclip` *（插入，计划中）* |
| 全局快捷键 | `uiohook-napi` *（计划中：按住说话要用 keydown/keyup）* |
| 转写 | OpenAI 兼容 API · `whisper.cpp` *（本地，计划中）* |

## 前置要求

- **Node.js** ≥ 22
- **pnpm** ≥ 9（`corepack enable` 或 `npm i -g pnpm`）
- **macOS** 或 **Linux（X11）**
- **只限 Linux：** 用按键 / 粘贴插入文字需要 `xdotool`、`xprop` 和 `xclip`
  *（插入功能做好后才需要；没有它们，应用也能以只用剪贴板的模式运行）*
- **云端引擎：** 一个 OpenAI 兼容的 API key
- **macOS：** 麦克风和辅助功能权限（全局快捷键和
  模拟按键要用）

## 快速开始

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

第一次启动时，会出现一个托盘 / 菜单栏图标，并在你的用户数据目录里写一个默认的 `config.toml`。
加上你的 API key（见[配置](#配置)），等 M1 做好后，
按 **F9** 就能听写。

其他脚本：

```bash
pnpm typecheck     # type-check without emitting
pnpm clean         # remove dist/
pnpm dist          # package for the current OS
pnpm dist:mac      # build macOS DMG + ZIP (universal)
pnpm dist:linux    # build Linux AppImage + deb
```

## 配置

第一次运行时，会在下面的位置生成一个带注释的 `config.toml`：

- **macOS：** `~/Library/Application Support/Dictation/config.toml`
- **Linux：** `~/.config/Dictation/config.toml`

用环境变量 `DICTATION_CONFIG` 可以改位置。这个文件以
`0600` 权限写入，因为里面可能有你的 API key。可以手改，也可以在
dashboard 里改（做好之后），或者通过应用一项一项改；写入时会保留注释和顺序。

| 节 | 主要设置 |
|-----------|--------------|
| `[general]` | `engine`（`cloud`/`local`）、`language`（`""` = 自动）、`multilingual`、`notifications` |
| `[keys]` | `mode`（`toggle`/`hold`）、`key`（比如 `f9`） |
| `[audio]` | `device`、`max_seconds`、`latency_msec`、`tail_ms` |
| `[local]` | `model`（`large-v3`…）、`device`（`cuda`/`cpu`）、`compute_type` |
| `[cloud]` | `model`、`prompt`（双语提示）、`base_url`、`api_key` |
| `[output]` | `mode`（`type`/`paste`/`clipboard`/`auto`）、`guard_focus`、`paste_key`、`terminal_paste_key`、`restore_clipboard` |
| `[cleanup]` | `enabled`、`provider`、`model`、`prompt` |
| `[history]` | `enabled`、`path`、`max_entries_in_menu` |
| `[ui]` | `tray`、`overlay`、`overlay_position`、`dashboard` |

**API key：** 粘贴到 `[cloud].api_key`，或者留空，改设
环境变量 `OPENAI_API_KEY`。

**双语小提示：** 中英混说时，在 `[cloud].prompt` 里写明两种语言
（再加几个汉字），让模型把两种都保留，而不是
合成一种。

## 项目结构

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

## 路线图

项目按里程碑来做。行为以 Python 守护进程为准；
每个里程碑把它的一部分移植到跨平台的 Electron 架构里。

| 里程碑 | 范围 | 状态 |
|:---------:|-------|:------:|
| **M0** | **骨架**：Electron 脚手架、托盘、配置、JSONL 历史、日志、接口 stub | ✅ 完成 |
| **M1** | **云端纵向切片**：`F9` 快捷键（uiohook）、录音（getUserMedia + WAV）、浮层、云端 STT、送到剪贴板 | 🔜 下一个 |
| **M2** | **插入和适配器**：带 `guard_focus` 的按焦点 `type`/`paste`；Linux 和 macOS 平台适配器 | ⏳ 计划中 |
| **M3** | **Dashboard / 设置窗口**：统计、历史、通过 IPC 配置引擎 | ⏳ 计划中 |
| **M4** | **本地引擎**：离线 `whisper.cpp`（Metal / CUDA） | ⏳ 计划中 |
| **M5** | **上线准备**：LLM 清理、权限引导、代码签名和公证 | ⏳ 计划中 |

## 参与贡献

欢迎贡献。开 pull request 之前，请确认 `pnpm typecheck` 能通过（项目用
TypeScript `strict` 模式构建），并且 Electron 能正常启动。
移植行为时，要跟现有守护进程的语义一致，保持引擎 / 平台
接缝不变。

## 许可证

以 [MIT License](https://opensource.org/licenses/MIT) 发布。

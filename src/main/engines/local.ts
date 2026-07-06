// LocalEngine — offline transcription (port of dictate.py LocalEngine).
//
// M0 STUB. The daemon used faster-whisper (Python + CUDA), which does not port
// to Node. The cross-platform plan (cross_plat_design §6, §10) replaces it with
// whisper.cpp (Metal on mac, CUDA on Linux), optionally a faster-whisper sidecar
// on Linux. That backend lands in M4; for now this records the config and throws
// on transcribe().
import type { AppConfig } from '../config';
import { log } from '../logger';
import type { Engine } from './types';

export class LocalEngine implements Engine {
  readonly name = 'local';
  readonly model: string;
  readonly device: string;
  readonly computeType: string;
  readonly language: string | null;
  readonly multilingual: boolean;

  constructor(cfg: AppConfig) {
    const lc = cfg.local;
    this.model = lc.model;
    this.device = lc.device;
    this.computeType = lc.compute_type;
    this.language = cfg.general.language || null;
    // Per-segment language detection only matters when language is auto.
    this.multilingual = cfg.general.multilingual && this.language === null;
    log.info(`Local engine (stub): model '${this.model}' on ${this.device}`);
  }

  async transcribe(_wavPath: string): Promise<string> {
    // M4: whisper.cpp (GGUF large-v3) or a faster-whisper sidecar.
    throw new Error('LocalEngine.transcribe not implemented until M4 (whisper.cpp)');
  }
}

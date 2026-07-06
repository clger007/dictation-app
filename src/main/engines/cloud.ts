// CloudEngine — OpenAI-compatible transcription (port of dictate.py CloudEngine).
//
// M0 STUB: reads the [cloud] + [general] config and reports itself, but
// transcribe() is not implemented until M1 (which adds the `openai` npm client:
// client.audio.transcriptions.create({ file, model, language?, prompt? }) with
// baseURL/apiKey). The bilingual `prompt` lever (gotcha #5) is preserved.
import type { AppConfig } from '../config';
import { log } from '../logger';
import type { Engine } from './types';

export class CloudEngine implements Engine {
  readonly name = 'cloud';
  readonly model: string;
  readonly baseUrl: string;
  readonly language: string | null;
  readonly prompt: string;
  private readonly apiKey: string;

  constructor(cfg: AppConfig) {
    const cc = cfg.cloud;
    this.model = cc.model;
    this.baseUrl = (cc.base_url || '').trim();
    this.apiKey = (cc.api_key || '').trim();
    this.language = cfg.general.language || null;
    this.prompt = (cc.prompt || '').trim();
    const where = this.baseUrl || 'api.openai.com (default)';
    log.info(
      `Cloud engine: model '${this.model}' via ${where}${this.prompt ? ' (+prompt)' : ''}`,
    );
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0 || !!(process.env.OPENAI_API_KEY || '').trim();
  }

  async transcribe(_wavPath: string): Promise<string> {
    // M1: POST /audio/transcriptions via the openai npm client.
    throw new Error('CloudEngine.transcribe not implemented until M1');
  }
}

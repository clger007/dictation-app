// Cleaner — optional LLM cleanup pass (port of dictate.py Cleaner).
//
// Fixes punctuation/capitalization and removes filler words before delivery.
// Off by default; toggled live from the tray (so `enabled` is mutable). M0 STUB:
// the OpenAI chat call lands in M5 — for now clean() is a no-op that returns the
// text unchanged when disabled and throws when enabled (the controller catches
// and falls back to the raw text, exactly as the daemon does).
import type { AppConfig } from '../config';

// The daemon's built-in cleanup instruction (used when [cleanup].prompt is "").
export const DEFAULT_CLEANUP_PROMPT =
  'You are a transcription cleanup assistant. Given raw dictated speech, fix ' +
  'capitalization, punctuation, and obvious grammar, and remove filler words ' +
  '(um, uh, er, like, you know). Preserve the speaker\'s wording and meaning ' +
  'exactly: do not paraphrase, summarize, translate, answer questions, or add ' +
  'content. Use only plain ASCII punctuation (straight quotes \' and ", hyphen ' +
  '-, and ... for ellipsis); never use smart quotes, em dashes, or other ' +
  'non-ASCII glyphs. Reply with only the cleaned text and nothing else.';

export class Cleaner {
  enabled: boolean; // mutable: tray toggles it live
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;

  constructor(cfg: AppConfig) {
    const cc = cfg.cleanup;
    this.enabled = cc.enabled;
    this.provider = cc.provider || 'openai';
    this.model = cc.model || 'gpt-4o-mini';
    this.prompt = cc.prompt || DEFAULT_CLEANUP_PROMPT;
  }

  /**
   * Return cleaned text. Throws on failure so the caller can fall back to raw
   * (matching the daemon). M0: not implemented while enabled; pass-through when
   * disabled or given empty text.
   */
  async clean(text: string): Promise<string> {
    if (!this.enabled || !text) return text;
    if (this.provider !== 'openai') {
      throw new Error(`unsupported cleanup provider: ${this.provider}`);
    }
    // M5: openai chat.completions.create({ model, temperature: 0, messages }).
    throw new Error('Cleaner.clean not implemented until M5');
  }
}

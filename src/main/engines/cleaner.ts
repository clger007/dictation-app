// Cleaner — optional LLM cleanup pass (port of dictate.py Cleaner).
//
// Fixes punctuation/capitalization and removes filler words before delivery.
// Off by default; toggled live from the tray (so `enabled` is mutable). Uses the
// same credentials/endpoint as [cloud] (chat.completions). Throws on failure so
// the controller can fall back to the raw transcript, exactly as the daemon does.
import type { AppConfig } from '../config';
import { normalizeBaseUrl, resolveApiKey } from './cloud';

const RULES =
  ' Never summarize, answer questions, or add content. Keep the original ' +
  'language(s) of the text — do not translate. Use only plain ASCII ' +
  "punctuation (straight quotes ' and \", hyphen -, and ... for ellipsis). " +
  'Reply with only the resulting text and nothing else.';

// Built-in instructions per [cleanup].level (used when [cleanup].prompt is "").
export const CLEANUP_PROMPTS: Record<string, string> = {
  // light: the daemon's original behavior — mechanics only, wording untouched.
  light:
    'You are a transcription cleanup assistant. Given raw dictated speech, fix ' +
    'capitalization, punctuation, and obvious typos, and remove filler words ' +
    "(um, uh, er, like, you know). Preserve the speaker's wording and meaning " +
    'exactly: do not paraphrase.' + RULES,
  // standard: also repair grammar — good for non-native speakers.
  standard:
    'You are a transcription cleanup assistant. Given raw dictated speech, fix ' +
    'capitalization, punctuation, filler words (um, uh, er, like, you know), ' +
    'grammar mistakes, wrong verb tenses, and word-order slips, keeping the ' +
    "speaker's wording wherever it is already correct. Do not rephrase beyond " +
    'what fixing the mistakes requires.' + RULES,
  // fluent: rewrite into natural native phrasing while preserving meaning.
  fluent:
    'You are an expert editor. Rewrite the dictated speech into clear, natural, ' +
    'native-sounding prose while preserving the meaning, intent, and tone ' +
    'exactly. Fix all grammar and awkward phrasing, remove fillers and false ' +
    'starts, and keep roughly the same length — polish, do not expand.' + RULES,
};

export const DEFAULT_CLEANUP_PROMPT = CLEANUP_PROMPTS.light;

export class Cleaner {
  enabled: boolean; // mutable: tray toggles it live
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: AppConfig) {
    const cc = cfg.cleanup;
    this.enabled = cc.enabled;
    this.provider = cc.provider || 'openai';
    this.model = cc.model || 'gpt-4o-mini';
    this.prompt = cc.prompt || CLEANUP_PROMPTS[cc.level] || DEFAULT_CLEANUP_PROMPT;
    this.baseUrl = normalizeBaseUrl(cfg.cloud.base_url);
    this.apiKey = (cfg.cloud.api_key || '').trim();
  }

  /**
   * Return cleaned text. Throws on failure so the caller can fall back to raw
   * (matching the daemon). Pass-through when disabled or given empty text.
   */
  async clean(text: string): Promise<string> {
    if (!this.enabled || !text) return text;
    if (this.provider !== 'openai') {
      throw new Error(`unsupported cleanup provider: ${this.provider}`);
    }
    const key = resolveApiKey(this.apiKey);
    if (!key) throw new Error('cleanup: no API key configured');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: this.prompt },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`cleanup failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = (data.choices?.[0]?.message?.content || '').trim();
    return out || text;
  }
}

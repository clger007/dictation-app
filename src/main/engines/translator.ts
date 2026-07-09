// Translator — translate-mode post-processor. Same OpenAI-compatible endpoint
// and credentials as [cloud]; the model comes from [cleanup].model (a small
// chat model is plenty for translation).
import type { AppConfig } from '../config';
import { normalizeBaseUrl, resolveApiKey } from './cloud';

export class Translator {
  readonly target: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: AppConfig) {
    this.target = (cfg.translate.target || 'English').trim() || 'English';
    this.model = cfg.cleanup.model || 'gpt-4o-mini';
    this.baseUrl = normalizeBaseUrl(cfg.cloud.base_url);
    this.apiKey = (cfg.cloud.api_key || '').trim();
  }

  /** Translate `text` (any language, mixed allowed) into the target language. */
  async translate(text: string): Promise<string> {
    if (!text) return text;
    const key = resolveApiKey(this.apiKey);
    if (!key) throw new Error('translate: no API key configured');
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
          {
            role: 'system',
            content:
              `You are a professional translator. Translate the user's text into ${this.target}. ` +
              'The text is dictated speech and may mix languages; translate ALL of it into ' +
              `${this.target}, preserving meaning, tone, and register. If part of the text is ` +
              `already in ${this.target}, keep it (lightly fixing punctuation only). ` +
              'Reply with ONLY the translation — no quotes, no commentary.',
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`translate failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = (data.choices?.[0]?.message?.content || '').trim();
    if (!out) throw new Error('translate: empty response');
    return out;
  }
}

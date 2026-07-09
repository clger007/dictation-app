// CloudEngine — OpenAI-compatible transcription (port of dictate.py CloudEngine).
//
// POSTs the finished WAV to {base_url}/audio/transcriptions with multipart form
// data (native fetch/FormData/Blob — no extra client dependency). base_url
// semantics match the openai client's baseURL: it should include the version
// segment (e.g. https://api.openai.com/v1); a bare host gets '/v1' appended.
// The bilingual `prompt` lever (gotcha #5) is preserved.
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config';
import { log } from '../logger';
import type { Engine } from './types';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Resolve a config base_url to an openai-style base (includes /v1). */
export function normalizeBaseUrl(raw: string): string {
  let base = (raw || '').trim().replace(/\/+$/, '');
  if (!base) return DEFAULT_BASE_URL;
  try {
    const u = new URL(base);
    if (!u.pathname || u.pathname === '/') base = `${base}/v1`;
  } catch {
    // leave as-is; the fetch will surface a clear error
  }
  return base;
}

/** The API key to use: config value, else the OPENAI_API_KEY env var. */
export function resolveApiKey(configured: string): string {
  return (configured || '').trim() || (process.env.OPENAI_API_KEY || '').trim();
}

// 16 kHz mono 16-bit PCM, as produced by the recorder renderer.
const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;
const WAV_HEADER = 44;

/** Wrap raw 16-bit PCM in a WAV header (mirror of the renderer's encoder). */
function pcmToWav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(WAV_HEADER);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** RMS of a PCM window (for finding quiet split points). */
function windowRms(pcm: Buffer, start: number, len: number): number {
  let sum = 0;
  let n = 0;
  const end = Math.min(pcm.length - 1, start + len);
  for (let i = start; i < end; i += 2) {
    const s = pcm.readInt16LE(i) / 32768;
    sum += s * s;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Split long PCM into ~chunkSeconds pieces, cutting at the quietest 100 ms
 * window within ±4 s of each target boundary so words aren't sliced in half.
 * Exported for the selftest.
 */
export function splitPcm(pcm: Buffer, chunkSeconds: number): Buffer[] {
  const chunkBytes = chunkSeconds * BYTES_PER_SEC;
  if (pcm.length <= chunkBytes * 1.5) return [pcm];
  const searchSpan = Math.min(4 * BYTES_PER_SEC, Math.floor(chunkBytes / 3));
  const win = Math.floor(0.1 * BYTES_PER_SEC);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (pcm.length - offset > chunkBytes * 1.5) {
    const target = offset + chunkBytes;
    let best = target;
    let bestRms = Infinity;
    for (let p = target - searchSpan; p <= target + searchSpan; p += win) {
      const r = windowRms(pcm, p, win);
      if (r < bestRms) {
        bestRms = r;
        best = p;
      }
    }
    best -= best % 2; // stay sample-aligned
    chunks.push(pcm.subarray(offset, best));
    offset = best;
  }
  chunks.push(pcm.subarray(offset));
  return chunks;
}

export class CloudEngine implements Engine {
  readonly name = 'cloud';
  readonly model: string;
  readonly baseUrl: string;
  readonly language: string | null;
  readonly prompt: string;
  readonly chunkSeconds: number;
  private readonly apiKey: string;

  constructor(cfg: AppConfig) {
    const cc = cfg.cloud;
    this.model = cc.model;
    this.baseUrl = normalizeBaseUrl(cc.base_url);
    this.apiKey = (cc.api_key || '').trim();
    this.language = cfg.general.language || null;
    this.prompt = (cc.prompt || '').trim();
    this.chunkSeconds = cfg.audio.chunk_seconds;
    const where = (cc.base_url || '').trim() || 'api.openai.com (default)';
    log.info(
      `Cloud engine: model '${this.model}' via ${where}${this.prompt ? ' (+prompt)' : ''}`,
    );
  }

  hasApiKey(): boolean {
    return resolveApiKey(this.apiKey).length > 0;
  }

  private async transcribeWav(wav: Buffer, key: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.model);
    if (this.language) form.append('language', this.language);
    if (this.prompt) form.append('prompt', this.prompt);

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 401) {
        throw new Error(`API key rejected (HTTP 401). Check it in Dashboard / Settings. ${body}`);
      }
      throw new Error(`transcription failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text || '').trim();
  }

  /**
   * Transcribe a WAV of any length. Recordings longer than ~1.5× chunk_seconds
   * are split at quiet points and sent as PARALLEL requests, then merged in
   * order — so there is no practical length limit and long dictations don't
   * take minutes to come back.
   */
  async transcribe(wavPath: string): Promise<string> {
    const key = resolveApiKey(this.apiKey);
    if (!key) {
      throw new Error(
        'No API key. Open Dashboard / Settings from the tray and paste your key, ' +
          'or set the OPENAI_API_KEY environment variable.',
      );
    }
    const wav = await readFile(wavPath);
    const pcm = wav.subarray(WAV_HEADER);
    const parts = splitPcm(pcm, this.chunkSeconds);
    if (parts.length === 1) {
      return this.transcribeWav(wav, key);
    }
    log.info(
      `long recording (${Math.round(pcm.length / BYTES_PER_SEC)}s) -> ${parts.length} chunks in parallel`,
    );
    const texts = await Promise.all(parts.map((p) => this.transcribeWav(pcmToWav(p), key)));
    return texts
      .map((t) => t.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }
}

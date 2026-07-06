// History: append-only JSONL log of transcripts.
//
// Port of dictate.py's `History`, `count_words`, `read_history`, `daily_stats`.
// Schema is UNCHANGED from the daemon so existing history.jsonl files remain
// readable: { ts, text, raw, cleaned, destination, engine } (one JSON per line).
//
// Path: config [history].path if set, else <userData>/history.jsonl.
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AppConfig } from './config';
import { log } from './logger';

export interface HistoryEntry {
  ts: string; // ISO-8601 to the second
  text: string; // delivered text (post-cleanup)
  raw: string; // raw transcript
  cleaned: boolean; // whether the cleanup pass changed the text
  destination: string; // delivery label ("typed", "pasted", "clipboard", ...)
  engine: string; // "cloud" | "local"
}

export interface DayStat {
  date: string; // YYYY-MM-DD
  words: number;
  dictations: number;
}

export interface Stats {
  days: DayStat[];
  total_words: number;
  total_dictations: number;
}

// CJK / kana ranges — each such char counts as one "word" for stats. Mirrors the
// Python `_CJK_RE` (hiragana/katakana, CJK Ext-A, CJK Unified, CJK compat,
// halfwidth katakana).
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g;

/** Word count for mixed scripts: CJK chars + whitespace-delimited Latin tokens. */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  const latin = text.replace(CJK_RE, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}

/** Read all (or the last `limit`) entries from a JSONL history file. */
export async function readHistory(path: string, limit?: number): Promise<HistoryEntry[]> {
  const items: HistoryEntry[] = [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return items; // missing file -> empty
  }
  for (const line of raw.split('\n')) {
    const ln = line.trim();
    if (!ln) continue;
    try {
      items.push(JSON.parse(ln) as HistoryEntry);
    } catch {
      // skip malformed lines
    }
  }
  return limit ? items.slice(-limit) : items;
}

/** Per-day word/dictation counts + totals (port of `daily_stats`). */
export async function dailyStats(path: string): Promise<Stats> {
  const byDay = new Map<string, DayStat>();
  let totalWords = 0;
  let totalDict = 0;
  for (const e of await readHistory(path)) {
    const day = (e.ts || '').slice(0, 10);
    if (!day) continue;
    const w = countWords(e.text || '');
    const d = byDay.get(day) || { date: day, words: 0, dictations: 0 };
    d.words += w;
    d.dictations += 1;
    byDay.set(day, d);
    totalWords += w;
    totalDict += 1;
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { days, total_words: totalWords, total_dictations: totalDict };
}

export class History {
  readonly enabled: boolean;
  readonly maxMenu: number;
  readonly path: string;
  private recentBuf: HistoryEntry[] = [];
  private readonly recentCap: number;

  constructor(cfg: AppConfig, userDataDir: string) {
    const hc = cfg.history;
    this.enabled = hc.enabled;
    this.maxMenu = Math.max(1, Math.trunc(hc.max_entries_in_menu));
    const configured = (hc.path || '').trim();
    this.path = configured
      ? expandHome(configured)
      : join(userDataDir, 'history.jsonl');
    this.recentCap = Math.max(this.maxMenu, 25);
  }

  /** Load the tail of the file into the recent buffer (call once at startup). */
  async loadRecent(): Promise<void> {
    if (!existsSync(this.path)) return;
    const all = await readHistory(this.path);
    this.recentBuf = all.slice(-this.recentCap);
  }

  /** Append an entry (JSONL) and update the recent buffer. */
  async add(entry: Omit<HistoryEntry, 'ts'>): Promise<void> {
    const full: HistoryEntry = {
      ts: new Date().toISOString().slice(0, 19),
      ...entry,
    };
    this.recentBuf.push(full);
    if (this.recentBuf.length > this.recentCap) {
      this.recentBuf = this.recentBuf.slice(-this.recentCap);
    }
    if (!this.enabled) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(full) + '\n', 'utf-8');
    } catch (e) {
      log.error('history append failed', e);
    }
  }

  /** The n most-recent entries, newest first (for the tray menu). */
  recent(n: number): HistoryEntry[] {
    return this.recentBuf.slice(-n).reverse();
  }
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

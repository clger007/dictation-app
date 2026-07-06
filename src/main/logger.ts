// Simple file logger. Mirrors the Python daemon's console format —
// `[Dictation] <message>` — but also appends to a logfile under the OS logs
// directory (app.getPath('logs')/dictation.log) so a background/agent run can
// be inspected after the fact (see cross_plat_design §7.3).
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PREFIX = '[Dictation]';

let logFile: string | null = null;
let ready: Promise<void> | null = null;

/** Point the logger at a directory (typically app.getPath('logs')). */
export function initLogger(logsDir: string): string {
  logFile = join(logsDir, 'dictation.log');
  ready = mkdir(dirname(logFile), { recursive: true })
    .then(() => undefined)
    .catch(() => undefined);
  return logFile;
}

function stamp(): string {
  // ISO-8601 to the second, matching History's `ts` granularity.
  return new Date().toISOString();
}

async function write(level: string, message: string): Promise<void> {
  const line = `${stamp()} ${PREFIX} ${level} ${message}\n`;
  if (!logFile) return;
  try {
    await ready;
    await appendFile(logFile, line, 'utf-8');
  } catch {
    // Never let logging crash the caller.
  }
}

function emit(level: 'INFO' | 'WARN' | 'ERROR', args: unknown[]): void {
  const message = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  // Console for live runs; file for later inspection.
  const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  consoleFn(`${PREFIX} ${message}`);
  void write(level, message);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (...args: unknown[]) => emit('INFO', args),
  warn: (...args: unknown[]) => emit('WARN', args),
  error: (...args: unknown[]) => emit('ERROR', args),
  /** Path of the active logfile, or null before initLogger(). */
  file: () => logFile,
};

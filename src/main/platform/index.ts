// Platform adapter factory — pick the implementation from process.platform.
// Windows is left for a later milestone; it falls back to the Linux adapter's
// clipboard-only behavior so the app still runs (never loses a transcript).
import { log } from '../logger';
import type { PlatformAdapter } from './adapter';
import { LinuxAdapter } from './linux';
import { DarwinAdapter } from './darwin';

export * from './adapter';

export function createPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
): PlatformAdapter {
  switch (platform) {
    case 'darwin':
      return new DarwinAdapter();
    case 'linux':
      return new LinuxAdapter();
    default:
      log.warn(`no adapter for platform '${platform}'; using Linux (clipboard-only)`);
      return new LinuxAdapter();
  }
}

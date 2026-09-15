/**
 * epoch-poller.ts — Background epoch polling task.
 *
 * setInterval fixed (no dynamic backoff — deterministic timer behavior).
 * On epoch change → invoke onEpochChange callback (typically flushes cache).
 * On fetch error → log warn, keep polling (transient errors expected).
 *
 * Guarantees: unref'd interval → won't block Node process exit.
 */
import type { SdkLogger } from './types.js';

interface EpochPollerOptions {
  intervalMs: number;
  fetchEpoch: () => Promise<number>;
  onEpochChange: (newEpoch: number, oldEpoch: number | null) => void;
  logger: SdkLogger;
}

export class EpochPoller {
  private timer: NodeJS.Timeout | null = null;
  private lastKnownEpoch: number | null = null;

  constructor(private readonly opts: EpochPollerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    // Don't block Node process exit
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const current = await this.opts.fetchEpoch();
      if (this.lastKnownEpoch === null) {
        this.lastKnownEpoch = current;
        return;
      }
      if (current !== this.lastKnownEpoch) {
        const old = this.lastKnownEpoch;
        this.lastKnownEpoch = current;
        try {
          this.opts.onEpochChange(current, old);
        } catch (err) {
          this.opts.logger.warn({ err }, 'epoch-poller: onEpochChange callback threw');
        }
      }
    } catch (err) {
      this.opts.logger.warn({ err }, 'epoch-poller: fetch failed — will retry next tick');
    }
  }
}

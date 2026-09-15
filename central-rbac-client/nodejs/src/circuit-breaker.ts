/**
 * circuit-breaker.ts — 3-state circuit breaker (closed / open / half-open).
 *
 * Closed: normal operation, count failures.
 * Open:   threshold exceeded → reject requests immediately for resetSec.
 * Half-open: after resetSec, allow 1 probe request. Success → closed. Fail → open again.
 *
 * Single-flight probe: prevents thundering herd khi half-open state opens gate.
 */

type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: State = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  /** Check nếu can proceed. Returns true nếu allowed, false nếu circuit open. */
  canProceed(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetMs) {
        this.state = 'half-open';
        return this.claimProbe();
      }
      return false;
    }
    // half-open — only 1 probe at a time
    return this.claimProbe();
  }

  private claimProbe(): boolean {
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /** Call sau khi request thành công. Reset state → closed. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.probeInFlight = false;
  }

  /** Call sau khi request fail. Increment counter, mở circuit nếu vượt threshold. */
  recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === 'half-open') {
      // Half-open probe failed → back to open
      this.state = 'open';
      this.openedAt = Date.now();
      return;
    }
    if (this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  /** Return current state (for observability/testing). */
  getState(): State {
    return this.state;
  }
}

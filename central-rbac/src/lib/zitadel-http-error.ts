/**
 * zitadel-http-error.ts — Typed error for non-2xx Zitadel Management API responses.
 *
 * Replaces the "throw new Error(`... HTTP ${status}`)" convention that the outbox
 * dispatcher used to regex-scrape for retry classification. A typed field is more
 * robust than string parsing when new call-sites are added.
 *
 * Convention: throw this from every Zitadel client on !res.ok. The dispatcher
 * (services/outbox-event-dispatcher.ts) reads err.status to decide dead vs retry.
 */
export class ZitadelHttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ZitadelHttpError';
    this.status = status;
  }
}

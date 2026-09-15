/**
 * errors.ts — Error taxonomy cho @onelog/central-rbac-client (10 codes per Appendix E).
 */

export type ErrorCode =
  | 'RBAC_SDK_CONFIG_ERROR'      // Bad config (bao gồm production+failMode=open guard)
  | 'RBAC_CENTRAL_UNREACHABLE'   // HTTP timeout / network error
  | 'RBAC_CENTRAL_5XX'           // Central 5xx response
  | 'RBAC_CENTRAL_4XX'           // Central 4xx (auth, validation, etc.)
  | 'RBAC_CIRCUIT_OPEN'          // Circuit breaker opened, request rejected
  | 'RBAC_MANIFEST_MISMATCH'     // X-Api-Version response header không match config
  | 'RBAC_INVALID_TOKEN'         // 401 invalid X-Rbac-Token
  | 'RBAC_APP_NOT_FOUND'         // 404 app_slug không tồn tại trên Central
  | 'RBAC_PERMISSION_DENIED'     // checkPermission returned false
  | 'RBAC_INTERNAL_ERROR';       // Unknown/unexpected

export class CentralRbacError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus?: number;
  public override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, opts?: { httpStatus?: number; cause?: unknown }) {
    super(message);
    this.name = 'CentralRbacError';
    this.code = code;
    if (opts?.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

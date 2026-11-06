export type AtlasErrorCode =
  | 'BACKEND_UNREACHABLE'
  | 'INVALID_INPUT'
  | 'PROJECT_NOT_FOUND'
  | 'BRANCH_REVIEW_NOT_FOUND'
  | 'PR_REVIEW_NOT_FOUND'
  | 'CHANGESET_NOT_FOUND'
  | 'NO_ACTIVE_PROVIDER'
  | 'REQUEST_TIMEOUT'
  | 'UNKNOWN_ERROR';

export class AtlasMcpError extends Error {
  readonly code: AtlasErrorCode;
  readonly status: number | null;
  readonly details: unknown;

  constructor(code: AtlasErrorCode, message: string, options?: { status?: number | null; details?: unknown }) {
    super(message);
    this.name = 'AtlasMcpError';
    this.code = code;
    this.status = options?.status ?? null;
    this.details = options?.details;
  }
}

export function isAtlasMcpError(error: unknown): error is AtlasMcpError {
  return error instanceof AtlasMcpError;
}

export function toAtlasMcpError(error: unknown): AtlasMcpError {
  if (isAtlasMcpError(error)) return error;

  if (error instanceof Error) {
    return new AtlasMcpError('UNKNOWN_ERROR', error.message, { details: error });
  }

  return new AtlasMcpError('UNKNOWN_ERROR', 'Unknown error', { details: error });
}

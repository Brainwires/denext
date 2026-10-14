// The one error type storage throws, with an HTTP status per code so the plugin's endpoints
// and an app's own route handlers answer the same way.

/** The reasons a storage call fails. */
export type StorageErrorCode =
  | "forbidden"
  | "not_found"
  | "invalid_key"
  | "invalid_bucket"
  | "unknown_bucket"
  | "too_large"
  | "mime_not_allowed"
  | "mime_mismatch"
  | "bad_request"
  | "expired"
  | "bad_signature"
  | "conflict"
  | "duplicate"
  | "not_empty"
  | "not_configured"
  | "unsupported"
  | "driver_error";

const STATUS: Record<StorageErrorCode, number> = {
  forbidden: 403,
  not_found: 404,
  invalid_key: 400,
  invalid_bucket: 400,
  unknown_bucket: 404,
  too_large: 413,
  mime_not_allowed: 415,
  mime_mismatch: 415,
  bad_request: 400,
  expired: 403,
  bad_signature: 403,
  conflict: 409,
  duplicate: 409,
  not_empty: 409,
  not_configured: 500,
  unsupported: 501,
  driver_error: 502,
};

/** A failed storage operation. `status` is the HTTP status the plugin answers it with. */
export class StorageError extends Error {
  /** The machine-readable reason. */
  readonly code: StorageErrorCode;
  /** The HTTP status for {@link code}. */
  readonly status: number;

  /**
   * Create a storage error.
   *
   * @param code The reason.
   * @param message A human-readable message (never contains a secret).
   * @param options The underlying cause, if any.
   */
  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
    this.status = STATUS[code];
  }
}

/**
 * Whether `value` is a {@link StorageError}.
 *
 * @param value Anything caught.
 * @returns `true` for a storage error.
 */
export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}

/**
 * What a client may read about `error`: its message, unless it is a Postgres error (a SQLSTATE
 * `code`) — whose text can name the database user, host or schema — which is logged here and
 * answered with `fallback`.
 *
 * @param error The error.
 * @param where Names the surface in the server log.
 * @param fallback The text the client gets for a database error.
 * @returns The client-facing message.
 */
export function clientErrorMessage(
  error: unknown,
  where: string,
  fallback = "database error",
): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    console.error(`[@denext/backend] ${where}`, error);
    return fallback;
  }
  return error instanceof Error ? error.message : String(error);
}

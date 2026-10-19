// Fresh's `HttpError`: thrown from a handler or middleware to answer with a status (a 404 renders
// the not-found page). Client-safe: islands may import it too.

/** The reason phrases {@link HttpError} uses when no message is given. */
const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/**
 * An error that carries an HTTP status (Fresh's `HttpError`). Throw it from a handler or a
 * middleware: a 404 renders the not-found page, any other status the route's error page with
 * that status.
 */
export class HttpError extends Error {
  /** The HTTP status. */
  readonly status: number;

  /**
   * Create the error.
   *
   * @param status The HTTP status.
   * @param message The message (defaults to the status's reason phrase).
   * @param options The error options (`cause`).
   */
  constructor(status: number, message?: string, options?: ErrorOptions) {
    super(message ?? STATUS_TEXT[status] ?? `HTTP ${status}`, options);
    this.name = "HttpError";
    this.status = status;
  }
}

// The audit trail: denextAuth's `events` (what happened) and `logger` (what the framework
// swallowed). Both are optional and silent by default — auth never writes to your console
// unless you ask it to.
//
// Two properties make this the right place for an audit log:
// - an event handler can never change the HTTP answer (a throw is caught and routed to
//   `logger.error`), so logging is always safe to add;
// - `signInFailed` carries a STABLE machine-readable reason (`invalid_credentials`,
//   `rate_limited`, `access_denied`, `account_not_linked`), so alerting can key on it.
//
// Nothing here logs an email, a password, a token or a cookie: user ids and reason codes
// only. Auth logs are the ones most likely to be shipped off-box.

import type { AuthEvents, AuthLogger } from "denext/server";

/** One structured audit line (send these to your log pipeline, not stdout). */
function audit(event: string, fields: Record<string, unknown>): void {
  console.log(`[auth] ${event} ${JSON.stringify(fields)}`);
}

/** Lifecycle hooks: who signed in, which attempts were refused, what was revoked. */
export const authEvents: AuthEvents = {
  signIn: ({ user, provider, isNewUser }) =>
    audit("sign-in", { user: user.id, provider, isNewUser }),
  signInFailed: ({ provider, reason }) => audit("sign-in refused", { provider, reason }),
  sessionRevoked: ({ sessionId, userId }) => audit("sessions revoked", { sessionId, userId }),
};

/** Where the framework reports misconfiguration and swallowed failures. */
export const authLogger: AuthLogger = {
  // Flow tracing is verbose (every body it refuses, every provider round-trip): opt in.
  debug: Deno.env.get("AUTH_DEBUG")
    ? (message, meta) => console.debug(`[auth] ${message}`, meta ?? {})
    : undefined,
  warn: (message, meta) => console.warn(`[auth] ${message}`, meta ?? {}),
  error: (message, error) => console.error(`[auth] ${message}`, error),
};

// A DEMO auth flow (in-memory, not for production): `checkCredentials` validates a hardcoded
// user, `issueToken` mints an opaque bearer token, and `requireBearer()` is API middleware that
// rejects any request without a valid `Authorization: Bearer <token>` header. The pet routes are
// built with `authed` so they require a token; `/api/login` stays public.

import { ApiError, type ApiMiddleware, createApi } from "denext/server";

// The one demo account. A real app checks a database + a password hash.
const DEMO = { username: "demo", password: "denext" };

const tokens = new Set<string>();

export function checkCredentials(username: string, password: string): boolean {
  return username === DEMO.username && password === DEMO.password;
}

export function issueToken(): string {
  const token = crypto.randomUUID();
  tokens.add(token);
  return token;
}

/** The token from an `Authorization: Bearer <token>` header, or `""` if absent/malformed. */
function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

/** API middleware: require a valid bearer token or 401. Adds `{ token }` to the handler ctx. */
function requireBearer(): ApiMiddleware<object, { token: string }> {
  return ({ request }) => {
    const token = bearerToken(request);
    if (!token || !tokens.has(token)) {
      throw new ApiError(401, "unauthorized", {
        message:
          "Missing or invalid bearer token — POST /api/login, then Authorize with the token.",
      });
    }
    return { token };
  };
}

/** Build protected endpoints with `authed.define(def, handler)` — the token is enforced first. */
export const authed = createApi().use(requireBearer());

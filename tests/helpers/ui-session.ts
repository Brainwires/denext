// A `denext ui` test's way in: run the `?t=` handshake and keep what it hands back.
//
// The session cookie is NOT the launch token (`src/ui/security.ts`, layer 3): it is a second
// secret the handshake mints, so a test cannot build its `Cookie` header from `server.token`. It
// does what a browser does instead — follows the printed URL once, keeps the cookie, and derives
// the CSRF token from the cookie's secret the way the server does.

import { deriveCsrf, UI_COOKIE } from "../../src/ui/security.ts";
import type { UiServer } from "../../src/ui/server.ts";

/** What one handshake left a test holding. */
export interface UiCredentials {
  /** The `Cookie` header value, `denext_ui_token=<secret>`. */
  readonly cookie: string;
  /** The cookie's secret alone. */
  readonly secret: string;
  /** The CSRF token every mutation must present. */
  readonly csrf: string;
  /** `{ cookie }`, ready to spread into a `fetch`'s headers. */
  readonly headers: { readonly cookie: string };
}

/**
 * Run the `?t=` handshake against `server` and return the credentials it minted.
 *
 * @param server A started UI server (its `url` carries the launch token).
 * @returns The session cookie and the CSRF token derived from it.
 * @throws When the handshake did not answer with the 302 + cookie it must.
 */
export async function uiHandshake(server: UiServer): Promise<UiCredentials> {
  const res = await fetch(server.url, { redirect: "manual" });
  await res.body?.cancel();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (res.status !== 302 || !cookie.startsWith(`${UI_COOKIE}=`)) {
    throw new Error(`denext ui handshake failed: ${res.status} ${cookie}`);
  }
  const secret = cookie.slice(UI_COOKIE.length + 1);
  return { cookie, secret, csrf: await deriveCsrf(secret), headers: { cookie } };
}

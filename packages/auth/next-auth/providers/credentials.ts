/**
 * `next-auth/providers/credentials` on denext: the app's `authorize(credentials, request)`
 * behind denext's Credentials provider — which adds what Auth.js leaves to the app: per-IP and
 * per-identifier rate limits, a same-origin check, and a generic `401` that never says whether
 * an account exists.
 *
 * ```ts
 * import Credentials from "next-auth/providers/credentials";
 * Credentials({
 *   credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
 *   authorize: async ({ email, password }) => await checkPassword(email, password),
 * });
 * ```
 *
 * @module
 */

import { credentials as denextCredentials } from "../../src/providers.ts";
import { currentContext } from "@denext/denext/auth-kit";
import { copyRemoteAddr } from "@denext/denext/auth-kit";
import type { AuthUser } from "../../src/types.ts";
import { signInRecord } from "../state.ts";
import { describeProvider, type ProfileUser, type ProviderDescriptor } from "./shared.ts";

/** One field the built-in sign-in page renders. */
export interface CredentialInput {
  /** The field's label. */
  label?: string;
  /** The `<input type>` (default `"text"`). */
  type?: string;
  /** A placeholder. */
  placeholder?: string;
}

/** The options of the Credentials provider. */
export interface CredentialsConfig {
  /** Provider id (default `"credentials"`). */
  id?: string;
  /** Display name (default `"Credentials"`). */
  name?: string;
  /** The fields the built-in sign-in page renders. */
  credentials?: Record<string, CredentialInput>;
  /**
   * Check the submitted fields: return the user, or `null` to refuse. A throw is a refusal too
   * (logged), answered like a wrong password.
   */
  authorize?: (
    credentials: Record<string, unknown>,
    request: AuthorizeRequest,
  ) => ProfileUser | null | undefined | Promise<ProfileUser | null | undefined>;
}

/**
 * The request `authorize()` receives: Auth.js v5's `Request`, which also answers NextAuth.js v4's
 * reads — `req.headers["x-forwarded-for"]` (as well as `req.headers.get(…)`), `req.query` and
 * `req.body` (the submitted fields). It carries no body stream: the handler already read it.
 */
export type AuthorizeRequest = Omit<Request, "body"> & {
  /** The request headers; each is also readable by its lower-case name (v4). */
  headers: Headers & Record<string, string | undefined>;
  /** The URL's query (v4). */
  query: Record<string, string>;
  /** The submitted fields (v4's parsed body). */
  body: Record<string, unknown>;
};

/** `headers` with each header also readable as a property (`headers["user-agent"]`), as in v4. */
function indexableHeaders(source: Headers): Headers & Record<string, string | undefined> {
  const headers = new Headers(source);
  for (const [name, value] of headers) {
    if (!(name in headers)) Object.defineProperty(headers, name, { value, enumerable: true });
  }
  return headers as Headers & Record<string, string | undefined>;
}

/** The request `authorize()` is handed for `credentials`: v5's `Request` with v4's fields. */
function authorizeRequest(credentials: Record<string, unknown>): AuthorizeRequest {
  const parent = currentContext()?.request ?? new Request("http://localhost/");
  const request = new Request(parent.url, { method: parent.method, headers: parent.headers });
  copyRemoteAddr(parent, request);
  Object.defineProperties(request, {
    headers: { value: indexableHeaders(parent.headers) },
    query: { value: Object.fromEntries(new URL(parent.url).searchParams), enumerable: true },
    body: { value: { ...credentials }, enumerable: true },
  });
  return request as unknown as AuthorizeRequest;
}

/** The denext user an `authorize()` result becomes (its own fields stay in the sign-in record). */
function toAuthUser(user: ProfileUser): AuthUser {
  const out: AuthUser = {
    id: user.id != null && user.id !== "" ? String(user.id) : crypto.randomUUID(),
  };
  if (typeof user.name === "string") out.name = user.name;
  if (typeof user.email === "string") out.email = user.email;
  if (typeof user.image === "string") out.image = user.image;
  return out;
}

/**
 * The Credentials provider.
 *
 * @param config The `authorize` callback, the fields, and an `id` / `name` override.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Credentials(
  config: CredentialsConfig = {},
): ProviderDescriptor<CredentialsConfig> {
  const id = config.id ?? "credentials";
  const descriptor = {
    id,
    name: config.name ?? "Credentials",
    type: "credentials" as const,
    options: config,
  };
  return describeProvider(descriptor, () => ({
    provider: denextCredentials({
      id,
      authorize: async (creds) => {
        const record = signInRecord();
        record.credentials = creds;
        const found = await config.authorize?.(creds, authorizeRequest(creds));
        if (!found) return null;
        const user = toAuthUser(found);
        record.user = { ...found, id: user.id };
        record.account = { provider: id, type: "credentials", providerAccountId: user.id };
        return user;
      },
    }),
  }));
}

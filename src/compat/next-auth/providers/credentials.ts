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

import { credentials as denextCredentials } from "../../../server/auth/providers.ts";
import { currentContext } from "../../../server/request-context.ts";
import type { AuthUser } from "../../../server/auth/types.ts";
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
    request: Request,
  ) => ProfileUser | null | undefined | Promise<ProfileUser | null | undefined>;
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
        const request = currentContext()?.request ?? new Request("http://localhost/");
        const found = await config.authorize?.(creds, request);
        if (!found) return null;
        const user = toAuthUser(found);
        record.user = { ...found, id: user.id };
        record.account = { provider: id, type: "credentials", providerAccountId: user.id };
        return user;
      },
    }),
  }));
}

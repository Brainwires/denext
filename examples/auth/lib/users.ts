// Accounts live in the auth ADAPTER — there is no parallel user table in this app.
//
// `sqliteAuthAdapter` owns users, the provider accounts linked to them, password hashes
// (`getCredential` / `setCredential`), bearer API tokens, and — as `adapter.sessions` — the
// session records. This module is the thin layer between the app's forms and that port.
//
// Upgrading from an older config? `sessionStore: sqliteSessionStore({ path: "sessions.db" })`
// becomes `adapter: sqliteAuthAdapter({ path: "sessions.db" })` + `session.strategy:
// "database"`: the `sessions` DDL is byte-identical, so the adapter adopts the existing
// table with no migration step and nobody is logged out.

import {
  type AdapterUser,
  type AuthAdapter,
  hashPassword,
  sqliteAuthAdapter,
  verifyPassword,
} from "denext/server";
import { countUsers, DB_PATH } from "./db.ts";

/** The demo account, seeded on first run (and, as the first user, the admin). */
const DEMO = { email: "demo@denext.dev", name: "Demo User", password: "password" };

/** The Credentials provider id — also the `provider` of the account row registration links. */
const CREDENTIALS = "credentials";

/** Where users, accounts, credentials, API tokens and sessions are persisted. */
export const adapter: AuthAdapter = sqliteAuthAdapter({ path: DB_PATH });

/**
 * The optional adapter groups this app relies on. `AuthAdapter` declares credentials
 * storage optional (an OAuth-only app needs none); `sqliteAuthAdapter` implements it, so
 * narrowing once here keeps every call site free of `?.` and `!`.
 */
const store = adapter as
  & AuthAdapter
  & Required<Pick<AuthAdapter, "getCredential" | "setCredential">>;

/** Roles for a new account: the FIRST user to register administers the app. */
function rolesForNewUser(): string[] {
  return countUsers() === 0 ? ["admin", "user"] : ["user"];
}

/** Look an account up by the address someone typed (the adapter matches case-insensitively). */
export function findUser(email: string): Promise<AdapterUser | undefined> {
  return Promise.resolve(adapter.getUserByEmail(email.trim().toLowerCase()));
}

/**
 * Create an account: the adapter user, the `credentials` account row that links this login
 * method to it, and the scrypt password hash.
 *
 * Linking here — rather than letting the first sign-in link by email — is what keeps the
 * flow honest. denext refuses to attach a provider account to a local user on an
 * **unverified** address (that is how account-takeover by email squatting works), and a
 * freshly registered address is not verified yet (see /verify-email). Registration knows
 * the link is real, so it makes it; every later sign-in then resolves by account, not by
 * address.
 *
 * @param email The address the account signs in with.
 * @param name The display name (may be empty).
 * @param password The plaintext password — only its scrypt hash is stored.
 * @returns The created adapter user.
 */
export async function createAccount(
  email: string,
  name: string,
  password: string,
): Promise<AdapterUser> {
  const user = await adapter.createUser({ email, name, roles: rolesForNewUser() });
  await adapter.linkAccount({
    userId: user.id,
    provider: CREDENTIALS,
    providerAccountId: user.id,
    type: "credentials",
  });
  await store.setCredential(user.id, await hashPassword(password));
  return user;
}

/**
 * Check a submitted password against the stored hash.
 *
 * An unknown account and a wrong password take the same path: `verifyPassword` runs either
 * way (against `""` for a miss) and is timing-equalized, so the endpoint never becomes a
 * user-enumeration oracle.
 *
 * @param user The account the address resolved to, or `undefined`.
 * @param password The submitted password.
 * @returns `true` when the password matches the stored hash.
 */
export async function checkPassword(
  user: AdapterUser | undefined,
  password: string,
): Promise<boolean> {
  const hash = user ? await store.getCredential(user.id) : undefined;
  return await verifyPassword(password, hash ?? "");
}

/**
 * Replace an account's password hash. The caller revokes that user's sessions afterwards —
 * a password change that leaves old cookies working protects nobody.
 *
 * @param userId The adapter user id.
 * @param password The new plaintext password.
 */
export async function setPassword(userId: string, password: string): Promise<void> {
  await store.setCredential(userId, await hashPassword(password));
}

// Seed the demo account the first time the database is created. It registers first, so it
// is the admin — sign in as it to see /admin.
if (!await findUser(DEMO.email)) {
  await createAccount(DEMO.email, DEMO.name, DEMO.password);
}

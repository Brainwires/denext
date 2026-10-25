/**
 * SAML Single Logout for **stateless** cookie sessions: every cookie session carries a random
 * `sid` in its sealed payload, a SAML sign-in records which `sid` its (provider, NameID,
 * SessionIndex) started, and an IdP's verified LogoutRequest puts exactly the named `sid`s on a
 * revocation list. A read of a SAML cookie session then looks its `sid` up (one query, once per
 * request) and a revoked one reads as signed out.
 *
 * **Where it lives.** In the auth adapter — the database every instance already shares — through
 * its optional session-index and revocation methods (`recordSsoSessionIndex`,
 * `listSsoSessionIndexBySessionIndex`, `listSsoSessionIndexByNameId`, `revokeSids`,
 * `isSidRevoked`). A revocation is a durable row kept until the session it ends would have
 * expired; nothing evicts it early. An adapter without the methods (an Auth.js adapter) leaves the
 * feature off: a LogoutRequest then ends every session of the user (`sessionsValidAfter`).
 *
 * **Failing closed.** A LogoutRequest whose target the index can't resolve (a session from
 * before `sid`s were minted, an index row the adapter pruned) ends every session of the user
 * signed in before it instead (`sessionsValidAfter`).
 *
 * @module
 */

import { currentContext } from "../request-context.ts";
import type { AuthAdapter, SsoSessionIndexRecord } from "./adapter.ts";
import { randomToken } from "./oauth.ts";
import type { AuthSessionSaml } from "./types.ts";

/** The adapter methods Single Logout of cookie sessions needs. */
export type CookieRevocationAdapter = Required<
  Pick<
    AuthAdapter,
    | "recordSsoSessionIndex"
    | "listSsoSessionIndexBySessionIndex"
    | "listSsoSessionIndexByNameId"
    | "revokeSids"
    | "isSidRevoked"
  >
>;

const METHODS = [
  "recordSsoSessionIndex",
  "listSsoSessionIndexBySessionIndex",
  "listSsoSessionIndexByNameId",
  "revokeSids",
  "isSidRevoked",
] as const;

/**
 * The adapter narrowed to the session-index and revocation methods, or `null` when it lacks any
 * of them.
 *
 * @param adapter The configured adapter.
 * @returns The adapter, or `null`.
 */
export function cookieRevocationOf(
  adapter: AuthAdapter | undefined,
): CookieRevocationAdapter | null {
  if (!adapter) return null;
  return METHODS.every((m) => typeof adapter[m] === "function")
    ? adapter as CookieRevocationAdapter
    : null;
}

/** A fresh session id: 128 random bits, base64url. */
export function newSessionId(): string {
  return randomToken(16);
}

/**
 * Record that a SAML sign-in at `providerId` started the cookie session `sid`, until
 * `expiresAt`.
 *
 * @param adapter The adapter.
 * @param providerId The `saml()` provider id (bound to one IdP entityID).
 * @param saml The assertion's subject.
 * @param sid The cookie session's id.
 * @param expiresAt The session's absolute ceiling, epoch seconds.
 */
export async function recordCookieSessionIndex(
  adapter: CookieRevocationAdapter,
  providerId: string,
  saml: AuthSessionSaml,
  sid: string,
  expiresAt: number,
): Promise<void> {
  await adapter.recordSsoSessionIndex(providerId, saml.nameId, saml.sessionIndex, sid, expiresAt);
}

/** The sessions a LogoutRequest names, or `null` when one of its targets is unknown. */
async function namedSessions(
  adapter: CookieRevocationAdapter,
  providerId: string,
  nameId: string,
  sessionIndexes: readonly string[],
): Promise<SsoSessionIndexRecord[] | null> {
  if (!sessionIndexes.length) {
    const all = await adapter.listSsoSessionIndexByNameId(providerId, nameId);
    return all.length ? all : null;
  }
  const targets: SsoSessionIndexRecord[] = [];
  for (const index of sessionIndexes) {
    const found = await adapter.listSsoSessionIndexBySessionIndex(providerId, nameId, index);
    if (!found.length) return null;
    targets.push(...found);
  }
  return targets;
}

/**
 * Put the cookie sessions a LogoutRequest names on the revocation list: those its SessionIndexes
 * started, or with none given, every session its NameID started (SAML 2.0 §3.7.3.2).
 *
 * @param adapter The adapter.
 * @param providerId The `saml()` provider id.
 * @param nameId The LogoutRequest's NameID.
 * @param sessionIndexes Its SessionIndexes (may be empty).
 * @returns The revoked `sid`s — or `null` when a target can't be resolved (the caller then ends
 *   every session of the user instead).
 */
export async function revokeCookieSessions(
  adapter: CookieRevocationAdapter,
  providerId: string,
  nameId: string,
  sessionIndexes: readonly string[],
): Promise<string[] | null> {
  const targets = await namedSessions(adapter, providerId, nameId, sessionIndexes);
  if (!targets) return null;
  const sids = [...new Set(targets.map((t) => t.sid))];
  await adapter.revokeSids(sids, Math.max(...targets.map((t) => t.expiresAt)));
  return sids;
}

/** The request memo slot of {@linkcode cookieSessionRevoked}: `sid` → its lookup. */
const REVOKED_READS = Symbol("denext.auth.revokedReads");

/**
 * Whether the cookie session `sid` is on the revocation list — one query, at most once per
 * request.
 *
 * @param adapter The adapter.
 * @param sid The session's id.
 * @returns `true` when it was revoked.
 */
export function cookieSessionRevoked(
  adapter: Pick<CookieRevocationAdapter, "isSidRevoked">,
  sid: string,
): Promise<boolean> {
  const memo = currentContext()?.memo;
  let reads = memo?.get(REVOKED_READS) as Map<string, Promise<boolean>> | undefined;
  if (memo && !reads) memo.set(REVOKED_READS, reads = new Map());
  const hit = reads?.get(sid);
  if (hit) return hit;
  const read = Promise.resolve().then(() => adapter.isSidRevoked(sid)).then((v) => v === true);
  reads?.set(sid, read);
  return read;
}

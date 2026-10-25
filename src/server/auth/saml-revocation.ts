/**
 * SAML Single Logout for **stateless** cookie sessions: every cookie session carries a random
 * `sid` in its sealed payload, a SAML sign-in records which `sid` its (provider, NameID,
 * SessionIndex) started, and an IdP's verified LogoutRequest puts exactly the named `sid`s on a
 * revocation list. A read of a SAML cookie session then looks its `sid` up (one key) and a
 * revoked one reads as signed out.
 *
 * Only an app that can revoke this way (`ResolvedAuthOptions.revocableCookies`: a `saml()`
 * provider with Single Logout, an adapter, no `sessionStore`) records or looks anything up.
 *
 * **Where it lives.** The app's cache store ({@linkcode getCacheStore}: `node:sqlite`, Postgres,
 * Redis, Deno KV or the app's own), so instances sharing one store share the index and the
 * revocations. While the cache store is the built-in in-memory one, this instance's own map is
 * used instead: the in-memory cache evicts its least recently used entries, and a revocation must
 * not be dropped before it expires. In-memory state is per instance, so a multi-instance
 * deployment needs a shared store (`denext doctor` warns).
 *
 * **Failing closed.** A LogoutRequest whose target this index can't resolve (a session from
 * before `sid`s were minted, an index entry the store lost) ends every session of the user
 * signed in before it instead (`sessionsValidAfter`), as before.
 *
 * Every entry expires with the session it describes: at its absolute ceiling
 * (`authTime + session.maxLifetime`).
 *
 * @module
 */

import { cacheStoreKind, getCacheStore } from "../cache.ts";
import { currentContext } from "../request-context.ts";
import { base64UrlEncode, randomToken } from "./oauth.ts";
import type { AuthSessionSaml } from "./types.ts";

/** Key prefixes in the store (the hashed parts keep keys short and delimiter-free). */
const INDEX_KEY = "denext:auth:slo:idx:";
const NAME_ID_KEY = "denext:auth:slo:nid:";
const REVOKED_KEY = "denext:auth:revoked:";

/** How often the read-modify-write of a NameID's list re-checks it kept its own entry. */
const LIST_WRITE_ATTEMPTS = 3;

/** One recorded session: its `sid` and when it ends, epoch milliseconds. */
interface IndexedSession {
  sid: string;
  exp: number;
}

/** The two operations this module needs of a store. */
interface IndexStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, expiresAtMs: number): Promise<void>;
}

/** This instance's entries while the cache store is the in-memory one (never evicted early). */
const local = new Map<string, { value: unknown; expiresAt: number }>();
/** The next time the local map drops its expired entries, epoch milliseconds. */
let nextSweep = 0;
const SWEEP_MS = 60_000;

const localStore: IndexStore = {
  get(key) {
    const entry = local.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (entry.expiresAt <= Date.now()) {
      local.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  },
  set(key, value, expiresAtMs) {
    const now = Date.now();
    if (now >= nextSweep) {
      nextSweep = now + SWEEP_MS;
      for (const [k, e] of local) if (e.expiresAt <= now) local.delete(k);
    }
    local.set(key, { value, expiresAt: expiresAtMs });
    return Promise.resolve();
  },
};

/** The store in use now: the shared cache store, or this instance's map for the in-memory one. */
function indexStore(): IndexStore {
  if (cacheStoreKind() === "memory") return localStore;
  const cache = getCacheStore();
  return {
    async get(key) {
      return (await cache.getData(key))?.value;
    },
    async set(key, value, expiresAtMs) {
      await cache.setData(key, { value, expiresAt: expiresAtMs, tags: [] });
    },
  };
}

/** A fresh session id: 128 random bits, base64url. */
export function newSessionId(): string {
  return randomToken(16);
}

/** SHA-256 of the parts (JSON-encoded, so no two tuples collide), base64url. */
async function digest(parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function indexKey(providerId: string, nameId: string, sessionIndex: string): Promise<string> {
  return digest([providerId, nameId, sessionIndex]).then((h) => INDEX_KEY + h);
}

function nameIdKey(providerId: string, nameId: string): Promise<string> {
  return digest([providerId, nameId]).then((h) => NAME_ID_KEY + h);
}

/** A stored session list, keeping the well-formed, unexpired entries. */
function liveEntries(value: unknown, now: number): IndexedSession[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is IndexedSession =>
    typeof e?.sid === "string" && typeof e?.exp === "number" && e.exp > now
  );
}

/** A stored single entry, when well-formed and unexpired. */
function liveEntry(value: unknown, now: number): IndexedSession | null {
  return liveEntries([value], now)[0] ?? null;
}

/** Add `entry` to the NameID's list, re-reading to confirm a concurrent write kept it. */
async function addToNameId(store: IndexStore, key: string, entry: IndexedSession): Promise<void> {
  for (let attempt = 0; attempt < LIST_WRITE_ATTEMPTS; attempt++) {
    const now = Date.now();
    const list = liveEntries(await store.get(key), now).filter((e) => e.sid !== entry.sid);
    list.push(entry);
    await store.set(key, list, Math.max(...list.map((e) => e.exp)));
    if (liveEntries(await store.get(key), Date.now()).some((e) => e.sid === entry.sid)) return;
  }
}

/**
 * Record that a SAML sign-in at `providerId` started the cookie session `sid`: under its
 * SessionIndex (when the assertion gave one) and in its NameID's list, both until `expiresAtMs`.
 *
 * @param providerId The `saml()` provider id (bound to one IdP entityID).
 * @param saml The assertion's subject.
 * @param sid The cookie session's id.
 * @param expiresAtMs The session's absolute ceiling, epoch milliseconds.
 */
export async function recordCookieSessionIndex(
  providerId: string,
  saml: AuthSessionSaml,
  sid: string,
  expiresAtMs: number,
): Promise<void> {
  const store = indexStore();
  const entry: IndexedSession = { sid, exp: expiresAtMs };
  if (saml.sessionIndex !== undefined) {
    await store.set(await indexKey(providerId, saml.nameId, saml.sessionIndex), entry, expiresAtMs);
  }
  await addToNameId(store, await nameIdKey(providerId, saml.nameId), entry);
}

/**
 * Put the cookie sessions a LogoutRequest names on the revocation list: those its SessionIndexes
 * started, or with none given, every session its NameID started (SAML 2.0 §3.7.3.2).
 *
 * @param providerId The `saml()` provider id.
 * @param nameId The LogoutRequest's NameID.
 * @param sessionIndexes Its SessionIndexes (may be empty).
 * @returns The revoked `sid`s — or `null` when a target can't be resolved (the caller then ends
 *   every session of the user instead).
 */
export async function revokeCookieSessions(
  providerId: string,
  nameId: string,
  sessionIndexes: readonly string[],
): Promise<string[] | null> {
  const store = indexStore();
  const now = Date.now();
  let targets: IndexedSession[];
  if (sessionIndexes.length) {
    targets = [];
    for (const index of sessionIndexes) {
      const entry = liveEntry(await store.get(await indexKey(providerId, nameId, index)), now);
      if (!entry) return null;
      targets.push(entry);
    }
  } else {
    targets = liveEntries(await store.get(await nameIdKey(providerId, nameId)), now);
    if (!targets.length) return null;
  }
  for (const target of targets) await store.set(REVOKED_KEY + target.sid, 1, target.exp);
  return targets.map((t) => t.sid);
}

/** The request memo slot of {@linkcode cookieSessionRevoked}: `sid` → its lookup. */
const REVOKED_READS = Symbol("denext.auth.revokedReads");

/**
 * Whether the cookie session `sid` is on the revocation list — one key lookup, at most once per
 * request.
 *
 * @param sid The session's id.
 * @returns `true` when it was revoked.
 */
export function cookieSessionRevoked(sid: string): Promise<boolean> {
  const memo = currentContext()?.memo;
  let reads = memo?.get(REVOKED_READS) as Map<string, Promise<boolean>> | undefined;
  if (memo && !reads) memo.set(REVOKED_READS, reads = new Map());
  const hit = reads?.get(sid);
  if (hit) return hit;
  const read = indexStore().get(REVOKED_KEY + sid).then((value) => value !== undefined);
  reads?.set(sid, read);
  return read;
}

/** Test seam: forget this instance's in-memory entries. */
export function resetLocalSessionIndex(): void {
  local.clear();
  nextSweep = 0;
}

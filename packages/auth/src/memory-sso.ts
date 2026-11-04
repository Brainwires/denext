// The in-memory adapter's SAML SSO group: stored providers (entity id and domains unique),
// the SSO origin of sessions, the shared SAML message-id replay cache, and the session index and
// revocation list of SAML Single Logout for stateless cookie sessions.

import type {
  AuthAdapter,
  SsoProviderRecord,
  SsoProviderWrite,
  SsoSessionIndexRecord,
  SsoSessionRecord,
} from "./adapter.ts";

/** The SSO methods, by name. */
export type SsoMethods = Pick<
  AuthAdapter,
  | "createSsoProvider"
  | "updateSsoProvider"
  | "getSsoProvider"
  | "getSsoProviderByEntityId"
  | "getSsoProviderByDomain"
  | "listSsoProviders"
  | "deleteSsoProvider"
  | "createSsoSession"
  | "listSsoSessions"
  | "claimSamlMessageId"
>;

/** The Single Logout session-index and revocation methods, by name. */
export type SsoIndexMethods = Pick<
  AuthAdapter,
  | "recordSsoSessionIndex"
  | "listSsoSessionIndexBySessionIndex"
  | "listSsoSessionIndexByNameId"
  | "revokeSids"
  | "isSidRevoked"
>;

/** The group, plus what the adapter's deletion and close need. */
export interface MemorySsoGroup {
  /** The adapter methods. */
  methods: SsoMethods & SsoIndexMethods;
  /** Drop a deleted user's SSO session records. */
  dropUser(userId: string): void;
  /** Drop everything. */
  clear(): void;
}

const copy = (p: SsoProviderRecord): SsoProviderRecord => structuredClone(p);

type Providers = Map<string, SsoProviderRecord>;

/** Why `record` cannot be written (ignoring the provider it replaces), or `ok`. */
function conflict(providers: Providers, record: SsoProviderRecord): SsoProviderWrite {
  for (const other of providers.values()) {
    if (other.id === record.id) continue;
    if (other.entityId === record.entityId) return "entity_id_exists";
    if (other.domains.some((d) => record.domains.includes(d))) return "domain_exists";
  }
  return "ok";
}

/** The first provider `match` accepts, copied. */
function find(
  providers: Providers,
  match: (p: SsoProviderRecord) => boolean,
): SsoProviderRecord | undefined {
  for (const p of providers.values()) if (match(p)) return copy(p);
  return undefined;
}

/** The provider methods. */
function providerMethods(providers: Providers, sessions: Map<string, SsoSessionRecord>) {
  const save = (record: SsoProviderRecord): SsoProviderWrite => {
    const verdict = conflict(providers, record);
    if (verdict === "ok") providers.set(record.id, copy(record));
    return verdict;
  };
  return {
    createSsoProvider: (record) => (providers.has(record.id) ? "entity_id_exists" : save(record)),
    updateSsoProvider: (record) => (providers.has(record.id) ? save(record) : "not_found"),
    getSsoProvider: (id) => find(providers, (p) => p.id === id),
    getSsoProviderByEntityId: (entityId) => find(providers, (p) => p.entityId === entityId),
    getSsoProviderByDomain: (domain) => find(providers, (p) => p.domains.includes(domain)),
    listSsoProviders: () =>
      [...providers.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .map(copy),
    deleteSsoProvider(id) {
      for (const [key, s] of sessions) if (s.providerId === id) sessions.delete(key);
      return providers.delete(id);
    },
  } satisfies Partial<SsoMethods>;
}

/** Drop expired rows, then the oldest past the cap. */
function prune<T>(map: Map<string, T>, maxEntries: number, expired: (value: T) => boolean): void {
  for (const [key, value] of map) if (expired(value)) map.delete(key);
  while (map.size > maxEntries) map.delete(map.keys().next().value as string);
}

/** The session-origin and message-id methods. */
function sessionMethods(
  sessions: Map<string, SsoSessionRecord>,
  ids: Map<string, number>,
  maxEntries: number,
  now: () => number,
) {
  return {
    createSsoSession(record) {
      prune(sessions, maxEntries, (s) => s.expiresAt <= now());
      sessions.set(record.sessionId, { ...record });
    },
    listSsoSessions: (providerId, nameId) =>
      [...sessions.values()]
        .filter((s) => s.providerId === providerId && s.nameId === nameId && s.expiresAt > now())
        .map((s) => ({ ...s })),
    claimSamlMessageId(id, expiresAt) {
      prune(ids, maxEntries, (until) => until <= now());
      if (ids.has(id)) return false;
      ids.set(id, expiresAt);
      return true;
    },
  } satisfies Partial<SsoMethods>;
}

/**
 * The Single Logout index and revocation list. Index rows past the cap are evicted oldest first
 * (a lost row makes a LogoutRequest fail closed); revocations are never evicted, only expired.
 */
function indexMethods(
  index: Map<string, SsoSessionIndexRecord>,
  revoked: Map<string, number>,
  maxEntries: number,
  now: () => number,
): SsoIndexMethods {
  const live = (match: (r: SsoSessionIndexRecord) => boolean) =>
    [...index.values()].filter((r) => r.expiresAt > now() && match(r)).map((r) => ({ ...r }));
  return {
    recordSsoSessionIndex(providerId, nameId, sessionIndex, sid, expiresAt) {
      prune(index, maxEntries, (r) => r.expiresAt <= now());
      index.set(sid, {
        providerId,
        nameId,
        ...(sessionIndex !== undefined && { sessionIndex }),
        sid,
        expiresAt,
      });
    },
    listSsoSessionIndexBySessionIndex: (providerId, nameId, sessionIndex) =>
      live((r) =>
        r.providerId === providerId && r.nameId === nameId && r.sessionIndex === sessionIndex
      ),
    listSsoSessionIndexByNameId: (providerId, nameId) =>
      live((r) => r.providerId === providerId && r.nameId === nameId),
    revokeSids(sids, expiresAt) {
      prune(revoked, Infinity, (until) => until <= now());
      for (const sid of sids) revoked.set(sid, Math.max(expiresAt, revoked.get(sid) ?? 0));
    },
    isSidRevoked: (sid) => (revoked.get(sid) ?? 0) > now(),
  };
}

/**
 * Build the group.
 *
 * @param maxEntries The cap on session records and remembered message ids (oldest evicted).
 * @param now Epoch seconds.
 * @returns The group.
 */
export function memorySsoGroup(maxEntries: number, now: () => number): MemorySsoGroup {
  const providers: Providers = new Map();
  const sessions = new Map<string, SsoSessionRecord>();
  const ids = new Map<string, number>();
  const index = new Map<string, SsoSessionIndexRecord>();
  const revoked = new Map<string, number>();
  return {
    methods: {
      ...providerMethods(providers, sessions),
      ...sessionMethods(sessions, ids, maxEntries, now),
      ...indexMethods(index, revoked, maxEntries, now),
    },
    dropUser(userId) {
      for (const [key, s] of sessions) if (s.userId === userId) sessions.delete(key);
    },
    clear() {
      providers.clear();
      sessions.clear();
      ids.clear();
      index.clear();
      revoked.clear();
    },
  };
}

// The in-memory adapter's SAML SSO group: stored providers (entity id and domains unique),
// the SSO origin of sessions, and the shared SAML message-id replay cache.

import type {
  AuthAdapter,
  SsoProviderRecord,
  SsoProviderWrite,
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

/** The group, plus what the adapter's deletion and close need. */
export interface MemorySsoGroup {
  /** The adapter methods. */
  methods: SsoMethods;
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
  return {
    methods: {
      ...providerMethods(providers, sessions),
      ...sessionMethods(sessions, ids, maxEntries, now),
    },
    dropUser(userId) {
      for (const [key, s] of sessions) if (s.userId === userId) sessions.delete(key);
    },
    clear() {
      providers.clear();
      sessions.clear();
      ids.clear();
    },
  };
}

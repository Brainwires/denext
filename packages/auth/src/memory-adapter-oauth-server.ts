/**
 * The in-memory implementation of the OAuth-server, stored-provider and Web3 nonce groups
 * (`./adapter-oauth-server.ts`) — part of `inMemoryAuthAdapter()`. Every map is bounded
 * (oldest evicted), and every compare-and-swap runs to completion without an `await`, which on
 * one isolate is the critical section.
 *
 * @module
 */

import type {
  CustomProviderAdapter,
  CustomProviderRecord,
  OAuthAuthorizationRecord,
  OAuthClientRecord,
  OAuthConsentRecord,
  OAuthServerAdapter,
  OAuthSessionLink,
  Web3NonceAdapter,
} from "./adapter-oauth-server.ts";

/** A bounded insertion-ordered map. */
class Bounded<T> extends Map<string, T> {
  constructor(private readonly max: number) {
    super();
  }
  override set(key: string, value: T): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.max) super.delete(this.keys().next().value!);
    return this;
  }
}

/** The groups plus the user-deletion hook. */
export type MemoryOAuthServerGroups =
  & Required<OAuthServerAdapter>
  & Required<CustomProviderAdapter>
  & Required<Web3NonceAdapter>
  & { forgetOAuthUser(userId: string): void; clearOAuthServer(): void };

const SEP = "\u0000";
const clone = <T>(value: T | undefined): T | undefined =>
  value === undefined ? undefined : structuredClone(value);

/**
 * Build the in-memory groups.
 *
 * @param max The row cap per map.
 * @param now The clock, epoch seconds.
 * @returns The methods, plus `forgetOAuthUser` for account deletion and `clearOAuthServer`.
 */
export function memoryOAuthServerGroups(max: number, now: () => number): MemoryOAuthServerGroups {
  const clients = new Bounded<OAuthClientRecord>(max);
  const authorizations = new Bounded<OAuthAuthorizationRecord>(max);
  const consents = new Bounded<OAuthConsentRecord>(max);
  const links = new Bounded<OAuthSessionLink>(max);
  const providers = new Bounded<CustomProviderRecord>(max);
  const nonces = new Bounded<number>(max);
  const dropWhere = <T>(map: Map<string, T>, test: (value: T) => boolean) => {
    for (const [key, value] of [...map]) if (test(value)) map.delete(key);
  };
  return {
    ...clientMethods(clients, authorizations, consents, links, dropWhere),
    ...authorizationMethods(authorizations, now),
    ...consentMethods(consents, links),
    ...providerMethods(providers),
    claimWeb3Nonce(hash, expiresAt) {
      const held = nonces.get(hash);
      if (held !== undefined && held > now()) return false;
      dropWhere(nonces, (expiry) => expiry <= now());
      nonces.set(hash, expiresAt);
      return true;
    },
    forgetOAuthUser(userId) {
      dropWhere(authorizations, (a) => a.userId === userId);
      dropWhere(consents, (c) => c.userId === userId);
      dropWhere(links, (l) => l.userId === userId);
    },
    clearOAuthServer() {
      for (const map of [clients, authorizations, consents, links, providers, nonces]) map.clear();
    },
  };
}

function clientMethods(
  clients: Bounded<OAuthClientRecord>,
  authorizations: Bounded<OAuthAuthorizationRecord>,
  consents: Bounded<OAuthConsentRecord>,
  links: Bounded<OAuthSessionLink>,
  dropWhere: <T>(map: Map<string, T>, test: (value: T) => boolean) => void,
): Pick<
  Required<OAuthServerAdapter>,
  | "createOAuthClient"
  | "getOAuthClient"
  | "listOAuthClients"
  | "updateOAuthClient"
  | "deleteOAuthClient"
> {
  return {
    createOAuthClient(client) {
      clients.set(client.id, structuredClone(client));
    },
    getOAuthClient: (id) => clone(clients.get(id)),
    listOAuthClients({ page, perPage }) {
      const all = [...clients.values()].sort((a, b) => a.createdAt - b.createdAt);
      const start = (page - 1) * perPage;
      return {
        clients: all.slice(start, start + perPage).map((c) => clone(c)!),
        total: all.length,
      };
    },
    updateOAuthClient(client) {
      if (clients.has(client.id)) clients.set(client.id, structuredClone(client));
    },
    deleteOAuthClient(id) {
      clients.delete(id);
      dropWhere(authorizations, (a) => a.clientId === id);
      dropWhere(consents, (c) => c.clientId === id);
      dropWhere(links, (l) => l.clientId === id);
    },
  };
}

function authorizationMethods(
  authorizations: Bounded<OAuthAuthorizationRecord>,
  now: () => number,
): Pick<
  Required<OAuthServerAdapter>,
  | "createOAuthAuthorization"
  | "getOAuthAuthorization"
  | "getOAuthAuthorizationByCode"
  | "updateOAuthAuthorization"
> {
  return {
    createOAuthAuthorization(record) {
      for (const [key, value] of [...authorizations]) {
        if (value.expiresAt <= now() - 3600) authorizations.delete(key);
      }
      authorizations.set(record.id, structuredClone(record));
    },
    getOAuthAuthorization: (id) => clone(authorizations.get(id)),
    getOAuthAuthorizationByCode(codeHash) {
      for (const record of authorizations.values()) {
        if (record.codeHash === codeHash) return clone(record);
      }
      return undefined;
    },
    updateOAuthAuthorization(id, patch, expect) {
      // No await between the check and the write: atomic on one isolate.
      const record = authorizations.get(id);
      if (!record) return false;
      if (expect.status !== undefined && record.status !== expect.status) return false;
      if (expect.userId === null && record.userId !== undefined) return false;
      if (typeof expect.userId === "string" && record.userId !== expect.userId) return false;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) Reflect.set(record, key, value);
      }
      return true;
    },
  };
}

function consentMethods(
  consents: Bounded<OAuthConsentRecord>,
  links: Bounded<OAuthSessionLink>,
): Pick<
  Required<OAuthServerAdapter>,
  | "putOAuthConsent"
  | "getOAuthConsent"
  | "listOAuthConsents"
  | "linkOAuthSession"
  | "listOAuthSessions"
  | "listOAuthClientSessions"
> {
  return {
    putOAuthConsent(consent) {
      consents.set(`${consent.userId}${SEP}${consent.clientId}`, structuredClone(consent));
    },
    getOAuthConsent: (userId, clientId) => clone(consents.get(`${userId}${SEP}${clientId}`)),
    listOAuthConsents: (userId) =>
      [...consents.values()].filter((c) => c.userId === userId)
        .sort((a, b) => a.grantedAt - b.grantedAt).map((c) => clone(c)!),
    linkOAuthSession(link) {
      links.set(link.sessionId, { ...link });
    },
    listOAuthSessions: (userId, clientId) =>
      [...links.values()].filter((l) => l.userId === userId && l.clientId === clientId)
        .map((l) => l.sessionId),
    listOAuthClientSessions: (clientId) =>
      [...links.values()].filter((l) => l.clientId === clientId).map((l) => l.sessionId),
  };
}

function providerMethods(
  providers: Bounded<CustomProviderRecord>,
): Required<CustomProviderAdapter> {
  return {
    createCustomProvider(record) {
      if (providers.has(record.identifier)) return false;
      providers.set(record.identifier, structuredClone(record));
      return true;
    },
    getCustomProvider: (identifier) => clone(providers.get(identifier)),
    listCustomProviders: () =>
      [...providers.values()].sort((a, b) => a.createdAt - b.createdAt).map((p) => clone(p)!),
    updateCustomProvider(record) {
      if (providers.has(record.identifier)) {
        providers.set(record.identifier, structuredClone(record));
      }
    },
    deleteCustomProvider(identifier) {
      providers.delete(identifier);
    },
  };
}

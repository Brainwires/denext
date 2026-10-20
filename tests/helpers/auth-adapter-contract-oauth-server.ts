// The AuthAdapter contract for the `/auth/v1` OAuth-server, stored-provider and Web3 nonce
// groups (src/server/auth/adapter-oauth-server.ts) — run by tests/helpers/auth-adapter-contract.ts
// against every adapter denext ships (in-memory, SQLite, Postgres).

import { assert, assertEquals } from "@std/assert";
import type { AuthAdapter } from "../../src/server/auth/adapter.ts";
import { at } from "./contract-clock.ts";
import {
  customProviderStoreOf,
  type OAuthAuthorizationRecord,
  type OAuthClientRecord,
  oauthServerStoreOf,
} from "../../src/server/auth/adapter-oauth-server.ts";

type Case = (adapter: AuthAdapter) => Promise<void>;

const client = (id: string, createdAt = at(0)): OAuthClientRecord => ({
  id,
  name: `client ${id}`,
  clientType: "confidential",
  tokenEndpointAuthMethod: "client_secret_basic",
  registrationType: "manual",
  redirectUris: ["https://client.test/cb"],
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  secretHash: "h".repeat(64),
  createdAt,
  updatedAt: createdAt,
});

const authorization = (id: string, clientId: string): OAuthAuthorizationRecord => ({
  id,
  clientId,
  redirectUri: "https://client.test/cb",
  scope: "openid email",
  state: "st",
  codeChallenge: "c".repeat(43),
  status: "pending",
  createdAt: at(0),
  expiresAt: at(600),
});

function store(adapter: AuthAdapter) {
  const oauth = oauthServerStoreOf(adapter);
  assert(oauth, "the OAuth-server group is required by this contract");
  return oauth;
}

/** The cases. */
export const OAUTH_SERVER_CASES: Record<string, Case> = {
  "oauth clients: create, read, page, update, delete": async (adapter) => {
    const oauth = store(adapter);
    await oauth.createOAuthClient(client("c1", at(-20)));
    await oauth.createOAuthClient(client("c2", at(-10)));
    await oauth.createOAuthClient(client("c3", at(0)));
    assertEquals((await oauth.getOAuthClient("c1"))?.redirectUris, ["https://client.test/cb"]);
    assertEquals(await oauth.getOAuthClient("nope"), undefined);
    const page = await oauth.listOAuthClients({ page: 2, perPage: 2 });
    assertEquals(page.total, 3);
    assertEquals(page.clients.map((c) => c.id), ["c3"]);
    await oauth.updateOAuthClient({ ...client("c1", at(-20)), name: "renamed" });
    assertEquals((await oauth.getOAuthClient("c1"))?.name, "renamed");
    await oauth.createOAuthAuthorization(authorization("a1", "c1"));
    await oauth.putOAuthConsent({ userId: "u1", clientId: "c1", scopes: ["email"], grantedAt: 1 });
    await oauth.linkOAuthSession({ sessionId: "s1", userId: "u1", clientId: "c1", createdAt: 1 });
    await oauth.deleteOAuthClient("c1");
    assertEquals(await oauth.getOAuthClient("c1"), undefined);
    assertEquals(await oauth.getOAuthAuthorization("a1"), undefined, "its requests go too");
    assertEquals(await oauth.getOAuthConsent("u1", "c1"), undefined, "and its consents");
    assertEquals(await oauth.listOAuthClientSessions("c1"), []);
  },
  "oauth authorizations: compare-and-swap binds one user and settles once": async (adapter) => {
    const oauth = store(adapter);
    await oauth.createOAuthAuthorization(authorization("a1", "c1"));
    const read = await oauth.getOAuthAuthorization("a1");
    assertEquals(read?.state, "st");
    assertEquals(read?.userId, undefined);
    assertEquals(
      await oauth.updateOAuthAuthorization("a1", { userId: "u1" }, { userId: null }),
      true,
    );
    assertEquals(
      await oauth.updateOAuthAuthorization("a1", { userId: "u2" }, { userId: null }),
      false,
      "a bound request can't be taken by another user",
    );
    const settle = () =>
      oauth.updateOAuthAuthorization("a1", { status: "approved", codeHash: "code-1" }, {
        status: "pending",
        userId: "u1",
      });
    const results = await Promise.all([settle(), settle()]);
    assertEquals(results.filter(Boolean).length, 1, "exactly one settles it");
    const byCode = await oauth.getOAuthAuthorizationByCode("code-1");
    assertEquals(byCode?.id, "a1");
    assertEquals(byCode?.status, "approved");
    assertEquals(byCode?.ssoConsent, undefined, "not SSO-consented unless recorded");
    await oauth.createOAuthAuthorization(authorization("a2", "c1"));
    assertEquals(
      await oauth.updateOAuthAuthorization("a2", {
        userId: "u1",
        status: "approved",
        codeHash: "code-2",
        ssoConsent: true,
      }, { status: "pending" }),
      true,
    );
    assertEquals((await oauth.getOAuthAuthorizationByCode("code-2"))?.ssoConsent, true);
    assertEquals(
      await oauth.updateOAuthAuthorization("a1", { status: "used", sessionId: "s1" }, {
        status: "approved",
      }),
      true,
    );
    assertEquals((await oauth.getOAuthAuthorization("a1"))?.sessionId, "s1");
    assertEquals(await oauth.updateOAuthAuthorization("nope", { status: "used" }, {}), false);
  },
  "oauth consents and session links": async (adapter) => {
    const oauth = store(adapter);
    await oauth.putOAuthConsent({ userId: "u1", clientId: "c1", scopes: ["email"], grantedAt: 5 });
    await oauth.putOAuthConsent({ userId: "u1", clientId: "c2", scopes: ["openid"], grantedAt: 6 });
    await oauth.putOAuthConsent({
      userId: "u1",
      clientId: "c1",
      scopes: ["email", "profile"],
      grantedAt: 7,
      revokedAt: 8,
    });
    const consent = await oauth.getOAuthConsent("u1", "c1");
    assertEquals(consent?.scopes, ["email", "profile"]);
    assertEquals(consent?.revokedAt, 8);
    assertEquals((await oauth.listOAuthConsents("u1")).map((c) => c.clientId), ["c2", "c1"]);
    await oauth.linkOAuthSession({ sessionId: "s1", userId: "u1", clientId: "c1", createdAt: 1 });
    await oauth.linkOAuthSession({ sessionId: "s2", userId: "u2", clientId: "c1", createdAt: 1 });
    assertEquals(await oauth.listOAuthSessions("u1", "c1"), ["s1"]);
    assertEquals((await oauth.listOAuthClientSessions("c1")).sort(), ["s1", "s2"]);
  },
  "oauth rows go with their user": async (adapter) => {
    const oauth = store(adapter);
    const user = await adapter.createUser({ email: "grant@x.test" });
    await oauth.createOAuthAuthorization({ ...authorization("a1", "c1"), userId: user.id });
    await oauth.putOAuthConsent({ userId: user.id, clientId: "c1", scopes: [], grantedAt: 1 });
    await oauth.linkOAuthSession({
      sessionId: "s1",
      userId: user.id,
      clientId: "c1",
      createdAt: 1,
    });
    await adapter.deleteUser?.(user.id);
    assertEquals(await oauth.getOAuthAuthorization("a1"), undefined);
    assertEquals(await oauth.getOAuthConsent(user.id, "c1"), undefined);
    assertEquals(await oauth.listOAuthSessions(user.id, "c1"), []);
  },
  "custom providers: insert-unless-present, read, list, update, delete": async (adapter) => {
    const providers = customProviderStoreOf(adapter);
    assert(providers, "the stored-provider group is required by this contract");
    const record = {
      id: "p-1",
      identifier: "custom:acme",
      providerType: "oidc" as const,
      name: "Acme",
      clientId: "acme-client",
      clientSecretSealed: "sealed",
      enabled: true,
      settings: { issuer: "https://idp.test", scopes: ["openid"] },
      createdAt: at(-5),
      updatedAt: at(-5),
    };
    assertEquals(await providers.createCustomProvider(record), true);
    assertEquals(
      await providers.createCustomProvider({ ...record, id: "p-2" }),
      false,
      "a taken identifier is refused",
    );
    await providers.createCustomProvider({ ...record, id: "p-3", identifier: "custom:b" });
    assertEquals((await providers.getCustomProvider("custom:acme"))?.settings, record.settings);
    assertEquals((await providers.listCustomProviders()).map((p) => p.identifier), [
      "custom:acme",
      "custom:b",
    ]);
    await providers.updateCustomProvider({ ...record, enabled: false });
    assertEquals((await providers.getCustomProvider("custom:acme"))?.enabled, false);
    await providers.deleteCustomProvider("custom:acme");
    assertEquals(await providers.getCustomProvider("custom:acme"), undefined);
  },
  "web3 nonces are claimed once": async (adapter) => {
    assert(adapter.claimWeb3Nonce, "the Web3 nonce group is required by this contract");
    const claims = await Promise.all([
      adapter.claimWeb3Nonce("n1", at(600)),
      adapter.claimWeb3Nonce("n1", at(600)),
    ]);
    assertEquals(claims.filter(Boolean).length, 1);
    assertEquals(await adapter.claimWeb3Nonce("n1", at(600)), false);
    assertEquals(await adapter.claimWeb3Nonce("n2", at(600)), true);
    // An expired claim no longer holds the value.
    assertEquals(await adapter.claimWeb3Nonce("n3", at(-1)), true);
    assertEquals(await adapter.claimWeb3Nonce("n3", at(600)), true);
  },
};

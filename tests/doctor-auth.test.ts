// `denext doctor`'s SAML Single Logout check: a warning when stateless SAML sessions can't be
// revoked exactly (an adapter without the session index) or only in this process (the in-memory
// adapter).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { authChecks, samlLogoutStoreCheck } from "../src/cli/commands/doctor-auth.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { saml } from "../src/server/auth/providers.ts";
import { sqliteSessionStore } from "../src/server/auth/sqlite-session-store.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { rsaKey } from "./_saml-helpers.ts";
import { spKey } from "./_saml-enc-helpers.ts";

const IDP = await rsaKey();
const SP = await spKey();
const METADATA = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.test/metadata">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${IDP.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.test/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

function auth(
  overrides: Partial<AuthConfig> = {},
  signingKey = true,
): DenextConfig["plugins"] {
  return [
    denextAuth({
      secret: "test-secret-value-at-least-32-chars-long",
      adapter: inMemoryAuthAdapter(),
      providers: [
        saml({
          id: "acme",
          metadataXml: METADATA,
          domains: ["acme.test"],
          ...(signingKey ? { sp: { signingKey: SP.pem, signingCertificate: SP.certificate } } : {}),
        }),
      ],
      ...overrides,
    }),
  ];
}

/** An adapter without the Single Logout session index (as an Auth.js adapter is). */
function withoutIndex(): AuthAdapter {
  const {
    recordSsoSessionIndex: _r,
    listSsoSessionIndexBySessionIndex: _i,
    listSsoSessionIndexByNameId: _n,
    revokeSids: _v,
    isSidRevoked: _s,
    ...rest
  } = sqliteAuthAdapter({ path: ":memory:" });
  return rest;
}

Deno.test("SAML Single Logout over the in-memory auth adapter is a (non-critical) warning", () => {
  const check = samlLogoutStoreCheck({ plugins: auth() });
  assert(check);
  assertEquals(check.ok, false);
  assertEquals(check.critical, false);
  assertStringIncludes(check.detail, "in-memory auth adapter");
});

Deno.test("an adapter without the session index is a warning: logout ends every session", () => {
  const check = samlLogoutStoreCheck({ plugins: auth({ adapter: withoutIndex() }) });
  assertEquals(check?.ok, false);
  assertStringIncludes(check!.detail, "keeps no SAML session index");
});

Deno.test("SAML Single Logout over a durable adapter passes", () => {
  const adapter = sqliteAuthAdapter({ path: ":memory:" });
  assertEquals(samlLogoutStoreCheck({ plugins: auth({ adapter }) })?.ok, true);
  assertEquals(authChecks({ plugins: auth({ adapter }) }).length, 1);
  assertEquals(authChecks({ plugins: [] }), []);
});

Deno.test("no check without SAML Single Logout, an auth plugin, or with a session store", () => {
  assertEquals(samlLogoutStoreCheck(null), null);
  assertEquals(samlLogoutStoreCheck({ cache: { store: "memory" } }), null);
  assertEquals(samlLogoutStoreCheck({ plugins: auth({}, false) }), null);
  const store = sqliteSessionStore({ path: ":memory:" });
  try {
    assertEquals(samlLogoutStoreCheck({ plugins: auth({ sessionStore: store }) }), null);
  } finally {
    store.close?.();
  }
});

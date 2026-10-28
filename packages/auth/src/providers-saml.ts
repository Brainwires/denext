/**
 * `saml()` — a SAML 2.0 identity provider for denextAuth's own sign-in endpoints. The routes
 * are `routes-saml.ts`'s; this validates the declaration up front, so a bad metadata document
 * or an unsafe id fails at `denext.config` import rather than at the first sign-in.
 *
 * @module
 */

import { idpFromMetadata } from "./gotrue/sso-metadata.ts";
import type { SamlProvider } from "./types.ts";

/** Options for {@link saml}: everything on a {@link SamlProvider} but its `type`. */
export type SamlProviderOptions = Omit<SamlProvider, "type">;

/** A provider id that is one URL path segment. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** An email domain: dot-separated labels, no scheme, port, path or `@`. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * A SAML 2.0 identity provider (Okta, Entra ID, Google Workspace, ADFS, Keycloak, …) on
 * `{basePath}/signin/:id`. Sign-ins are SSO sign-ins: the account is the IdP's (an SSO user),
 * its email is bound only on the provider's `domains`, and an existing account is never taken
 * over unless `linkExistingAccounts` is set.
 *
 * ```ts
 * saml({
 *   id: "acme",
 *   metadataXml: await Deno.readTextFile("./acme-idp-metadata.xml"),
 *   domains: ["acme.com"],
 * });
 * ```
 *
 * @param options The IdP's metadata, its domains and the account rules.
 * @returns The provider to list in `AuthConfig.providers`.
 * @throws {TypeError} For an unsafe id, a malformed domain, or metadata that doesn't parse.
 */
export function saml(options: SamlProviderOptions): SamlProvider {
  if (!PROVIDER_ID.test(String(options.id ?? ""))) {
    throw new TypeError("auth: saml provider id must match [A-Za-z0-9._-] (1-128 chars)");
  }
  const domains = (options.domains ?? []).map((d) => String(d).trim().toLowerCase());
  const bad = domains.find((d) => !DOMAIN.test(d));
  if (bad !== undefined) {
    throw new TypeError(
      `auth: saml provider "${options.id}" has an invalid domain ${JSON.stringify(bad)}`,
    );
  }
  try {
    idpFromMetadata(options.metadataXml);
  } catch (error) {
    throw new TypeError(
      `auth: saml provider "${options.id}" metadata does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { ...options, type: "saml", domains };
}

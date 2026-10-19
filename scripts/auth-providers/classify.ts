/**
 * How `deno task gen:auth-providers` treats each provider Auth.js ships in `@auth/core`'s
 * `providers/` at the pinned version: generated from Auth.js's own provider definition (the
 * default), written by hand (a denext preset already covers it, or it is not OAuth / OIDC), or
 * left out with the reason. A provider the pinned list adds that none of these names is
 * generated; one the generator can't express fails the run until it is classified here.
 *
 * @module
 */

/** The `@auth/core` release the generated providers follow (`next-auth@5.0.0-beta.32`'s). */
export const AUTHJS_CORE_VERSION = "0.41.3";

/** `@auth/core/providers/*` files that are not providers. */
export const NOT_PROVIDERS: readonly string[] = ["index", "oauth", "provider-types"];

/**
 * The providers denext's shim writes by hand: the ones on a denext preset (its endpoints,
 * scopes and email-verification rules), and the non-OAuth kinds (credentials, email, passkey).
 */
export const HAND_WRITTEN: readonly string[] = [
  "apple",
  "auth0",
  "azure-ad",
  "cognito",
  "credentials",
  "discord",
  "email",
  "facebook",
  "forwardemail",
  "github",
  "gitlab",
  "google",
  "keycloak",
  "linkedin",
  "loops",
  "mailgun",
  "microsoft-entra-id",
  "nodemailer",
  "notion",
  "okta",
  "passkey",
  "postmark",
  "resend",
  "sendgrid",
  "slack",
  "spotify",
  "twitch",
  "twitter",
  "webauthn",
  "zoom",
];

/** The providers left out, each with why denext can't run it as Auth.js defines it. */
export const UNSUPPORTED: Readonly<Record<string, string>> = {
  "azure-devops": "Azure DevOps OAuth exchanges a JWT assertion (`response_type=Assertion`) " +
    "instead of an authorization code, and Microsoft has deprecated it: use " +
    "`microsoft-entra-id`.",
  "bankid-no": "BankID Norge returns userinfo as a signed JWT (`userinfo_signed_response_alg`); " +
    "denext reads userinfo as JSON.",
  bungie: "Bungie's userinfo URL needs the account's `membershipId` from the token response, " +
    "and every call needs an `X-API-Key` header.",
  dropbox: "Dropbox reads the account with a POST to `/2/users/get_current_account`; denext's " +
    "userinfo request is a GET.",
  foursquare: "Foursquare takes the access token as an `oauth_token` query parameter (with a " +
    "`v` version date), not as a Bearer header.",
  hubspot: "HubSpot puts the access token in the userinfo URL's path " +
    "(`/oauth/v1/access-tokens/<token>`).",
  line: "LINE signs its `id_token` with HS256 under the channel secret; denext verifies " +
    "`id_token`s against the provider's JWKS (RS, PS and ES algorithms) only.",
  netsuite: "NetSuite has no userinfo endpoint: the profile comes from a RESTlet the app " +
    "deploys, which Auth.js leaves to the app's own `userinfo`.",
  nextcloud: "Nextcloud reads the user from `/ocs/v1.php/cloud/users/<user_id>` (the id comes " +
    "from the token response) with OCS headers.",
  tiktok: "TikTok's token endpoint takes the client id as `client_key`, not `client_id`.",
  todoist: "Todoist reads the user through its Sync API (a POST with `sync_token` and " +
    "`resource_types`), not a userinfo endpoint.",
  trakt: "Trakt needs `trakt-api-key` and `trakt-api-version` headers on every API call.",
  vk: "VK returns the address in the token response (`email`) and the user as " +
    "`users.get`'s `response[0]`.",
  wechat: "WeChat sends `appid` / `secret` as query parameters instead of OAuth client " +
    "authentication, and its userinfo request needs the token response's `openid`.",
};

/** An option a provider reads besides the client credentials and the issuer. */
export interface OptionRule {
  /** Its default, when the app leaves it out (may name `{clientId}`). */
  default?: string;
  /** Insert it verbatim (a URL prefix); otherwise it is URL-encoded where it lands. */
  raw?: boolean;
}

/** One alternative of a profile field the tracer can't see (see `ProfileExpr`). */
export type ProfileOverride =
  | { p: string[] }
  | { t: (string | string[])[] }
  | { c: string | number | boolean | null }
  | { join: string[][]; sep: string }
  | { find: string[]; where: string; pick: string }
  | { when: string[]; then: ProfileOverride; else: ProfileOverride };

/** What a provider needs beyond what the generator reads off its definition. */
export interface ProviderRule {
  /** Options it reads (`apiBaseUrl`, `connection`, …), and the issuer's default. */
  options?: Readonly<Record<string, OptionRule>>;
  /** Hooks the definition carries that denext can do without (a no-op for its flow). */
  ignore?: readonly string[];
  /** Profile fields the tracer can't follow (`filter(Boolean).join(" ")`), as alternatives. */
  profile?: Readonly<Record<string, readonly ProfileOverride[]>>;
  /** `false`: `profile` is the whole mapping (the tracer can't run Auth.js's `profile()`). */
  trace?: false;
  /** Extra raw profiles to check the mapping against Auth.js's `profile()` on. */
  samples?: readonly Record<string, unknown>[];
}

/** The per-provider rules. */
export const RULES: Readonly<Record<string, ProviderRule>> = {
  "boxyhq-saml": {
    profile: { name: [{ join: [["p", "firstName"], ["p", "lastName"]], sep: " " }] },
  },
  "click-up": { ignore: ["clientId", "clientSecret"] },
  eventbrite: {
    trace: false,
    profile: {
      id: [{ p: ["p", "id"] }],
      name: [{ p: ["p", "name"] }],
      email: [{ find: ["p", "emails"], where: "primary", pick: "email" }],
      image: [{
        when: ["p", "image_id"],
        then: {
          t: [
            "https://img.evbuc.com/https%3A%2F%2Fcdn.evbuc.com%2Fimages%2F",
            ["p", "image_id"],
            "%2F1%2Foriginal.jpg",
          ],
        },
        else: { c: null },
      }],
    },
    samples: [
      { id: "1", name: "Ada", emails: [{ email: "a@x", primary: false }] },
      {
        id: "1",
        name: "Ada",
        image_id: "42",
        emails: [{ email: "a@x", primary: false }, { email: "b@x", primary: true }],
      },
    ],
  },
  descope: { options: { issuer: { default: "https://api.descope.com/{clientId}", raw: true } } },
  dribbble: { options: { scope: {} } },
  // FACEIT wants the client credentials as HTTP Basic, which is the generated default.
  faceit: { ignore: ["headers"] },
  fusionauth: {
    options: { tenantId: {} },
    // Strips a `WWW-Authenticate` header off the token response; denext never reads it.
    ignore: ["token.conform", "clientId", "clientSecret"],
    profile: {
      name: [
        { p: ["p", "name"] },
        { p: ["p", "preferred_username"] },
        {
          join: [["p", "given_name"], ["p", "middle_name"], ["p", "family_name"]],
          sep: " ",
        },
      ],
    },
  },
  mattermost: { ignore: ["clientId", "clientSecret"] },
  webex: { options: { apiBaseUrl: { default: "https://webexapis.com/v1", raw: true } } },
  workos: {
    options: { issuer: { default: "https://api.workos.com/", raw: true }, connection: {} },
  },
};

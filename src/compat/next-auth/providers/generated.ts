/**
 * The runtime behind the generated `next-auth/providers/*` modules: each carries the static data
 * `deno task gen:auth-providers` read off Auth.js's own provider definition (endpoints, scopes,
 * token-endpoint authentication, the profile mapping as data), and this module turns it into a
 * denext provider with Auth.js's defaults — `AUTH_<ID>_ID` / `_SECRET` / `_ISSUER`, HTTP Basic
 * client authentication unless the provider names `client_secret_post`, and `openid profile
 * email` when the provider names no scope.
 *
 * @module
 */

import { emailVerifiedClaim } from "../../../server/auth/providers-presets.ts";
import { oidc } from "../../../server/auth/providers.ts";
import type {
  AuthUser,
  OAuthCheck,
  OAuthProvider,
  ProfileInput,
} from "../../../server/auth/types.ts";
import {
  issuerUrl,
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
  specProvider,
} from "./shared.ts";

/**
 * One alternative of a profile field: a path into the raw profile (`["p", …]`) or the token
 * response (`["t", …]`), a template of literal text and paths, a constant, a list of paths
 * joined without the empty ones, a field of the first list entry whose `where` field is truthy,
 * a choice on whether a path is truthy, or a path's value under a base URL (one `/` between).
 */
export type ProfileExpr =
  | { p: string[] }
  | { t: (string | string[])[] }
  | { url: string; path: string[] }
  | { c: string | number | boolean | null }
  | { join: string[][]; sep: string }
  | { find: string[]; where: string; pick: string }
  | { when: string[]; then: ProfileExpr; else: ProfileExpr };

/** An option a provider reads besides the credentials: its default, and how it is inserted. */
export interface GeneratedOption {
  /** The default when the app leaves it out (may name `{clientId}`). */
  default?: string;
  /** Inserted verbatim (a URL prefix) instead of URL-encoded. */
  raw?: boolean;
}

/**
 * A userinfo request of the provider's own shape (Auth.js's `userinfo.request`, as data). The
 * URL is the spec's `userinfo`, which may name `{token.<field>}` of the token response (filled,
 * URL-encoded, per sign-in).
 */
export interface GeneratedUserinfoRequest {
  /** `"POST"` (Dropbox, Todoist); a `GET` otherwise. */
  method?: "POST";
  /**
   * Where the access token goes: a Bearer header (the default), a query parameter
   * (`{ query: "oauth_token" }`), or nowhere (`"none"`: the URL carries it).
   */
  token?: "bearer" | "none" | { query: string };
  /** Extra headers (templates over `{clientId}` and options). */
  headers?: Record<string, string>;
  /** An option whose object value is sent as extra headers (Bungie's `headers`). */
  headersOption?: string;
  /** Extra query parameters (templates; may name `{token.<field>}`). */
  query?: Record<string, string>;
  /** A JSON body. */
  json?: Record<string, unknown>;
  /** The profile is this path of the response (`["response", "0"]`). */
  pick?: string[];
  /** Profile fields taken from the token response (`{ email: "email" }`), `null` when absent. */
  fromToken?: Record<string, string>;
}

/** A generated provider's static data. Strings may name `{issuer}`, `{clientId}` and options. */
export interface GeneratedSpec {
  /** The provider id. */
  id: string;
  /** Its display name. */
  name: string;
  /** `"oidc"` verifies an `id_token` (endpoints by discovery); `"oauth"` reads userinfo. */
  type: "oauth" | "oidc";
  /** The authorization endpoint (OAuth). */
  authorization?: string;
  /** The token endpoint (OAuth). */
  token?: string;
  /** The userinfo endpoint (OAuth, or OIDC with `profileFromUserinfo`). */
  userinfo?: string;
  /** The issuer (OIDC): a URL, or a template over the configured issuer. */
  issuer?: string;
  /** The scopes requested when the app names none. */
  scopes: string[];
  /** An option that supplies the scope (a provider whose scope Auth.js takes from its options). */
  scopeOption?: string;
  /** Extra authorization-request parameters (one naming an unset option is left out). */
  params?: Record<string, string>;
  /** How the client authenticates at the token endpoint. */
  tokenAuth: "client_secret_basic" | "client_secret_post";
  /**
   * The definition's own `checks` (absent when it names none: PKCE, plus a `nonce` for OIDC).
   * denext runs PKCE and the `nonce` only where they are listed; `state` always.
   */
  checks?: OAuthCheck[];
  /** A userinfo request that isn't a Bearer `GET` (see {@linkcode GeneratedUserinfoRequest}). */
  userinfoRequest?: GeneratedUserinfoRequest;
  /** Extra token-request parameters (templates over `{clientId}`): TikTok's `client_key`. */
  tokenParams?: Record<string, string>;
  /** `"HS256"`: the `id_token` is signed with the client secret, as LINE's specification has it. */
  idTokenAlg?: "HS256";
  /** OIDC whose profile is the userinfo response (Auth.js's `idToken: false`). */
  profileFromUserinfo?: boolean;
  /** The options it reads besides the credentials and the issuer. */
  options?: Record<string, GeneratedOption>;
  /**
   * The Auth.js user each field maps to, as alternatives tried in order (`??`); absent for a
   * provider with no `profile()`, which maps as Auth.js's default does ({@linkcode DEFAULT_PROFILE}).
   */
  profile?: Record<string, ProfileExpr[]>;
}

/** Auth.js's default profile mapping (`lib/utils/providers.js`), minus its random-UUID id. */
const DEFAULT_PROFILE: Record<string, ProfileExpr[]> = {
  id: [{ p: ["p", "sub"] }, { p: ["p", "id"] }],
  name: [{ p: ["p", "name"] }, { p: ["p", "nickname"] }, { p: ["p", "preferred_username"] }],
  email: [{ p: ["p", "email"] }],
  image: [{ p: ["p", "picture"] }],
};

/** A spec's profile mapping. */
function mappingOf(spec: GeneratedSpec): Record<string, ProfileExpr[]> {
  return spec.profile ?? DEFAULT_PROFILE;
}

/** The options a generated provider takes: Auth.js's, plus the ones its definition reads. */
export interface GeneratedUserConfig<P = Record<string, unknown>> extends OAuthUserConfig<P> {
  /** A provider-specific option (`apiBaseUrl`, `connection`, `tenantId`, `scope`, …). */
  [option: string]: unknown;
}

/** The value at `path` under `root`, or `undefined`. */
function at(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The raw profile and token response a profile path starts from. */
interface ProfileRoots {
  /** `p`: the profile Auth.js hands `profile()`. */
  p: Record<string, unknown>;
  /** `t`: the token response. */
  t: Record<string, unknown>;
}

/** A `["p" | "t", …]` path's value. */
function read(roots: ProfileRoots, path: readonly string[]): unknown {
  const [root, ...rest] = path;
  return at(root === "t" ? roots.t : roots.p, rest);
}

/** Values a template's literal text may name (`{issuer}`), filled where they appear. */
type Vars = Readonly<Record<string, string>>;

/** A literal with the `{name}`s `vars` has filled in. */
function literalText(text: string, vars: Vars): string {
  return text.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** A `find` alternative: a field of the first list entry whose `where` field is truthy. */
function findIn(
  expr: { find: string[]; where: string; pick: string },
  roots: ProfileRoots,
): unknown {
  const list = read(roots, expr.find);
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((entry) => entry && (entry as Record<string, unknown>)[expr.where]);
  return hit ? (hit as Record<string, unknown>)[expr.pick] : undefined;
}

/** A `url` alternative: a path's string value under a base URL, one `/` between (Bungie's). */
function underUrl(expr: { url: string; path: string[] }, roots: ProfileRoots): unknown {
  const value = read(roots, expr.path);
  if (typeof value !== "string") return undefined;
  return `${expr.url}${value.startsWith("/") ? "" : "/"}${value}`;
}

/** One alternative's value. */
function evaluate(expr: ProfileExpr, roots: ProfileRoots, vars: Vars = {}): unknown {
  if ("p" in expr) return read(roots, expr.p);
  if ("c" in expr) return expr.c;
  if ("join" in expr) {
    return expr.join.map((path) => read(roots, path)).filter(Boolean).join(expr.sep);
  }
  if ("find" in expr) return findIn(expr, roots);
  if ("url" in expr) return underUrl(expr, roots);
  if ("when" in expr) {
    return evaluate(read(roots, expr.when) ? expr.then : expr.else, roots, vars);
  }
  return expr.t.map((part) =>
    typeof part === "string" ? literalText(part, vars) : String(read(roots, part))
  ).join("");
}

/**
 * The Auth.js user a profile mapping yields: each field's first alternative that is not
 * `null` / `undefined` (else the last one's value), fields that come out `undefined` left out.
 *
 * @param mapping The provider's profile mapping.
 * @param roots The raw profile and the token response.
 * @param vars The values a template's literal text names (`{issuer}`: Nextcloud's avatar URL).
 * @returns The user as Auth.js's `profile()` would have returned it.
 */
export function mapProfile(
  mapping: Record<string, ProfileExpr[]>,
  roots: ProfileRoots,
  vars: Vars = {},
): Record<string, unknown> {
  const user: Record<string, unknown> = {};
  for (const [field, alternatives] of Object.entries(mapping)) {
    let value: unknown;
    for (const alternative of alternatives) {
      value = evaluate(alternative, roots, vars);
      if (value !== null && value !== undefined) break;
    }
    if (value !== undefined) user[field] = value;
  }
  return user;
}

/** The raw profile `profile()` receives: the id_token claims (OIDC), else the userinfo. */
function rawProfile(spec: GeneratedSpec, input: ProfileInput): Record<string, unknown> {
  if (spec.type === "oidc" && !spec.profileFromUserinfo) {
    return { ...(input.userinfo ?? {}), ...(input.claims ?? {}) };
  }
  return { ...(input.claims ?? {}), ...(input.userinfo ?? {}) };
}

/** Whether the id alternative that applies reads only values that are there. */
function idComplete(alternatives: ProfileExpr[], roots: ProfileRoots): boolean {
  for (const alternative of alternatives) {
    const value = evaluate(alternative, roots);
    if (value === null || value === undefined) continue;
    if (!("t" in alternative)) return true;
    return alternative.t.every((part) =>
      typeof part === "string" || (read(roots, part) ?? null) !== null
    );
  }
  return false;
}

/** A string field, when it is a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The mapped id, or `""` when it was built from a missing value (`String(undefined)`). */
function idOf(mapping: Record<string, ProfileExpr[]>, roots: ProfileRoots, id: unknown): string {
  if (!idComplete(mapping.id ?? [], roots)) return "";
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/**
 * The address fields: an OAuth provider's address is never treated as verified; an OIDC one is
 * when its `email_verified` claim says so, and one the claim marks unverified is dropped (as
 * denext's OIDC presets do).
 */
function emailFields(
  spec: GeneratedSpec,
  raw: Record<string, unknown>,
  email: string | undefined,
): Pick<AuthUser, "email" | "emailVerified"> {
  if (!email) return {};
  if (spec.type === "oauth") return { email };
  const verified = email === raw.email ? emailVerifiedClaim(raw.email_verified) : undefined;
  if (verified === false) return {};
  return verified === undefined ? { email } : { email, emailVerified: verified };
}

/** The denext user: the mapped id, name, image and (see {@link emailFields}) address. */
function denextUser(spec: GeneratedSpec, input: ProfileInput, vars: Vars): AuthUser {
  const raw = rawProfile(spec, input);
  const roots = { p: raw, t: input.tokens };
  const mapping = mappingOf(spec);
  const mapped = mapProfile(mapping, roots, vars);
  const user: AuthUser = { id: idOf(mapping, roots, mapped.id) };
  const name = text(mapped.name);
  const image = text(mapped.image);
  if (name) user.name = name;
  if (image) user.image = image;
  return { ...user, ...emailFields(spec, raw, text(mapped.email)) };
}

/** A template value: its text, and whether it is inserted verbatim. */
type TemplateValue = { value: string; raw: boolean };

/** `{token.<field>}` in a userinfo URL or query value. */
const TOKEN_FIELD = /\{token\.([A-Za-z_]+)\}/g;

/**
 * Fill a template's `{token.<field>}`s from the token response, URL-encoded. A field the
 * response lacks fails the sign-in (Auth.js would request `…/undefined`).
 */
function fillTokenFields(template: string, tokens: Record<string, unknown>): string {
  return template.replace(TOKEN_FIELD, (_, field: string) => {
    const value = tokens[field];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`the token response has no \`${field}\` for the userinfo request`);
    }
    return encodeURIComponent(String(value));
  });
}

/** The value at `path` of a userinfo response, when it is an object. */
function pickProfile(response: unknown, path: readonly string[]): Record<string, unknown> {
  const profile = at(response, path);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("userinfo returned no profile");
  }
  return { ...profile as Record<string, unknown> };
}

/**
 * The userinfo request a spec describes, its URL and headers filled from the build-time values
 * and its token fields from each sign-in's token response; the profile is the response (or the
 * `pick` path of it) plus the `fromToken` fields, as Auth.js's own `userinfo.request` returns it.
 *
 * @param request The request's shape.
 * @param url The userinfo URL, filled but for its `{token.<field>}`s.
 * @param headers The extra headers, filled.
 * @returns The provider's `userinfoRequest`.
 */
export function generatedUserinfoRequest(
  request: GeneratedUserinfoRequest,
  url: string,
  headers: Record<string, string>,
): NonNullable<OAuthProvider["userinfoRequest"]> {
  return async ({ tokens, fetch }) => {
    const accessToken = accessTokenOf(tokens);
    const res = await fetch(userinfoTarget(request, url, tokens, accessToken), {
      method: request.method ?? "GET",
      headers: userinfoHeaders(request, headers, accessToken),
      body: request.json && JSON.stringify(request.json),
    });
    if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
    return profileFrom(request, await res.json().catch(() => null), tokens);
  };
}

/** The token response's access token (a sign-in without one fails). */
function accessTokenOf(tokens: Record<string, unknown>): string {
  const token = tokens.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("the token response has no access_token");
  }
  return token;
}

/** The profile in a userinfo response: its `pick` path, plus the `fromToken` fields. */
function profileFrom(
  request: GeneratedUserinfoRequest,
  response: unknown,
  tokens: Record<string, unknown>,
): Record<string, unknown> {
  const profile = pickProfile(response, request.pick ?? []);
  for (const [field, from] of Object.entries(request.fromToken ?? {})) {
    profile[field] = tokens[from] ? tokens[from] : null;
  }
  return profile;
}

/** The userinfo URL with its token fields, query and (`{ query }`) access token filled. */
function userinfoTarget(
  request: GeneratedUserinfoRequest,
  url: string,
  tokens: Record<string, unknown>,
  accessToken: string,
): string {
  const target = new URL(fillTokenFields(url, tokens));
  for (const [key, value] of Object.entries(request.query ?? {})) {
    target.searchParams.set(key, fillTokenFields(value, tokens));
  }
  if (typeof request.token === "object") target.searchParams.set(request.token.query, accessToken);
  return target.href;
}

/** The userinfo request's headers: JSON, the provider's own, and the Bearer token by default. */
function userinfoHeaders(
  request: GeneratedUserinfoRequest,
  headers: Record<string, string>,
  accessToken: string,
): Record<string, string> {
  const sent: Record<string, string> = {
    accept: "application/json",
    "user-agent": "denext-auth",
    ...headers,
  };
  if ((request.token ?? "bearer") === "bearer") sent.authorization = `Bearer ${accessToken}`;
  if (request.json) sent["content-type"] = "application/json";
  return sent;
}

/** The headers an option's object value adds (string values only; never `authorization`). */
function optionHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key, v]) =>
      typeof v === "string" && key.toLowerCase() !== "authorization"
    ) as [string, string][],
  );
}

/** A spec's userinfo request, with its build-time values filled. */
function userinfoRequestOf(
  spec: GeneratedSpec,
  options: GeneratedUserConfig,
  values: Map<string, TemplateValue>,
): OAuthProvider["userinfoRequest"] {
  const request = spec.userinfoRequest;
  if (!request || !spec.userinfo) return undefined;
  const headers: Record<string, string> = { ...filled(request.headers, values) };
  if (request.headersOption) Object.assign(headers, optionHeaders(options[request.headersOption]));
  return generatedUserinfoRequest(request, endpoint(spec, spec.userinfo, values), headers);
}

/** One option's value: the app's (the issuer: the resolved one), else its default. */
function optionValue(
  rule: GeneratedOption,
  own: unknown,
  values: Map<string, TemplateValue>,
): TemplateValue | undefined {
  const given = typeof own === "string" && own !== "" ? own : undefined;
  const value = given ?? (rule.default === undefined ? undefined : fill(rule.default, values));
  return value === undefined ? undefined : { value, raw: rule.raw === true };
}

/** The provider's options with their defaults and the credentials, by template name. */
function templateValues(
  spec: GeneratedSpec,
  options: GeneratedUserConfig,
  credentials: { clientId: string; issuer: string },
): Map<string, TemplateValue> {
  const values = new Map<string, TemplateValue>();
  values.set("clientId", { value: credentials.clientId, raw: false });
  for (const [key, rule] of Object.entries(spec.options ?? {})) {
    const own = key === "issuer" ? credentials.issuer : options[key];
    const value = optionValue(rule, own, values);
    if (value) values.set(key, value);
  }
  if (!values.has("issuer") && credentials.issuer) {
    values.set("issuer", { value: credentials.issuer, raw: true });
  }
  return values;
}

/** The names a template uses. */
function namesIn(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
}

/** Fill a template; a name without a value is left for the caller to report. */
function fill(template: string, values: Map<string, TemplateValue>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    const entry = values.get(name);
    if (!entry) return whole;
    return entry.raw ? entry.value : encodeURIComponent(entry.value);
  });
}

/** Fill an endpoint template, refusing (at config time) one that names a missing value. */
function endpoint(
  spec: GeneratedSpec,
  template: string,
  values: Map<string, TemplateValue>,
): string {
  const missing = namesIn(template).filter((name) => !values.has(name));
  if (missing.includes("issuer")) issuerUrl(spec.id, "");
  if (missing.length) {
    throw new TypeError(
      `next-auth: provider "${spec.id}" needs the \`${missing[0]}\` option`,
    );
  }
  const filled = fill(template, values);
  if (namesIn(template).includes("issuer")) issuerUrl(spec.id, filled);
  // A URL the app supplies (NetSuite's `userinfo`, Webex's `apiBaseUrl`) must be https too.
  const raw = namesIn(template).find((name) => name !== "issuer" && values.get(name)?.raw);
  if (raw && !/^https:\/\/[^/]/.test(filled)) {
    throw new TypeError(`next-auth: provider "${spec.id}" needs an https \`${raw}\` URL`);
  }
  return filled;
}

/** The authorization parameters, a parameter naming an unset option left out. */
function params(
  spec: GeneratedSpec,
  values: Map<string, TemplateValue>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(spec.params ?? {})) {
    if (namesIn(template).some((name) => !values.has(name))) continue;
    out[key] = template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => values.get(name)!.value);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The scopes: the app's, the scope option's, else the provider's. */
function scopesOf(
  spec: GeneratedSpec,
  options: GeneratedUserConfig,
  own: string[] | undefined,
): string[] {
  if (own) return own;
  const fromOption = spec.scopeOption ? options[spec.scopeOption] : undefined;
  if (typeof fromOption === "string") return fromOption.split(" ").filter(Boolean);
  return spec.scopes;
}

/** An OIDC provider: discovery from the issuer, the scopes, params and client auth. */
function buildOidc(
  spec: GeneratedSpec,
  credentials: { clientId: string; clientSecret: string },
  issuer: string,
): OAuthProvider {
  issuerUrl(spec.id, issuer);
  const provider = oidc({ id: spec.id, issuer, ...credentials });
  // A placeholder `userinfoUrl` (the discovery document) asks the flow for userinfo, which
  // discovery then points at the real endpoint.
  if (spec.profileFromUserinfo) provider.userinfoUrl = provider.tokenUrl;
  return provider;
}

/**
 * Build the denext provider a generated spec describes.
 *
 * @param spec The provider's static data.
 * @param options The app's options.
 * @param credentials The resolved client credentials and scopes.
 * @param issuer The resolved issuer (`""` when neither the option nor the env sets one).
 * @returns The denext provider.
 */
function buildGenerated(
  spec: GeneratedSpec,
  options: GeneratedUserConfig,
  credentials: { clientId: string; clientSecret: string; scopes?: string[] },
  issuer: string,
): OAuthProvider {
  const values = templateValues(spec, options, { clientId: credentials.clientId, issuer });
  const scopes = scopesOf(spec, options, credentials.scopes);
  const { clientId, clientSecret } = credentials;
  let provider: OAuthProvider;
  if (spec.type === "oidc") {
    // A fixed issuer gives way to the app's, as Auth.js's options override the definition.
    const own = spec.issuer!.includes("{issuer}") ? "" : issuer;
    provider = buildOidc(
      spec,
      { clientId, clientSecret },
      own || endpoint(spec, spec.issuer!, values),
    );
  } else {
    provider = specProvider({
      id: spec.id,
      type: "oauth",
      authorizationUrl: endpoint(spec, spec.authorization!, values),
      tokenUrl: endpoint(spec, spec.token!, values),
      userinfoUrl: spec.userinfo ? endpoint(spec, spec.userinfo, values) : undefined,
      scopes,
    }, { clientId, clientSecret, scopes });
  }
  provider.scopes = scopes;
  provider.tokenEndpointAuthMethod = spec.tokenAuth;
  if (spec.checks) provider.checks = [...spec.checks];
  attachHooks(provider, spec, options, values);
  const vars = varsOf(values);
  provider.profile = (input) => denextUser(spec, input, vars);
  return provider;
}

/** The spec's protocol hooks on the built provider: id_token alg, params, token params, userinfo. */
function attachHooks(
  provider: OAuthProvider,
  spec: GeneratedSpec,
  options: GeneratedUserConfig,
  values: Map<string, TemplateValue>,
): void {
  if (spec.idTokenAlg) provider.idTokenAlg = spec.idTokenAlg;
  const extra = params(spec, values);
  if (extra) provider.authorizationParams = { ...provider.authorizationParams, ...extra };
  const tokenParams = filled(spec.tokenParams, values);
  if (tokenParams) provider.tokenRequestParams = tokenParams;
  const userinfoRequest = userinfoRequestOf(spec, options, values);
  if (userinfoRequest) provider.userinfoRequest = userinfoRequest;
}

/** The template values as plain text, for a profile template's literals. */
function varsOf(values: Map<string, TemplateValue>): Vars {
  return Object.fromEntries([...values].map(([name, entry]) => [name, entry.value]));
}

/** Templates filled from `values` (a name without one is left as it is). */
function filled(
  templates: Record<string, string> | undefined,
  values: Map<string, TemplateValue>,
): Record<string, string> | undefined {
  if (!templates) return undefined;
  return Object.fromEntries(
    Object.entries(templates).map(([key, template]) => [
      key,
      template.replace(
        /\{([A-Za-z]+)\}/g,
        (whole, name: string) => values.get(name)?.value ?? whole,
      ),
    ]),
  );
}

/**
 * Describe a generated provider, so it lists and builds like a hand-written one; the Auth.js
 * callbacks see the user exactly as Auth.js's own `profile()` maps it.
 *
 * @param spec The provider's static data.
 * @param options The app's options.
 * @returns The descriptor.
 */
export function generatedDescriptor<P>(
  spec: GeneratedSpec,
  options: GeneratedUserConfig<P>,
): ProviderDescriptor<GeneratedUserConfig<P>> {
  // The build's template values, for the literals of the Auth.js user's mapping too.
  let vars: Vars = {};
  return oauthDescriptor(
    {
      id: spec.id,
      name: spec.name,
      type: spec.type,
      rawProfile: (input) => rawProfile(spec, input),
      authJsUser: (input) =>
        mapProfile(mappingOf(spec), { p: rawProfile(spec, input), t: input.tokens }, vars),
    },
    options,
    (credentials, issuer) => {
      const values = templateValues(spec, options as GeneratedUserConfig, {
        clientId: credentials.clientId,
        issuer,
      });
      vars = varsOf(values);
      return buildGenerated(spec, options as GeneratedUserConfig, credentials, issuer);
    },
  );
}

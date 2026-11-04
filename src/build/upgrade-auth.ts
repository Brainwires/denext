// `denext upgrade` across 4.x → 5.0: the auth layer left `@denext/denext` for its own package,
// `@denext/auth`. This rewrites a project to match, textually (every other byte kept):
//
// - **Source.** An import of a moved name from `denext/server` (`denextAuth`, the providers, the
//   adapters, …) is split: the moved names import from `@denext/auth`, the rest stay. An import
//   from `denext/auth` is split the other way: what stays in core (`auth()`, `requireAuth`,
//   `requireSession`, the session types, the rate-limit stores, password hashing, the Supabase
//   keys) imports from `denext/server`, the rest from `@denext/auth`. The same holds for the
//   `@denext/denext/<sub>` and `jsr:@denext/denext@<range>/<sub>` spellings.
// - **`deno.json`.** The `denext/auth` entry becomes `"@denext/auth": "jsr:@denext/auth@<range>"`
//   (added when a source needs it and no entry exists), and the `next-auth` aliases point at
//   `@denext/auth`'s shim, so the app's `next-auth` imports stay as they are.
//
// A namespace import (`import * as s from "denext/server"`) or a dynamic `import()` can't be
// split by text: it is reported, not changed.

import { join, relative } from "@std/path";
import { deleteJsonValue, setJsonValue } from "./json-edit.ts";

/**
 * The names `denext/auth` exported in 4.x that stay in `denext/server` in 5.0 (the session
 * readers and guards, the session types, the rate-limit stores, password hashing and the
 * Supabase key minting).
 */
export const AUTH_KEPT_NAMES: ReadonlySet<string> = new Set([
  "apiKeyRole",
  "auth",
  "AuthPluginMissingError",
  "AuthSession",
  "AuthSessionSaml",
  "AuthUser",
  "canSign",
  "GeneratedSupabaseKeys",
  "generateSupabaseKeys",
  "hashPassword",
  "HashPasswordOptions",
  "InMemoryRateLimitStoreOptions",
  "inMemoryRateLimitStore",
  "installedSupabaseKeys",
  "installSupabaseKeys",
  "looksLikeJwt",
  "opaqueKeyRole",
  "RateLimitStore",
  "RateLimitWindow",
  "requireAuth",
  "RequireAuthOptions",
  "requireSession",
  "RequireSessionOptions",
  "resolveSupabaseKeys",
  "SessionStore",
  "signSupabaseJwt",
  "SUPABASE_KEY_ENV",
  "supabaseJwks",
  "SupabaseJwtClaims",
  "SupabaseKeyError",
  "SupabaseKeyErrorCode",
  "SupabaseKeys",
  "SupabaseKeysConfig",
  "SupabaseRole",
  "SupabaseSigningKey",
  "verifyPassword",
  "verifySupabaseJwt",
  "VerifySupabaseJwtOptions",
]);

/**
 * Every name `@denext/auth` exports: what an import from `denext/server` moves there. A test
 * keeps it equal to the package's `mod.ts`.
 */
export const AUTH_MOVED_NAMES: ReadonlySet<string> = new Set(
  // deno-fmt-ignore
  [
    "AccountDeletedPayload", "activeAuthConfig", "AdapterAccount", "AdapterAccountRef",
    "AdapterUser", "ApiTokenRecord", "ApiTokenRevokedReason", "apple", "auth0", "Auth0Options",
    "AuthAdapter", "AuthCallbacks", "AuthConfig", "AuthCookieConfig", "AuthEmailConfig",
    "AuthEvents", "AuthLogger", "AuthMfaConfig", "AuthNativeConfig", "AuthorizedCallbackInput",
    "AuthPasskeyAndroidApp", "AuthPasskeyConfig", "AuthPasskeyMdsConfig",
    "AuthPasskeyRevocationPolicy", "AuthProvider", "AuthSessionConfig", "backupCodeMatcher",
    "BackupCodes", "BearerContext", "bearerTokenOf", "buildAuthnRequest",
    "BuildAuthnRequestOptions", "buildLogoutRequest", "BuildLogoutRequestOptions",
    "buildLogoutResponse", "BuildLogoutResponseOptions", "confirmTotp", "ConfirmTotpResult",
    "credentials", "CredentialsOptions", "CredentialsProvider", "currentSessionId",
    "CustomProviderAdapter", "CustomProviderRecord", "deletePasskey", "denextAuth",
    "denoKvRateLimitStore", "DenoKvRateLimitStoreOptions", "denoKvSessionStore",
    "DenoKvSessionStoreOptions", "disableTotp", "discord", "emailOtp", "EmailProvider",
    "EmailProviderOptions", "EmailRequestResult", "enrollTotp", "EnrollTotpResult", "facebook",
    "generateBackupCodes", "generateTotpSecret", "github", "gitlab", "GitLabOptions", "google",
    "GoTrueAccessTokenHookInput", "GoTrueCaptchaOptions", "GoTrueError", "GoTrueErrorCode",
    "GoTrueHandlerOptions", "GoTrueHooks", "GoTrueMailKind", "GoTrueOAuthServerOptions",
    "GoTrueOptions", "GoTrueSamlOptions", "GoTrueSamlProvider", "GoTrueSendEmailPayload",
    "GoTrueSmsMessage", "goTrueSmtpFromEnv", "GoTrueSmtpOptions", "GoTrueWeb3Options",
    "handleGoTrueRequest", "Hasher", "inMemoryAuthAdapter", "InMemoryAuthAdapterOptions",
    "inMemorySamlReplayCache", "inMemorySessionStore", "InMemorySessionStoreOptions",
    "installGoTrue", "issueApiToken", "IssueApiTokenOptions", "IssuedApiToken", "jwtBearerOf",
    "keycloak", "KeycloakOptions", "listApiTokens", "listPasskeys", "magicLink",
    "MagicLinkOptions", "MailMessage", "MaybePromise", "MfaAttemptResult", "MfaFactorRecord",
    "MfaMethod", "MfaRecord", "MfaStatus", "mfaStatus", "microsoftEntra", "MicrosoftEntraOptions",
    "NativeAppleConfig", "nativeBearerToken", "NativeGrantRecord", "NativeIdTokenProviderConfig",
    "NativeSessionRecord", "OAuthAuthorizationExpect", "OAuthAuthorizationPatch",
    "OAuthAuthorizationRecord", "OAuthCheck", "OAuthClientOptions", "OAuthClientRecord",
    "OAuthConsentRecord", "OAuthProvider", "OAuthServerAdapter", "OAuthSessionLink", "oidc",
    "OidcOptions", "okta", "OktaOptions", "ParsedIdpMetadata", "parseIdpMetadata",
    "PasskeyChallengeRecord", "PasskeyRecord", "PasskeySummary", "PeekedLogoutMessage",
    "peekLogoutMessage", "pendingMfaSession", "phoneOtp", "PhoneProvider", "PhoneProviderOptions",
    "postgresAuthAdapter", "PostgresAuthAdapterOptions", "PostgresAuthStoreOptions",
    "postgresRateLimitStore", "PostgresRateLimitStoreOptions", "postgresSessionStore",
    "PostgresSessionStoreOptions", "ProfileInput", "RateLimitOptions", "redisRateLimitStore",
    "RedisRateLimitStoreOptions", "redisSessionStore", "RedisSessionStoreOptions",
    "RefreshOutcome", "refreshSsoMetadata", "RefreshSsoMetadataOptions",
    "requestEmailVerification", "requestPasswordReset", "requireBearer", "RequireBearerOptions",
    "ResealOptions", "ResealReport", "resealTotpFactors", "resetPassword", "ResetPasswordResult",
    "revokeAllSessions", "revokeApiToken", "revokeSession", "saml", "SamlBindingInput",
    "SamlError", "SamlErrorCode", "SamlIdpConfig", "SamlPrivateKey", "SamlProvider",
    "SamlProviderOptions", "SamlProviderSp", "SamlReplayCache", "SamlSpConfig", "scryptHasher",
    "SecondFactorResult", "SendVerificationRequest", "sessionFromClaims", "SignInFailedReason",
    "slack", "SmtpContent", "SmtpError", "SmtpMailer", "smtpMailer", "SmtpMailerOptions",
    "SmtpMessageError", "spendMfaAttempt", "spMetadataXml", "sqliteAuthAdapter",
    "SqliteAuthAdapterOptions", "sqliteSessionStore", "SqliteSessionStoreOptions",
    "SsoAttributeMapping", "SsoAttributeMappingKey", "SsoMetadataRefreshSummary",
    "SsoProviderRecord", "SsoProviderWrite", "SsoSessionIndexRecord", "SsoSessionRecord",
    "TenantIssuer", "totpAuthUri", "TotpAuthUriOptions", "TotpEnrollment", "totpQrSvg",
    "TotpQrSvgOptions", "TotpVerifyOptions", "TotpVerifyResult", "updateAuthSession",
    "UserinfoRequestInput", "VerificationPurpose", "VerificationRequestParams",
    "VerificationTokenRecord", "VerificationTokenRef", "VerifiedLogoutRequest",
    "VerifiedLogoutResponse", "VerifiedSamlAssertion", "verifyAccessToken", "verifyApiToken",
    "verifyEmail", "VerifyEmailResult", "VerifyLogoutOptions", "verifyLogoutRequest",
    "verifyLogoutResponse", "verifySamlResponse", "VerifySamlResponseOptions",
    "verifySecondFactor", "verifyTotp", "Web3NonceAdapter",
  ],
);

/** The package the moved names import from. */
const AUTH_PACKAGE_SPECIFIER = "@denext/auth";

/** `denext/<sub>`, `@denext/denext/<sub>` or `jsr:@denext/denext[@<range>]/<sub>`. */
const DENEXT_SUBPATH =
  /^(denext\/|@denext\/denext\/|jsr:@denext\/denext(?:@[^/]+)?\/)(server|auth)$/;

/** One import / re-export statement with a named list: `import type { a, b as c } from "x";`. */
const NAMED_STATEMENT =
  /\b(import|export)(\s+type)?\s*\{([^{}]*)\}\s*from\s*(["'])([^"'\n]+)\4(\s*with\s*\{[^}]*\})?\s*;?/g;

/** `import * as ns from "x"` / `export * from "x"` / `import("x")` naming a denext subpath. */
const UNSPLITTABLE =
  /\bimport\s*\*\s*as\s+\w+\s*from\s*["']([^"'\n]+)["']|\bexport\s*\*(?:\s*as\s+\w+)?\s*from\s*["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

/** What {@link rewriteAuthImports} did to one module. */
export interface AuthSourceRewrite {
  /** The new text (the input when nothing changed). */
  readonly text: string;
  /** Whether any statement changed. */
  readonly changed: boolean;
  /** Whether the text now imports `@denext/auth` (its config needs the entry). */
  readonly needsAuth: boolean;
  /** Statements left as they were that may need a hand edit. */
  readonly warnings: readonly string[];
}

/** The name an import specifier item imports (`type a as b` → `a`). */
function importedName(item: string): string {
  return item.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
}

/** The longest line a split statement is written on before it wraps (deno fmt's default). */
const LINE_WIDTH = 100;

/**
 * A named statement re-assembled with `items` and `specifier`, quoted as the original: one line,
 * or one item per line (each behind `prefix`, the statement's own line prefix) past
 * {@link LINE_WIDTH}.
 */
function statement(
  kind: string,
  typeOnly: string,
  items: readonly string[],
  quote: string,
  specifier: string,
  attrs: string,
  prefix: string,
): string {
  const tail = `from ${quote}${specifier}${quote}${attrs};`;
  const line = `${kind}${typeOnly} { ${items.join(", ")} } ${tail}`;
  if (prefix.length + line.length <= LINE_WIDTH) return line;
  const body = items.map((item) => `${prefix}  ${item},`).join("\n");
  return `${kind}${typeOnly} {\n${body}\n${prefix}} ${tail}`;
}

/** `whole` (one matched statement) with its specifier swapped in place, formatting kept. */
function respecified(whole: string, quote: string, from: string, to: string): string {
  return whole.replace(`${quote}${from}${quote}`, `${quote}${to}${quote}`);
}

/**
 * Split a module's imports of `denext/server` and `denext/auth` (any spelling) between
 * `denext/server` and `@denext/auth` (see the file header).
 *
 * @param text The module source.
 * @returns The new source, whether it changed, whether it imports `@denext/auth`, and warnings.
 */
export function rewriteAuthImports(text: string): AuthSourceRewrite {
  const warnings: string[] = [];
  let needsAuth = false;
  const out = text.replace(
    NAMED_STATEMENT,
    (
      whole: string,
      kind: string,
      typeOnly: string | undefined,
      list: string,
      quote: string,
      spec: string,
      attrsGroup: string | undefined,
      offset: number,
    ) => {
      const attrs = attrsGroup ?? "";
      const typeKw = typeOnly ?? "";
      const m = DENEXT_SUBPATH.exec(spec);
      if (!m) return whole;
      const [, prefix, sub] = m;
      const items = list.split(",").map((s) => s.trim()).filter(Boolean);
      // From `denext/server` only the listed moved names leave; from `denext/auth` everything
      // but what stays in core does.
      const moves = (item: string) =>
        sub === "server"
          ? AUTH_MOVED_NAMES.has(importedName(item))
          : !AUTH_KEPT_NAMES.has(importedName(item));
      const moved = items.filter(moves);
      const kept = items.filter((item) => !moves(item));
      const keptSpec = `${prefix}server`;
      // A statement that moves whole keeps its formatting: only the specifier changes.
      if (moved.length === 0) {
        return sub === "server" ? whole : respecified(whole, quote, spec, keptSpec);
      }
      needsAuth = true;
      if (kept.length === 0) return respecified(whole, quote, spec, AUTH_PACKAGE_SPECIFIER);
      // The statement's line prefix (indentation, or a doc comment's ` * `) starts the second line.
      const before = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
      const linePrefix = /^[ \t]*(?:(?:\*|\/\/)[ \t]*)?$/.test(before) ? before : "";
      const at = (items: readonly string[], to: string) =>
        statement(kind, typeKw, items, quote, to, attrs, linePrefix);
      return `${at(kept, keptSpec)}\n${linePrefix}${at(moved, AUTH_PACKAGE_SPECIFIER)}`;
    },
  );
  for (const m of out.matchAll(UNSPLITTABLE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (DENEXT_SUBPATH.test(spec)) {
      warnings.push(
        `${m[0].trim()}: a namespace import, re-export or dynamic import() can't be split — ` +
          `the auth names (denextAuth, the providers, …) are @denext/auth's from 5.0`,
      );
    }
  }
  return { text: out, changed: out !== text, needsAuth, warnings };
}

/** What {@link rewriteAuthConfig} did to one `deno.json`. */
export interface AuthConfigRewrite {
  /** The new text. */
  readonly text: string;
  /** Whether anything changed. */
  readonly changed: boolean;
}

/** The `"denext/auth": "…"` member of an import map. */
const DENEXT_AUTH_ENTRY = /"denext\/auth"(\s*:\s*)"[^"\n]*"/;

/** A `next-auth` alias target on denext's shim: `jsr:[/]@denext/denext@<range>/next-auth…`. */
const NEXT_AUTH_TARGET = /jsr:(\/?)@denext\/denext(@[~^]?[0-9A-Za-z.+-]+)?\/next-auth/g;

/**
 * Point a `deno.json`'s auth entries at `@denext/auth` (see the file header).
 *
 * @param text The `deno.json` / `deno.jsonc` text.
 * @param authSpec The `@denext/auth` specifier to pin (`jsr:@denext/auth@^5.0.0`).
 * @param addEntry Add the `@denext/auth` entry when the config has none (a source needs it).
 * @returns The new text and whether it changed.
 */
export async function rewriteAuthConfig(
  text: string,
  authSpec: string,
  addEntry: boolean,
): Promise<AuthConfigRewrite> {
  let out = text.replace(NEXT_AUTH_TARGET, (_whole, slash: string) => {
    const range = authSpec.slice(authSpec.indexOf("@denext/auth") + "@denext/auth".length);
    return `jsr:${slash}@denext/auth${range}/next-auth`;
  });
  const hasAuthEntry = /"@denext\/auth"\s*:/.test(out);
  if (DENEXT_AUTH_ENTRY.test(out)) {
    if (hasAuthEntry) {
      const removed = await deleteJsonValue(out, ["imports", "denext/auth"]);
      if (removed.ok) out = removed.source;
    } else {
      out = out.replace(
        DENEXT_AUTH_ENTRY,
        (_w, sep: string) => `"@denext/auth"${sep}"${authSpec}"`,
      );
    }
  } else if (addEntry && !hasAuthEntry) {
    const added = await setJsonValue(out, ["imports", "@denext/auth"], authSpec);
    if (added.ok) out = added.source;
  }
  return { text: out, changed: out !== text };
}

/** Directories never walked for sources. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".denext",
  ".deno",
  "dist",
  "out",
  "coverage",
  "vendor",
]);

/** Source files `upgrade` rewrites. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** One rewritten module. */
export interface AuthFileRewrite {
  /** The path, relative to the project. */
  readonly path: string;
  /** The new text. */
  readonly text: string;
}

/** What {@link planAuthSourceRewrites} found in a project. */
export interface AuthSourcePlan {
  /** The modules that change. */
  readonly files: readonly AuthFileRewrite[];
  /** Whether a rewritten module imports `@denext/auth`. */
  readonly needsAuth: boolean;
  /** `<path>: <statement …>` lines a person should look at. */
  readonly warnings: readonly string[];
}

/**
 * Every source module under `dir` whose auth imports change (see {@link rewriteAuthImports}),
 * skipping dependencies, build output and symlinks.
 *
 * @param dir The project directory.
 * @returns The rewrites and warnings (nothing is written).
 */
export async function planAuthSourceRewrites(dir: string): Promise<AuthSourcePlan> {
  const files: AuthFileRewrite[] = [];
  const warnings: string[] = [];
  let needsAuth = false;
  for await (const path of sourceModules(dir)) {
    const result = rewriteAuthImports(await Deno.readTextFile(path));
    const rel = relative(dir, path).replaceAll("\\", "/");
    for (const w of result.warnings) warnings.push(`${rel}: ${w}`);
    if (!result.changed) continue;
    needsAuth ||= result.needsAuth;
    files.push({ path: rel, text: result.text });
  }
  return { files, needsAuth, warnings };
}

/** Every source module under `at` ({@link SOURCE_FILE}), outside {@link SKIP_DIRS} and links. */
async function* sourceModules(at: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(at)) {
    const path = join(at, entry.name);
    if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) yield* sourceModules(path);
    else if (entry.isFile && SOURCE_FILE.test(entry.name)) yield path;
  }
}

/** The denext major the auth layer left `@denext/denext` in. */
const AUTH_SPLIT_MAJOR = 5;

/**
 * Whether moving denext from `from` to `to` crosses into the release that split the auth layer
 * out (4.x → 5.0 or later).
 *
 * @param from The pinned denext version.
 * @param to The version the upgrade moves to.
 * @returns `true` when the auth rewrite applies.
 */
export function crossesAuthSplit(from: string, to: string): boolean {
  const major = (v: string) => Number(/^(\d+)\./.exec(v)?.[1] ?? NaN);
  return major(from) < AUTH_SPLIT_MAJOR && major(to) >= AUTH_SPLIT_MAJOR;
}

/**
 * The `@denext/auth` specifier for a config: denext's own pin operator (`^`, `~` or exact)
 * with `version`, since the two packages are versioned together.
 *
 * @param text The config text (its `jsr:@denext/denext@…` pin supplies the operator).
 * @param version The denext version the upgrade moves to.
 * @returns `jsr:@denext/auth@<op><version>`.
 */
export function authSpecifierFor(text: string, version: string): string {
  const op = /jsr:\/?@denext\/denext@([~^]?)\d/.exec(text)?.[1] ?? "^";
  return `jsr:@denext/auth@${op}${version}`;
}

// Universal links (iOS) and App Links (Android) need the web domain to vouch for the app:
// `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. With the
// config's `appLinks`, `denext start` / `denext dev` serve both (application/json, 200, no
// redirect, no extension on the Apple file), and `denext export` writes them into the export.
// Pure: no filesystem here (the export writes what `appLinkFiles` returns). The config types
// live in ./config.ts with the rest of `DenextConfig` (the schema generator reads them there).

import type { AndroidAppLinks, AppleAppLinks, AppLinksConfig } from "./config.ts";

/** The URL paths the two files are served at. */
const APPLE_APP_SITE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";
const ASSET_LINKS_PATH = "/.well-known/assetlinks.json";

/** `<Team ID>.<bundle id>`: a 10-character Team ID, then a reverse-DNS bundle id. */
const APPLE_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** An Android application id. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * A SHA-256 certificate fingerprint in the colon form Android expects, or null when `value` is
 * not 32 bytes of hex (with or without colons).
 *
 * @param value The fingerprint as written.
 * @returns `AB:CD:…` (upper case), or null.
 */
export function normalizeCertFingerprint(value: string): string | null {
  const hex = value.replace(/:/g, "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g)!.join(":");
}

/**
 * Check an `appLinks` config, reporting each problem through `fail(path, message)` (the
 * config validator's reporter). Nothing is reported for a valid config.
 *
 * @param value The config's `appLinks`.
 * @param fail Called per problem with the key path and the message.
 */
export function validateAppLinks(
  value: unknown,
  fail: (path: string, message: string) => void,
): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("appLinks", "must be an object with `apple` and/or `android`");
  }
  const { apple, android } = value as Record<string, unknown>;
  if (apple !== undefined) validateApple(apple, fail);
  if (android !== undefined) validateAndroid(android, fail);
}

type Fail = (path: string, message: string) => void;

/** A non-empty list whose every item passes `valid`; `bad(item)` words a failing one. */
function validateList(
  value: unknown,
  path: string,
  empty: string,
  valid: (item: unknown) => boolean,
  bad: (item: unknown) => string,
  fail: Fail,
): void {
  if (!Array.isArray(value) || value.length === 0) return fail(path, empty);
  for (const item of value) if (!valid(item)) fail(path, bad(item));
}

/** An optional boolean switch. */
function validateOptionalBoolean(value: unknown, path: string, fail: Fail): void {
  if (value !== undefined && typeof value !== "boolean") fail(path, "must be a boolean");
}

/** `appLinks.apple`. */
function validateApple(apple: unknown, fail: Fail): void {
  if (typeof apple !== "object" || apple === null) {
    return fail("appLinks.apple", "must be an object ({ appIds, paths?, webcredentials? })");
  }
  const { appIds, paths, webcredentials } = apple as Record<string, unknown>;
  validateList(
    appIds,
    "appLinks.apple.appIds",
    'must list at least one "<TEAM ID>.<bundle id>"',
    (id) => typeof id === "string" && APPLE_APP_ID.test(id),
    (id) =>
      `${JSON.stringify(id)} is not "<TEAM ID>.<bundle id>" (e.g. "ABCDE12345.com.example.app")`,
    fail,
  );
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every(isPathPattern))) {
    fail("appLinks.apple.paths", 'must be URL path patterns ("/orders/*", "!/admin/*", "*")');
  }
  validateOptionalBoolean(webcredentials, "appLinks.apple.webcredentials", fail);
}

/** `appLinks.android`. */
function validateAndroid(android: unknown, fail: Fail): void {
  if (typeof android !== "object" || android === null) {
    return fail("appLinks.android", "must be an object ({ packageName, sha256CertFingerprints })");
  }
  const { packageName, sha256CertFingerprints, loginCredentials } = android as Record<
    string,
    unknown
  >;
  if (typeof packageName !== "string" || !ANDROID_PACKAGE.test(packageName)) {
    fail("appLinks.android.packageName", 'must be the application id (e.g. "com.example.app")');
  }
  validateList(
    sha256CertFingerprints,
    "appLinks.android.sha256CertFingerprints",
    "must list at least one SHA-256 fingerprint",
    (fp) => typeof fp === "string" && normalizeCertFingerprint(fp) !== null,
    (fp) => `${JSON.stringify(fp)} is not a SHA-256 fingerprint (32 hex bytes, "AB:CD:…")`,
    fail,
  );
  validateOptionalBoolean(loginCredentials, "appLinks.android.loginCredentials", fail);
}

/** Whether `p` is a path pattern the AASA `components` can carry. */
function isPathPattern(p: unknown): boolean {
  if (typeof p !== "string") return false;
  const path = p.startsWith("!") ? p.slice(1) : p;
  return path === "*" || (path.startsWith("/") && !/[\s"\\]/.test(path));
}

/**
 * The `apple-app-site-association` document (iOS 13+ `components` form).
 *
 * @param apple The iOS config.
 * @returns The JSON value to serve.
 */
export function appleAppSiteAssociation(apple: AppleAppLinks): Record<string, unknown> {
  const components = (apple.paths ?? ["*"]).map((p) =>
    p.startsWith("!") ? { "/": p.slice(1), exclude: true } : { "/": p }
  );
  return {
    applinks: { details: [{ appIDs: [...apple.appIds], components }] },
    ...(apple.webcredentials === false ? {} : { webcredentials: { apps: [...apple.appIds] } }),
  };
}

/**
 * The `assetlinks.json` statement list (Digital Asset Links).
 *
 * @param android The Android config.
 * @returns The JSON value to serve.
 */
export function assetLinks(android: AndroidAppLinks): Array<Record<string, unknown>> {
  const relation = ["delegate_permission/common.handle_all_urls"];
  if (android.loginCredentials !== false) {
    relation.push("delegate_permission/common.get_login_creds");
  }
  return [{
    relation,
    target: {
      namespace: "android_app",
      package_name: android.packageName,
      sha256_cert_fingerprints: android.sha256CertFingerprints.map((fp) =>
        normalizeCertFingerprint(fp) ?? fp
      ),
    },
  }];
}

/**
 * The files `appLinks` produces, by URL path (`/.well-known/…`) → JSON text.
 *
 * @param config The config's `appLinks` (none: no files).
 * @returns The files; empty without a config.
 */
export function appLinkFiles(config: AppLinksConfig | undefined): Map<string, string> {
  const files = new Map<string, string>();
  if (config?.apple) {
    files.set(
      APPLE_APP_SITE_ASSOCIATION_PATH,
      JSON.stringify(appleAppSiteAssociation(config.apple)),
    );
  }
  if (config?.android) files.set(ASSET_LINKS_PATH, JSON.stringify(assetLinks(config.android)));
  return files;
}

/**
 * A request handler for the two association files: `GET`/`HEAD` of a configured path answers
 * `200` `application/json` (short public caching); anything else resolves `null`. `denext
 * start` and `denext dev` run it first, before redirects, `trailingSlash` and middleware, since
 * iOS and Android refuse a redirected or non-200 answer. Use it in a custom server too.
 *
 * @param config The `appLinks` config.
 * @returns `(request) => Response | null`.
 * @example
 * ```ts
 * import { createAppLinksHandler } from "denext/server";
 *
 * const appLinks = createAppLinksHandler({
 *   apple: { appIds: ["ABCDE12345.com.example.app"], paths: ["/orders/*"] },
 *   android: { packageName: "com.example.app", sha256CertFingerprints: ["AB:CD:…"] },
 * });
 * Deno.serve((req) => appLinks(req) ?? app(req));
 * ```
 */
export function createAppLinksHandler(
  config: AppLinksConfig | undefined,
): (request: Request) => Response | null {
  const files = appLinkFiles(config);
  if (files.size === 0) return () => null;
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const body = files.get(new URL(request.url).pathname);
    if (body === undefined) return null;
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
      },
    });
  };
}

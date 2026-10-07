// denext.config validation — pure (types only, no build/IO deps) so both the
// server-side `defineConfig` authoring helper and the build-time config loader can
// share one source of truth. `validateDenextConfig` throws a field-scoped error on a
// bad *value*; `warnUnknownConfigKeys` warns (never throws) on an unrecognized *key*,
// with a "did you mean" suggestion — a typo like `basepath` would otherwise be
// silently dropped by the loader's field whitelist.

import { type DenextConfig, isOrigin } from "./config.ts";
import { CONFIG_KEYS, EXPERIMENTAL_KEYS } from "./config-keys.generated.ts";
import { editDistance } from "../utils/edit-distance.ts";
import { isLoopbackHost } from "../utils/loopback.ts";
import { VERB_NAME } from "../cli/command.ts";
import { resolveCors } from "./cors.ts";
import { ROUTE_CSP_KEYS } from "./segment-config.ts";
import { validateAppLinks } from "./app-links.ts";
import { COMMUNITY_ALIASES } from "../react-native-compat/manifest.ts";
import {
  desktopAppIdentifierError,
  desktopSchemeError,
  normalizeDesktopBridgeOrigin,
  originWithoutIdentifierMessage,
  parseDesktopAppOrigin,
} from "../desktop/app-origin.ts";
import { desktopDenoFlagError } from "../desktop/deno-flags.ts";

/**
 * The recognized top-level {@link DenextConfig} keys — the generated
 * {@link CONFIG_KEYS} list (derived from the interface by `deno task gen:config-schema`,
 * so it cannot drift from the type). `warnUnknownConfigKeys` flags anything outside this
 * set, since the loader copies exactly these fields and would drop an unknown key silently.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = CONFIG_KEYS;

/** The recognized `experimental.*` sub-keys (generated from `ExperimentalConfig`). */
const KNOWN_EXPERIMENTAL_KEYS: readonly string[] = EXPERIMENTAL_KEYS;

/**
 * The closest key in `known` to `key` within a small edit distance (case-insensitive), or
 * `undefined` when nothing is near enough to suggest. Used for "did you mean" hints; the
 * candidate list defaults to the top-level {@link KNOWN_CONFIG_KEYS}.
 */
export function didYouMean(
  key: string,
  known: readonly string[] = KNOWN_CONFIG_KEYS,
): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  // Only suggest when the typo is close: within a third of the key's length (min 2).
  return best !== undefined && bestDist <= Math.max(2, Math.floor(key.length / 3))
    ? best
    : undefined;
}

/** The "unknown option" warning line, with a suggestion when a close known key exists. */
function unknownKeyMessage(name: string, key: string, suggestion: string | undefined): string {
  return `denext: ${name} has an unknown option \`${key}\`, which will be ignored` +
    (suggestion ? ` — did you mean \`${suggestion}\`?` : ".");
}

/**
 * `experimental.*` keys that graduated to top-level config, with whether the old alias is
 * still read. Setting one gets a "moved" message instead of a generic unknown-key warning.
 * The honored ones are Next.js's own spellings, kept as obsolete aliases for migrated Next
 * apps (and so still `ExperimentalConfig` members); this map is consulted before the
 * generated key list, so it warns either way.
 */
const MOVED_EXPERIMENTAL_KEYS: ReadonlyMap<string, { to: string; honored: boolean }> = new Map([
  ["streaming", { to: "streaming", honored: false }], // alias removed in 2.0
  ["live", { to: "live", honored: false }], // alias removed in 2.0
  ["cacheComponents", { to: "cacheComponents", honored: true }], // Next 16's spelling
  ["reactCompiler", { to: "reactCompiler", honored: true }], // Next 15's spelling
  ["optimizePackageImports", { to: "optimizePackageImports", honored: true }], // Next's spelling
]);

/**
 * denext's own former `experimental.*` keys, removed in 3.0, mapped to the top-level key that
 * replaces each. Setting one is a validation ERROR, not a warning: silently ignoring, say,
 * `experimental.nodeResolve: false` would change how the app builds.
 */
const REMOVED_EXPERIMENTAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["compiler", "reactCompiler"],
  ["asyncContext", "asyncContext"],
  ["features", "features"],
  ["nodeResolve", "nodeResolve"],
]);

/** The warning for a graduated `experimental.<key>`, pointing at its top-level home. */
function movedKeyMessage(name: string, key: string, to: string, honored: boolean): string {
  const status = honored ? "is still honored for now but has moved" : "is no longer honored";
  return `denext: ${name} sets \`experimental.${key}\`, which ${status} — set top-level \`${to}\` instead.`;
}

/**
 * One level down: a "moved" pointer for every graduated `experimental.*` key, and an
 * unknown-key warning for anything outside the generated `EXPERIMENTAL_KEYS`.
 */
function warnUnknownExperimentalKeys(experimental: unknown, name: string): void {
  if (typeof experimental !== "object" || experimental === null || Array.isArray(experimental)) {
    return;
  }
  for (const key of Object.keys(experimental)) {
    if (REMOVED_EXPERIMENTAL_KEYS.has(key)) continue; // a validation error, not a warning
    const moved = MOVED_EXPERIMENTAL_KEYS.get(key);
    if (moved) {
      console.warn(movedKeyMessage(name, key, moved.to, moved.honored));
      continue;
    }
    if (KNOWN_EXPERIMENTAL_KEYS.includes(key)) continue;
    const suggestion = didYouMean(key, KNOWN_EXPERIMENTAL_KEYS);
    console.warn(unknownKeyMessage(name, `experimental.${key}`, suggestion));
  }
}

/**
 * Warn (to stderr, never throw) on any top-level config key not in {@link KNOWN_CONFIG_KEYS},
 * and one level down on any `experimental.*` key not in the generated `EXPERIMENTAL_KEYS`.
 * The loader reconstructs config from a fixed field list, so an unrecognized key (a typo,
 * a stale Next.js option) is otherwise dropped with no signal. Emits a "did you mean"
 * suggestion when a close known key exists, and a "moved to top-level" pointer for every
 * graduated `experimental.*` key (see `MOVED_EXPERIMENTAL_KEYS`).
 *
 * @param config The raw config object as authored (before the loader's whitelist).
 * @param name The config file name, for the message (default `"denext.config"`).
 */
export function warnUnknownConfigKeys(config: object, name = "denext.config"): void {
  for (const key of Object.keys(config)) {
    if (KNOWN_CONFIG_KEYS.includes(key)) continue;
    console.warn(unknownKeyMessage(name, key, didYouMean(key)));
  }
  warnUnknownExperimentalKeys((config as { experimental?: unknown }).experimental, name);
}

// --- Value validation ------------------------------------------------------------
// Split into small field-group validators (mode/spa, routing, images, security, cache)
// so each stays readable and independently testable — validation of a 20-field config
// object is inherently branchy, but no single function has to carry all of it.

/** Throws a field-scoped `invalid <name>: \`<field>\` <msg>` error. */
type Fail = (field: string, msg: string) => never;

interface NumOpts {
  int?: boolean;
  min?: number;
  max?: number;
}

/** Whether `v` is a finite number within the requested range / integer-ness. */
function isValidNumber(v: unknown, opts: NumOpts): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (v < (opts.min ?? 0)) return false;
  if (opts.max !== undefined && v > opts.max) return false;
  if (opts.int && !Number.isInteger(v)) return false;
  return true;
}

/**
 * A `NaN`/`Infinity`/negative slips silently into HTTP headers (`max-age`),
 * redirect-loop bounds, and cache-eviction counts otherwise, so validate
 * finiteness/range at boot (present fields only; `undefined` keeps the default).
 */
function num(fail: Fail, field: string, v: unknown, opts: NumOpts = {}): void {
  if (isValidNumber(v, opts)) return;
  const min = opts.min ?? 0;
  const range = opts.max !== undefined ? `${min}..${opts.max}` : `>= ${min}`;
  fail(field, `must be a finite ${opts.int ? "integer" : "number"} ${range}`);
}

/** Validate an array of numbers element-wise. */
function numArray(fail: Fail, field: string, v: unknown, opts: NumOpts): void {
  if (!Array.isArray(v)) fail(field, "must be an array of numbers");
  else (v as unknown[]).forEach((el, i) => num(fail, `${field}[${i}]`, el, opts));
}

/**
 * The `desktop` block: the capability allowlist's shape. Light — the runtime enforces the
 * allowlist itself; this only catches obvious mistakes (a non-object, or a bad `extensions` list /
 * `fs`/`shell` option). Unknown capability keys are allowed (forward-compat with `desktop add`).
 */
/** `desktop.extraPermissions`: an object of permission kinds to string arrays. */
function validateExtraPermissions(extra: unknown, fail: Fail): void {
  if (extra === undefined) return;
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) {
    fail("desktop.extraPermissions", "must be an object of permission kinds to string arrays");
    return;
  }
  const KINDS = ["read", "write", "net", "run", "ffi", "env", "sys"];
  for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
    if (!(KINDS.includes(k) && Array.isArray(v) && v.every((s) => typeof s === "string"))) {
      fail(
        `desktop.extraPermissions.${k}`,
        "must be an array of strings (kinds: read, write, net, run, ffi, env, sys)",
      );
    }
  }
}

/** Whether `v` is a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `desktop.app.origin`: the runtime's origin rules, and the identifier it then requires. */
function validateDesktopOrigin(app: Record<string, unknown>, fail: Fail): void {
  const origin = app.origin;
  if (origin === undefined) return;
  if (typeof origin !== "string") fail("desktop.app.origin", 'must be a string like "myapp://app"');
  const parsed = parseDesktopAppOrigin(origin as string);
  if (!parsed.ok) fail("desktop.app.origin", `is invalid: ${parsed.error}`);
  const id = app.identifier;
  if (id === undefined) fail("desktop.app.identifier", originWithoutIdentifierMessage(`${origin}`));
  const idError = typeof id === "string" ? desktopAppIdentifierError(id) : "must be a string";
  if (idError) fail("desktop.app.identifier", `is invalid: ${idError}`);
}

/**
 * `desktop.capabilities.passkeys`: `false`, or `{ rpIds: string[] }`. The pin is mandatory — the
 * native path skips the browser's origin check, and on Windows nothing else ties the RP ID to the
 * app — so a bare `true` (which once meant "any RP") is an error, not a default.
 */
function validatePasskeys(passkeys: unknown, fail: Fail): void {
  if (passkeys === undefined || passkeys === false) return;
  if (!isPlainObject(passkeys) || passkeys.rpIds === undefined) {
    fail(
      "desktop.capabilities.passkeys",
      'must pin its relying parties: { rpIds: ["example.com"] } (a bare `true` allowed any RP ID)',
    );
  }
  const rpIds = (passkeys as Record<string, unknown>).rpIds;
  if (!Array.isArray(rpIds) || !rpIds.every((id) => typeof id === "string" && id !== "")) {
    fail("desktop.capabilities.passkeys.rpIds", "must be an array of RP ID strings");
  }
}

/** `desktop.app.deepLinks`: bare custom URL schemes. */
function validateDeepLinks(deepLinks: unknown, fail: Fail): void {
  if (deepLinks === undefined) return;
  if (!Array.isArray(deepLinks)) fail("desktop.app.deepLinks", "must be an array of URL schemes");
  (deepLinks as unknown[]).forEach((scheme, i) => {
    const err = typeof scheme === "string"
      ? desktopSchemeError(scheme)
      : 'must be a bare URL scheme string (e.g. "myapp")';
    if (err) fail(`desktop.app.deepLinks[${i}]`, err);
  });
}

/** `desktop.app.bridgeOrigins`: origins, `<scheme>://*` or `*`. */
function validateBridgeOrigins(origins: unknown, fail: Fail): void {
  if (origins === undefined) return;
  if (!Array.isArray(origins)) {
    fail("desktop.app.bridgeOrigins", "must be an array of origins");
  }
  (origins as unknown[]).forEach((entry, i) => {
    if (typeof entry !== "string" || normalizeDesktopBridgeOrigin(entry) === null) {
      fail(
        `desktop.app.bridgeOrigins[${i}]`,
        'must be an origin ("https://idp.example"), "<scheme>://*" or "*"',
      );
    }
  });
}

/** `desktop.app`: origin + identifier, deep-link schemes, singleInstance, bridge origins. */
function validateDesktopApp(app: unknown, fail: Fail): void {
  if (app === undefined) return;
  if (!isPlainObject(app)) fail("desktop.app", "must be an object");
  const a = app as Record<string, unknown>;
  validateDesktopOrigin(a, fail);
  validateDeepLinks(a.deepLinks, fail);
  validateBridgeOrigins(a.bridgeOrigins, fail);
  if (a.singleInstance !== undefined && typeof a.singleInstance !== "boolean") {
    fail("desktop.app.singleInstance", "must be a boolean");
  }
  if (a.name !== undefined && (typeof a.name !== "string" || a.name.trim() === "")) {
    fail("desktop.app.name", "must be a non-empty string");
  }
  validateDesktopIcons(a.icons, fail);
}

/** `desktop.app.icons`: `{ macos?, windows?, linux? }` file paths. */
function validateDesktopIcons(icons: unknown, fail: Fail): void {
  if (icons === undefined) return;
  if (!isPlainObject(icons)) fail("desktop.app.icons", "must be { macos?, windows?, linux? }");
  for (const [os, path] of Object.entries(icons as Record<string, unknown>)) {
    if (!["macos", "windows", "linux"].includes(os)) {
      fail(`desktop.app.icons.${os}`, "is not an OS (macos, windows or linux)");
    }
    if (typeof path !== "string" || path.trim() === "") {
      fail(`desktop.app.icons.${os}`, "must be a file path");
    }
  }
}

/** `desktop.denoFlags`: an allow-list of `deno desktop` flags, never a permission flag. */
function validateDenoFlags(flags: unknown, fail: Fail): void {
  if (flags === undefined) return;
  if (!Array.isArray(flags)) {
    fail("desktop.denoFlags", 'must be an array of flags, e.g. ["--node-modules-dir=none"]');
  }
  (flags as unknown[]).forEach((flag, i) => {
    const err = desktopDenoFlagError(flag);
    if (err) fail(`desktop.denoFlags[${i}]`, err);
  });
}

/** A `{ width, height }` size (each ≥ 1). */
function validateDesktopSize(v: unknown, field: string, fail: Fail): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) fail(field, "must be { width, height }");
  const size = v as Record<string, unknown>;
  num(fail, `${field}.width`, size.width, { min: 1 });
  num(fail, `${field}.height`, size.height, { min: 1 });
}

/** `desktop.window`: optional width/height (≥ 1), title, resizable. */
function validateDesktopWindow(win: unknown, fail: Fail): void {
  if (win === undefined) return;
  if (!isPlainObject(win)) fail("desktop.window", "must be an object");
  const w = win as Record<string, unknown>;
  if (w.width !== undefined) num(fail, "desktop.window.width", w.width, { min: 1 });
  if (w.height !== undefined) num(fail, "desktop.window.height", w.height, { min: 1 });
  if (w.title !== undefined && typeof w.title !== "string") {
    fail("desktop.window.title", "must be a string");
  }
  if (w.resizable !== undefined && typeof w.resizable !== "boolean") {
    fail("desktop.window.resizable", "must be a boolean");
  }
}

/** A value that must be one of `allowed` when set. */
function oneOf(v: unknown, allowed: readonly string[], field: string, fail: Fail): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    fail(field, `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
}

/** The window-shape keys: window, titleBar, backdrop, minSize ≤ maxSize, inspectable, preload. */
function validateDesktopWindowing(d: Record<string, unknown>, fail: Fail): void {
  validateDesktopWindow(d.window, fail);
  oneOf(d.titleBar, ["default", "hidden", "hiddenInset"], "desktop.titleBar", fail);
  oneOf(d.backdrop, ["none", "mica", "acrylic", "vibrancy"], "desktop.backdrop", fail);
  validateDesktopSize(d.minSize, "desktop.minSize", fail);
  validateDesktopSize(d.maxSize, "desktop.maxSize", fail);
  const min = d.minSize as { width: number; height: number } | undefined;
  const max = d.maxSize as { width: number; height: number } | undefined;
  if (min && max && (min.width > max.width || min.height > max.height)) {
    fail("desktop.minSize", "must not exceed desktop.maxSize");
  }
  if (d.inspectable !== undefined && typeof d.inspectable !== "boolean") {
    fail("desktop.inspectable", "must be a boolean");
  }
  if (d.preload !== undefined && (typeof d.preload !== "string" || d.preload === "")) {
    fail("desktop.preload", "must be a module path");
  }
}

/** `desktop.update.autoConfirm`: a boolean (the other `desktop.update` keys are checked at package). */
function validateDesktopUpdate(update: unknown, fail: Fail): void {
  const autoConfirm = (update as { autoConfirm?: unknown } | undefined)?.autoConfirm;
  if (autoConfirm !== undefined && typeof autoConfirm !== "boolean") {
    fail("desktop.update.autoConfirm", "must be a boolean");
  }
}

/** The installer formats per OS `desktop.installers.<os>` accepts. */
const DESKTOP_INSTALLER_KEYS: Record<string, readonly string[]> = {
  macos: ["dmg", "pkg"],
  linux: ["tar.gz", "deb", "rpm", "appimage"],
  windows: ["msi", "zip"],
};

/** `desktop.installers`: per-OS format lists, and the publisher / description strings. */
function validateDesktopInstallers(installers: unknown, fail: Fail): void {
  if (installers === undefined) return;
  if (!isPlainObject(installers)) fail("desktop.installers", "must be an object");
  const i = installers as Record<string, unknown>;
  for (const [os, formats] of Object.entries(DESKTOP_INSTALLER_KEYS)) {
    const v = i[os];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((f) => formats.includes(f as string))) {
      fail(
        `desktop.installers.${os}`,
        `must be an array of ${formats.map((f) => `"${f}"`).join(", ")}`,
      );
    }
  }
  for (const key of ["publisher", "description"]) {
    if (i[key] !== undefined && (typeof i[key] !== "string" || i[key] === "")) {
      fail(`desktop.installers.${key}`, "must be a non-empty string");
    }
  }
}

/** Whether `v` is one entitlement value: a string, a finite number, a boolean or a string array. */
function isEntitlementValue(v: unknown): boolean {
  return typeof v === "string" || typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (Array.isArray(v) && v.every((s) => typeof s === "string"));
}

/** `desktop.macos`: the provisioning profile path and the entitlements object. */
function validateDesktopMacos(macos: unknown, fail: Fail): void {
  if (macos === undefined) return;
  if (!isPlainObject(macos)) {
    fail("desktop.macos", "must be { provisioningProfile?, entitlements? }");
  }
  const m = macos as Record<string, unknown>;
  const profile = m.provisioningProfile;
  if (profile !== undefined && (typeof profile !== "string" || profile.trim() === "")) {
    fail("desktop.macos.provisioningProfile", "must be a .provisionprofile file path");
  }
  const ents = m.entitlements;
  if (ents === undefined) return;
  if (!isPlainObject(ents)) {
    fail("desktop.macos.entitlements", "must be an object of entitlement keys to values");
  }
  for (const [key, value] of Object.entries(ents as Record<string, unknown>)) {
    if (!isEntitlementValue(value)) {
      fail(
        `desktop.macos.entitlements["${key}"]`,
        "must be a string, a number, a boolean or an array of strings",
      );
    }
  }
}

/** `desktop.linux`: `{ requireSandbox?: boolean }`. */
function validateDesktopLinux(linux: unknown, fail: Fail): void {
  if (linux === undefined) return;
  if (!isPlainObject(linux)) fail("desktop.linux", "must be { requireSandbox? }");
  const require = (linux as Record<string, unknown>).requireSandbox;
  if (require !== undefined && typeof require !== "boolean") {
    fail("desktop.linux.requireSandbox", "must be a boolean");
  }
}

function validateDesktop(desktop: DenextConfig["desktop"], fail: Fail): void {
  if (desktop === undefined) return;
  if (typeof desktop !== "object" || Array.isArray(desktop)) {
    fail("desktop", "must be an object");
  }
  validateExtraPermissions((desktop as { extraPermissions?: unknown }).extraPermissions, fail);
  validateDesktopApp((desktop as { app?: unknown }).app, fail);
  validateDesktopWindowing(desktop as Record<string, unknown>, fail);
  validateDesktopUpdate((desktop as { update?: unknown }).update, fail);
  validateDesktopInstallers((desktop as { installers?: unknown }).installers, fail);
  validateDesktopMacos((desktop as { macos?: unknown }).macos, fail);
  validateDesktopLinux((desktop as { linux?: unknown }).linux, fail);
  validateDenoFlags((desktop as { denoFlags?: unknown }).denoFlags, fail);
  const caps = (desktop as { capabilities?: unknown }).capabilities;
  if (caps === undefined) return;
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
    fail("desktop.capabilities", "must be an object of capability names to `true` or options");
  }
  const c = caps as Record<string, unknown>;
  if (c.extensions !== undefined) {
    const ok = Array.isArray(c.extensions) &&
      c.extensions.every((p) => typeof p === "string" && p !== "");
    if (!ok) fail("desktop.capabilities.extensions", "must be an array of module paths");
  }
  validatePasskeys(c.passkeys, fail);
  for (const key of ["fs", "shell", "passkeys"]) {
    const v = c[key];
    const ok = v === undefined || typeof v === "boolean" ||
      (typeof v === "object" && v !== null && !Array.isArray(v));
    if (!ok) fail(`desktop.capabilities.${key}`, "must be a boolean or an options object");
  }
  validateOpenPathAllow(c.shell, fail);
}

/** `desktop.capabilities.shell.openPathAllowExtensions`: bare extensions (no dot, no path). */
function validateOpenPathAllow(shell: unknown, fail: Fail): void {
  if (typeof shell !== "object" || shell === null || Array.isArray(shell)) return;
  const allow = (shell as { openPathAllowExtensions?: unknown }).openPathAllowExtensions;
  if (allow === undefined) return;
  const ok = Array.isArray(allow) &&
    allow.every((e) => typeof e === "string" && e !== "" && !/[./\\]/.test(e));
  if (!ok) {
    fail(
      "desktop.capabilities.shell.openPathAllowExtensions",
      'must be an array of bare file extensions (no dot, no path separators), e.g. ["py", "sh"]',
    );
  }
}

/** `mode` and, in SPA mode, the required `spa.entry`. */
function validateMode(config: DenextConfig, fail: Fail): void {
  if (config.mode !== undefined && config.mode !== "spa") {
    fail("mode", 'must be "spa" (or omitted for the default App Router)');
  }
  if (config.mode !== "spa") return;
  if (!config.spa || typeof config.spa !== "object") {
    fail("spa", 'is required when `mode: "spa"` (e.g. `spa: { entry: "./src/main.tsx" }`)');
  } else if (typeof config.spa.entry !== "string" || config.spa.entry === "") {
    fail("spa.entry", "must be a non-empty path to the client entry module");
  }
}

/** `spa.ota`: a boolean when present. */
function validateSpaOta(ota: unknown, fail: Fail): void {
  if (ota !== undefined && typeof ota !== "boolean") fail("spa.ota", "must be a boolean");
}

type Proxy = NonNullable<NonNullable<DenextConfig["spa"]>["proxy"]>;

/** `spa.proxy.prefixes`: a non-empty array of "/"-rooted path strings. */
function validateProxyPrefixes(prefixes: Proxy["prefixes"], fail: Fail): void {
  const bad = !Array.isArray(prefixes) || prefixes.length === 0 ||
    prefixes.some((p) => typeof p !== "string" || !p.startsWith("/"));
  if (bad) {
    fail(
      "spa.proxy.prefixes",
      'must be a non-empty array of path prefixes starting with "/" (e.g. ["/api", "/ws"])',
    );
  }
}

/** `spa.proxy.target`: an absolute URL, loopback unless `allowNonLoopback`. */
function validateProxyTarget(proxy: Proxy, fail: Fail): void {
  let target: URL | undefined;
  try {
    target = new URL(proxy.target);
  } catch {
    fail("spa.proxy.target", 'must be an absolute URL (e.g. "http://127.0.0.1:3773")');
  }
  if (target && !proxy.allowNonLoopback && !isLoopbackHost(target.hostname)) {
    fail(
      "spa.proxy.target",
      `must be a loopback host (127.0.0.1 / localhost / [::1]) unless \`allowNonLoopback: true\` — got "${target.hostname}"`,
    );
  }
}

/** The dev-proxy `spa.proxy` block (loopback-gated target). */
function validateProxy(proxy: Proxy | undefined, fail: Fail): void {
  if (proxy === undefined) return;
  if (typeof proxy !== "object" || proxy === null) {
    fail(
      "spa.proxy",
      'must be an object (e.g. `{ prefixes: ["/api"], target: "http://127.0.0.1:3773" }`)',
    );
  }
  validateProxyPrefixes(proxy.prefixes, fail);
  validateProxyTarget(proxy, fail);
}

/** `basePath`: empty, or a "/"-rooted path without a trailing slash. */
function validateBasePath(basePath: DenextConfig["basePath"], fail: Fail): void {
  if (basePath === undefined) return;
  if (typeof basePath !== "string") fail("basePath", "must be a string");
  else if (basePath !== "" && (!basePath.startsWith("/") || basePath.endsWith("/"))) {
    fail("basePath", 'must start with "/" and not end with "/" (e.g. "/docs")');
  }
}

/** `basePath`/`assetPrefix`/`trailingSlash` and the redirect/rewrite/header thunks. */
function validateRouting(config: DenextConfig, fail: Fail): void {
  const { basePath, assetPrefix, trailingSlash, redirects, rewrites, headers } = config;
  validateBasePath(basePath, fail);
  if (assetPrefix !== undefined && typeof assetPrefix !== "string") {
    fail("assetPrefix", "must be a string");
  }
  if (trailingSlash !== undefined && typeof trailingSlash !== "boolean") {
    fail("trailingSlash", "must be a boolean");
  }
  // redirects/rewrites/headers are functions that return the rule array at startup.
  const thunks = [["redirects", redirects], ["rewrites", rewrites], ["headers", headers]] as const;
  for (const [field, v] of thunks) {
    if (v !== undefined && typeof v !== "function") {
      fail(field, "must be a function returning an array (e.g. `redirects: () => [...]`)");
    }
  }
}

/** `images.domains` / `images.remotePatterns` host allowlists. */
function validateImageAllowlists(images: DenextConfig["images"], fail: Fail): void {
  if (images?.domains !== undefined) {
    if (!Array.isArray(images.domains) || images.domains.some((d) => typeof d !== "string")) {
      fail("images.domains", "must be an array of host strings");
    }
  }
  if (images?.remotePatterns === undefined) return;
  if (!Array.isArray(images.remotePatterns)) {
    fail("images.remotePatterns", "must be an array");
  } else if (
    images.remotePatterns.some((p) => !p || typeof p.hostname !== "string" || p.hostname === "")
  ) {
    fail("images.remotePatterns", "each entry needs a non-empty `hostname` string");
  }
}

/** Image-pipeline numerics: pixel widths, quality (1..100), cache TTL, redirect bound. */
function validateImageNumerics(images: DenextConfig["images"], fail: Fail): void {
  if (!images) return;
  const { deviceSizes, imageSizes, qualities, minimumCacheTTL, maximumRedirects } = images;
  // Array widths/qualities: each element a finite positive integer (quality capped 100).
  const arrays: Array<[string, unknown, NumOpts]> = [
    ["images.deviceSizes", deviceSizes, { int: true, min: 1 }],
    ["images.imageSizes", imageSizes, { int: true, min: 1 }],
    ["images.qualities", qualities, { int: true, min: 1, max: 100 }],
  ];
  for (const [field, v, opts] of arrays) {
    if (v !== undefined) numArray(fail, field, v, opts);
  }
  if (minimumCacheTTL !== undefined) num(fail, "images.minimumCacheTTL", minimumCacheTTL);
  if (maximumRedirects !== undefined) {
    num(fail, "images.maximumRedirects", maximumRedirects, { int: true });
  }
}

/**
 * `csp` / `spa.csp`: `"strict"` | `"off"` | an opt-in object whose values are string
 * arrays. An unknown opt-in key (a typo such as `frameSource`) warns with a suggestion —
 * the policy would otherwise stay strict for that directive with no signal.
 */
function validateCsp(field: string, csp: DenextConfig["csp"], fail: Fail): void {
  if (csp === undefined || csp === "strict" || csp === "off") return;
  if (typeof csp !== "object" || csp === null || Array.isArray(csp)) {
    fail(field, 'must be "strict", "off", or an opt-in object (e.g. `{ scriptSrc: [...] }`)');
  }
  for (const [key, value] of Object.entries(csp)) validateCspOptIn(field, key, value, fail);
}

/** One `csp` opt-in entry: a known directive key holding an array of source strings. */
function validateCspOptIn(field: string, key: string, value: unknown, fail: Fail): void {
  const known: readonly string[] = ROUTE_CSP_KEYS;
  if (!known.includes(key)) {
    console.warn(unknownKeyMessage(`\`${field}\``, key, didYouMean(key, known)));
  } else if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`${field}.${key}`, 'must be an array of source strings (e.g. `["https://x.io"]`)');
  }
}

/** `hsts`: an object (with a finite `maxAge`) or `false`. */
function validateHsts(hsts: DenextConfig["hsts"], fail: Fail): void {
  if (hsts === undefined || hsts === false) return;
  if (typeof hsts !== "object" || hsts === null) {
    fail("hsts", "must be an object (e.g. `{ includeSubDomains: true }`) or `false`");
  } else if (hsts.maxAge !== undefined) {
    num(fail, "hsts.maxAge", hsts.maxAge); // seconds; finite >= 0
  }
}

/** `csp` (three-state) and `hsts` (object|false). */
function validateSecurity(config: DenextConfig, fail: Fail): void {
  validateCsp("csp", config.csp, fail);
  validateCsp("spa.csp", config.spa?.csp, fail);
  validateHsts(config.hsts, fail);
  validateApiBatch(config.apiBatch, fail);
  validateCors(config.cors, fail);
  validateAppLinks(config.appLinks, fail);
  if (config.apiMaxBodyBytes !== undefined) {
    num(fail, "apiMaxBodyBytes", config.apiMaxBodyBytes, { int: true, min: 1 });
  }
  validateServerOptions(config, fail);
}

/** `compress`: a boolean, or `{ encodings }` listing `"gzip"` / `"br"`. */
function validateCompress(compress: unknown, fail: Fail): void {
  if (compress === undefined || typeof compress === "boolean") return;
  if (typeof compress !== "object" || compress === null || Array.isArray(compress)) {
    fail("compress", 'must be a boolean or { encodings: ("gzip" | "br")[] }');
  }
  const encodings = (compress as { encodings?: unknown }).encodings;
  if (
    encodings !== undefined &&
    (!Array.isArray(encodings) || !encodings.every((e) => e === "gzip" || e === "br"))
  ) {
    fail("compress.encodings", 'must be an array of "gzip" / "br"');
  }
}

/**
 * The production-server knobs (`canonicalOrigin`, `trustForwardedHeaders`, `compress`,
 * `requestTimeout`, `maxConcurrency`, `slotBackstop`, `actionMaxBodyBytes`, `cacheKeyParams`):
 * a bare origin, booleans, whole numbers in range, a list of param names. A bad `canonicalOrigin` would
 * otherwise silently 403 every Server Action (the origin check compares against it).
 */
function validateServerOptions(config: DenextConfig, fail: Fail): void {
  const { canonicalOrigin, trustForwardedHeaders, cacheKeyParams } = config;
  if (
    canonicalOrigin !== undefined &&
    (typeof canonicalOrigin !== "string" || !isOrigin(canonicalOrigin))
  ) {
    fail(
      "canonicalOrigin",
      'must be an origin — scheme + host, no path (e.g. "https://example.com")',
    );
  }
  if (trustForwardedHeaders !== undefined && typeof trustForwardedHeaders !== "boolean") {
    fail("trustForwardedHeaders", "must be a boolean");
  }
  validateCompress(config.compress, fail);
  if (config.requestTimeout !== undefined) {
    num(fail, "requestTimeout", config.requestTimeout, { int: true, min: 0 }); // ms; 0 disables
  }
  if (config.maxConcurrency !== undefined) {
    num(fail, "maxConcurrency", config.maxConcurrency, { int: true, min: 1 });
  }
  if (config.slotBackstop !== undefined) {
    num(fail, "slotBackstop", config.slotBackstop, { int: true, min: 1 });
  }
  if (config.actionMaxBodyBytes !== undefined) {
    num(fail, "actionMaxBodyBytes", config.actionMaxBodyBytes, { int: true, min: 1 });
  }
  if (cacheKeyParams !== undefined) {
    if (!Array.isArray(cacheKeyParams) || cacheKeyParams.some((p) => typeof p !== "string")) {
      fail("cacheKeyParams", "must be an array of query-parameter-name strings");
    }
  }
}

/**
 * `cors`: the same resolution `createApp` runs (exact origins, never `"null"`, `"*"` alone and
 * never with credentials, a sane `maxAge`), so a bad policy fails at config load.
 */
function validateCors(cors: DenextConfig["cors"], fail: Fail): void {
  if (cors === undefined) return;
  try {
    resolveCors(cors);
  } catch (error) {
    fail("cors", (error instanceof Error ? error.message : String(error)).replace(/^denext: /, ""));
  }
}

/** `apiBatch` caps are finite whole numbers in sane ranges; `enabled` is a boolean. */
function validateApiBatch(apiBatch: DenextConfig["apiBatch"], fail: Fail): void {
  if (apiBatch === undefined) return;
  if (typeof apiBatch !== "object" || apiBatch === null) {
    return fail("apiBatch", "must be an object");
  }
  if (apiBatch.enabled !== undefined && typeof apiBatch.enabled !== "boolean") {
    fail("apiBatch.enabled", "must be a boolean");
  }
  if (apiBatch.maxItems !== undefined) {
    num(fail, "apiBatch.maxItems", apiBatch.maxItems, { int: true, min: 1, max: 100 });
  }
  if (apiBatch.maxBodyBytes !== undefined) {
    num(fail, "apiBatch.maxBodyBytes", apiBatch.maxBodyBytes, { int: true, min: 1 });
  }
  if (apiBatch.concurrency !== undefined) {
    num(fail, "apiBatch.concurrency", apiBatch.concurrency, { int: true, min: 1, max: 64 });
  }
  if (apiBatch.maxItemResponseBytes !== undefined) {
    num(fail, "apiBatch.maxItemResponseBytes", apiBatch.maxItemResponseBytes, {
      int: true,
      min: 1,
    });
  }
  if (apiBatch.maxTotalResponseBytes !== undefined) {
    num(fail, "apiBatch.maxTotalResponseBytes", apiBatch.maxTotalResponseBytes, {
      int: true,
      min: 1,
    });
  }
}

/** Cache eviction counts (finite whole numbers >= 1) and the `publicEnv` allowlist. */
function validateCacheAndEnv(config: DenextConfig, fail: Fail): void {
  if (config.cache?.maxDataEntries !== undefined) {
    num(fail, "cache.maxDataEntries", config.cache.maxDataEntries, { int: true, min: 1 });
  }
  if (config.cache?.maxPageEntries !== undefined) {
    num(fail, "cache.maxPageEntries", config.cache.maxPageEntries, { int: true, min: 1 });
  }
  if (config.publicEnv !== undefined) {
    if (!Array.isArray(config.publicEnv) || config.publicEnv.some((k) => typeof k !== "string")) {
      fail("publicEnv", "must be an array of env-variable-name strings");
    }
  }
}

/** `tasks.historyMaxRuns` is a finite whole number >= 1. */
function validateTasks(tasks: DenextConfig["tasks"], fail: Fail): void {
  if (tasks?.historyMaxRuns !== undefined) {
    num(fail, "tasks.historyMaxRuns", tasks.historyMaxRuns, { int: true, min: 1 });
  }
}

/** `tailwind.input`/`output` are required non-empty path strings. */
function validateTailwind(tailwind: unknown, fail: Fail): void {
  if (tailwind === undefined) return;
  if (typeof tailwind !== "object" || tailwind === null) {
    return fail("tailwind", "must be an object");
  }
  const tw = tailwind as Record<string, unknown>;
  for (const k of ["input", "output"]) {
    if (typeof tw[k] !== "string" || !tw[k]) {
      fail(`tailwind.${k}`, "must be a non-empty path string");
    }
  }
}

/** `i18n.locales` is a non-empty string list and `defaultLocale` is one of them. */
function validateI18n(i18n: unknown, fail: Fail): void {
  if (i18n === undefined) return;
  const { locales, defaultLocale } = (i18n ?? {}) as { locales?: unknown; defaultLocale?: unknown };
  const list = Array.isArray(locales) ? locales : [];
  if (list.length === 0 || list.some((l) => typeof l !== "string")) {
    return fail("i18n.locales", "must be a non-empty array of locale strings");
  }
  if (typeof defaultLocale !== "string" || !list.includes(defaultLocale)) {
    fail("i18n.defaultLocale", "must be one of i18n.locales");
  }
}

/**
 * Why `entry` is not a usable `allowedDevOrigins` entry, or `null` when it is one: an origin
 * (`http(s)://host[:port]`, nothing after it), a custom-scheme app origin (`myapp://app`,
 * validated as `desktop.app.origin` is — a Deno Desktop window's) or a bare host (`host` or
 * `host:port`, a raw IPv6 address included). The dev origin gate matches entries exactly, so a wildcard is
 * refused rather than silently never matching. Shared by the config validator and
 * `denext dev --allowed-dev-origin`.
 *
 * @param entry One entry, as given.
 * @returns The problem, ready to append to the entry, or `null`.
 */
export function devOriginError(entry: unknown): string | null {
  if (typeof entry !== "string" || entry.trim() === "") return "must be a non-empty string";
  if (entry.includes("*")) return "has a wildcard, which is not supported: list each host";
  if (/\s/.test(entry)) return "must not contain whitespace";
  return entry.includes("://") ? originEntryError(entry) : hostEntryError(entry);
}

/**
 * An `allowedDevOrigins` entry written as an origin: `http(s)://host[:port]` exactly, or a
 * custom-scheme app origin (`myapp://app`) by `desktop.app.origin`'s rules.
 */
function originEntryError(entry: string): string | null {
  if (!/^https?:\/\//i.test(entry)) {
    const parsed = parseDesktopAppOrigin(entry);
    return parsed.ok ? null : `must be an http(s) origin or a custom-scheme app origin like ` +
      `myapp://app (${parsed.error})`;
  }
  if (!URL.canParse(entry)) return "is not a valid origin";
  const url = new URL(entry);
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an http(s) origin";
  return url.origin === entry
    ? null
    : "must be an origin like http://192.168.1.5:3000 (lowercase, no path, no trailing /)";
}

/** An `allowedDevOrigins` entry written as a bare host: `host[:port]`, or a raw IPv6 address. */
function hostEntryError(entry: string): string | null {
  // A raw IPv6 address (the gate compares it to the bracket-stripped Host hostname).
  if ((entry.match(/:/g) ?? []).length > 1) {
    return URL.canParse(`http://[${entry}]`) ? null : "is not a valid IPv6 address";
  }
  const ok = URL.canParse(`http://${entry}`) && new URL(`http://${entry}`).host === entry;
  return ok
    ? null
    : "must be a host like 192.168.1.5, mac.local or mac.local:3000 (lowercase, no path)";
}

/** `allowedDevOrigins` is a list of origins or bare hosts, no wildcards. */
function validateAllowedDevOrigins(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return fail("allowedDevOrigins", "must be an array of origins");
  value.forEach((entry, i) => {
    const problem = devOriginError(entry);
    if (problem) fail(`allowedDevOrigins[${i}]`, problem);
  });
}

/** `momentumSafeScroll` is an on/off switch; absent keeps the iOS scroll shim on. */
function validateMomentumSafeScroll(value: unknown, fail: Fail): void {
  if (value !== undefined && typeof value !== "boolean") {
    fail("momentumSafeScroll", "must be a boolean");
  }
}

/** `platformExtensions` is a boolean or `{ native?: boolean, osFiles?: boolean }`. */
function validatePlatformExtensions(value: unknown, fail: Fail): void {
  if (value === undefined || typeof value === "boolean") return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("platformExtensions", "must be a boolean or `{ native?: boolean, osFiles?: boolean }`");
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key !== "native" && key !== "osFiles") {
      fail(`platformExtensions.${key}`, "is not a known option (native, osFiles)");
    } else if (typeof v !== "boolean") fail(`platformExtensions.${key}`, "must be a boolean");
  }
}

/** The string fields of a `mobile.flavors` entry. */
const FLAVOR_STRINGS = [
  "appId",
  "appIdSuffix",
  "appName",
  "serverUrl",
  "icon",
  "splash",
  "backgroundColor",
] as const;

/** A value-shape rule for one `mobile.flavors` field: the problem, or null. */
const FLAVOR_RULES: Record<string, (v: string) => string | null> = {
  appId: (v) =>
    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v)
      ? null
      : "must be a reverse-DNS id like com.example.app.beta",
  appIdSuffix: (v) =>
    /^(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v) ? null : 'must start with "." (e.g. ".staging")',
  serverUrl: (v) => (URL.canParse(v) ? null : "must be an absolute URL"),
  backgroundColor: (v) =>
    /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? null : "must be a hex colour like #0f172a",
};

/** Whether `value` is a plain object of strings. */
function isStringRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
}

/** One `mobile.flavors.<name>` entry. */
function validateMobileFlavor(name: string, value: unknown, fail: Fail): void {
  const at = `mobile.flavors.${name}`;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return fail(at, "names a flavor with lowercase letters, digits and `-` only");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(at, "must be an object");
  }
  const flavor = value as Record<string, unknown>;
  for (const key of FLAVOR_STRINGS) {
    const field = flavor[key];
    if (field === undefined) continue;
    const problem = typeof field === "string" ? FLAVOR_RULES[key]?.(field) : "must be a string";
    if (problem) fail(`${at}.${key}`, problem);
  }
  if (flavor.env !== undefined && !isStringRecord(flavor.env)) {
    fail(`${at}.env`, "must be an object of string values");
  }
}

/** `mobile`: `{ flavors?: { <name>: flavor } }`. */
function validateMobile(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("mobile", "must be an object");
  }
  const flavors = (value as Record<string, unknown>).flavors;
  if (flavors === undefined) return;
  if (typeof flavors !== "object" || flavors === null || Array.isArray(flavors)) {
    return fail("mobile.flavors", "must be an object of flavor name → settings");
  }
  for (const [name, flavor] of Object.entries(flavors)) validateMobileFlavor(name, flavor, fail);
}

/**
 * `reactNative`: `true`/`false` or an options object, and only in SPA mode — the resolve mode
 * applies to the SPA bundle, so anywhere else it would be silently ignored.
 */
function validateReactNative(config: DenextConfig, fail: Fail): void {
  const value: unknown = config.reactNative;
  if (value === undefined || value === false) return;
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (value !== true && !isObject) fail("reactNative", "must be a boolean or an options object");
  for (const key of ["rootStyle", "expoShims"] as const) {
    const option = isObject ? (value as Record<string, unknown>)[key] : undefined;
    if (option !== undefined && typeof option !== "boolean") {
      fail(`reactNative.${key}`, "must be a boolean");
    }
  }
  if (isObject) validateReactNativeObject(value as Record<string, unknown>, fail);
  if (config.mode !== "spa") {
    fail("reactNative", 'applies only in SPA mode — set `mode: "spa"` and `spa.entry`');
  }
}

/** `reactNative`'s object options: `lists`, `desktopPackage` and `aliases`. */
function validateReactNativeObject(value: Record<string, unknown>, fail: Fail): void {
  if (value.lists !== undefined && value.lists !== "denext" && value.lists !== "library") {
    fail("reactNative.lists", 'must be "denext" or "library"');
  }
  const desktop = value.desktopPackage;
  if (
    desktop !== undefined && desktop !== "react-native-macos" && desktop !== "react-native-windows"
  ) {
    fail("reactNative.desktopPackage", 'must be "react-native-macos" or "react-native-windows"');
  }
  validateReactNativeAliases(value.aliases, fail);
}

/**
 * `reactNative.aliases`: a map of aliased package names (`COMMUNITY_ALIASES`) to booleans. An
 * unknown name is a mistake (the alias it means to turn off stays on), so it fails with the
 * closest package named.
 */
function validateReactNativeAliases(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("reactNative.aliases", "must be an object of package name → boolean");
    return;
  }
  const known = Object.keys(COMMUNITY_ALIASES);
  for (const [pkg, on] of Object.entries(value)) {
    if (typeof on !== "boolean") fail(`reactNative.aliases.${pkg}`, "must be a boolean");
    if (known.includes(pkg)) continue;
    const near = known.map((k) =>
      [k, editDistance(pkg, k)] as const
    ).sort((a, b) => a[1] - b[1])[0];
    const hint = near && near[1] <= 3 ? ` (did you mean "${near[0]}"?)` : "";
    fail(`reactNative.aliases.${pkg}`, `is not an aliased package${hint}`);
  }
}

/** Nested fields whose absence would crash at request time rather than at boot. */
/**
 * `features` must be a flat map of booleans — the fold replaces a `feature("KEY")` call with
 * the literal, so a non-boolean value would emit invalid code (and a nested object is always a
 * mistake). Absent keeps every flag off.
 */
function validateFeatures(features: unknown, at: string, fail: Fail): void {
  if (features === undefined) return;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    fail(at, "must be an object mapping flag names to booleans");
  }
  for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
    if (typeof value !== "boolean") {
      fail(`${at}.${key}`, "must be a boolean");
    }
  }
}

/**
 * One `commands[i]` entry: a usable verb name, a summary to show in `denext --help`,
 * and a callable `run`. Nothing here checks for a collision with a built-in verb —
 * that is not an error: the CLI simply keeps the built-in (core wins) and skips the
 * entry, so a denext release adding a verb can never break a project's config load.
 */
function validateCommand(command: unknown, index: number, seen: Set<string>, fail: Fail): void {
  const at = `commands[${index}]`;
  if (typeof command !== "object" || command === null || Array.isArray(command)) {
    return fail(at, "must be an object with `name`, `summary`, and `run`");
  }
  const { name, summary, run } = command as Record<string, unknown>;
  // The one grammar for a verb name, shared with the CLI's help cache: what validation admits
  // here is exactly what the cache accepts back from disk (`src/cli/command-cache.ts`).
  if (typeof name !== "string" || !VERB_NAME.test(name)) {
    fail(`${at}.name`, `must be a lowercase verb name matching ${VERB_NAME}`);
  }
  if (seen.has(name as string)) {
    fail(`${at}.name`, `duplicates an earlier \`commands\` entry ("${name}")`);
  }
  seen.add(name as string);
  if (typeof summary !== "string" || !summary) {
    fail(`${at}.summary`, "must be a non-empty one-line description");
  }
  if (typeof run !== "function") fail(`${at}.run`, "must be a function");
}

/** `commands` is a list of shape-valid, uniquely named project verbs. */
function validateCommands(commands: unknown, fail: Fail): void {
  if (commands === undefined) return;
  if (!Array.isArray(commands)) return fail("commands", "must be an array of command objects");
  const seen = new Set<string>();
  commands.forEach((command, i) => validateCommand(command, i, seen, fail));
}

/**
 * `optimizePackageImports` (and Next's `experimental.optimizePackageImports`) is a list of
 * package names, `"!pkg"` exclusions, or (top-level only) `false` — a non-string entry would
 * otherwise never match an import, silently.
 */
function validatePackageList(list: unknown, at: string, fail: Fail, allowFalse = false): void {
  if (list === undefined || (allowFalse && list === false)) return;
  const bad = (p: unknown) => typeof p !== "string" || p === "" || p === "!";
  if (!Array.isArray(list) || list.some(bad)) {
    fail(
      at,
      "must be an array of package names (e.g. " +
        '["lucide-react", "react-icons/*", "!recharts"])' + (allowFalse ? " or false" : ""),
    );
  }
}

/** A removed denext `experimental.*` key fails, naming the top-level key that replaced it. */
function validateRemovedExperimental(experimental: unknown, fail: Fail): void {
  if (typeof experimental !== "object" || experimental === null) return;
  for (const [key, to] of REMOVED_EXPERIMENTAL_KEYS) {
    if (Object.hasOwn(experimental, key)) {
      fail(`experimental.${key}`, `was removed in denext 3.0 — set top-level \`${to}\` instead`);
    }
  }
}

function validateNestedRequired(config: DenextConfig, fail: Fail): void {
  validateRemovedExperimental(config.experimental, fail);
  validateFeatures(config.features, "features", fail);
  validatePackageList(config.optimizePackageImports, "optimizePackageImports", fail, true);
  validatePackageList(
    config.experimental?.optimizePackageImports,
    "experimental.optimizePackageImports",
    fail,
  );
  validateTailwind(config.tailwind, fail);
  validateI18n(config.i18n, fail);
}

/** Validate a loaded `denext.config`, throwing a field-scoped error on a bad value. */
export function validateDenextConfig(config: DenextConfig, name = "denext.config"): void {
  const fail: Fail = (field, msg) => {
    throw new Error(`invalid ${name}: \`${field}\` ${msg}`);
  };
  validateMode(config, fail);
  validateProxy(config.spa?.proxy, fail);
  validateSpaOta(config.spa?.ota, fail);
  validateMomentumSafeScroll(config.momentumSafeScroll, fail);
  validatePlatformExtensions(config.platformExtensions, fail);
  validateMobile(config.mobile, fail);
  validateDesktop(config.desktop, fail);
  validateAllowedDevOrigins(config.allowedDevOrigins, fail);
  validateReactNative(config, fail);
  validateRouting(config, fail);
  validateImageAllowlists(config.images, fail);
  validateImageNumerics(config.images, fail);
  validateSecurity(config, fail);
  validateCacheAndEnv(config, fail);
  validateTasks(config.tasks, fail);
  validateCommands(config.commands, fail);
  validateNestedRequired(config, fail);
}

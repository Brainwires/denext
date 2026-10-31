// The `desktop` block of denext.config: the capability allowlist, the app origin and identity,
// the window, sidecars, updates, installers and the per-OS signing / sandbox options.

import type { DenextConfig } from "../config.ts";
import {
  desktopAppIdentifierError,
  desktopSchemeError,
  normalizeDesktopBridgeOrigin,
  normalizeDesktopNavigationOrigin,
  originWithoutIdentifierMessage,
  parseDesktopAppOrigin,
} from "../../desktop/app-origin.ts";
import { desktopDenoFlagError } from "../../desktop/deno-flags.ts";
import { desktopTrayProblem } from "../../desktop/tray-config.ts";
import { desktopWindowKeyProblem } from "../../desktop/window-config.ts";
import { sidecarListError } from "../../desktop/sidecar.ts";
import { type Fail, isPlainObject, num, oneOf, validatePermissionLists } from "./shared.ts";

/** The kinds `desktop.extraPermissions` takes. */
const EXTRA_PERMISSION_KINDS = [
  "read",
  "write",
  "net",
  "netConnect",
  "netListen",
  "run",
  "ffi",
  "env",
  "sys",
];

/** Whether `v` is an array of strings. */
const isStringList = (v: unknown): boolean =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** `desktop.extraPermissions`: an object of permission kinds to string arrays. */
function validateExtraPermissions(extra: unknown, fail: Fail): void {
  if (extra === undefined) return;
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) {
    fail("desktop.extraPermissions", "must be an object of permission kinds to string arrays");
    return;
  }
  validatePermissionLists(
    "desktop.extraPermissions",
    extra as Record<string, unknown>,
    EXTRA_PERMISSION_KINDS,
    isStringList,
    fail,
  );
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
    } else if (entry.trim() === "*" || /:\/\/\*$/.test(entry.trim())) {
      warnOnce(bridgeWildcardWarning(i, entry.trim()));
    }
  });
}

/** The warning for a wildcard `desktop.app.bridgeOrigins` entry (`*`, `<scheme>://*`). */
function bridgeWildcardWarning(index: number, entry: string): string {
  const what = entry === "*"
    ? "every document the window loads"
    : `every ${entry.slice(0, -4)} origin`;
  return `denext.config: desktop.app.bridgeOrigins[${index}] is "${entry}": the native bridge ` +
    `answers ${what}, not only the app's own origin. Each binding still has to list the origin ` +
    "(bind(…, { origins })), but list exact origins here unless you need the wildcard.";
}

/** Warnings already printed by this process (a config is validated more than once). */
const warned = new Set<string>();

/** `console.warn` a message once per process. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** `desktop.app.allowedNavigationOrigins`: exact origins (no wildcards). */
function validateNavigationOrigins(origins: unknown, fail: Fail): void {
  if (origins === undefined) return;
  if (!Array.isArray(origins)) {
    fail("desktop.app.allowedNavigationOrigins", "must be an array of origins");
  }
  (origins as unknown[]).forEach((entry, i) => {
    if (typeof entry !== "string" || normalizeDesktopNavigationOrigin(entry) === null) {
      fail(
        `desktop.app.allowedNavigationOrigins[${i}]`,
        'must be an exact origin ("https://idp.example"): no path, wildcard or credentials',
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
  validateNavigationOrigins(a.allowedNavigationOrigins, fail);
  for (const key of ["singleInstance", "keepAlive", "dock"]) {
    if (a[key] !== undefined && typeof a[key] !== "boolean") {
      fail(`desktop.app.${key}`, "must be a boolean");
    }
  }
  if (a.name !== undefined && (typeof a.name !== "string" || a.name.trim() === "")) {
    fail("desktop.app.name", "must be a non-empty string");
  }
  validateActivationPolicy(a, fail);
  validateDesktopIcons(a.icons, fail);
}

/** `desktop.app.activationPolicy`: `"regular"` or `"accessory"`, and not regular with no Dock. */
function validateActivationPolicy(a: Record<string, unknown>, fail: Fail): void {
  const policy = a.activationPolicy;
  if (policy === undefined) return;
  if (policy !== "regular" && policy !== "accessory") {
    fail("desktop.app.activationPolicy", 'must be "regular" or "accessory"');
  }
  if (policy === "regular" && a.dock === false) {
    fail(
      "desktop.app.activationPolicy",
      'is "regular" (a Dock icon) but desktop.app.dock is false: drop one of them',
    );
  }
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

/**
 * `desktop.window`: optional width/height (≥ 1), title, and the flags (resizable, show, frameless,
 * transparent, focusable, skipTaskbar, visibleOnAllWorkspaces, overlay), alwaysOnTop, opacity.
 */
function validateDesktopWindow(win: unknown, fail: Fail): void {
  if (win === undefined) return;
  if (!isPlainObject(win)) fail("desktop.window", "must be an object");
  const w = win as Record<string, unknown>;
  if (w.width !== undefined) num(fail, "desktop.window.width", w.width, { min: 1 });
  if (w.height !== undefined) num(fail, "desktop.window.height", w.height, { min: 1 });
  if (w.title !== undefined && typeof w.title !== "string") {
    fail("desktop.window.title", "must be a string");
  }
  const problem = desktopWindowKeyProblem(w);
  if (problem) fail(`desktop.${problem[0]}`, problem[1]);
}

/** `desktop.tray`: an icon path in the export, optional texts, a menu and a panel. */
function validateDesktopTray(tray: unknown, fail: Fail): void {
  if (tray === undefined) return;
  const problem = desktopTrayProblem(tray);
  if (problem) fail(`desktop.${problem[0]}`, problem[1]);
}

/** The window-shape keys: window, titleBar, backdrop, minSize ≤ maxSize, inspectable, preload. */
function validateDesktopWindowing(d: Record<string, unknown>, fail: Fail): void {
  validateDesktopWindow(d.window, fail);
  validateDesktopTray(d.tray, fail);
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

/**
 * `desktop.sidecars`: each definition (the runtime's own checks), unique names, one `proxy` at
 * most, and a `proxy: true` sidecar needs `spa.proxy` (its prefixes).
 */
function validateDesktopSidecars(sidecars: unknown, spaProxy: unknown, fail: Fail): void {
  if (sidecars === undefined) return;
  const problem = sidecarListError(sidecars);
  if (problem) {
    const at = /^\[(\d+)\] /.exec(problem);
    if (at) fail(`desktop.sidecars[${at[1]}]`, problem.slice(at[0].length));
    fail("desktop.sidecars", problem.trim());
  }
  const proxied = (sidecars as { name: string; proxy?: boolean }[]).find((s) => s.proxy === true);
  if (proxied && spaProxy === undefined) {
    fail(
      "desktop.sidecars",
      `"${proxied.name}" sets proxy: true, which needs spa.proxy (the prefixes to forward)`,
    );
  }
}

/**
 * `desktop.update.autoConfirm`: a boolean; `desktop.update.ui`: a feed URL and a public key (the
 * other `desktop.update` keys are checked at package).
 */
function validateDesktopUpdate(update: unknown, fail: Fail): void {
  const autoConfirm = (update as { autoConfirm?: unknown } | undefined)?.autoConfirm;
  if (autoConfirm !== undefined && typeof autoConfirm !== "boolean") {
    fail("desktop.update.autoConfirm", "must be a boolean");
  }
  const ui = (update as { ui?: unknown } | undefined)?.ui;
  if (ui === undefined) return;
  if (!isPlainObject(ui)) fail("desktop.update.ui", "must be an object");
  const { feedUrl, publicKey } = ui as { feedUrl?: unknown; publicKey?: unknown };
  if (typeof feedUrl !== "string" || !URL.canParse(feedUrl)) {
    fail("desktop.update.ui.feedUrl", "must be an absolute URL");
  }
  if (typeof publicKey !== "string" || publicKey === "") {
    fail("desktop.update.ui.publicKey", "must be the release public key (base64 SPKI or PEM)");
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
    fail("desktop.macos", "must be { provisioningProfile?, entitlements?, userActivityTypes? }");
  }
  const m = macos as Record<string, unknown>;
  const profile = m.provisioningProfile;
  if (profile !== undefined && (typeof profile !== "string" || profile.trim() === "")) {
    fail("desktop.macos.provisioningProfile", "must be a .provisionprofile file path");
  }
  validateUserActivityTypes(m.userActivityTypes, fail);
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

/** `desktop.macos.userActivityTypes`: reverse-DNS activity types. */
function validateUserActivityTypes(types: unknown, fail: Fail): void {
  if (types === undefined) return;
  const ok = Array.isArray(types) &&
    types.every((t) =>
      typeof t === "string" && t.length <= 256 && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(t)
    );
  if (!ok) {
    fail(
      "desktop.macos.userActivityTypes",
      'must be an array of reverse-DNS names ("com.example.app.editing")',
    );
  }
}

/** `desktop.windows`: `{ proxy?: "system" | "direct" }`. */
function validateDesktopWindows(windows: unknown, fail: Fail): void {
  if (windows === undefined) return;
  if (!isPlainObject(windows)) fail("desktop.windows", "must be { proxy? }");
  const proxy = (windows as Record<string, unknown>).proxy;
  if (proxy !== undefined && proxy !== "system" && proxy !== "direct") {
    fail("desktop.windows.proxy", 'must be "system" or "direct"');
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

/**
 * The `desktop` block: the capability allowlist's shape. Light — the runtime enforces the
 * allowlist itself; this only catches obvious mistakes (a non-object, or a bad `extensions` list /
 * `fs`/`shell` option). Unknown capability keys are allowed (forward-compat with `desktop add`).
 */
export function validateDesktop(
  desktop: DenextConfig["desktop"],
  spaProxy: unknown,
  fail: Fail,
): void {
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
  validateDesktopWindows((desktop as { windows?: unknown }).windows, fail);
  validateDenoFlags((desktop as { denoFlags?: unknown }).denoFlags, fail);
  validateDesktopSidecars((desktop as { sidecars?: unknown }).sidecars, spaProxy, fail);
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

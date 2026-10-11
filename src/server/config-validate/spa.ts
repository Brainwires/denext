// `mode` and the `spa` block of denext.config: the entry, OTA, the Vite manifest, the TanStack
// Router splitter, the boot shell, the assets directory and the dev proxy.

import type { DenextConfig } from "../config.ts";
import { isLoopbackHost } from "../../utils/loopback.ts";
import { type Fail, isPlainObject, validateOptionalPath } from "./shared.ts";

/** `mode` and, in SPA mode, the required `spa.entry`. */
export function validateMode(config: DenextConfig, fail: Fail): void {
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
export function validateSpaOta(ota: unknown, fail: Fail): void {
  if (ota !== undefined && typeof ota !== "boolean") fail("spa.ota", "must be a boolean");
}

/** `spa.viteManifest`: a boolean when present. */
export function validateSpaViteManifest(value: unknown, fail: Fail): void {
  if (value !== undefined && typeof value !== "boolean") {
    fail("spa.viteManifest", "must be a boolean");
  }
}

/** The keys of `spa.tanstackRouter` (a typo would silently turn code-splitting off). */
const TANSTACK_ROUTER_KEYS = ["autoCodeSplitting", "routesDirectory", "generatedRouteTree"];

/** `spa.tanstackRouter`: `{ autoCodeSplitting?: boolean, routesDirectory?, generatedRouteTree? }`. */
export function validateSpaTanstackRouter(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("spa.tanstackRouter", "must be an object (e.g. `{ autoCodeSplitting: true }`)");
    return;
  }
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).find((key) => !TANSTACK_ROUTER_KEYS.includes(key));
  if (unknown !== undefined) {
    fail(
      `spa.tanstackRouter.${unknown}`,
      `is not a known option (${TANSTACK_ROUTER_KEYS.join(", ")})`,
    );
  }
  if (v.autoCodeSplitting !== undefined && typeof v.autoCodeSplitting !== "boolean") {
    fail("spa.tanstackRouter.autoCodeSplitting", "must be a boolean");
  }
  validateOptionalPath("spa.tanstackRouter.routesDirectory", v.routesDirectory, fail);
  validateOptionalPath("spa.tanstackRouter.generatedRouteTree", v.generatedRouteTree, fail);
}

/** The keys of `spa.shell` (a typo would silently drop the setting). */
const SPA_SHELL_KEYS = ["component", "props", "bootScript", "platforms", "readyOn", "maxHoldMs"];

/** The export targets `spa.shell.platforms` may name. */
const SPA_SHELL_PLATFORMS = ["web", "ios", "android", "macos", "windows", "linux"];

/** The `spa.shell.readyOn` values. */
const SPA_SHELL_READY_ON = ["first-settled-commit", "shellReady"];

/**
 * `spa.shell`: `{ component, props?, bootScript?, platforms?, readyOn?, maxHoldMs? }`, and never
 * together with `spa.loading` (both fill the mount element before the app renders).
 */
export function validateSpaShell(spa: DenextConfig["spa"], fail: Fail): void {
  const value: unknown = spa?.shell;
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    fail("spa.shell", 'must be an object (e.g. `{ component: "./src/AppShell.tsx" }`)');
    return;
  }
  if (spa?.loading !== undefined) {
    fail("spa.loading", "cannot be set together with `spa.shell` (the shell replaces it)");
  }
  const unknown = Object.keys(value).find((key) => !SPA_SHELL_KEYS.includes(key));
  if (unknown !== undefined) {
    fail(`spa.shell.${unknown}`, `is not a known option (${SPA_SHELL_KEYS.join(", ")})`);
  }
  if (typeof value.component !== "string" || value.component === "") {
    fail("spa.shell.component", "must be a non-empty path to the shell component's module");
  }
  validateOptionalPath("spa.shell.bootScript", value.bootScript, fail);
  validateSpaShellOptions(value, fail);
}

/** `spa.shell`'s `props`, `platforms`, `readyOn` and `maxHoldMs`. */
function validateSpaShellOptions(value: Record<string, unknown>, fail: Fail): void {
  if (value.props !== undefined && !isPlainObject(value.props)) {
    fail("spa.shell.props", "must be an object of props");
  }
  const platforms = value.platforms;
  if (
    platforms !== undefined &&
    !(Array.isArray(platforms) && platforms.every((p) => SPA_SHELL_PLATFORMS.includes(p)))
  ) {
    fail("spa.shell.platforms", `must be an array of ${SPA_SHELL_PLATFORMS.join(", ")}`);
  }
  if (value.readyOn !== undefined && !SPA_SHELL_READY_ON.includes(value.readyOn as string)) {
    fail("spa.shell.readyOn", 'must be "first-settled-commit" or "shellReady"');
  }
  const hold = value.maxHoldMs;
  if (hold !== undefined && !(typeof hold === "number" && Number.isFinite(hold) && hold >= 0)) {
    fail("spa.shell.maxHoldMs", "must be a non-negative number of milliseconds");
  }
}

/**
 * The top-level directories the client may not move under: denext's own endpoints and files
 * (`_denext`), the web's well-known URIs (app links) and the `spa.viteManifest` manifest
 * (`.vite`). Compared without case (a case-insensitive file system would merge them).
 */
const RESERVED_ASSETS_ROOTS = new Set(["_denext", ".well-known", ".vite"]);

/**
 * `spa.assetsDir` normalized: the slash-separated directory without leading or trailing
 * slashes, or null when it is not a plain relative directory. Each segment is letters, digits,
 * `_`, `.` or `-`, and never `.` / `..`; a directory under `_denext`, `.well-known` or `.vite`
 * is refused (denext's own endpoints, the web's well-known URIs and Vite's manifest live there).
 *
 * @param value The configured directory (`"assets"`, `"/static/js/"`).
 * @returns The normalized directory (`"assets"`, `"static/js"`), or null.
 */
export function normalizeSpaAssetsDir(value: string): string | null {
  const dir = value.replace(/^\/+|\/+$/g, "");
  const segments = dir.split("/");
  const valid = dir !== "" && !RESERVED_ASSETS_ROOTS.has(segments[0].toLowerCase()) &&
    segments.every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..");
  return valid ? dir : null;
}

/** `spa.assetsDir`: a plain relative directory when present. */
export function validateSpaAssetsDir(dir: unknown, fail: Fail): void {
  if (dir === undefined) return;
  if (typeof dir !== "string" || normalizeSpaAssetsDir(dir) === null) {
    fail(
      "spa.assetsDir",
      'must be a relative directory of letters, digits, "_", "." and "-" segments, not under ' +
        '_denext, .well-known or .vite (e.g. "assets")',
    );
  }
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
export function validateProxy(proxy: Proxy | undefined, fail: Fail): void {
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

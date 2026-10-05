// denext desktop runtime: serve a denext SPA export (`out/`) inside a native
// `deno desktop` window, optionally reverse-proxying a backend (`spa.proxy`). The
// app-level `desktop.ts` that `migrate --desktop` / `create --desktop` generates is
// a thin call to {@link runDesktop} — the serve + proxy + window plumbing lives here
// so a fix reaches every app.
//
// Serving reuses denext's {@link serveStatic} (content-types, gzip negotiation,
// path-traversal protection) over the export dir, with an SPA history fallback to
// `index.html` and `no-store` caching so a repackaged app never serves a stale
// bundle from the WebView cache. The proxy is the same mechanism as `denext start`
// in `mode:"spa"` (see {@link matchesProxyPrefix}/{@link proxyToBackend}).

import { basename, fromFileUrl, join } from "@std/path";
import type { SpaProxyConfig } from "../server/config.ts";
import { serveStatic } from "../server/static.ts";
import { isLoopbackHost } from "./dev-server/lan.ts";
import { DESKTOP_DEV_BUILD_KEY } from "./desktop-dev-build.ts";
import { wantsShell } from "./spa/shared.ts";
import {
  authSessionUnavailable,
  defaultOpenBrowser,
  type DesktopRequestAccess,
  handleDesktopAuthSession,
  timingSafeEqual,
} from "../desktop/auth-session-runtime.ts";
import {
  DESKTOP_APP_ORIGIN_ENV,
  DESKTOP_WS_URL_ENV,
  desktopRuntimeSkewWarning,
  type DesktopServeInfo,
  type DesktopTrust,
  type DesktopTrustDecision,
  isCrossOriginMarked,
  isRelayConnection,
  LOOPBACK_TRUST,
  memoryGate,
  resolveDesktopTrust,
  resolveDesktopWsUrl,
} from "../desktop/transport.ts";
import { sha256Base64 } from "../server/csp.ts";
import { devProxyTokenHeaders } from "./dev-server/dev-token.ts";
import type { DesktopUpdaterConfig } from "../desktop/updater.ts";
import { appUpdateAutoConfirm, combineBootHooks } from "../desktop/app-update-confirm.ts";
import { createDesktopBridge, type DesktopBridge } from "../desktop/bridge.ts";
import {
  DESKTOP_PRELOAD_ENV,
  DESKTOP_PRELOAD_FILE,
  inlineSafeScript,
  readDesktopPreload,
} from "../desktop/preload.ts";
import { DESKTOP_NOTIFICATION_SHIM_JS } from "../desktop/notification-shim.ts";
import type { DesktopCapability } from "../desktop/extension.ts";
import { createLaunchRouter, desktopAppApi } from "../desktop/launch-events.ts";
import { createSchemeAuthSessions } from "../desktop/scheme-auth-session.ts";
import type { PickedPaths } from "../desktop/picked-paths.ts";
import type { DesktopAppDirs } from "../desktop/app-dirs.ts";
import { createWindowController, type WindowController } from "../desktop/caps/window.ts";
import { createAppController } from "../desktop/caps/app.ts";
import {
  applyDesktopWindowSettings,
  type DesktopWindowSettings,
} from "../desktop/window-config.ts";

/** The per-launch picked-path set (re-exported so {@linkcode RunDesktopOptions} is documentable). */
export type { PickedPaths, PickedTarget, PickMode } from "../desktop/picked-paths.ts";
/** The app's own folders (re-exported so {@linkcode RunDesktopOptions} is documentable). */
export type { DesktopAppDirs } from "../desktop/app-dirs.ts";
/** The initial-window settings `runDesktop` applies (`desktop.window`, `desktop.titleBar`, …). */
export type { DesktopWindowSettings, DesktopWindowSize } from "../desktop/window-config.ts";

/** The gated capability bridge {@linkcode createDesktopHandler} dispatches to (re-exported so the
 * handler's signature has no private type). */
export type { DesktopBridge } from "../desktop/bridge.ts";
/** The retained-event replay buffer reached through {@linkcode DesktopBridge}'s `events` (re-exported
 * so that public member does not reference a private type). */
export type { DesktopEventLog } from "../desktop/bridge-events.ts";

// The desktop native-extension authoring API is served from `denext/desktop` (this module).
export {
  defineDesktopExtension,
  type DesktopCapability,
  type DesktopCapabilityMethod,
  type DesktopCapCtx,
  DesktopCapError,
  type DesktopMainThreadFn,
  type DesktopPermissions,
} from "../desktop/extension.ts";

// Which desktop world the app runs in (stock loopback vs the denext-pinned runtime's in-process
// memory transport at a stable origin): the env the runtime publishes, and the types the handler's
// signature uses.
export {
  DESKTOP_APP_ORIGIN_ENV,
  DESKTOP_WS_URL_ENV,
  type DesktopServeInfo,
  type DesktopTrust,
} from "../desktop/transport.ts";

// The packager's per-app files: `.deno-desktop/app.json` (+ `compile.include`) and the packaged
// `laufey-launch.json`, called by the scaffolded `scripts/package-*.ts`.
export {
  DESKTOP_APP_CONFIG_FILE,
  type DesktopAppSyncReport,
  LAUFEY_LAUNCH_FILE,
  syncDesktopAppConfig,
  writeLaufeyLaunchConfig,
} from "./desktop-app-config.ts";

// The config→capabilities resolver the generated `desktop.ts` entry spreads into `runDesktop`.
export {
  type ResolvedDesktop,
  resolveDesktopCapabilities,
  type ResolveDesktopOptions,
} from "../desktop/caps/mod.ts";

// The least-privilege packaging flags the scaffolded package scripts bake into `deno desktop`
// (in place of `-A`), derived from the project's `desktop.capabilities`.
export {
  DESKTOP_BASELINE_FLAGS,
  desktopBuildFlags,
  desktopIncludeArgs,
  desktopNpmArgs,
  type DesktopOs,
  desktopPackageFlags,
} from "./desktop-capabilities.ts";

// `desktop.denoFlags` (an allow-list of resolution / type-check flags) for the package scripts.
export { desktopDenoFlagArgs } from "./desktop-deno-flags.ts";

// denext's pinned Deno Desktop runtime (downloaded + SHA-256-verified into the Deno cache): the
// `DENORT_DESKTOP_BIN` / `LAUFEY_DEV_DIR` env the scaffolded package scripts set on `deno desktop`.
export { desktopRuntimeEnv } from "./desktop-runtime.ts";

// The installers the scaffolded package scripts build from a finished bundle (`desktop.installers`,
// `--format`): the per-OS format plan, the package metadata, and the .msi / .deb / .rpm / .tar.gz builders.
export {
  buildDesktopDeb,
  buildDesktopMsi,
  buildDesktopRpm,
  buildDesktopTarball,
  type BuildDesktopTarballOptions,
  type BuildLinuxPackageOptions,
  type BuildMsiOptions,
  DEFAULT_DESKTOP_INSTALLERS,
  DESKTOP_INSTALLER_FORMATS,
  type DesktopInstallerFormat,
  type DesktopInstallerPlan,
  desktopInstallerPlan,
  type DesktopPackageMeta,
  desktopPackageMeta,
  planDesktopInstallers,
} from "./desktop-installers.ts";
// `desktop.macos` for scripts/package-macos.ts: the provisioning profile it embeds and the
// entitlements it signs with, checked against the app before the build.
export {
  type DesktopMacosSigning,
  desktopMacosSigning,
  type DesktopMacosSigningOptions,
} from "./desktop-macos-signing.ts";
// The scaffolded package scripts' shared command line, tool probe and run setup.
export {
  buildDesktopBundle,
  desktopAppName,
  type DesktopBundleOptions,
  desktopHasTool,
  desktopIconArgs,
  type DesktopMsiProbe,
  desktopMsiProblem,
  desktopOptionalInstaller,
  desktopPackageArches,
  type DesktopPackageArgs,
  type DesktopPackageArgSpec,
  desktopPeFiles,
  desktopRequireTool,
  desktopRun,
  type DesktopRunOptions,
  desktopSignWindows,
  type DesktopSignWindowsDeps,
  desktopSlug,
  desktopToolGate,
  desktopVersionProblem,
  parseDesktopPackageArgs,
  type PreparedDesktopPackage,
  prepareDesktopPackage,
} from "./desktop-package-script.ts";

/** The lazily-imported reverse-proxy module ({@link ./dev-proxy.ts}) {@linkcode createDesktopHandler}
 * forwards to when a backend proxy is configured; exported so the handler's signature is public. */
export type ProxyModule = typeof import("./dev-proxy.ts");

/** The token-gated loopback OAuth endpoint the desktop client half POSTs to. */
const AUTH_SESSION_PATH = "/_denext/desktop/auth-session";
/** The token-gated boot-confirm endpoint the injected beacon POSTs to (updater watchdog). */
const BOOTED_PATH = "/_denext/desktop/booted";
/** The token-gated quit endpoint the injected `window.close` override POSTs to (page-initiated
 * close). A single-window desktop app quits, mirroring the native window-close handler. */
const QUIT_PATH = "/_denext/desktop/quit";
/** The per-launch token header the desktop client half presents to the local endpoints. */
const DESKTOP_TOKEN_HEADER = "x-denext-desktop-token";

/**
 * The env var `denext desktop dev` sets on the window process to put the runtime into
 * live-reload PROXY mode: its value is the loopback `denext dev` URL to reverse-proxy to. It is
 * the ONLY switch that turns proxy-all on — a release / `run` / `package` invocation never sets
 * it, so those windows serve the static export exactly as before (see {@linkcode runDesktop}).
 */
export const DESKTOP_DEV_URL_ENV = "DENEXT_DESKTOP_DEV_URL";

/**
 * The SECOND dev-only opt-in `denext desktop dev --lan` sets alongside {@linkcode
 * DESKTOP_DEV_URL_ENV} to allow a NON-loopback dev-server target. Without it a non-loopback
 * `DENEXT_DESKTOP_DEV_URL` is refused at runtime (see {@linkcode desktopDevProxyDecision}), so an
 * inherited/hostile env cannot turn a window into a proxy to an arbitrary remote origin.
 */
export const DESKTOP_DEV_LAN_ENV = "DENEXT_DESKTOP_DEV_LAN";

/**
 * Whether `execPath` is the `deno` CLI (`deno` / `deno.exe`, case-insensitive) rather than a
 * compiled/packaged app binary. A packaged app's execPath is its own binary; the window
 * `denext desktop dev` builds is one too, and carries the dev-build mark instead (see
 * {@linkcode desktopDevProxyDecision}). Pure, so the packaged-vs-dev decision is testable without
 * the real {@linkcode Deno.execPath}.
 */
export function isDenoCliExecPath(execPath: string): boolean {
  return ["deno", "deno.exe"].includes(basename(execPath).toLowerCase());
}

/** Whether this process runs a `denext desktop dev` build (its generated entry set the mark). */
function isDesktopDevBuild(): boolean {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(DESKTOP_DEV_BUILD_KEY)] === true;
}

/** The live-reload proxy decision from the env + the running binary — see {@linkcode desktopDevProxyDecision}. */
export type DesktopDevProxyDecision =
  | { readonly proxy: false; readonly refused?: string }
  | { readonly proxy: true; readonly target: string; readonly allowNonLoopback: boolean };

/**
 * Decide whether `runDesktop` enters live-reload PROXY mode, enforcing the loopback rule at
 * RUNTIME rather than trusting the env (invariant: a release build never proxies to a remote
 * origin). Pure + testable. Proxy mode requires ALL of:
 * - a `devUrl` (the {@linkcode DESKTOP_DEV_URL_ENV} value);
 * - `execPath` being the `deno` CLI ({@linkcode isDenoCliExecPath}), or `devBuild` (the mark only a
 *   `denext desktop dev` build compiles in) — a packaged app IGNORES the env, so an
 *   inherited/hostile env cannot turn a shipped window into a proxy;
 * - a parseable URL whose host is loopback — OR non-loopback WITH `lan` (the
 *   {@linkcode DESKTOP_DEV_LAN_ENV} opt-in that only `desktop dev --lan` sets). `allowNonLoopback`
 *   is true only in that LAN case.
 * A blocked case returns `{ proxy: false, refused }` so the caller can log why and serve static.
 */
export function desktopDevProxyDecision(
  devUrl: string | undefined,
  lan: boolean,
  execPath: string,
  devBuild = false,
): DesktopDevProxyDecision {
  if (!devUrl) return { proxy: false };
  if (!devBuild && !isDenoCliExecPath(execPath)) {
    return {
      proxy: false,
      refused: `${DESKTOP_DEV_URL_ENV} is ignored outside \`denext desktop dev\``,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(devUrl);
  } catch {
    return { proxy: false, refused: `${DESKTOP_DEV_URL_ENV} is not a valid URL` };
  }
  if (parsed.protocol !== "http:") {
    return {
      proxy: false,
      refused: `${DESKTOP_DEV_URL_ENV} must be an http: URL (got ${parsed.protocol})`,
    };
  }
  const host = parsed.hostname;
  if (isLoopbackHost(host)) return { proxy: true, target: devUrl, allowNonLoopback: false };
  if (lan) return { proxy: true, target: devUrl, allowNonLoopback: true };
  return {
    proxy: false,
    refused:
      `non-loopback ${DESKTOP_DEV_URL_ENV} "${host}" refused without ${DESKTOP_DEV_LAN_ENV}=1`,
  };
}

/**
 * Forward a request the desktop window received to the `denext dev` server. Injected into
 * {@linkcode createDesktopHandler} so tests exercise the dev path with a spy and never spawn a
 * real dev server; {@linkcode runDesktop} wires it to {@link proxyToBackend}.
 */
export type DesktopProxyFn = (request: Request, url: URL) => Response | Promise<Response>;

/** Whether the request is a WebSocket upgrade (reading headers can throw once upgraded). */
function isWebSocketUpgrade(request: Request): boolean {
  try {
    return request.headers.get("upgrade")?.toLowerCase() === "websocket";
  } catch {
    return false;
  }
}

/**
 * The request to forward to the dev server with the desktop credential removed: the per-launch
 * `x-denext-desktop-token` header is dropped so it never reaches the dev server (invariant: the
 * token gates the LOCAL endpoints only). A WebSocket upgrade is returned untouched — it cannot be
 * reconstructed (`Deno.upgradeWebSocket` needs the original connection), a browser cannot set a
 * custom header on a WS handshake, and {@link proxyToBackend}'s WS bridge forwards only
 * `host`/`origin`/`cookie` upstream, never the token. denext injects no desktop-specific cookie
 * (the token lives in `globalThis.__denext` and this header only), so there is none to strip.
 */
export function stripDesktopCredentials(request: Request): Request {
  if (isWebSocketUpgrade(request) || !request.headers.has(DESKTOP_TOKEN_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(DESKTOP_TOKEN_HEADER);
  return new Request(request, { headers });
}

/**
 * Forward a request through the live-reload dev proxy, injecting `__denext` into an UNCOMPRESSED
 * HTML navigation response so `runtimePlatform()` reads "desktop" in dev too. The per-launch token
 * is injected only when `injectToken` (a loopback target), never in --lan mode. Compressed or
 * non-HTML responses (and HEAD) stream through untouched — injecting into a gzipped body corrupts it.
 */
async function devProxyResponse(
  request: Request,
  url: URL,
  devProxy: DesktopProxyFn,
  token: string,
  injectToken: boolean,
  preload?: string,
  preloadKey?: string,
  page?: DesktopPageGlobals,
): Promise<Response> {
  const res = await devProxy(stripDesktopCredentials(request), url);
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (
    request.method === "HEAD" || res.headers.get("content-encoding") || !type.includes("text/html")
  ) {
    return res;
  }
  const injected = await injectDesktopGlobal(
    await res.text(),
    injectToken ? token : null,
    injectToken,
    injectToken ? preload : undefined,
    preloadKey,
    page,
  );
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(injected, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Options for {@linkcode runDesktop} (and {@linkcode createDesktopHandler}): where to serve the
 * static export from, an optional loopback reverse proxy and request escape hatch, the signed
 * self-updater, the enabled capability bridge, the app-support directory, and whether the loopback
 * OAuth endpoint is enabled. The generated `desktop.ts` entry spreads
 * {@linkcode resolveDesktopCapabilities} into it.
 */
export interface RunDesktopOptions {
  /**
   * Absolute path (or a path relative to {@link importMetaUrl}) of the static export
   * to serve. Default: `out/` resolved relative to `importMetaUrl`, else `<cwd>/out`.
   */
  outDir?: string;
  /**
   * Pass `import.meta.url` from the app's `desktop.ts` so `out/` resolves relative to
   * the entry module — which is how it works both under `deno desktop desktop.ts` and
   * from inside the packaged `.app` (where the CWD is not the project).
   */
  importMetaUrl?: string;
  /** Local server port. Default: env `PORT`, else `8000`. */
  port?: number;
  /**
   * Backend reverse-proxy config. Generated `desktop.ts` passes
   * `config.spa?.proxy` from the app's `denext.config.ts` (compiled into the entry,
   * since the packaged app has no config file at runtime). Omit for no proxy.
   */
  proxy?: SpaProxyConfig;
  /**
   * Escape hatch: intercept a request before the default proxy/serve. Return a
   * `Response` to handle it; return `null`/`undefined` to fall through.
   */
  onRequest?: (
    req: Request,
    url: URL,
  ) => Response | null | undefined | Promise<Response | null | undefined>;
  /**
   * Enable the SIGNED UI self-updater. When present, the served directory is resolved through
   * {@link resolveDesktopUiDir} — the verified overlay in the app-support dir if one is active
   * and healthy, else the bundled export — and {@link desktopBooted} confirms the launch after
   * the server is up (the boot watchdog rolls back a UI that fails to boot). Omit it to keep the
   * existing behavior (serve the bundled export only).
   */
  updater?: DesktopUpdaterConfig;
  /**
   * The enabled desktop capabilities — the compiled allowlist the {@link createDesktopBridge}
   * dispatcher serves (built-ins from `src/desktop/caps`, plus `defineDesktopExtension` modules).
   * Generated `desktop.ts` passes the set derived from `desktop.capabilities`. Omit for none, in
   * which case every bridge RPC answers `unavailable` and the page uses its web fallback.
   */
  capabilities?: readonly DesktopCapability[];
  /**
   * The OS per-app support directory handed to capability handlers
   * ({@link DesktopCapCtx.appSupportDir}) for state that must survive relaunch — browser storage
   * does not on desktop, because the runtime picks a new loopback origin each launch. Generated
   * `desktop.ts` computes it from the app id.
   */
  appSupportDir?: string;
  /**
   * Whether the `auth-session` capability is enabled (from `desktop.capabilities.authSession`, via
   * {@link resolveDesktopCapabilities}). The loopback OAuth endpoint ({@link openAuthSession}) is
   * DEFAULT-DENY: when this is not `true` it answers `unavailable`, so the page-side
   * `openAuthSession` reports that the capability is off rather than opening the system browser. It
   * is a full-trust `--allow-run` of the browser opener, so it is opt-in like every other run cap.
   */
  authSessionEnabled?: boolean;
  /**
   * The configured `desktop.app.origin`, normalized (from {@link resolveDesktopCapabilities}). Only
   * compared against the origin the runtime publishes, to warn about a stale package; the gates
   * trust the PUBLISHED origin ({@link resolveDesktopTrust}).
   */
  appOrigin?: string;
  /**
   * The deep-link schemes (`desktop.app.deepLinks`, lower-case; from {@link
   * resolveDesktopCapabilities}). Under denext's pinned runtime, links with these schemes reach the
   * page's `onDeepLink`, and they are the only schemes `openAuthSession` accepts as a callback.
   */
  deepLinks?: readonly string[];
  /**
   * The per-launch picked-path set the `dialogs`/`fs`/`shell` capabilities share (from {@link
   * resolveDesktopCapabilities}); files the OS opens with the app become read-only handles in it.
   */
  pickedPaths?: PickedPaths;
  /**
   * The initial-window settings from `desktop.window` / `desktop.titleBar` / `desktop.backdrop` /
   * `desktop.minSize` / `desktop.maxSize` (from {@link resolveDesktopCapabilities}), applied to the
   * adopted window at launch. The size limits, title bar style and backdrop need denext's pinned
   * runtime; the stock runtime skips them with a warning.
   */
  window?: DesktopWindowSettings;
  /**
   * The app's own folders (from {@link resolveDesktopCapabilities}): besides picked handles, the
   * only files the page may drag out of the window (`startFileDrag` in `denext/desktop/window`).
   */
  appDirs?: DesktopAppDirs;
  /**
   * Confirm a full-app update (`denext/desktop/updater`) on its trial launch once the window has
   * loaded (`desktop.update.autoConfirm`, from {@link resolveDesktopCapabilities}). Default `true`;
   * `false` leaves it to the app's own `confirmAppUpdate()` call.
   */
  autoConfirmAppUpdate?: boolean;
}

/**
 * What {@linkcode runDesktop} hands back once the server is up: the app window, the desktop world
 * the gates enforce, and a hook that pushes an event down the page's bridge stream (what
 * `onDesktopEvent(cap, event, …)` in `denext/desktop/client` receives) — the seam OS events (deep
 * links, open-file, …) are emitted through.
 */
export interface DesktopRuntime {
  /** The adopted initial `Deno.BrowserWindow`, or `undefined` outside the desktop runtime. */
  readonly window: unknown;
  /** The desktop world the gates enforce. */
  readonly trust: DesktopTrust;
  /**
   * Push an event to the page (`cap` need not be a registered capability's). Events are retained
   * for replay, so one emitted before the page subscribes is still delivered.
   */
  emit(cap: string, event: string, data: unknown): void;
}

// The SPA entry is stably named (`/_denext/client/index.js`), so the WebView would
// otherwise serve a cached copy after a repackage — force revalidation every load.
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * denext's CSP is HASH-based (never nonce-based) and, on the SPA/desktop shell, travels as a
 * `<meta http-equiv="Content-Security-Policy">` inside the document (see `cspMetaTag` in
 * `spa/shared.ts`). If the served shell carries such a meta with a `script-src` directive, add
 * `hash` to it so the injected desktop `<script>` is allowed — an unpatched strict CSP would
 * silently block the script and break desktop detection (and the whole auth flow). When the
 * shell carries no CSP meta (the SPA default), there is nothing to patch. One hash per injected
 * script (the desktop global, and the `desktop.preload` when there is one).
 */
function addScriptHashToCspMeta(html: string, hashes: readonly string[]): string {
  const metaRe = /<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/i;
  const tag = html.match(metaRe)?.[0];
  if (!tag) return html;
  const contentRe = /content=(["'])([\s\S]*?)\1/i;
  const cm = tag.match(contentRe);
  if (!cm) return html;
  const policy = cm[2];
  // No explicit script-src ⇒ default-src governs scripts; leave the policy untouched.
  const missing = hashes.filter((hash) => !policy.includes(hash));
  if (!/script-src\b/i.test(policy) || missing.length === 0) return html;
  const newPolicy = policy.replace(/(script-src\b[^;]*)/i, (d) => `${d} ${missing.join(" ")}`);
  const newTag = tag.replace(contentRe, (_full, q: string) => `content=${q}${newPolicy}${q}`);
  return html.replace(tag, newTag);
}

/**
 * The boot-confirm beacon appended to the injected script when the updater is on: once the page
 * has actually loaded (proof the UI rendered, not just that the server started), it POSTs the
 * per-launch token to `/_denext/desktop/booted`, which confirms the pending overlay so the boot
 * watchdog does not roll a healthy update back. Token-gated so a cross-origin drive-by cannot
 * confirm a broken update. Failures are swallowed (a missed beacon just leaves the trial pending,
 * i.e. it rolls back — fail-safe).
 */
const BOOT_BEACON_JS = ';(function(){function b(){try{fetch("/_denext/desktop/booted",' +
  '{method:"POST",headers:{"x-denext-desktop-token":globalThis.__denext.token}})' +
  '["catch"](function(){})}catch(e){}}' +
  'if(document.readyState==="complete")b();else addEventListener("load",b)})()';

/**
 * Override `window.close()` so a page-initiated close quits the app. The WebView does not forward
 * `window.close()` to the native window, so it would otherwise be a no-op; this POSTs the per-launch
 * token to {@link QUIT_PATH} (fire-and-forget), which exits the process — the same outcome as the
 * native window-close handler for this single-window shell. Token-gated so only the real top-level
 * page (which receives the token) can trigger it; a subframe / cross-origin page cannot.
 */
const QUIT_OVERRIDE_JS = ";(function(){var c=window.close;window.close=function(){try{" +
  'fetch("/_denext/desktop/quit",{method:"POST",headers:{"x-denext-desktop-token":' +
  'globalThis.__denext.token}})["catch"](function(){})}catch(e){}' +
  "try{return c.call(window)}catch(e){}}})()";

/**
 * What the injected `globalThis.__denext` carries besides the desktop marker and the token (see
 * {@linkcode injectDesktopGlobal}).
 */
export interface DesktopPageGlobals {
  /**
   * The runtime's WebSocket relay URL (`ws://127.0.0.1:<port>/.deno-desktop-relay/<token>`): where
   * the page dials a WebSocket to its own server (with its path appended) when it runs at a custom
   * app origin (denext's pinned runtime). It carries the relay's per-launch token, so it is
   * injected only together with the desktop token (a top-level document of the app).
   */
  readonly wsUrl?: string;
  /**
   * Install the web `Notification` shim (`src/desktop/notification-shim.ts`), backed by the
   * `notifications` capability. Only with the token (it posts through the bridge); the handler sets
   * it in the memory world when the capability is enabled.
   */
  readonly notifications?: boolean;
}

/**
 * The `globalThis.__denext` value: the desktop marker and the OS, plus — only with the per-launch
 * token — the token and the relay URL (which carries the relay's own token).
 */
function desktopGlobals(token: string | null, page: DesktopPageGlobals): Record<string, unknown> {
  if (token === null) return { desktop: true, os: Deno.build.os };
  return {
    desktop: true,
    token,
    os: Deno.build.os,
    ...(page.wsUrl ? { wsUrl: page.wsUrl } : {}),
  };
}

/**
 * Inject `globalThis.__denext = { desktop: true, token }` as an inline `<script>` immediately
 * after the opening `<head>` (falling back to after `<body>`, then to a prepend). The value is
 * `JSON.stringify`-escaped. When `beacon` is set, the boot-confirm beacon ({@linkcode
 * BOOT_BEACON_JS}) is appended to the SAME script so one CSP hash covers both. When the shell
 * carries a hash-based CSP meta, its `script-src` is extended with this script's `'sha256-…'` so
 * the script survives a strict policy.
 *
 * `preload` (the bundled `desktop.preload`, already inline-safe) is injected as a SECOND inline
 * script right after the global — so it runs after `__denext` exists and before any page script —
 * with its own hash. It is injected only together with the token (a top-level document); the
 * caller additionally limits it to the memory world. With a `preloadKey`, the preload is framed by
 * two more scripts that set `globalThis.__denextPreloadKey` before it and delete it after (even
 * when the preload throws), so only code the preload runs synchronously can read the key — the
 * proof `denext/desktop/clerk` presents for its Clerk-only session binding. The setting script
 * removes its own element as it runs, so the key cannot be read back from `document.scripts`.
 *
 * `page` adds what the page needs from the runtime ({@linkcode DesktopPageGlobals}): the
 * WebSocket relay URL and — both only with the token — the web `Notification` shim, appended to the
 * same script (one CSP hash) so it is in place before any page script runs.
 */
export async function injectDesktopGlobal(
  html: string,
  token: string | null,
  beacon = false,
  preload?: string,
  preloadKey?: string,
  page: DesktopPageGlobals = {},
): Promise<string> {
  // A null token marks the window desktop WITHOUT handing it the per-launch token (the --lan
  // live-reload case): runtimePlatform() reads "desktop", but the token-gated endpoints stay
  // unreachable, and the boot beacon (which needs the token) is not injected.
  const body = `globalThis.__denext=${JSON.stringify(desktopGlobals(token, page))}` +
    (token !== null ? QUIT_OVERRIDE_JS : "") +
    (token !== null && page.notifications === true ? NOTIFICATION_SHIM_INLINE : "") +
    (token !== null && beacon ? BOOT_BEACON_JS : "");
  const withPreload = token !== null && preload !== undefined;
  const scripts = !withPreload ? [body] : preloadKey === undefined ? [body, preload] : [
    body,
    // The element removes itself as it runs: its text would otherwise sit in `document.scripts`
    // for any page script to read the key back out of.
    `globalThis.${PRELOAD_KEY_GLOBAL}=${JSON.stringify(preloadKey)};${REMOVE_CURRENT_SCRIPT}`,
    preload,
    `delete globalThis.${PRELOAD_KEY_GLOBAL}`,
  ];
  const scriptTag = scripts.map((code) => `<script>${code}</script>`).join("");
  const headMatch = html.match(/<head\b[^>]*>/i);
  const bodyMatch = headMatch ? null : html.match(/<body\b[^>]*>/i);
  let out: string;
  if (headMatch) {
    const at = headMatch.index! + headMatch[0].length;
    out = html.slice(0, at) + scriptTag + html.slice(at);
  } else if (bodyMatch) {
    const at = bodyMatch.index! + bodyMatch[0].length;
    out = html.slice(0, at) + scriptTag + html.slice(at);
  } else {
    out = scriptTag + html;
  }
  const hashes = await Promise.all(
    scripts.map(async (code) => `'sha256-${await sha256Base64(code)}'`),
  );
  return addScriptHashToCspMeta(out, hashes);
}

/** The web `Notification` shim as it sits inside the injected inline script. */
const NOTIFICATION_SHIM_INLINE = inlineSafeScript(DESKTOP_NOTIFICATION_SHIM_JS);

/** The one-shot global the preload key is handed to `desktop.preload` in. */
const PRELOAD_KEY_GLOBAL = "__denextPreloadKey";

/** Detach the running inline `<script>` from the document (it has already been parsed). */
const REMOVE_CURRENT_SCRIPT = "document.currentScript&&document.currentScript.remove()";

/** The export dir: `outDir` (relative to the entry module when given), else `out/`. */
/** The static-export dir to serve: `outDir` (relative to `importMetaUrl` when given), else `out/`. */
export function resolveOutDir(options: RunDesktopOptions): string {
  const base = options.importMetaUrl ? new URL(".", options.importMetaUrl) : undefined;
  if (options.outDir) return base ? fromFileUrl(new URL(options.outDir, base)) : options.outDir;
  return base ? fromFileUrl(new URL("out", base)) : join(Deno.cwd(), "out");
}

/**
 * Closing the window (macOS red light / Cmd-W) quits the app. `Deno.serve` is a
 * permanently-live task, so deno desktop won't auto-exit on close; adopt the initial
 * window and exit on its `close`. Guarded so a non-desktop run is a no-op. Returns the adopted
 * window (handed to capabilities as `ctx.window`), or `undefined` outside the desktop runtime.
 *
 * @param BrowserWindow The runtime's window constructor (`Deno.BrowserWindow`); a parameter so a
 *   test can stand one in.
 * @param exit How the process ends (default `Deno.exit`).
 * @param intercept Consulted first on every close: `true` when it took the close over (the page
 *   guards it, see `onCloseRequested` in `denext/desktop/window`), so the app keeps running.
 */
export function installWindowCloseHandler(
  // deno-lint-ignore no-explicit-any
  BrowserWindow: unknown = (Deno as any).BrowserWindow,
  exit: (code: number) => void = Deno.exit,
  intercept?: (event: Event) => boolean,
): unknown {
  try {
    if (typeof BrowserWindow === "function") {
      const appWindow = new (BrowserWindow as new () => EventTarget)();
      appWindow.addEventListener("close", (event) => {
        if (intercept?.(event) === true) return;
        exit(0);
      });
      return appWindow;
    }
  } catch (err) {
    console.error("desktop: window-close handler not installed", err);
  }
  return undefined;
}

/**
 * The token-gated local endpoints: the loopback OAuth sheet ({@link AUTH_SESSION_PATH}) and, with
 * the updater on, the boot-confirm beacon ({@link BOOTED_PATH}) — a real "the UI rendered" signal
 * that replaces a timer. The beacon requires POST + a constant-time token match, so a cross-origin
 * page cannot confirm a broken update. Returns the endpoint's `Response`, or `null` to fall through.
 */
async function handleLocalEndpoint(
  request: Request,
  url: URL,
  token: string,
  authSessionEnabled: boolean,
  access: DesktopRequestAccess,
  onBooted?: () => void | Promise<void>,
  onQuit?: () => void,
): Promise<Response | null> {
  if (url.pathname === AUTH_SESSION_PATH) {
    // Default-deny: without the `auth-session` capability the endpoint answers `unavailable` and
    // never opens the system browser, so the opener's `--allow-run` is only baked when opted in.
    return authSessionEnabled
      ? await handleDesktopAuthSession(request, token, undefined, access)
      : authSessionUnavailable();
  }
  if (onBooted && url.pathname === BOOTED_PATH) {
    const reject = requireTokenedPost(request, token, access);
    if (reject) return reject;
    await onBooted();
    return new Response(null, { status: 204 });
  }
  if (url.pathname === QUIT_PATH) {
    // The page called `window.close()` (see QUIT_OVERRIDE_JS); quit the single-window app, as native
    // close. queueMicrotask lets the 204 flush before the process goes away.
    const reject = requireTokenedPost(request, token, access);
    if (reject) return reject;
    queueMicrotask(() => onQuit?.());
    return new Response(null, { status: 204 });
  }
  return null;
}

/** Guard a token-gated POST endpoint: a `Response` to reject (405 for a non-POST, 403 for a missing
 * or non-constant-time-matching token, so a cross-origin / subframe page cannot reach it), or `null`
 * when the request is a POST carrying the valid per-launch token. In the memory world the request
 * must also come over the memory transport with an absent-or-exact `Origin`; a `refuse` world
 * refuses. */
function requireTokenedPost(
  request: Request,
  token: string,
  access: DesktopRequestAccess,
): Response | null {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const presented = request.headers.get(DESKTOP_TOKEN_HEADER) ?? "";
  if (!timingSafeEqual(presented, token)) return new Response(null, { status: 403 });
  const { trust } = access;
  if (trust.kind === "refuse") return new Response(null, { status: 403 });
  if (trust.kind === "memory" && memoryGate(trust, request, access.info) !== null) {
    return new Response(null, { status: 403 });
  }
  return null;
}

/**
 * Whether the per-launch token may be injected into the document this request fetches: never on
 * a request the runtime relayed from its loopback WebSocket relay (any local process can dial it,
 * so its missing `Origin` / `Sec-Fetch-Dest` prove nothing); otherwise a TOP-LEVEL document only
 * (`Sec-Fetch-Dest`, `document` when absent), so a subframe gets the desktop global without the
 * token. Then, per world: loopback — a LOOPBACK `Host`, so a DNS-rebinding Host gets no token;
 * memory — the in-process memory transport and an `Origin` that is absent or exactly the app
 * origin; refuse — never.
 */
export function shouldInjectDesktopToken(
  request: Request,
  url: URL,
  trust: DesktopTrust,
  info?: DesktopServeInfo,
): boolean {
  if (isRelayConnection(request)) return false;
  if ((request.headers.get("sec-fetch-dest") ?? "document") !== "document") return false;
  if (trust.kind === "refuse") return false;
  if (trust.kind === "memory") return memoryGate(trust, request, info) === null;
  return isLoopbackHost(url.hostname);
}

/** The prefix of every token-gated local endpoint (bridge, auth session, boot beacon, quit). */
const DESKTOP_ENDPOINT_PREFIX = "/_denext/desktop/";

/**
 * A `/_denext/desktop/*` request the runtime's scheme bridge marked as coming from another
 * origin's document ({@linkcode isCrossOriginMarked}): refused (403) whatever else it carries,
 * before any gate or the `onRequest` escape hatch sees it. Defense in depth: the endpoints' real
 * gate is the per-launch token, and an engine that discloses no `Origin` / `Sec-Fetch-Site`
 * leaves a foreign request unmarked. `null` to proceed.
 */
function refuseCrossOriginEndpoint(request: Request, url: URL): Response | null {
  if (!url.pathname.startsWith(DESKTOP_ENDPOINT_PREFIX) || !isCrossOriginMarked(request)) {
    return null;
  }
  return new Response("forbidden", { status: 403 });
}

/**
 * The app side of the WebSocket check in the memory world: an upgrade reaches `Deno.serve` only
 * through the runtime's loopback relay, which admits nothing but an `Origin` equal to the app
 * origin — checked again here (memory transport + that exact `Origin`, which an upgrade must carry)
 * so the app does not rely on the relay alone. A relay-marked request ({@linkcode
 * isRelayConnection}) that is NOT an upgrade, or that targets a `/_denext/desktop/*` endpoint, is
 * refused outright: the relay exists for the page's WebSockets only. `null` to proceed, else a
 * 403. Other worlds and unmarked non-upgrade requests pass through unchanged.
 */
function refuseForeignWebSocket(
  request: Request,
  url: URL,
  trust: DesktopTrust,
  info?: DesktopServeInfo,
): Response | null {
  if (
    trust.kind !== "loopback" && isRelayConnection(request) &&
    (!isWebSocketUpgrade(request) || url.pathname.startsWith(DESKTOP_ENDPOINT_PREFIX))
  ) {
    return new Response("forbidden", { status: 403 });
  }
  if (trust.kind === "loopback" || !isWebSocketUpgrade(request)) return null;
  if (trust.kind === "memory" && memoryGate(trust, request, info, true) === null) return null;
  return new Response("forbidden", { status: 403 });
}

/**
 * The desktop request handler: the `onRequest` escape hatch, the token-gated local endpoints,
 * then — when `devProxy` is set (`denext desktop dev` only) — the reverse proxy to `denext dev`
 * for EVERYTHING else; otherwise the backend proxy, the export's static assets (`no-store`), the
 * `index.html` shell for navigations, else 404. Exported for tests; {@linkcode runDesktop} wires
 * it to `Deno.serve`.
 *
 * Request order is load-bearing: the token-gated `/_denext/desktop/*` endpoints ({@link
 * handleLocalEndpoint}) run BEFORE the dev proxy, so they are always served LOCALLY and never
 * forwarded to the dev server, even in live-reload mode.
 */
export function createDesktopHandler(
  options: RunDesktopOptions,
  outDir: string,
  proxy: ProxyModule | undefined,
  token: string = crypto.randomUUID(),
  onBooted?: () => void | Promise<void>,
  devProxy?: DesktopProxyFn,
  devInjectToken = false,
  bridge?: DesktopBridge,
  onQuit?: () => void,
  trust: DesktopTrust = LOOPBACK_TRUST,
  preload?: string,
  preloadKey?: string,
  wsUrl?: string,
): (request: Request, url: URL, info?: DesktopServeInfo) => Promise<Response> {
  const proxyCfg = options.proxy;
  const indexHtmlPath = join(outDir, "index.html");
  // `desktop.preload` runs only in the memory world (the pinned runtime at its stable origin), and
  // only where the token goes (a top-level document over the memory transport): never into an
  // iframe, and never into a loopback-world page.
  const memoryPreload = trust.kind === "memory" ? preload : undefined;
  // What the page reads from `__denext` besides the token: the relay its WebSockets dial (only in
  // the memory world, the one place the page runs at a custom origin), and the web `Notification`
  // shim when the `notifications` capability is on (the pinned runtime's OS notifications).
  const memory = trust.kind === "memory";
  const page: DesktopPageGlobals = {
    ...(memory && wsUrl ? { wsUrl } : {}),
    ...(memory && options.capabilities?.some((c) => c.name === "notifications")
      ? { notifications: true }
      : {}),
  };

  /** Serve the export's `index.html` shell with the desktop global (and, with the updater on, the
   * boot-confirm beacon) injected. `injectToken` gates the per-launch TOKEN: a subframe or a
   * DNS-rebinding `Host` still learns it is desktop (runtimePlatform()) but gets NO token, so it
   * cannot reach the bridge. */
  const serveShell = async (isHead: boolean, injectToken: boolean): Promise<Response | null> => {
    const html = await Deno.readTextFile(indexHtmlPath).catch(() => null);
    if (html === null) return null;
    const injected = await injectDesktopGlobal(
      html,
      injectToken ? token : null,
      onBooted !== undefined,
      injectToken ? memoryPreload : undefined,
      preloadKey,
      page,
    );
    return noStore(
      new Response(isHead ? null : injected, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  };

  /** The backend proxy (when configured + matched), then the static export, its `index.html` shell
   * for navigations, else 404. Split out so the top-level handler stays simple. */
  const serveBackendOrExport = async (
    request: Request,
    url: URL,
    injectToken: boolean,
  ): Promise<Response> => {
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }
    // The served-asset index.html path: inject the desktop global (re-read from disk so the
    // injection is not fighting content-encoding on the static response).
    if (url.pathname === "/index.html") {
      const shell = await serveShell(request.method === "HEAD", injectToken);
      if (shell) return shell;
    }
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const asset = await serveStatic(outDir, url.pathname, accEnc, request);
    if (asset) return noStore(asset);
    if (wantsShell(request, url.pathname)) {
      const shell = await serveShell(request.method === "HEAD", injectToken);
      if (shell) return shell;
    }
    return new Response("not found", { status: 404 });
  };

  return async (request, url, info) => {
    // A desktop endpoint request marked cross-origin is refused, and in the memory world a
    // WebSocket upgrade must carry the exact app origin (the relay checked it too) — before even
    // the onRequest escape hatch, so no app code sees either.
    const foreign = refuseCrossOriginEndpoint(request, url) ??
      refuseForeignWebSocket(request, url, trust, info);
    if (foreign) return foreign;
    if (options.onRequest) {
      const r = await options.onRequest(request, url);
      if (r) return r;
    }
    // The token-gated local endpoints (loopback OAuth + boot-confirm beacon) — before the dev
    // proxy AND the backend proxy/static, so they are always served locally (never proxied).
    const endpoint = await handleLocalEndpoint(
      request,
      url,
      token,
      options.authSessionEnabled === true,
      { trust, info },
      onBooted,
      onQuit,
    );
    if (endpoint) return endpoint;
    // The capability bridge (RPC + events) — gated, and like the local endpoints it runs BEFORE any
    // proxy so it is always served locally and never forwarded.
    if (bridge) {
      const bridged = await bridge.handle(request, url, token, info);
      if (bridged) return bridged;
    }
    // The per-launch token is injected only into a TOP-LEVEL document (Sec-Fetch-Dest, default
    // document when absent) served over the memory transport (the pinned runtime) or to a LOOPBACK
    // Host (the stock runtime) — so a subframe AND a DNS-rebinding Host each get the desktop global
    // without the token, and cannot reach the bridge.
    const injectToken = shouldInjectDesktopToken(request, url, trust, info);
    // A top-level NAVIGATION (a reload or a new page) ends the previous page: release what it
    // held through the bridge (keep-awake holds…). Only a real browser navigation counts.
    if (bridge && injectToken && request.method === "GET" && isPageNavigation(request)) {
      await bridge.pageLoaded();
    }
    // Live-reload mode (`denext desktop dev` only): reverse-proxy EVERYTHING else to `denext dev`,
    // with the per-launch desktop token stripped so it never reaches the dev server. The token is
    // injected into a buffered HTML navigation only for a loopback dev target (`devInjectToken`)
    // that is also a top-level loopback-Host document, never in --lan mode.
    if (devProxy) {
      return await devProxyResponse(
        request,
        url,
        devProxy,
        token,
        devInjectToken && injectToken,
        memoryPreload,
        preloadKey,
        page,
      );
    }
    return await serveBackendOrExport(request, url, injectToken);
  };
}

/**
 * The app-event capabilities of denext's pinned runtime (`Deno.desktop`): the launch router
 * (`deepLinks` / `openFiles`, fed by `openurl` / `openfile` / `secondinstance` and the cold-start
 * lists) and — with the `auth-session` capability on — the custom-scheme auth sessions, whose
 * callbacks the router offers to the pending session before anything reaches the page. Nothing
 * under the stock runtime (no `Deno.desktop`): the page's deep-link calls answer `unavailable`.
 */
function desktopAppEvents(
  options: RunDesktopOptions,
  emit: (cap: string, event: string, data: unknown) => void,
  preloadKey: string,
): { capabilities: DesktopCapability[]; install(): void } {
  const api = desktopAppApi();
  if (!api) return { capabilities: [], install: () => {} };
  const schemes = options.deepLinks ?? [];
  const auth = options.authSessionEnabled === true
    ? createSchemeAuthSessions({ schemes, api, openBrowser: defaultOpenBrowser, preloadKey })
    : undefined;
  const router = createLaunchRouter({
    schemes,
    api,
    emit,
    ...(options.pickedPaths ? { picked: options.pickedPaths } : {}),
    ...(auth ? { claimAuthCallback: auth.claim } : {}),
  });
  return {
    capabilities: [...router.capabilities, ...(auth ? [auth.capability] : [])],
    install: router.install,
  };
}

/**
 * The bundled `desktop.preload` to inline, or `undefined` without one: the export's copy, or — in
 * live-reload proxy mode only, where the export is not rebuilt — the dev build `denext desktop dev`
 * points {@link DESKTOP_PRELOAD_ENV} at. Read once at startup.
 */
async function loadDesktopPreload(outDir: string, devProxy: boolean): Promise<string | undefined> {
  const devFile = devProxy ? Deno.env.get(DESKTOP_PRELOAD_ENV) : undefined;
  return await readDesktopPreload(devFile || join(outDir, DESKTOP_PRELOAD_FILE));
}

/**
 * Print, once at startup, what is worth knowing about the desktop world: the trust decision's own
 * warning, a refused world, and a runtime older than the denext.9 contract ({@linkcode
 * desktopRuntimeSkewWarning}: no relay URL published in the memory world).
 */
function reportDesktopWorld(decision: DesktopTrustDecision, publishedWsUrl: string | undefined) {
  const { trust, warning } = decision;
  if (warning) console.error(`desktop: ${warning}`);
  if (trust.kind === "refuse") {
    console.error(`desktop: ${trust.reason}; every desktop endpoint is refused.`);
  }
  const skew = desktopRuntimeSkewWarning(trust, publishedWsUrl);
  if (skew) console.error(`desktop: ${skew}`);
}

/** Whether `request` is a browser's top-level navigation (`Sec-Fetch-Mode: navigate`, document). */
function isPageNavigation(request: Request): boolean {
  return request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document";
}

/**
 * Serve a denext SPA export in a `deno desktop` window. Adopts the initial
 * `Deno.BrowserWindow` and quits the process on window close; under a plain
 * `deno run` (no desktop runtime) it just starts the server. Resolves once the server is started,
 * with the window and an event hook ({@linkcode DesktopRuntime}).
 */
// fallow-ignore-next-line complexity -- server bootstrap (starts Deno.serve); not unit-tested, CRAP is coverage-estimated
export async function runDesktop(options: RunDesktopOptions = {}): Promise<DesktopRuntime> {
  const bundledOut = resolveOutDir(options);
  // With the updater on, prefer the verified overlay in the app-support dir (the boot watchdog
  // rolls back a version that failed to boot last launch); without it, serve the bundle as before.
  // Imported lazily so apps that don't use the updater never pull the module in.
  const updaterMod = options.updater ? await import("../desktop/updater.ts") : undefined;
  const outDir = updaterMod
    ? await updaterMod.resolveDesktopUiDir(bundledOut, options.updater!)
    : bundledOut;
  const port = options.port ?? Number(Deno.env.get("PORT") ?? 8000);
  // Live-reload PROXY mode is decided at RUNTIME, never by trusting the env: a packaged app
  // ignores DENEXT_DESKTOP_DEV_URL, and a non-loopback target is refused without the `--lan`
  // opt-in — so an inherited or hostile env cannot turn a shipped window into a proxy to a remote
  // origin (which would then run at this app's loopback origin and read its storage).
  const devDecision = desktopDevProxyDecision(
    Deno.env.get(DESKTOP_DEV_URL_ENV),
    Deno.env.get(DESKTOP_DEV_LAN_ENV) === "1",
    Deno.execPath(),
    isDesktopDevBuild(),
  );
  if (!devDecision.proxy && devDecision.refused) {
    console.error(`desktop: ${devDecision.refused}; serving the static export.`);
  }
  const devUrl = devDecision.proxy ? devDecision.target : undefined;
  // The proxied dev-server HTML gets __denext injected for platform fidelity; the per-launch token
  // is injected ONLY for a loopback (trusted-local) target, never in --lan mode.
  const devInjectToken = devDecision.proxy && !devDecision.allowNonLoopback;
  // Imported lazily so proxy-less apps never pull in the proxy module (and its `npm:ws`).
  const proxy = (options.proxy || devUrl) ? await import("./dev-proxy.ts") : undefined;
  // The window controller (the `window` capability) is created once the bridge exists; the close
  // listener consults it so a page-guarded close keeps the app running.
  const windowRef: { ctl?: WindowController } = {};
  const appWindow = installWindowCloseHandler(
    undefined,
    undefined,
    (event) => windowRef.ctl?.interceptClose(event) ?? false,
  );
  applyDesktopWindowSettings(appWindow, options.window);
  // Which desktop world this is, decided ONCE from what the runtime published: the pinned runtime's
  // in-process memory transport at a stable origin, or the stock runtime's loopback port.
  const trustDecision = resolveDesktopTrust(
    Deno.env.get(DESKTOP_APP_ORIGIN_ENV),
    options.appOrigin,
  );
  const { trust } = trustDecision;
  reportDesktopWorld(trustDecision, Deno.env.get(DESKTOP_WS_URL_ENV));
  // A stray WebSocket/proxy rejection must never take down the server process.
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    console.error("desktop: unhandledrejection", (e as PromiseRejectionEvent).reason);
  });
  // A per-launch token gates the loopback OAuth endpoint and is injected into every served
  // shell so only this app's own pages can drive `startDesktopAuthSession`.
  const token = crypto.randomUUID();
  // A second per-launch secret, handed only to `desktop.preload` (see injectDesktopGlobal): what
  // denext/desktop/clerk installed there proves for its Clerk-only auth-session binding.
  const preloadKey = crypto.randomUUID();
  // The updater's boot watchdog is confirmed by the injected beacon hitting BOOTED_PATH once the
  // page has actually LOADED (proof the UI rendered) — not a timer. A crash before render never
  // beacons, so the trial version stays PENDING and the next launch rolls it back.
  // A full-app update's trial launch is confirmed at the same signal (`desktop.update.autoConfirm`,
  // default on), so an app that never calls `confirmAppUpdate()` does not roll every update back.
  const onBooted = combineBootHooks(
    appUpdateAutoConfirm(options.autoConfirmAppUpdate),
    updaterMod && options.updater ? () => updaterMod.desktopBooted(options.updater!) : undefined,
  );
  // In live-reload mode, forward everything (that is not a local endpoint) to the dev server.
  // `allowNonLoopback` is set because the loopback rule is the CLI's job (and `--lan` may opt in);
  // `proxyToBackend` forwards to the target regardless of prefixes.
  // A LAN dev server's session token rides the dev URL (`?__denext_dev=…`, from `desktop dev
  // --lan`); every proxied request carries it upstream as a header.
  const devTokenHeaders = devUrl ? devProxyTokenHeaders(devUrl) : {};
  const devProxy: DesktopProxyFn | undefined = devUrl && proxy
    ? (req, url) =>
      proxy.proxyToBackend(req, url, {
        target: devUrl,
        prefixes: [],
        allowNonLoopback: devDecision.proxy && devDecision.allowNonLoopback,
      }, devTokenHeaders)
    : undefined;
  // The capability bridge over the compiled allowlist (default deny — no capabilities means every
  // RPC answers `unavailable`), plus the app-event capabilities of denext's pinned runtime (deep
  // links, opened files, custom-scheme auth sessions). `dev` (live-reload mode) lets an unexpected
  // handler error include its message; a packaged build stays generic.
  const emitToPage = (cap: string, event: string, data: unknown) => bridge.emit(cap, event, data);
  const appEvents = desktopAppEvents(options, emitToPage, preloadKey);
  // The page's control over its own window (state, size, displays, chrome, a guarded close, quit,
  // files dragged in and out): registered whenever a window was adopted.
  const windowCtl = appWindow === undefined ? undefined : createWindowController({
    window: appWindow,
    api: desktopAppApi(),
    emit: emitToPage,
    ...(options.pickedPaths ? { picked: options.pickedPaths } : {}),
    ...(options.appDirs ? { dirs: options.appDirs } : {}),
  });
  // The app's own chrome (application menu, tray icons, dock badge / menu): no permission needed,
  // registered with the window.
  const appCtl = appWindow === undefined
    ? undefined
    : createAppController({ window: appWindow, api: desktopAppApi(), emit: emitToPage });
  const bridge = createDesktopBridge(
    [
      ...(options.capabilities ?? []),
      ...appEvents.capabilities,
      ...(windowCtl ? [windowCtl.capability] : []),
      ...(appCtl ? [appCtl.capability] : []),
    ],
    {
      appSupportDir: options.appSupportDir,
      getWindow: () => appWindow,
      dev: devDecision.proxy,
      trust,
    },
  );
  windowRef.ctl = windowCtl;
  appEvents.install();
  windowCtl?.install();
  appCtl?.install();
  const handle = createDesktopHandler(
    options,
    outDir,
    proxy,
    token,
    onBooted,
    devProxy,
    devInjectToken,
    bridge,
    () => Deno.exit(0), // a page-initiated window.close() quits, like the native window close
    trust,
    await loadDesktopPreload(outDir, devDecision.proxy),
    preloadKey,
    // The relay the page's WebSockets dial (Live, `desktopWebSocketUrl`), per-launch token included:
    // published by the pinned runtime next to the app origin.
    resolveDesktopWsUrl(Deno.env.get(DESKTOP_WS_URL_ENV)),
  );
  // Under the pinned runtime `DENO_SERVE_ADDRESS=memory:…` overrides this port/hostname, so the
  // server listens on the in-process memory transport; under the stock runtime it is loopback.
  Deno.serve({
    port,
    hostname: "127.0.0.1",
    onError: (e) => {
      console.error("desktop: handler error", e);
      return new Response("desktop error", { status: 502 });
    },
  }, (req, info) => handle(req, new URL(req.url), info as DesktopServeInfo));
  return { window: appWindow, trust, emit: (cap, event, data) => bridge.emit(cap, event, data) };
}

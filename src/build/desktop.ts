// denext desktop runtime: serve a denext SPA export (`out/`) inside a native
// `deno desktop` window, optionally reverse-proxying a backend (`spa.proxy`). The
// app-level `desktop.ts` that `migrate --desktop` / `create --desktop` generates is
// a thin call to {@link runDesktop} — the serve + proxy + window plumbing lives here
// so a fix reaches every app.
//
// Serving reuses denext's `serveStatic` (content-types, gzip negotiation,
// path-traversal protection) over the export dir (a UI overlay's files verified as they are
// served: `desktop-ui-files.ts`), with an SPA history fallback to
// `index.html` and `no-store` caching so a repackaged app never serves a stale
// bundle from the WebView cache. The proxy is the same mechanism as `denext start`
// in `mode:"spa"` (see {@link matchesProxyPrefix}/{@link proxyToBackend}).

import { basename, fromFileUrl, join } from "@std/path";
import type { SpaProxyConfig } from "../server/config.ts";
import { bundledUiFiles, type DesktopUiFiles, desktopUiFiles } from "./desktop-ui-files.ts";
import { isLoopbackHost } from "./dev-server/lan.ts";
import { DESKTOP_DEV_BUILD_KEY } from "./desktop-dev-build.ts";
import { wantsShell } from "./spa/shared.ts";
import { resolveExportPath } from "./export-paths.ts";
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
import { devProxyTokenHeaders, hasDevSessionToken } from "./dev-server/dev-token.ts";
import { readDesktopAppFile } from "./desktop-dev-file.ts";
import type { DesktopUpdaterConfig } from "../desktop/updater.ts";
import { appUpdateAutoConfirm, combineBootHooks } from "../desktop/app-update-confirm.ts";
import { createDesktopBridge, type DesktopBridge } from "../desktop/bridge.ts";
import { DESKTOP_PRELOAD_ENV, inlineSafeScript, readDesktopPreload } from "../desktop/preload.ts";
import { DESKTOP_NOTIFICATION_SHIM_JS } from "../desktop/notification-shim.ts";
import type { DesktopCapability } from "../desktop/extension.ts";
import { createLaunchRouter, desktopAppApi } from "../desktop/launch-events.ts";
import { createSchemeAuthSessions } from "../desktop/scheme-auth-session.ts";
import type { PickedPaths } from "../desktop/picked-paths.ts";
import type { DesktopAppDirs } from "../desktop/app-dirs.ts";
import type { DesktopAppSettings, DesktopWindowSettings } from "../desktop/window-config.ts";
import {
  type DesktopOpenWindowOptions,
  type DesktopWindowRef,
  type DesktopWindows,
  type DesktopWindowsSetup,
  noDesktopWindows,
  setUpDesktopWindows,
} from "../desktop/app-windows.ts";
import type {
  DesktopTrayHandle,
  DesktopTrayIcon,
  DesktopTrayOptions,
  DesktopTrayPanelHandle,
  DesktopTrayUpdate,
} from "../desktop/backend-tray.ts";
import type { DesktopTraySettings } from "../desktop/tray-config.ts";
import { createSpeechCapability } from "../desktop/caps/speech.ts";
import { mergeSidecars, SIDECAR_CHILD_ENV, type SidecarDefinition } from "../desktop/sidecar.ts";
import type { SidecarHandle } from "../desktop/sidecar-supervisor.ts";
import type { SidecarHost } from "../desktop/sidecar-host.ts";

/** The per-launch picked-path set (re-exported so {@linkcode RunDesktopOptions} is documentable). */
export type { PickedPaths, PickedTarget, PickMode } from "../desktop/picked-paths.ts";
/** The app's own folders (re-exported so {@linkcode RunDesktopOptions} is documentable). */
export type { DesktopAppDirs } from "../desktop/app-dirs.ts";
/** The initial-window settings `runDesktop` applies (`desktop.window`, `desktop.titleBar`, …). */
export type {
  DesktopAppSettings,
  DesktopWindowSettings,
  DesktopWindowSize,
} from "../desktop/window-config.ts";
export type {
  DesktopOpenWindowOptions,
  DesktopTrayHandle,
  DesktopTrayIcon,
  DesktopTrayOptions,
  DesktopTrayPanelHandle,
  DesktopTrayUpdate,
  DesktopWindowRef,
  DesktopWindows,
};
export type { DesktopTrayPanelSettings, DesktopTraySettings } from "../desktop/tray-config.ts";

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

// Sidecars: backends the app runs and supervises next to its window (`desktop.sidecars`,
// `runDesktop({ sidecars })`).
export {
  defineSidecar,
  type SidecarDefinition,
  type SidecarExit,
  type SidecarExposedValue,
  type SidecarInfo,
  type SidecarLoginShellEnv,
  type SidecarLogs,
  type SidecarPermissions,
  type SidecarReady,
  type SidecarRestart,
  type SidecarRun,
  type SidecarShutdown,
  type SidecarState,
  type SidecarStatus,
} from "../desktop/sidecar.ts";
export type { SidecarHandle } from "../desktop/sidecar-supervisor.ts";
export { stopSidecars } from "../desktop/sidecar-registry.ts";

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
  type LaufeyLaunchWriteOptions,
  syncDesktopAppConfig,
  writeLaufeyLaunchConfig,
} from "./desktop-app-config.ts";

// The UI files a handler serves (the bundled export, or a verified UI overlay), for
// `createDesktopHandler`.
export type { DesktopUiFiles } from "./desktop-ui-files.ts";

// The config→capabilities resolver the generated `desktop.ts` entry spreads into `runDesktop`.
export {
  type DesktopRuntimeConfig,
  type ResolvedDesktop,
  resolveDesktopCapabilities,
  type ResolveDesktopOptions,
} from "../desktop/caps/mod.ts";

// The least-privilege packaging flags the scaffolded package scripts bake into `deno desktop`
// (in place of `-A`), derived from the project's `desktop.capabilities`.
export {
  DESKTOP_BASELINE_FLAGS,
  type DesktopBuildFlagOptions,
  desktopBuildFlags,
  desktopIncludeArgs,
  desktopNpmArgs,
  type DesktopOs,
  desktopPackageFlags,
} from "./desktop-capabilities.ts";

// `desktop.denoFlags` (an allow-list of resolution / type-check flags) for the package scripts.
export { desktopDenoFlagArgs } from "./desktop-deno-flags.ts";

// denext's pinned Deno Desktop runtime (downloaded + SHA-256-verified into the Deno cache): the
// `DENORT_DESKTOP_BIN` / `LAUFEY_DEV_DIR` env the scaffolded package scripts set on `deno desktop`,
// and the flags a build on it gets (`--unstable-no-legacy-abort` before runtime 3.0.0-rc.5).
export { desktopRuntimeDenoFlags, desktopRuntimeEnv } from "./desktop-runtime.ts";

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
  desktopAppVersion,
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
  cefHelperEntitlements,
  type DesktopMacosSigning,
  desktopMacosSigning,
  type DesktopMacosSigningOptions,
  macosSigningEntitlements,
  type MacosSigningEntitlementsOptions,
  V8_ENTITLEMENTS,
} from "./desktop-macos-signing.ts";
// The code-signing argv and credentials the package scripts and `denext build --compile --sign`
// share.
export {
  macosCodesignArgs,
  type MacosCodesignOptions,
  type NotaryCredentials,
  notarytoolSubmitArgs,
  type SigntoolCertificateDeps,
  type StoreCommandResult,
  type StoreCommandRunner,
  type StoreCommandRunnerSync,
} from "./code-signing.ts";
// The scaffolded package scripts' shared command line, tool probe and run setup.
export {
  buildDesktopBundle,
  desktopAppName,
  type DesktopBundleOptions,
  desktopExportEnv,
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
  desktopWindowsTargetNote,
  desktopWithAppVersion,
  parseDesktopPackageArgs,
  type PreparedDesktopPackage,
  prepareDesktopPackage,
} from "./desktop-package-script.ts";
// scripts/package-windows.ts: the app-local VC++ runtime, only the DLLs the target arch imports,
// each checked to be the target's machine type.
export {
  bundleDesktopVcRuntime,
  DESKTOP_VC_RUNTIME_DLLS,
  desktopPeMachine,
  desktopVcRedistUrl,
  type DesktopVcRuntimeDeps,
  type DesktopWindowsArch,
} from "./desktop-vc-runtime.ts";

// A CEF app signed with a certificate Windows does not trust dies at launch (CEF's bootstrap runs
// WinVerifyTrust on itself): the Windows package script checks the signed executable.
export {
  desktopCheckCefSignature,
  type PowerShellRunner,
  type WindowsTrustDeps,
} from "./desktop-windows-trust.ts";

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
  | {
    readonly proxy: true;
    readonly target: string;
    readonly allowNonLoopback: boolean;
    /**
     * Whether the per-launch desktop token rides the proxied top-level page (so its bridge and
     * `secureStore` work): always for a loopback target; for a `--lan` target only when its URL
     * carries the dev server's per-run session token (`?__denext_dev=…`), i.e. a gated server.
     */
    readonly injectToken: boolean;
  };

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
 *   is true only in that LAN case, and `injectToken` there requires the dev server's per-run
 *   session token on the URL (`desktop dev --lan` puts it there), so the window's page gets its
 *   bridge only from a dev server that gates its other peers.
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
  if (isLoopbackHost(host)) {
    return { proxy: true, target: devUrl, allowNonLoopback: false, injectToken: true };
  }
  if (lan) {
    return {
      proxy: true,
      target: devUrl,
      allowNonLoopback: true,
      injectToken: hasDevSessionToken(devUrl),
    };
  }
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
 * is injected only when `injectToken` (a loopback target, or a token-gated --lan one). Compressed or
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
  const injected = await injectDesktopScripts(
    await res.text(),
    injectToken ? token : null,
    injectToken,
    injectToken ? preload : undefined,
    preloadKey,
    page ?? {},
  );
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  // The dev server's CSP travels as a header: allow the injected scripts there too, or a strict
  // `script-src` blocks the desktop global (no `__denext`, no token, no bridge).
  const csp = headers.get("content-security-policy");
  if (csp) {
    headers.set("content-security-policy", addScriptHashesToCspHeader(csp, injected.hashes));
  }
  return new Response(injected.html, { status: res.status, statusText: res.statusText, headers });
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
   * Backend reverse-proxy config. The generated `desktop.ts` spreads
   * `resolveDesktopCapabilities(config)`, which carries `spa.proxy` from
   * `.deno-desktop/config.json` (the config's runtime slice, compiled into the entry, since
   * the packaged app has no config file at runtime). Omit for no proxy.
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
   * {@link openDesktopUi} — the verified overlay in the app-support dir if one is active
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
   * `desktop.app`'s launch settings (from {@link resolveDesktopCapabilities}): `keepAlive` (the
   * app stays up with no window; default on with a tray) and `dock` (`false`: no macOS Dock icon).
   */
  app?: DesktopAppSettings;
  /** `desktop.tray` from the config (from {@link resolveDesktopCapabilities}); {@link tray} is laid over it. */
  configTray?: DesktopTraySettings;
  /**
   * The tray icon the backend owns: created before the first page needs it, kept across page
   * reloads, reachable from every window (`getTray()` in `denext/desktop/app`) and from
   * {@linkcode DesktopRuntime.tray}. Its keys replace `desktop.tray`'s; the handlers run in the
   * backend, before the pages hear of a click. Setting a tray keeps the app alive with no window
   * unless `desktop.app.keepAlive` is `false`.
   */
  tray?: DesktopTrayOptions;
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
  /**
   * Backends the app runs and supervises next to its window ({@linkcode defineSidecar}): a module in
   * a worker of the app's own runtime, or a program. Laid over {@link configSidecars} by name (a
   * field set here replaces the config's), so `probe`, `bootstrap` and `secrets` can be functions.
   * They start once the window's server is up; {@linkcode DesktopRuntime.sidecar} controls one.
   */
  sidecars?: readonly SidecarDefinition[];
  /**
   * `desktop.sidecars` from the config (from {@link resolveDesktopCapabilities}); {@link sidecars}
   * is laid over it.
   */
  configSidecars?: readonly SidecarDefinition[];
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
  /**
   * The app's windows: open one on a page of the app (`windows.open({ url: "/settings" })`), find
   * one by id, list them. Pages open and drive them with `openWindow` in `denext/desktop/window`.
   */
  readonly windows: DesktopWindows;
  /**
   * The backend tray (`desktop.tray` / `runDesktop({ tray })`), or `undefined` when the app has none
   * or the session has no tray host (the window was shown instead).
   */
  readonly tray?: DesktopTrayHandle;
  /**
   * Show or hide the app's macOS Dock icon (the activation policy; on Windows and Linux the main
   * window's taskbar entry, where the runtime can). Returns whether it applied.
   */
  setDockVisible(visible: boolean): boolean;
  /**
   * Set the macOS activation policy: `"regular"` (a Dock icon and a menu bar), `"accessory"`
   * (neither: a tray app) or `"prohibited"` (runtime `3.0.0-denext.6`+; on an older runtime
   * `"regular"` / `"accessory"` show / hide the Dock icon). Switching to regular also brings the
   * app to the front. On Windows and Linux `"regular"` shows the main window's taskbar entry and
   * the others hide it (as `"accessory"` does at launch), where the runtime can. Returns whether it
   * applied.
   */
  setActivationPolicy(policy: "regular" | "accessory" | "prohibited"): boolean;
  /** The macOS activation policy, or `null` where there is none (Windows, Linux, older runtimes). */
  getActivationPolicy(): "regular" | "accessory" | "prohibited" | null;
  /** The desktop world the gates enforce. */
  readonly trust: DesktopTrust;
  /**
   * Push an event to the page (`cap` need not be a registered capability's). Events are retained
   * for replay, so one emitted before the page subscribes is still delivered.
   */
  emit(cap: string, event: string, data: unknown): void;
  /**
   * The handle of one sidecar (`desktop.sidecars` / `runDesktop({ sidecars })`): its `status`,
   * `onStatus`, `restart` and `stop`. Throws for a name the app does not declare.
   */
  sidecar(name: string): SidecarHandle;
  /**
   * Set when this launch is a child a module sidecar started (`denextSidecar.spawnSelf` /
   * `childCommand`): the sidecar's name. `runDesktop` then ran that sidecar's module headless
   * instead of serving a window, and resolved once it was loaded with no window, no server and no
   * sidecars; the process ends when the module's work is done. Code after `runDesktop` in the entry
   * runs in the child too, so guard it with this.
   */
  readonly sidecarChild?: string;
}

/**
 * The HTML of the exported page a GET/HEAD navigation to `pathname` names (the shared
 * {@linkcode resolveExportPath} candidates, the mapping the Capacitor shells' routers mirror), or
 * `null` when the export has none (the caller then serves the root `index.html` shell, so a
 * single-page app's client routes keep working). Read through the UI's files: the bundled export
 * through `serveStatic` (its path-traversal and symlink checks), a UI overlay verified.
 */
async function readExportPage(files: DesktopUiFiles, pathname: string): Promise<string | null> {
  for (const candidate of resolveExportPath(pathname).pages) {
    const text = await files.text(candidate);
    if (text !== null) return text;
  }
  return null;
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
 * Override `window.close()` so a page-initiated close closes its window. The WebView does not
 * forward `window.close()` to the native window, so it would otherwise be a no-op; this POSTs the
 * per-launch token (and the window's own token, when the runtime gave it one) to {@link QUIT_PATH}
 * (fire-and-forget), which closes that window — and quits the app once its last window is gone,
 * unless it is kept alive. Token-gated so only the real top-level page (which receives the token)
 * can trigger it; a subframe / cross-origin page cannot.
 */
const QUIT_OVERRIDE_JS = ";(function(){var c=window.close;window.close=function(){try{" +
  'var h={"x-denext-desktop-token":globalThis.__denext.token},' +
  "b=globalThis.bindings&&globalThis.bindings.__denextWindow;" +
  'Promise.resolve(b?b():null)["catch"](function(){return null}).then(function(w){' +
  'if(typeof w==="string"&&w)h["x-denext-desktop-window"]=w;' +
  'return fetch("/_denext/desktop/quit",{method:"POST",headers:h})})["catch"](function(){})' +
  "}catch(e){}try{return c.call(window)}catch(e){}}})()";

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
  /**
   * The runtime gave the app's windows a window binding (`__denextWindow`): the page's bridge
   * client asks it for its window's token. Only with the desktop token.
   */
  readonly windows?: boolean;
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
    ...(page.windows ? { windows: true } : {}),
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
  return (await injectDesktopScripts(html, token, beacon, preload, preloadKey, page)).html;
}

/**
 * {@linkcode injectDesktopGlobal}, also returning the injected scripts' CSP hashes
 * (`'sha256-…'`), for a caller that must allow them in a `Content-Security-Policy` header too.
 */
async function injectDesktopScripts(
  html: string,
  token: string | null,
  beacon: boolean,
  preload: string | undefined,
  preloadKey: string | undefined,
  page: DesktopPageGlobals,
): Promise<{ html: string; hashes: string[] }> {
  const scripts = desktopInlineScripts(token, beacon, preload, preloadKey, page);
  const out = insertAfterHeadOrBody(
    html,
    scripts.map((code) => `<script>${code}</script>`).join(""),
  );
  const hashes = await Promise.all(
    scripts.map(async (code) => `'sha256-${await sha256Base64(code)}'`),
  );
  return { html: addScriptHashToCspMeta(out, hashes), hashes };
}

/** The inline scripts {@linkcode injectDesktopScripts} injects, in order. */
function desktopInlineScripts(
  token: string | null,
  beacon: boolean,
  preload: string | undefined,
  preloadKey: string | undefined,
  page: DesktopPageGlobals,
): string[] {
  // A null token marks the window desktop WITHOUT handing it the per-launch token (a subframe, or
  // a --lan live-reload target whose dev server is not token-gated): runtimePlatform() reads
  // "desktop", but the token-gated endpoints stay unreachable, and the boot beacon (which needs
  // the token) is not injected.
  const body = `globalThis.__denext=${JSON.stringify(desktopGlobals(token, page))}` +
    (token !== null ? QUIT_OVERRIDE_JS : "") +
    (token !== null && page.notifications === true ? NOTIFICATION_SHIM_INLINE : "") +
    (token !== null && beacon ? BOOT_BEACON_JS : "");
  const withPreload = token !== null && preload !== undefined;
  if (!withPreload) return [body];
  if (preloadKey === undefined) return [body, preload];
  return [
    body,
    // The element removes itself as it runs: its text would otherwise sit in `document.scripts`
    // for any page script to read the key back out of.
    `globalThis.${PRELOAD_KEY_GLOBAL}=${JSON.stringify(preloadKey)};${REMOVE_CURRENT_SCRIPT}`,
    preload,
    `delete globalThis.${PRELOAD_KEY_GLOBAL}`,
  ];
}

/** `tag` right after the opening `<head>`, else after `<body>`, else prepended. */
function insertAfterHeadOrBody(html: string, tag: string): string {
  const match = html.match(/<head\b[^>]*>/i) ?? html.match(/<body\b[^>]*>/i);
  if (!match) return tag + html;
  const at = match.index! + match[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

/**
 * A `Content-Security-Policy` HEADER value with `hashes` allowed for scripts: added to its
 * `script-src`, or — with none — to a `script-src` copied from `default-src`, which governs scripts
 * then. A policy with neither restricts no scripts and is returned as is. The proxied dev server
 * sends its strict policy as a header (no `'unsafe-inline'`), which would otherwise block the
 * injected desktop global.
 */
function addScriptHashesToCspHeader(policy: string, hashes: readonly string[]): string {
  const missing = hashes.filter((hash) => !policy.includes(hash));
  if (missing.length === 0) return policy;
  const add = (values: string) => `${values.trimEnd()} ${missing.join(" ")}`;
  const scriptSrc = /((?:^|;)\s*script-src)((?=[\s;]|$)[^;]*)/i;
  if (scriptSrc.test(policy)) {
    return policy.replace(scriptSrc, (_d, name: string, values: string) => name + add(values));
  }
  const fallback = /(?:^|;)\s*default-src((?=[\s;]|$)[^;]*)/i.exec(policy);
  if (!fallback) return policy;
  return `${policy.trimEnd().replace(/;$/, "")}; script-src${add(fallback[1])}`;
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
 * Adopt the window the app started with, and act on its `close` (macOS red light / Cmd-W): by
 * default that ends the process (`Deno.serve` is a permanently-live task, so deno desktop won't
 * auto-exit on close); `runDesktop` passes an `exit` that quits only once the app's last window is
 * gone and the app is not kept alive. Guarded so a non-desktop run is a no-op. Returns the adopted
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
  onQuit?: (windowToken: string | null) => void,
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
    // The page called `window.close()` (see QUIT_OVERRIDE_JS): close its window, as native close
    // (the app quits after its last window). queueMicrotask lets the 204 flush first.
    const reject = requireTokenedPost(request, token, access);
    if (reject) return reject;
    const windowToken = request.headers.get("x-denext-desktop-window");
    queueMicrotask(() => onQuit?.(windowToken));
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
 * (`Sec-Fetch-Dest`, `document` when absent), so a subframe that declares itself gets the desktop
 * global without the token. Absent stays `document` on purpose: engines send no `Sec-Fetch-*` to a
 * scheme they don't treat as secure (WKWebView has no API to register one; the Fetch spec sends
 * them only to potentially trustworthy URLs), so failing closed would strip the token from the
 * page itself there. Where it is absent, a same-origin frame cannot be told from the page; the
 * per-world rules below still refuse a request that names another origin. Then, per world: loopback — a LOOPBACK `Host`, so a DNS-rebinding Host gets no token;
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
  outDir: string | DesktopUiFiles,
  proxy: ProxyModule | undefined,
  token: string = crypto.randomUUID(),
  onBooted?: () => void | Promise<void>,
  devProxy?: DesktopProxyFn,
  devInjectToken = false,
  bridge?: DesktopBridge,
  onQuit?: (windowToken: string | null) => void,
  trust: DesktopTrust = LOOPBACK_TRUST,
  preload?: string,
  preloadKey?: string,
  wsUrl?: string,
  windowBindings = false,
): (request: Request, url: URL, info?: DesktopServeInfo) => Promise<Response> {
  // `desktop.preload` runs only in the memory world (the pinned runtime at its stable origin), and
  // only where the token goes (a top-level document over the memory transport): never into an
  // iframe, and never into a loopback-world page.
  const memoryPreload = trust.kind === "memory" ? preload : undefined;
  const page = {
    ...desktopPageGlobals(options, trust, wsUrl),
    ...(windowBindings ? { windows: true } : {}),
  };
  const files = typeof outDir === "string" ? bundledUiFiles(outDir) : outDir;
  const serveShell = desktopShellServer({
    files,
    token,
    beacon: onBooted !== undefined,
    memoryPreload,
    preloadKey,
    page,
  });
  const serveBackendOrExport = backendOrExportServer(options.proxy, proxy, files, serveShell);

  const serveLocal = localDesktopStage({ options, token, onBooted, bridge, onQuit, trust });
  const serveDev = devProxy
    ? devProxyServer(devProxy, token, devInjectToken, memoryPreload, preloadKey, page)
    : undefined;

  return async (request, url, info) => {
    const local = await serveLocal(request, url, info);
    if (local) return local;
    // The per-launch token is injected only into a TOP-LEVEL document (Sec-Fetch-Dest, default
    // document when absent) served over the memory transport (the pinned runtime) or to a LOOPBACK
    // Host (the stock runtime) — so a subframe AND a DNS-rebinding Host each get the desktop global
    // without the token, and cannot reach the bridge.
    const injectToken = shouldInjectDesktopToken(request, url, trust, info);
    // A top-level NAVIGATION (a reload or a new page) ends the previous page: release what it
    // held through the bridge (keep-awake holds…). Only a real browser navigation counts.
    // With several windows the navigation is not attributed here: each page's first bridge request
    // says which window reloaded.
    if (bridge && injectToken && request.method === "GET" && isPageNavigation(request)) {
      await bridge.navigationStarted();
    }
    // Live-reload mode (`denext desktop dev` only): reverse-proxy EVERYTHING else to `denext dev`.
    if (serveDev) return await serveDev(request, url, injectToken);
    return await serveBackendOrExport(request, url, injectToken);
  };
}

/**
 * The requests a desktop window's server always answers locally, ahead of any proxy: a refused
 * cross-origin endpoint or foreign WebSocket, the `onRequest` escape hatch, the token-gated
 * local endpoints and the capability bridge. `null` hands the request on.
 */
function localDesktopStage(ctx: {
  options: RunDesktopOptions;
  token: string;
  onBooted: (() => void | Promise<void>) | undefined;
  bridge: DesktopBridge | undefined;
  onQuit: ((windowToken: string | null) => void) | undefined;
  trust: DesktopTrust;
}): (request: Request, url: URL, info?: DesktopServeInfo) => Promise<Response | null> {
  // Unpacked once: the per-request path reads closure locals, as it did inline.
  const { options, token, onBooted, bridge, onQuit, trust } = ctx;
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
    return null;
  };
}

/**
 * Live-reload mode (`denext desktop dev` only): reverse-proxy EVERYTHING else to `denext dev`,
 * with the per-launch desktop token stripped so it never reaches the dev server. The token is
 * injected into a buffered HTML navigation only when the dev target allows it (`devInjectToken`:
 * loopback, or a token-gated --lan server) and the request is a top-level document the window's
 * trust world admits ({@linkcode shouldInjectDesktopToken}).
 */
function devProxyServer(
  devProxy: DesktopProxyFn,
  token: string,
  devInjectToken: boolean,
  memoryPreload: string | undefined,
  preloadKey: string | undefined,
  page: DesktopPageGlobals,
): (request: Request, url: URL, injectToken: boolean) => Promise<Response> {
  return (request, url, injectToken) =>
    devProxyResponse(
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

/** Serves an exported page (`pageHtml`, else the export's `index.html` shell) to a desktop window. */
type DesktopShellServer = (
  isHead: boolean,
  injectToken: boolean,
  pageHtml?: string,
) => Promise<Response | null>;

/**
 * What the page reads from `__denext` besides the token: the relay its WebSockets dial (only in
 * the memory world, the one place the page runs at a custom origin), and the web `Notification`
 * shim when the `notifications` capability is on (the pinned runtime's OS notifications).
 */
function desktopPageGlobals(
  options: RunDesktopOptions,
  trust: DesktopTrust,
  wsUrl: string | undefined,
): DesktopPageGlobals {
  const memory = trust.kind === "memory";
  return {
    ...(memory && wsUrl ? { wsUrl } : {}),
    ...(memory && options.capabilities?.some((c) => c.name === "notifications")
      ? { notifications: true }
      : {}),
  };
}

/** Serve an exported page (`html`, else the export's `index.html` shell) with the desktop
 * global (and, with the updater on, the boot-confirm beacon) injected. `injectToken` gates the
 * per-launch TOKEN: a subframe or a DNS-rebinding `Host` still learns it is desktop
 * (runtimePlatform()) but gets NO token, so it cannot reach the bridge. */
function desktopShellServer(ctx: {
  files: DesktopUiFiles;
  token: string;
  /** Inject the boot-confirm beacon (the updater is on). */
  beacon: boolean;
  memoryPreload: string | undefined;
  preloadKey: string | undefined;
  page: DesktopPageGlobals;
}): DesktopShellServer {
  return async (isHead, injectToken, pageHtml) => {
    const html = pageHtml ?? await ctx.files.text("/index.html");
    if (html === null) return null;
    const injected = await injectDesktopGlobal(
      html,
      injectToken ? ctx.token : null,
      ctx.beacon,
      injectToken ? ctx.memoryPreload : undefined,
      ctx.preloadKey,
      ctx.page,
    );
    return noStore(
      new Response(isHead ? null : injected, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  };
}

/** An exported page for a GET / HEAD of its path, with the desktop global injected; else `null`. */
async function serveExportPage(
  request: Request,
  url: URL,
  files: DesktopUiFiles,
  serveShell: DesktopShellServer,
  injectToken: boolean,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const pageHtml = await readExportPage(files, url.pathname);
  if (pageHtml === null) return null;
  return await serveShell(request.method === "HEAD", injectToken, pageHtml);
}

/** The backend proxy (when configured + matched), then the static export, its `index.html` shell
 * for navigations, else 404. Split out so the top-level handler stays simple. */
function backendOrExportServer(
  proxyCfg: RunDesktopOptions["proxy"],
  proxy: ProxyModule | undefined,
  files: DesktopUiFiles,
  serveShell: DesktopShellServer,
): (request: Request, url: URL, injectToken: boolean) => Promise<Response> {
  return async (request, url, injectToken) => {
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }
    // An exported page (`/route` → `route/index.html` or `route.html`, `/x.html`, `/`): served
    // with the desktop global injected (read uncompressed, so the injection is not fighting
    // content-encoding on the static response). Without this every path got the ROOT shell, so
    // a multi-page export's `<a href="/protected">` reloaded the home page.
    const page = await serveExportPage(request, url, files, serveShell, injectToken);
    if (page) return page;
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const asset = await files.asset(url.pathname, accEnc, request);
    if (asset) return noStore(asset);
    if (wantsShell(request, url.pathname)) {
      const shell = await serveShell(request.method === "HEAD", injectToken);
      if (shell) return shell;
    }
    return new Response("not found", { status: 404 });
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
 * The bundled `desktop.preload` to inline, or `undefined` without one: the UI's copy (a UI
 * overlay's only when its signed manifest lists it, verified), or — in live-reload proxy mode only,
 * where the export is not rebuilt — the dev build `denext desktop dev` points
 * {@link DESKTOP_PRELOAD_ENV} at. Read once at startup.
 */
async function loadDesktopPreload(
  files: DesktopUiFiles,
  devProxy: boolean,
): Promise<string | undefined> {
  const devFile = devProxy ? Deno.env.get(DESKTOP_PRELOAD_ENV) : undefined;
  return devFile ? await readDesktopPreload(devFile) : await files.preload();
}

/**
 * Print, once at startup, what is worth knowing about the desktop world: the trust decision's own
 * warning, a refused world, and a runtime older than the one denext requires ({@linkcode
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

/**
 * The URL a window loads for an app path (`/settings`): under the app origin in the memory world
 * (the pinned runtime), else at the loopback address the server listens on.
 *
 * @param trust The desktop world.
 * @param addr The server's address (`Deno.serve`'s `addr`).
 * @returns The resolver.
 */
export function desktopAppUrl(trust: DesktopTrust, addr: unknown): (path: string) => string {
  const a = addr as { hostname?: unknown; port?: unknown } | null | undefined;
  const base = trust.kind === "memory"
    ? trust.origin
    : `http://127.0.0.1:${typeof a?.port === "number" ? a.port : 8000}`;
  return (path) => new URL(path, base).href;
}

/** A file of the export by its path (`/tray.png`), or `null` when the export has none. */
async function readExportFile(files: DesktopUiFiles, path: string): Promise<Uint8Array | null> {
  const pathname = new URL(path, "http://export.invalid").pathname;
  const res = await files.asset(
    pathname,
    undefined,
    new Request(`http://export.invalid${pathname}`),
  );
  if (res?.status !== 200) {
    await res?.body?.cancel();
    return null;
  }
  return new Uint8Array(await res.arrayBuffer());
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
  // A child a module sidecar started of the app runs that sidecar's module, nothing else.
  const child = await runAsSidecarChild(options);
  if (child) return child;
  const bundledOut = resolveOutDir(options);
  // With the updater on, prefer the verified overlay in the app-support dir (the boot watchdog
  // rolls back a version that failed to boot last launch); without it, serve the bundle as before.
  // Imported lazily so apps that don't use the updater never pull the module in.
  // The overlay's files are verified as they are served, never read straight from its folder.
  const updaterMod = options.updater ? await import("../desktop/updater.ts") : undefined;
  const uiFiles = updaterMod
    ? desktopUiFiles(await updaterMod.openDesktopUi(bundledOut, options.updater!))
    : bundledUiFiles(bundledOut);
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
  // goes with it for a loopback target, and for a --lan target whose dev server is token-gated.
  const devInjectToken = devDecision.proxy && devDecision.injectToken;
  // Imported lazily so proxy-less apps never pull in the proxy module (and its `npm:ws`).
  const proxy = (options.proxy || devUrl) ? await import("./dev-proxy.ts") : undefined;
  // The app's windows (the registry over the adopted window, the `window` / `windows` / `app`
  // capabilities, keepAlive and the Dock): set up once the window is adopted; the close listener
  // consults it so a page-guarded close keeps the app running, and a close quits only after the
  // app's last window unless it is kept alive.
  const windowsRef: { setup?: DesktopWindowsSetup } = {};
  const exit = Deno.exit;
  const appWindow = installWindowCloseHandler(
    undefined,
    () => windowsRef.setup ? windowsRef.setup.mainClosed() : exit(0),
    (event) => windowsRef.setup?.interceptMainClose(event) ?? false,
  );
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
  // Events can fire before the bridge exists (a window registered first): they are dropped then.
  const bridgeRef: { bridge?: DesktopBridge } = {};
  const emitToPage = (cap: string, event: string, data: unknown, target?: string) =>
    bridgeRef.bridge?.emit(cap, event, data, target);
  const appEvents = desktopAppEvents(options, emitToPage, preloadKey);
  // The sidecars (`desktop.sidecars` + `runDesktop({ sidecars })`): ports and secrets are settled
  // now, so `spa.proxy` can point at the proxied one; they start once the server is up.
  const sidecarHost = await createSidecars(options, emitToPage);
  const backendProxy = sidecarProxy(options, proxy, sidecarHost);
  // Each page's control over its own window (state, size, displays, chrome, a guarded close, quit,
  // files dragged in and out, overlay settings), the `windows` capability that opens more, and the
  // app's own chrome (application menu, tray icons, dock): registered whenever a window was adopted.
  const windows = setUpDesktopWindows({
    window: appWindow,
    BrowserWindow: (Deno as unknown as { BrowserWindow?: unknown }).BrowserWindow,
    api: desktopAppApi(),
    emit: emitToPage,
    ...(options.window ? { windowSettings: options.window } : {}),
    ...(options.app ? { appSettings: options.app } : {}),
    wantsTray: options.tray !== undefined || options.configTray !== undefined,
    exit,
    ...(options.pickedPaths ? { picked: options.pickedPaths } : {}),
    ...(options.appDirs ? { dirs: options.appDirs } : {}),
  });
  windowsRef.setup = windows;
  const registry = windows.registry;
  const bridge = createDesktopBridge(
    [
      ...(options.capabilities ?? []),
      ...appEvents.capabilities,
      ...windows.capabilities,
      ...(appWindow !== undefined ? [createSpeechCapability(desktopAppApi)] : []),
      ...(sidecarHost ? [sidecarHost.capability] : []),
    ],
    {
      appSupportDir: options.appSupportDir,
      getWindow: (id) => registry?.get(id)?.window ?? appWindow,
      ...(registry
        ? {
          resolveWindow: (t: string) => registry.resolveToken(t),
          allowed: (id: string, cap: string) => registry.allowed(id, cap),
          windowCount: () => registry.count(),
        }
        : {}),
      dev: devDecision.proxy,
      trust,
    },
  );
  bridgeRef.bridge = bridge;
  appEvents.install();
  windows.install();
  const handle = createDesktopHandler(
    backendProxy.options,
    uiFiles,
    backendProxy.proxy,
    token,
    onBooted,
    devProxy,
    devInjectToken,
    bridge,
    // A page-initiated window.close() closes its window, like the native close.
    (windowToken) => windows.closeFromPage(windowToken),
    trust,
    await loadDesktopPreload(uiFiles, devDecision.proxy),
    preloadKey,
    // The relay the page's WebSockets dial (Live, `desktopWebSocketUrl`), per-launch token included:
    // published by the pinned runtime next to the app origin.
    resolveDesktopWsUrl(Deno.env.get(DESKTOP_WS_URL_ENV)),
    registry?.bound() === true,
  );
  // Under the pinned runtime `DENO_SERVE_ADDRESS=memory:…` overrides this port/hostname, so the
  // server listens on the in-process memory transport; under the stock runtime it is loopback.
  const server = Deno.serve({
    port,
    hostname: "127.0.0.1",
    onError: (e) => {
      console.error("desktop: handler error", e);
      return new Response("desktop error", { status: 502 });
    },
  }, (req, info) => handle(req, new URL(req.url), info as DesktopServeInfo));
  // The URL a new window (or the tray panel) loads for an app path: the app origin, or the
  // loopback address the server listens on.
  windows.setAppUrl(desktopAppUrl(trust, server.addr));
  const tray = await windows.startTray({
    ...(options.tray ? { options: options.tray } : {}),
    ...(options.configTray ? { settings: options.configTray } : {}),
    appUrl: desktopAppUrl(trust, server.addr),
    // `denext desktop dev` builds no export: a file missing there comes from the dev server.
    readFile: (path) =>
      readDesktopAppFile(
        (p) => readExportFile(uiFiles, p),
        path,
        devUrl ? { url: devUrl, headers: devTokenHeaders } : undefined,
      ),
  });
  startSidecars(sidecarHost);
  return {
    window: appWindow,
    windows: windows.windows,
    ...(tray ? { tray } : {}),
    setDockVisible: (visible) => windows.setDockVisible(visible),
    setActivationPolicy: (policy) => windows.setActivationPolicy(policy),
    getActivationPolicy: () => windows.getActivationPolicy(),
    trust,
    emit: (cap, event, data) => bridge.emit(cap, event, data),
    sidecar: (name) => {
      if (!sidecarHost) throw new Error(`desktop: no sidecar named "${name}" (none declared)`);
      return sidecarHost.handle(name);
    },
  };
}

/**
 * When this launch is a child of one of the app's module sidecars ({@linkcode SIDECAR_CHILD_ENV},
 * see `src/desktop/sidecar-child.ts`), run that sidecar's module and return the child's inert
 * runtime; otherwise `undefined` (and the sidecar-child module is never loaded).
 */
async function runAsSidecarChild(options: RunDesktopOptions): Promise<DesktopRuntime | undefined> {
  let marked = false;
  try {
    marked = Deno.env.get(SIDECAR_CHILD_ENV) !== undefined;
  } catch { /* no --allow-env: not a child */ }
  if (!marked) return undefined;
  const { readSidecarChildLaunch, runSidecarChild } = await import("../desktop/sidecar-child.ts");
  const launch = readSidecarChildLaunch(
    options.importMetaUrl,
    mergeSidecars(options.configSidecars, options.sidecars),
  );
  if (!launch) return undefined;
  if (!options.importMetaUrl) throw new Error("desktop: a sidecar's child needs importMetaUrl");
  await runSidecarChild(launch, {
    importMetaUrl: options.importMetaUrl,
    ...(options.appDirs?.cache ? { cacheDir: options.appDirs.cache } : {}),
  });
  return {
    window: undefined,
    ...noDesktopWindows(),
    trust: resolveDesktopTrust(undefined, options.appOrigin).trust,
    emit: () => {},
    sidecar: (name) => {
      throw new Error(`desktop: no sidecar named "${name}" (a sidecar's child runs none)`);
    },
    sidecarChild: launch.name,
  };
}

/** The app's sidecar host, or `undefined` when it declares none (the module is then never loaded). */
async function createSidecars(
  options: RunDesktopOptions,
  emit: (cap: string, event: string, data: unknown) => void,
): Promise<SidecarHost | undefined> {
  const sidecars = mergeSidecars(options.configSidecars, options.sidecars);
  if (sidecars.length === 0) return undefined;
  const { createSidecarHost } = await import("../desktop/sidecar-host.ts");
  const dataDir = options.appDirs?.data ?? options.appSupportDir;
  return await createSidecarHost({
    sidecars,
    ...(options.importMetaUrl ? { importMetaUrl: options.importMetaUrl } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(options.appDirs?.cache ? { cacheDir: options.appDirs.cache } : {}),
    emit,
  });
}

/**
 * The backend proxy as the handler serves it: with a `proxy: true` sidecar, `spa.proxy` forwards to
 * the sidecar's port, and a request waits (up to the sidecar's ready timeout) while it starts or
 * restarts, then answers 503 if it is not ready. Without one, `options` and `proxy` as given.
 */
function sidecarProxy(
  options: RunDesktopOptions,
  proxy: ProxyModule | undefined,
  host: SidecarHost | undefined,
): { options: RunDesktopOptions; proxy: ProxyModule | undefined } {
  const proxied = host?.proxied;
  if (!proxied || !host) return { options, proxy };
  if (!options.proxy || !proxy) {
    throw new Error(
      `desktop: sidecar "${proxied.name}" sets proxy: true, which needs spa.proxy (its prefixes)`,
    );
  }
  const sidecar = host.handle(proxied.name);
  const gated = {
    ...proxy,
    proxyToBackend: async (...args: Parameters<ProxyModule["proxyToBackend"]>) => {
      const status = await sidecar.whenReady();
      if (status.state !== "ready") {
        return new Response(`sidecar ${proxied.name} is ${status.state}`, {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }
      // The sidecar's current port: a new one when another process took the first.
      const [request, url, cfg, ...rest] = args;
      const target = `http://127.0.0.1:${sidecar.info.port ?? proxied.port}`;
      return await proxy.proxyToBackend(request, url, { ...cfg, target }, ...rest);
    },
  } as ProxyModule;
  return {
    options: {
      ...options,
      proxy: { ...options.proxy, target: `http://127.0.0.1:${proxied.port}` },
    },
    proxy: gated,
  };
}

/**
 * Start the sidecars, once the window's server took the runtime's page transport: under denext's
 * pinned runtime `DENO_SERVE_ADDRESS` (an in-process `memory:` address) is honoured by the FIRST
 * server of each isolate, so a worker's own `node:http` / `Deno.serve` would try to take it again
 * (`AddrInUse`). The window's server has consumed it by now, so it is cleared for everyone after.
 */
function startSidecars(host: SidecarHost | undefined): void {
  if (!host) return;
  try {
    Deno.env.delete("DENO_SERVE_ADDRESS");
  } catch { /* no --allow-env: nothing to clear */ }
  host.startAll();
}

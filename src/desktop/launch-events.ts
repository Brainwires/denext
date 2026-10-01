/**
 * Deep links and opened files on Deno Desktop, runtime side: what `Deno.desktop` (denext's pinned
 * runtime) hands the app — `launchUrls` / `launchFiles` at a cold start, `openurl` / `openfile`
 * while it runs (macOS), and `secondinstance` (a later launch forwarded by the single-instance
 * lock, Windows and Linux) — routed to the page.
 *
 * Delivery is a PULL, so every link is seen once: the runtime queues each accepted link and pushes
 * a payload-free `available` signal down the bridge's event stream; the page then takes the queue
 * with an RPC (`deepLinks.take` / `openFiles.take`), which empties it. A link that arrives before
 * the page subscribes (a cold start) waits in the queue for the first subscriber; one taken is
 * never replayed — not to a second subscriber, not after a reload — and the URLs (which may carry
 * an OAuth callback's code) never enter the event stream's replay buffer.
 *
 * Every link is offered first to a pending custom-scheme auth session ({@link
 * ./scheme-auth-session.ts}): its callback is consumed there and never reaches the page's routes.
 * A link is accepted only with a scheme declared in `desktop.app.deepLinks` (the runtime filters
 * launch arguments already; `openurl` is filtered again here).
 *
 * An opened file is untrusted input — any program of the same user can open any path with the app
 * — so the page never gets authority from its path: it gets a READ-ONLY picked handle
 * ({@link PickedPaths}), the same scoping model a file dialog uses.
 *
 * Focus: on a forwarded launch the webview backend raises the app window itself before
 * `secondinstance` fires (laufey's single-instance activate hook), so nothing here focuses again.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { basename } from "@std/path";
import { type DesktopCapability, DesktopCapError } from "./extension.ts";
import { PickedPaths } from "./picked-paths.ts";

/** Who handles a deep-link scheme, as `Deno.desktop.getSchemeOwner` reports it. */
export interface SchemeOwnerInfo {
  /** `self` (this app), `other` (another app), `none` (no app). */
  readonly owner: "self" | "other" | "none";
  /** The handler's identity, for display only (any same-user program can write it). */
  readonly handler?: string;
}

/** What `Deno.desktop.registerScheme` reports. */
export interface RegisterSchemeResult extends SchemeOwnerInfo {
  /** Whether this app handles the scheme after the call. */
  readonly registered: boolean;
  /** Why it does not, when it doesn't. */
  readonly reason?: string;
}

/**
 * The slice of `Deno.desktop` (denext's pinned Deno Desktop runtime) the app events use. Every
 * member is optional: the stock runtime has no `Deno.desktop`, and an older pinned runtime lacks
 * scheme registration and passkeys — each is feature-detected where it is used.
 */
export interface DesktopAppApi {
  /** The deep links the app was launched with (taken on first read). */
  readonly launchUrls?: readonly string[];
  /** The files the app was launched with (taken on first read). */
  readonly launchFiles?: readonly string[];
  /** `openurl` / `openfile` / `secondinstance`. */
  addEventListener?(type: string, listener: (event: Event) => void): void;
  /** Who handles one of the app's declared schemes. */
  getSchemeOwner?(scheme: string): Promise<SchemeOwnerInfo>;
  /** Register the app as a declared scheme's handler (`force` only on an explicit user action). */
  registerScheme?(scheme: string, options?: { force?: boolean }): Promise<RegisterSchemeResult>;
  /** Native passkeys (`@clerk/electron-passkeys` wire format). */
  readonly passkeys?: {
    capabilities(): Promise<{ platformAuthenticator?: boolean; securityKeys?: boolean }>;
    create(optionsJson: string, options?: { window?: unknown }): Promise<string>;
    get(optionsJson: string, options?: { window?: unknown }): Promise<string>;
  };
}

/** `Deno.desktop` when the runtime has it (denext's pinned runtime), else `undefined`. */
export function desktopAppApi(): DesktopAppApi | undefined {
  const api = (Deno as unknown as { desktop?: unknown }).desktop;
  return typeof api === "object" && api !== null ? api as DesktopAppApi : undefined;
}

/** One queued deep link, as the page takes it. */
interface QueuedDeepLink {
  /** The URL as the OS delivered it (a declared scheme). */
  readonly url: string;
  /** `true` for a link that cold-started the app. */
  readonly launch: boolean;
}

/** One queued opened file, as the page takes it. */
interface QueuedOpenedFile {
  /** A read-only picked handle (`{ directory: { picked: handle } }` with the `fs` capability). */
  readonly handle: string;
  /** The file name. */
  readonly name: string;
  /** The absolute path, for display only (it grants nothing). */
  readonly path: string;
  /** `true` for a file the app was launched with. */
  readonly launch: boolean;
}

/** The longest URL accepted (bytes of a reasonable deep link; longer ones are dropped). */
const MAX_URL_CHARS = 8 * 1024;
/** How many untaken links / files are kept (oldest dropped past it). */
const MAX_QUEUED = 64;

/** Options for {@linkcode createLaunchRouter}. */
export interface LaunchRouterOptions {
  /** The declared deep-link schemes (`desktop.app.deepLinks`), lower-case, no `:`. */
  readonly schemes: readonly string[];
  /** The per-launch picked-path set shared with `fs` / `shell` (opened files land here). */
  readonly picked?: PickedPaths;
  /** Push an event to the page's stream (the bridge's `emit`). */
  readonly emit: (cap: string, event: string, data: unknown) => void;
  /**
   * Offered every accepted link FIRST: `true` when a pending auth session consumed it (it is then
   * not queued for the page).
   */
  readonly claimAuthCallback?: (url: string) => boolean;
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
  /** Resolve a path to a real, existing file (default `Deno.realPath` + `Deno.stat`). */
  readonly resolveFile?: (path: string) => Promise<string | undefined>;
}

/** What {@linkcode createLaunchRouter} returns. */
export interface LaunchRouter {
  /** The bridge capabilities `deepLinks` (take / owner / claim) and `openFiles` (take). */
  readonly capabilities: DesktopCapability[];
  /** Subscribe to the runtime's events and queue the cold-start links and files (once). */
  install(): void;
  /** Route one URL (the event handlers' path; exported for tests). */
  acceptUrl(url: unknown, launch: boolean): void;
  /** Route one opened file (exported for tests). */
  acceptFile(path: unknown, launch: boolean): Promise<void>;
}

/** The lower-case scheme of `url` when it parses, else `undefined`. */
function schemeOf(url: string): string | undefined {
  try {
    return new URL(url).protocol.slice(0, -1).toLowerCase();
  } catch {
    return undefined;
  }
}

/** The default file resolver: the real path of an existing regular file, else `undefined`. */
async function realFile(path: string): Promise<string | undefined> {
  try {
    const real = await Deno.realPath(path);
    return (await Deno.stat(real)).isFile ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Push onto a bounded queue (drop oldest). */
function enqueue<T>(queue: T[], item: T): void {
  queue.push(item);
  if (queue.length > MAX_QUEUED) queue.shift();
}

/** A declared scheme from an RPC argument, or a `validation` error. */
function declaredScheme(schemes: readonly string[], args: unknown): string {
  const raw = (args as { scheme?: unknown } | null)?.scheme;
  const scheme = typeof raw === "string" ? raw.toLowerCase().replace(/:$/, "") : "";
  if (!schemes.includes(scheme)) {
    throw new DesktopCapError(
      "scheme_not_declared",
      `"${String(raw)}" is not declared in desktop.app.deepLinks`,
    );
  }
  return scheme;
}

/** The runtime's scheme API, or an `unsupported` error naming what is missing. */
function schemeApi<K extends "getSchemeOwner" | "registerScheme">(
  api: DesktopAppApi | undefined,
  member: K,
): NonNullable<DesktopAppApi[K]> {
  const fn = api?.[member];
  if (typeof fn !== "function") {
    throw new DesktopCapError(
      "unsupported",
      `this Deno Desktop runtime has no Deno.desktop.${member} (denext's pinned runtime adds it)`,
      { status: 501 },
    );
  }
  return fn.bind(api) as NonNullable<DesktopAppApi[K]>;
}

/** The detail of a runtime event (`CustomEvent.detail`), or `{}`. */
function detailOf(event: Event): Record<string, unknown> {
  const detail = (event as CustomEvent).detail;
  return typeof detail === "object" && detail !== null ? detail as Record<string, unknown> : {};
}

/** The strings in `value` when it is an array (anything else is no items). */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Create the launch router: the `deepLinks` and `openFiles` bridge capabilities plus the runtime
 * subscriptions that feed them (see the module docs for the delivery model).
 *
 * @param options The declared schemes, the shared picked-path set, the event emitter and the auth
 * session's claim hook.
 * @returns The router.
 */
export function createLaunchRouter(options: LaunchRouterOptions): LaunchRouter {
  const schemes = options.schemes.map((s) => s.toLowerCase());
  const picked = options.picked ?? new PickedPaths();
  const resolveFile = options.resolveFile ?? realFile;
  const api = options.api ?? desktopAppApi();
  const links: QueuedDeepLink[] = [];
  const files: QueuedOpenedFile[] = [];
  let installed = false;

  const acceptUrl = (url: unknown, launch: boolean): void => {
    if (typeof url !== "string" || url === "" || url.length > MAX_URL_CHARS) return;
    const scheme = schemeOf(url);
    if (scheme === undefined || !schemes.includes(scheme)) return;
    if (options.claimAuthCallback?.(url) === true) return;
    enqueue(links, { url, launch });
    options.emit("deepLinks", "available", null);
  };

  const acceptFile = async (path: unknown, launch: boolean): Promise<void> => {
    if (typeof path !== "string" || path === "") return;
    const real = await resolveFile(path);
    if (real === undefined) return;
    const handle = picked.add(real, "read");
    enqueue(files, { handle, name: basename(real), path: real, launch });
    options.emit("openFiles", "available", null);
  };

  const take = <T>(queue: T[]) => () => queue.splice(0, queue.length);

  const deepLinks: DesktopCapability = {
    name: "deepLinks",
    methods: {
      take: { handler: take(links) },
      owner: {
        handler: async (args) => {
          const scheme = declaredScheme(schemes, args);
          const info = await schemeApi(api, "getSchemeOwner")(scheme);
          return { owner: info.owner, ...(info.handler ? { handler: info.handler } : {}) };
        },
      },
      claim: {
        // The user confirmed it in the app's UI (the page's job): take the scheme over.
        handler: async (args) => {
          const scheme = declaredScheme(schemes, args);
          const r = await schemeApi(api, "registerScheme")(scheme, { force: true });
          return {
            registered: r.registered === true,
            owner: r.owner,
            ...(r.handler ? { handler: r.handler } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
          };
        },
      },
    },
    events: ["available"],
  };
  const openFiles: DesktopCapability = {
    name: "openFiles",
    methods: { take: { handler: take(files) } },
    events: ["available"],
  };

  return {
    capabilities: [deepLinks, openFiles],
    acceptUrl,
    acceptFile,
    install: () => {
      if (installed || !api) return;
      installed = true;
      // Cold start first (taken on first read), then the live events: a link delivered after the
      // read arrives as an event, so each is seen once.
      for (const url of strings(api.launchUrls)) acceptUrl(url, true);
      for (const path of strings(api.launchFiles)) void acceptFile(path, true);
      if (typeof api.addEventListener !== "function") return;
      api.addEventListener("openurl", (e) => acceptUrl(detailOf(e).url, false));
      api.addEventListener("openfile", (e) => void acceptFile(detailOf(e).path, false));
      api.addEventListener("secondinstance", (e) => {
        const detail = detailOf(e);
        for (const url of strings(detail.urls)) acceptUrl(url, false);
        for (const path of strings(detail.files)) void acceptFile(path, false);
      });
    },
  };
}

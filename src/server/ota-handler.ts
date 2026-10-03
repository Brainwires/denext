// A web-standard request handler that serves an over-the-air UI export to the native
// `DenextOta` plugin: `_denext/ota.json` plus exactly the files it lists, with
// `Cache-Control: no-store`. Auth stays the app's job: wrap the handler with the same check
// the app's API uses. Node servers implement the same three rules in their own route.

import { contentType } from "@std/media-types";
import { dirname, extname, join, resolve, SEPARATOR } from "@std/path";
import {
  isOtaManifest,
  isOtaManifestPath,
  OTA_MANIFEST_PATH,
  type OtaManifest,
} from "../mobile/ota-manifest.ts";
import {
  inOtaRollout,
  OTA_CHANNEL_HEADER,
  OTA_CHANNEL_NAME,
  OTA_INSTALL_ID_HEADER,
  type OtaChannelsFile,
  otaChannelsProblem,
} from "./ota-rollout.ts";

/** Options for {@linkcode createOtaHandler}. */
export interface OtaHandlerOptions {
  /**
   * The export directory holding `_denext/ota.json` (e.g. `"out"`). Give exactly one of `dir`
   * and `channels`.
   */
  dir?: string;
  /**
   * Serve per-channel releases with staged rollouts instead of one `dir`: the path of a channels
   * file (`ota-channels.json`, re-read when its mtime changes, release paths relative to it;
   * `denext ota channel` / `denext ota promote` write it), or the {@linkcode OtaChannelsFile}
   * itself (release paths relative to the working directory).
   *
   * A request follows the channel its `x-denext-ota-channel` header names (absent: the file's
   * `default`; an unknown or malformed name is not served — it never falls back to another
   * channel). A channel's `rollout` candidate goes to the share of devices whose
   * `x-denext-ota-install-id` falls in the rollout bucket (`otaRolloutBucket`); a request without
   * a valid install id always gets the stable `release`. The manifest and every file of one
   * request come from the same release, and each release's manifest is served unchanged, so its
   * signature is verified on the device exactly as with `dir`. The client sends both headers
   * with `checkForUiUpdate({ channel })` (denext/mobile), on the manifest request and on every
   * native file download.
   */
  channels?: string | OtaChannelsFile;
  /**
   * The URL path the UI is served under, e.g. `"/mobile-ui"` (the client's `baseUrl` is
   * then `https://host/mobile-ui`). Default `""`: the origin root.
   */
  basePath?: string;
  /**
   * Answer CORS for the web app's manifest request (`checkForUiUpdate` / `prepareUiUpdate`
   * fetch `_denext/ota.json` from the webview's origin, and an `Authorization` header makes that
   * a preflighted request). `true` allows the Capacitor webview origins `capacitor://localhost`
   * (iOS), `https://localhost` and `http://localhost` (Android); a string or list allows exactly
   * those origins. An allowed `OPTIONS` preflight is answered `204` with
   * `Access-Control-Allow-Headers: authorization`, and `GET`/`HEAD` responses carry
   * `Access-Control-Allow-Origin` for an allowed `Origin`. Default: no CORS headers, and
   * `OPTIONS` is not answered. A preflight carries no credentials, so route `OPTIONS` to the
   * handler before your auth check. Native file downloads are not subject to CORS.
   */
  cors?: true | string | readonly string[];
}

/** The webview origins `cors: true` allows. */
const CAPACITOR_ORIGINS: readonly string[] = [
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
];

/**
 * How long after its mtime a file's cached contents are trusted on the mtime alone. A file
 * rewritten within the mtime's granularity of the moment it was read (a millisecond here, a second
 * or two on FAT / some network filesystems) keeps the same mtime, so a cache keyed on the mtime
 * would serve the old contents forever ("racy git"). Until the read is this much later than the
 * mtime, the file is read again on every request.
 */
const RACY_WINDOW_MS = 2_000;

/** Whether contents read at `readAt` from a file with `mtime` can be reused while it keeps it. */
function settled(mtime: number, readAt: number, current: number): boolean {
  return mtime === current && readAt - mtime > RACY_WINDOW_MS;
}

/** The parsed manifest, re-read when the file's mtime changes. */
interface Cached {
  mtime: number;
  readAt: number;
  manifest: OtaManifest;
  paths: Set<string>;
}

/** One export directory whose `_denext/ota.json` is (re)loaded on demand. */
interface Release {
  readonly dir: string;
  load(): Promise<Cached | null>;
}

/** A release loader for `dir`: the manifest is re-read when its mtime changes. */
function releaseAt(dir: string): Release {
  const manifestFile = join(dir, ...OTA_MANIFEST_PATH.split("/"));
  let cached: Cached | null = null;
  return {
    dir,
    async load() {
      let mtime: number;
      try {
        mtime = (await Deno.stat(manifestFile)).mtime?.getTime() ?? 0;
      } catch {
        return cached = null;
      }
      if (cached && settled(cached.mtime, cached.readAt, mtime)) return cached;
      const readAt = Date.now();
      try {
        const manifest: unknown = JSON.parse(await Deno.readTextFile(manifestFile));
        if (!isOtaManifest(manifest)) return cached = null;
        const paths = new Set(manifest.files.map((f) => f.path));
        return cached = { mtime, readAt, manifest, paths };
      } catch {
        return cached = null;
      }
    },
  };
}

/** The release one request is served from, with its loaded manifest. */
interface Served {
  readonly release: Release;
  readonly current: Cached;
}

/**
 * Resolves the release for a request: `dir` mode always the one release; channel mode per the
 * channels file (re-read on mtime change when given as a path).
 */
function releaseResolver(options: OtaHandlerOptions): (request: Request) => Promise<Served | null> {
  const hasDir = typeof options.dir === "string";
  const hasChannels = options.channels !== undefined;
  if (hasDir === hasChannels) {
    throw new TypeError("createOtaHandler: pass exactly one of `dir` and `channels`");
  }
  if (hasDir) {
    const release = releaseAt(options.dir!);
    return async () => {
      const current = await release.load();
      return current ? { release, current } : null;
    };
  }
  const releases = new Map<string, Release>();
  const releaseFor = (base: string, path: string) => {
    const dir = resolve(base, path);
    let release = releases.get(dir);
    if (!release) releases.set(dir, release = releaseAt(dir));
    return release;
  };
  const channels = options.channels!;
  let fileCache: { mtime: number; readAt: number; doc: OtaChannelsFile | null } | null = null;
  const loadChannels = async (): Promise<{ doc: OtaChannelsFile; base: string } | null> => {
    if (typeof channels !== "string") {
      return otaChannelsProblem(channels) === null ? { doc: channels, base: Deno.cwd() } : null;
    }
    let mtime: number;
    try {
      mtime = (await Deno.stat(channels)).mtime?.getTime() ?? 0;
    } catch {
      return null;
    }
    if (!fileCache || !settled(fileCache.mtime, fileCache.readAt, mtime)) {
      const readAt = Date.now();
      let doc: OtaChannelsFile | null = null;
      try {
        const parsed: unknown = JSON.parse(await Deno.readTextFile(channels));
        if (otaChannelsProblem(parsed) === null) doc = parsed as OtaChannelsFile;
      } catch {
        doc = null;
      }
      fileCache = { mtime, readAt, doc };
    }
    return fileCache.doc ? { doc: fileCache.doc, base: dirname(resolve(channels)) } : null;
  };
  return async (request) => {
    const loaded = await loadChannels();
    if (!loaded) return null;
    const { doc, base } = loaded;
    const name = request.headers.get(OTA_CHANNEL_HEADER) ?? doc.default;
    if (!OTA_CHANNEL_NAME.test(name) || !Object.hasOwn(doc.channels, name)) return null;
    const channel = doc.channels[name];
    const stable = releaseFor(base, channel.release);
    if (channel.rollout) {
      const candidate = releaseFor(base, channel.rollout.release);
      const next = await candidate.load();
      const installId = request.headers.get(OTA_INSTALL_ID_HEADER);
      if (
        next &&
        await inOtaRollout(name, next.manifest.version, installId, channel.rollout.percent)
      ) {
        return { release: candidate, current: next };
      }
    }
    const current = await stable.load();
    return current ? { release: stable, current } : null;
  };
}

/** A path segment list that stays inside the directory (no control characters either). */
function safeSegments(path: string): string[] | null {
  if (!isOtaManifestPath(path) || path.includes("\\")) return null;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? segments : null;
}

/** The set of origins `cors` allows (empty: CORS off). */
function allowedOrigins(cors: OtaHandlerOptions["cors"]): ReadonlySet<string> {
  if (cors === true) return new Set(CAPACITOR_ORIGINS);
  if (typeof cors === "string") return new Set([cors]);
  return new Set(cors ?? []);
}

/** The CORS headers for `request`'s `Origin` when it is allowed, else none. */
function corsHeaders(request: Request, origins: ReadonlySet<string>): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origins.size === 0) return {};
  if (origin === null || !origins.has(origin)) return { vary: "Origin" };
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/** `headers` with the channel headers added to its `vary` (channel mode only). */
function withChannelVary(headers: Record<string, string>): Record<string, string> {
  const channelVary = `${OTA_CHANNEL_HEADER}, ${OTA_INSTALL_ID_HEADER}`;
  return { ...headers, vary: headers.vary ? `${headers.vary}, ${channelVary}` : channelVary };
}

/** The `204` answer to an allowed preflight. */
function preflight(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers":
        `authorization, ${OTA_CHANNEL_HEADER}, ${OTA_INSTALL_ID_HEADER}`,
      "access-control-max-age": "600",
    },
  });
}

/**
 * Build a handler that serves an OTA UI export to `checkForUiUpdate` / the native
 * `DenextOta` plugin, following the serving rules every OTA server must keep:
 *
 * 1. serve `_denext/ota.json` and ONLY the files it lists (anything else resolves `null`,
 *    so a request can never reach a file the manifest does not name);
 * 2. put it behind the same auth as the app's API (wrap the handler; it does no auth);
 * 3. send `Cache-Control: no-store`, so no cache serves a stale manifest or file.
 *
 * Only `GET`/`HEAD` are answered (plus an `OPTIONS` preflight from an origin `cors` allows).
 * The manifest is re-read when its mtime changes, so a re-stamp (`denext ota manifest`, which
 * replaces the file atomically) needs no restart. Re-exporting in place is not atomic (a phone
 * could fetch a new manifest and old files, which then fail their hash check): export into a
 * new directory and point the handler at it, e.g. through a symlink you swap.
 *
 * With `channels` instead of `dir`, each request is served from the release its channel (and,
 * during a staged rollout, its install id's bucket) selects; the rules above hold per release.
 *
 * @param options The export directory (or the channels file), the path it is served under, and
 *   CORS.
 * @throws TypeError when neither or both of `dir` and `channels` are given.
 * @returns `(request) => Response | null`: `null` for a request that is not for the UI.
 * @example
 * ```ts
 * import { createOtaHandler } from "denext/server";
 *
 * const ota = createOtaHandler({ dir: "out", basePath: "/mobile-ui", cors: true });
 * Deno.serve(async (req) => {
 *   if (new URL(req.url).pathname.startsWith("/mobile-ui/")) {
 *     // A CORS preflight carries no credentials: answer it before the auth check.
 *     if (req.method === "OPTIONS") return (await ota(req)) ?? new Response(null, { status: 404 });
 *     if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });
 *     return (await ota(req)) ?? new Response("Not Found", { status: 404 });
 *   }
 *   return app(req);
 * });
 * ```
 */
export function createOtaHandler(
  options: OtaHandlerOptions,
): (request: Request) => Promise<Response | null> {
  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const resolveRelease = releaseResolver(options);
  const channelMode = options.channels !== undefined;

  const origins = allowedOrigins(options.cors);

  const noStore = (type: string, length: number, cors: Record<string, string>) =>
    new Headers({
      ...cors,
      "content-type": type,
      "content-length": String(length),
      "cache-control": "no-store",
    });

  /** The request's path relative to `base`, or null when it is not under it. */
  function relativePath(request: Request): string | null {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(`${base}/`)) return null;
    try {
      return decodeURIComponent(pathname.slice(base.length + 1));
    } catch {
      return null;
    }
  }

  /** The bytes of the listed file `rel`, or null when it is not listed or leaves the export. */
  async function readListed({ release, current }: Served, rel: string) {
    const segments = current.paths.has(rel) ? safeSegments(rel) : null;
    if (!segments) return null;
    try {
      // The real path must stay inside the export: a listed file later swapped for a
      // symlink (or a symlinked parent) cannot reach anything outside it.
      const real = await Deno.realPath(join(release.dir, ...segments));
      if (!real.startsWith((await Deno.realPath(release.dir)) + SEPARATOR)) return null;
      return await Deno.readFile(real);
    } catch {
      return null;
    }
  }

  return async (request) => {
    const rel = relativePath(request);
    if (rel === null) return null;
    const allowed = corsHeaders(request, origins);
    if (request.method === "OPTIONS") {
      return "access-control-allow-origin" in allowed ? preflight(allowed) : null;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const cors = channelMode ? withChannelVary(allowed) : allowed;
    const served = await resolveRelease(request);
    if (!served) return null;
    const head = request.method === "HEAD";
    if (rel === OTA_MANIFEST_PATH) {
      const body = new TextEncoder().encode(JSON.stringify(served.current.manifest));
      const headers = noStore("application/json; charset=utf-8", body.byteLength, cors);
      return new Response(head ? null : body, { headers });
    }
    const bytes = await readListed(served, rel);
    if (!bytes) return null;
    const type = contentType(extname(rel)) ?? "application/octet-stream";
    return new Response(head ? null : bytes as Uint8Array<ArrayBuffer>, {
      headers: noStore(type, bytes.byteLength, cors),
    });
  };
}

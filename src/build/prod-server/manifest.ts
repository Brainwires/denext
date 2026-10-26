// Production server, stage 1: the build manifest, the Flight boundary, and the
// complete-build check.

import { join } from "@std/path";
import type { ModuleLoader } from "../../server/types.ts";
import { timed } from "../../runtime/timing.ts";
import { boundaryRefLoader, compatModuleMapFromManifest } from "../next-compat-loader.ts";
import { setSelfHostedFonts } from "../../compat/next/font/registry.ts";
import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import { tagClientModules } from "../../runtime/client-reference.ts";
import { setUnreferencedActionsPermissive, tagServerModules } from "../../runtime/server-action.ts";
import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";
import {
  type BoundaryManifest,
  deserializeBoundary,
  type SerializedBoundary,
} from "../boundary-manifest.ts";
import { type ProjectPaths, routeId } from "../paths.ts";
import { parseServerCopies, type ServerCopiesManifest } from "../server-copies.ts";
import { setBuildServerActionsKey } from "../../server/action-bound.ts";
import {
  ACTION_ID_SECRET_ENV,
  actionIdSecretDigest,
  actionIdSecretEnvValue,
  setBuildActionIdSecret,
  setLegacyActionIds,
} from "../../server/action-ids.ts";
import { registerHealthCheck } from "../../server/health.ts";

/** What `denext start` reads from `manifest.json` (absent/old fields fall back). */
export interface BuildInfo {
  /**
   * Routes the build determined are static (no client JS): they have no bundle on disk
   * by design, get no hydration <script>, and are skipped by the missing-bundle check.
   */
  staticRoutes: Set<string>;
  /**
   * next-compat: the build rewrote route modules to denext's single React; the
   * source→server-bundle map redirects the SSR loader. The Flight boundary is preserved
   * in compat too (Stage 4b).
   */
  nextCompat: boolean;
  compatModuleMap: Map<string, string>;
  /** Public-env vars to embed: build-detected ∪ config allowlist. Undefined ⇒ ship all. */
  publicEnvKeys: string[] | undefined;
  /** The build's Flight boundary (routes + module manifest), when the manifest recorded it. */
  boundary?: { routes: Set<string>; manifest: BoundaryManifest };
  /** The build's id (keys its cached pages); absent for a build that predates it. */
  buildId?: string;
  /** The id came from `DENEXT_BUILD_ID` (deliberate and shared by replicas), not at random. */
  buildIdPinned?: boolean;
  /** The server render's redirects and copies the build made (absent for an older build). */
  serverCopies?: ServerCopiesManifest | null;
}

/** Install the build's bound-action key; a malformed one is reported, never fatal here. */
function installBuildKey(key: string): void {
  try {
    setBuildServerActionsKey(key);
  } catch (err) {
    console.error("denext:", (err as Error).message);
  }
}

/**
 * The server can't serve the build's Server Action ids: the build minted them under a
 * `DENEXT_ACTION_ID_SECRET` the server doesn't have (unset, or another value), so every action
 * the client bundle posts would be unknown. `denext start` fails with it.
 */
export class ActionIdSecretError extends Error {
  override name = "ActionIdSecretError";
}

/** Unregisters the `action-ids` readiness check once it is down (`null` while healthy). */
let actionIdsDown: (() => void) | null = null;

/**
 * Take the instance out of rotation: `/_denext/health` reports `action-ids: "down"` (503) from
 * now on, so a deploy whose action-id secret disagrees with its build fails its probe instead of
 * answering `ok` while the operator's setting is wrong.
 */
function markActionIdSecretMismatch(): void {
  actionIdsDown ??= registerHealthCheck("action-ids", () => false);
}

/** Bring the `action-ids` readiness check back up (tests). */
export function resetActionIdHealthForTesting(): void {
  actionIdsDown?.();
  actionIdsDown = null;
  warnedIgnoredEnvSecret = false;
}

/** Whether the ignored-variable warning was printed (once per process). */
let warnedIgnoredEnvSecret = false;

/** What the build manifest says about the action-id secret. */
interface ActionIdSecretRecord {
  actionIdSecret?: unknown;
  actionIdSecretEnv?: unknown;
  actionIdSecretDigest?: unknown;
}

/**
 * Install the secret the build minted its Server Action ids under — the one the client bundle
 * carries ids for, so it is authoritative over the environment's:
 * - the recorded one (the build generated it): a `DENEXT_ACTION_ID_SECRET` set here that differs
 *   is ignored, with one warning per process, since it was not there when the ids were minted.
 *   The server answers every action correctly then, so the instance stays healthy;
 * - the environment's, when the build used it: it must be set here to the same value — unset, or
 *   another value (told apart by the recorded fingerprint), is an {@link ActionIdSecretError} and
 *   the start fails, never a server answering every action with "unknown";
 * - or, for a build from before salted ids, the legacy ids its client bundle carries.
 */
function installActionIdSecret(bm: ActionIdSecretRecord): void {
  if (typeof bm.actionIdSecret === "string" && bm.actionIdSecret) {
    installRecordedSecret(bm.actionIdSecret);
  } else if (bm.actionIdSecretEnv === true) {
    installEnvSecret(typeof bm.actionIdSecretDigest === "string" ? bm.actionIdSecretDigest : null);
  } else {
    setLegacyActionIds(true);
  }
}

/** The build generated `secret`: it is used, and a differing environment value is ignored. */
function installRecordedSecret(secret: string): void {
  setBuildActionIdSecret(secret);
  const env = actionIdSecretEnvValue();
  if (!env || env === secret || warnedIgnoredEnvSecret) return;
  warnedIgnoredEnvSecret = true;
  console.warn(
    `denext: ${ACTION_ID_SECRET_ENV} is set, but this build generated its own Server Action ` +
      "id secret (the variable was not set when `denext build` ran), so the build's is used " +
      "and the variable ignored (Server Actions work). To share one secret across builds and " +
      "instances, set it where `denext build` runs too.",
  );
}

/**
 * The build used the environment's secret (`digest` its fingerprint, when recorded): the server
 * must have the same value.
 */
function installEnvSecret(digest: string | null): void {
  setBuildActionIdSecret(null);
  const env = actionIdSecretEnvValue();
  if (env && (digest === null || actionIdSecretDigest(env) === digest)) return;
  markActionIdSecretMismatch();
  throw new ActionIdSecretError(
    `denext: this build minted its Server Action ids under ${ACTION_ID_SECRET_ENV}, which ` +
      `is ${env ? "set to another value" : "not set"} here, so every action the client ` +
      "bundle posts would be unknown. Set the variable to the value `denext build` ran " +
      "with (it must be the same for every build and every instance of this app), or " +
      "rebuild with the value set here.",
  );
}

/**
 * Read the build manifest; a missing/invalid one means "nothing static, no compat".
 *
 * @throws {ActionIdSecretError} When the build minted its action ids under a
 *   `DENEXT_ACTION_ID_SECRET` this server doesn't have (see {@link installActionIdSecret}).
 */
export async function readBuildInfo(paths: ProjectPaths): Promise<BuildInfo> {
  const info: BuildInfo = {
    staticRoutes: new Set(),
    nextCompat: false,
    compatModuleMap: new Map(),
    publicEnvKeys: undefined,
  };
  try {
    const bm = JSON.parse(await Deno.readTextFile(join(paths.outDir, "manifest.json")));
    if (Array.isArray(bm.staticRoutes)) info.staticRoutes = new Set<string>(bm.staticRoutes);
    if (Array.isArray(bm.publicEnvKeys)) {
      info.publicEnvKeys = [...new Set([...bm.publicEnvKeys, ...(paths.config?.publicEnv ?? [])])];
    }
    // Install build-self-hosted Google fonts so renderFontStyles emits local CSS.
    if (bm.fonts && typeof bm.fonts === "object") setSelfHostedFonts(bm.fonts);
    // The key this build seals bound Server Action values under (unless the env sets one).
    if (typeof bm.serverActionsKey === "string") installBuildKey(bm.serverActionsKey);
    installActionIdSecret(bm);
    info.nextCompat = bm.nextCompat === true;
    if (typeof bm.buildId === "string" && bm.buildId) info.buildId = bm.buildId;
    info.buildIdPinned = bm.buildIdPinned === true;
    info.serverCopies = parseServerCopies(bm.serverCopies);
    if (bm.boundary && typeof bm.boundary === "object" && Array.isArray(bm.boundaryRoutes)) {
      info.boundary = {
        routes: new Set<string>(bm.boundaryRoutes),
        manifest: deserializeBoundary(bm.boundary as SerializedBoundary, paths.projectDir),
      };
    }
    if (bm.compatServerModules && typeof bm.compatServerModules === "object") {
      info.compatModuleMap = compatModuleMapFromManifest(
        paths.projectDir,
        paths.outDir,
        bm.compatServerModules as Record<string, string>,
      );
    }
  } catch (error) {
    // A server that can't serve the build's action ids must not start; anything else (no or an
    // invalid build manifest) means "nothing static, no compat".
    if (error instanceof ActionIdSecretError) throw error;
  }
  return info;
}

/**
 * What the production server compiles at startup when the build did not record it — an older
 * build, or one whose server copies import a moved project by absolute path. `denext start`
 * passes ./startup-compile.ts; a compiled app (`denext build --compile`) passes none, so its
 * binary embeds neither the import-graph crawler nor the compiler: its build always records them.
 */
export interface StartupCompile {
  /** The routes that reach a client island (the build's `boundaryRoutes`). */
  boundaryRoutes(appDir: string, pages: PageRoute[]): Promise<Set<string>>;
  /** The app's client/server boundary (the build's `boundary`). */
  boundaryManifest(appDir: string, pages: PageRoute[]): Promise<BoundaryManifest>;
  /** The server render's loader over copies compiled now (the build's `serverCopies`). */
  loader(paths: ProjectPaths, base: ModuleLoader): Promise<ModuleLoader>;
}

/**
 * `compile`, or the error a server without a startup compiler (a compiled app) throws for a
 * build that did not record `what`.
 *
 * @param compile The startup compiler, if any.
 * @param what What the build's `manifest.json` lacks.
 * @returns The startup compiler.
 */
export function requireStartupCompile(
  compile: StartupCompile | undefined,
  what: string,
): StartupCompile {
  if (compile) return compile;
  throw new Error(
    `The build in this app records no ${what}: it was made by an older denext, or for a project ` +
      "at another path. Rebuild it with this version (`denext build --compile`).",
  );
}

/** A boundary with no islands and no actions. */
const EMPTY_BOUNDARY = (): BoundaryManifest => ({ client: new Map(), server: new Map() });

/** The Flight boundary computed once at startup. */
export interface FlightBoundary {
  /** Routes that reach a client island. */
  flightRoutes: Set<string>;
  boundary: BoundaryManifest;
}

/**
 * Which routes reach a client island, and the client modules to tag — via the
 * import-graph crawl. The boundary manifest is built unconditionally (not only when a
 * client island exists) so its "use server" modules are discovered even for pure
 * progressive-enhancement pages — routes with a `<form action={serverActionFn}>` but no
 * client island, which are never "flight" routes yet still must render a working action
 * URL. Every discovered "use server" module is registered up front so its exports
 * serialize as action references and dispatch on ANY route.
 *
 * The refs are tagged through the render's own loader (`load`, from `prodLoader`), so the tagged
 * island and action instances are the ones the render imports: a module the render loads as a
 * copy (one that reaches a platform variant or a `"use cache"` module) is tagged and registered
 * as that copy, and an action then runs the variant its copy imports. In next-compat mode that
 * loader redirects each boundary ref to its module in the react→denext server bundle — the
 * instance the page bundles reference, NOT the raw npm-React source.
 *
 * @param paths The project paths.
 * @param manifest The scanned routes.
 * @param info The build manifest.
 * @param load The server render's module loader.
 * @param compile The startup compiler for a build that recorded no boundary (none in a compiled
 *   app).
 */
export async function resolveFlightBoundary(
  paths: ProjectPaths,
  manifest: RouteManifest,
  info: BuildInfo,
  load: ModuleLoader,
  compile?: StartupCompile,
): Promise<FlightBoundary> {
  // The build already crawled the import graph; reuse its answer when the manifest has it
  // (a large app's crawl is 30 s of startup), else compute it (no/old build manifest). With no
  // pages (a Pages Router app's empty `app/`) there is nothing to crawl.
  const recorded = info.boundary ??
    (manifest.pages.length === 0
      ? { routes: new Set<string>(), manifest: EMPTY_BOUNDARY() }
      : null);
  const pages = manifest.pages;
  const flightRoutes = recorded?.routes ?? await timed(
    "computeBoundaryRoutes",
    () => requireStartupCompile(compile, "client boundary").boundaryRoutes(paths.appDir, pages),
  );
  const boundary = recorded?.manifest ?? await timed(
    "appBoundaryManifest",
    () => requireStartupCompile(compile, "client boundary").boundaryManifest(paths.appDir, pages),
  );
  // Tag through the render's loader: its copies, and in compat mode each ref's module inside
  // the single keyed server bundle (the whole app's islands cost one module load, not one
  // import per island).
  const tagLoad = boundaryRefLoader(load);
  // Production refuses the actions no module imports (a dev server earlier in this process, as
  // in a test run, may have left the process permissive).
  setUnreferencedActionsPermissive(false);
  await timed("tagServerModules", () => tagServerModules(boundary.server, tagLoad));
  // Import + tag the islands now, before the server listens, so the FIRST request doesn't
  // pay for it.
  if (flightRoutes.size > 0) {
    await timed("tagClientModules", () => tagClientModules(boundary.client, tagLoad));
  }
  return { flightRoutes, boundary };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail fast on a partial/incomplete build: every non-Flight, non-static page route must
 * have its client entry on disk. Otherwise the page would SSR but silently never hydrate
 * (the browser 404s the missing entry, and the loader swallows it). Flight routes share
 * the app-wide flight.js, checked once.
 */
export async function assertBuildComplete(
  clientDir: string,
  manifest: RouteManifest,
  flightRoutes: Set<string>,
  staticRoutes: Set<string>,
): Promise<void> {
  const missing: string[] = [];
  for (const page of manifest.pages) {
    if (flightRoutes.has(page.routePath) || staticRoutes.has(page.routePath)) continue;
    const entry = join(clientDir, `${routeId(page.routePath)}.js`);
    if (!(await exists(entry))) missing.push(`${page.routePath} -> ${entry}`);
  }
  const flightFile = join(clientDir, FLIGHT_BUNDLE_FILE);
  if (flightRoutes.size > 0 && !(await exists(flightFile))) {
    missing.push(`(flight) -> ${flightFile}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Incomplete build: ${missing.length} client entry file(s) missing. Re-run ` +
        `\`denext build\`.\n  ${missing.join("\n  ")}`,
    );
  }
}

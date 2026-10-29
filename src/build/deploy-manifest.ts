// Collect and write the deploy manifest (`.denext/deploy-manifest.json`, typed in
// src/deploy/manifest.ts): what a deploy adapter needs to know about a built app — its routes
// and how each is served, the files served as they are with their cache headers, how the server
// starts, the jobs and their schedules, the services, the environment it reads, the permissions
// it needs, the image optimizer and the `build --compile` output.
//
// Everything is read from the project as text and from the build directory's listing (nothing
// is imported), sorted, and recorded project-relative, so the document is stable: the same tree
// writes the same bytes. Build-time only; never imported by a shipped bundle.

import { join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import { getPluginDeployAssets, getPluginDeployRoutes } from "../plugin/mod.ts";
import type { DenextConfig } from "../server/config.ts";
import { VERSION } from "../version.ts";
import {
  DEPLOY_MANIFEST_FILE,
  DEPLOY_MANIFEST_VERSION,
  type DeployAssetGroup,
  type DeployCompile,
  type DeployEnvVar,
  type DeployManifest,
  type DeployRoute,
  type DeploySchedule,
} from "../deploy/manifest.ts";
import {
  classifyPage,
  conventionModules,
  envReads,
  exists,
  filesUnder,
  handlerMethods,
  jobSchedules,
  middlewareMatcher,
  readText,
  rel,
} from "./deploy-scan.ts";
import { compileBuildFlags } from "./compile-app.ts";
import { detectDockerStack, resolveStack } from "./docker-detect.ts";
import { stackEnv } from "./docker-stack.ts";
import { pinnedIdleTrim, readEnv } from "./idle-trim.ts";
import { resourceLimitFlags } from "./resource-limits.ts";
import type { ProjectPaths } from "./paths.ts";

/** The `Cache-Control` the production server sends for content-hashed client files. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** The `Cache-Control` it sends for `public/` and emitted files (revalidated every time). */
const REVALIDATE = "public, max-age=0, must-revalidate";
/** The port `denext start` binds when `PORT` is unset. */
const DEFAULT_PORT = 3000;
/** The default `SIGTERM` drain (ms). */
const DEFAULT_DRAIN_MS = 10_000;

/** Sort by path, then kind (a page and a handler never share a path, but the order is total). */
function byPathAndKind(a: DeployRoute, b: DeployRoute): number {
  const ka = `${a.path}\0${a.kind}`;
  const kb = `${b.path}\0${b.kind}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The metadata routes served from modules (`sitemap.ts` → `/sitemap.xml`, …). */
function metadataRoutes(
  projectDir: string,
  manifest: Awaited<ReturnType<typeof scanRoutes>>,
): DeployRoute[] {
  const modules: [string | null | undefined, string][] = [
    [manifest.sitemap, "/sitemap.xml"],
    [manifest.robots, "/robots.txt"],
    [manifest.webManifest, "/manifest.webmanifest"],
  ];
  return modules.filter(([file]) => !!file).map(([file, path]) => ({
    path,
    kind: "route-handler",
    source: rel(projectDir, file!),
    reason: "a metadata route, rendered by the server",
    metadata: true,
  }));
}

/**
 * Every route: an App Router app's pages, route handlers and metadata routes, the middleware, and
 * the routes plugins contribute (`addDeployRoutes`: a router plugin's pages and endpoints).
 */
async function collectRoutes(paths: ProjectPaths, mode: DeployManifest["mode"]) {
  const routes: DeployRoute[] = [];
  if (mode === "app") {
    const manifest = await scanRoutes(paths.appDir);
    for (const page of manifest.pages) routes.push(await classifyPage(paths.projectDir, page));
    for (const api of manifest.api) {
      routes.push({
        path: api.routePath,
        kind: "route-handler",
        source: rel(paths.projectDir, api.filePath),
        reason: "a route handler",
        methods: handlerMethods(await readText(api.filePath)),
      });
    }
    routes.push(...metadataRoutes(paths.projectDir, manifest));
  }
  if (paths.middlewarePath) {
    const matcher = middlewareMatcher(await readText(paths.middlewarePath));
    routes.push({
      path: "*",
      kind: "middleware",
      source: rel(paths.projectDir, paths.middlewarePath),
      reason: "runs before every matched request",
      ...(matcher ? { matcher } : {}),
    });
  }
  routes.push(...await getPluginDeployRoutes());
  return routes.sort(byPathAndKind);
}

/**
 * The directories the production server serves files from as they are, then the plugins' own
 * ({@linkcode getPluginDeployAssets}).
 */
async function collectAssets(paths: ProjectPaths): Promise<DeployAssetGroup[]> {
  const buildDir = rel(paths.projectDir, paths.outDir);
  const groups: Omit<DeployAssetGroup, "files">[] = [
    {
      urlPrefix: "/_denext/client/",
      dir: `${buildDir}/client`,
      cacheControl: IMMUTABLE,
      immutable: true,
    },
    {
      urlPrefix: "/_denext/fonts/",
      dir: `${buildDir}/client/_fonts`,
      cacheControl: IMMUTABLE,
      immutable: true,
    },
    { urlPrefix: "/", dir: `${buildDir}/emitted`, cacheControl: REVALIDATE, immutable: false },
    {
      urlPrefix: "/",
      dir: rel(paths.projectDir, paths.publicDir),
      cacheControl: REVALIDATE,
      immutable: false,
    },
  ];
  const out: DeployAssetGroup[] = [];
  for (const group of groups) {
    const skip = group.urlPrefix === "/_denext/client/" ? ["_fonts"] : [];
    const files = await filesUnder(join(paths.projectDir, group.dir), skip);
    if (files.length) out.push({ ...group, files });
  }
  out.push(...await getPluginDeployAssets());
  return out;
}

/** The jobs and every schedule: `scheduledJobs` from the config, then each job's own. */
async function collectJobs(paths: ProjectPaths, config: DenextConfig) {
  const modules = await conventionModules(join(paths.projectDir, "jobs"));
  const schedules: DeploySchedule[] = [];
  const seen = new Set<string>();
  const add = (cron: string, job: string, from: DeploySchedule["from"]) => {
    if (seen.has(`${job}\0${cron}`)) return;
    seen.add(`${job}\0${cron}`);
    schedules.push({ cron, job, from });
  };
  for (const [cron, jobs] of Object.entries(config.scheduledJobs ?? {})) {
    for (const job of Array.isArray(jobs) ? jobs : [jobs]) add(cron, job, "config");
  }
  for (const m of modules) {
    for (const cron of jobSchedules(await readText(m.path))) add(cron, m.name, "job");
  }
  return {
    jobs: modules.map((m) => ({ name: m.name, source: rel(paths.projectDir, m.path) })),
    schedules,
  };
}

/** The environment the app reads: the detected stack's secrets, then the source's literal reads. */
async function collectEnv(projectDir: string): Promise<DeployEnvVar[]> {
  const vars = new Map<string, DeployEnvVar>();
  const entry = (name: string) => {
    let v = vars.get(name);
    if (!v) {
      v = {
        name,
        required: false,
        public: /^(DENEXT|NEXT)_PUBLIC_/.test(name),
        sources: [],
      };
      vars.set(name, v);
    }
    return v;
  };
  const stack = resolveStack(await detectDockerStack(projectDir));
  for (const v of stackEnv(stack)) {
    if (!v.app) continue;
    const e = entry(v.name);
    e.required ||= v.required;
    if (!e.sources.includes("stack")) e.sources.push("stack");
  }
  for (const read of await envReads(projectDir)) {
    const e = entry(read.name);
    e.required ||= read.asserted;
    if (!e.sources.includes(read.source)) e.sources.push(read.source);
  }
  return [...vars.values()]
    .map((v) => ({ ...v, sources: v.sources.sort() }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The start command: the project's own plain `start` task, else the CLI's `start`. */
async function serverCommand(projectDir: string, flags: string[]): Promise<string[]> {
  const detection = await detectDockerStack(projectDir);
  if (detection.startCommand) return [...detection.startCommand];
  return ["deno", "run", ...flags, ...detection.cli, "start", "."];
}

/** `DeployPermissions.net` from `compile.permissions` (`null` under `"all"`). */
function deployNet(compile: DenextConfig["compile"]): DeployManifest["permissions"]["net"] {
  const p = compile?.permissions;
  if (p === "all") return null;
  const list = (values: readonly string[] | undefined) =>
    !values || values.length === 0 || values.includes("*") ? ["*"] : [...new Set(values)].sort();
  return { connect: list(p?.netConnect), listen: list(p?.netListen) };
}

/** Which app shape this is. */
async function modeOf(paths: ProjectPaths): Promise<DeployManifest["mode"]> {
  if (paths.config?.mode === "spa") return "spa";
  return await exists(paths.appDir) ? "app" : "pages";
}

/** The image optimizer's facts. */
function imagesOf(config: DenextConfig, mode: DeployManifest["mode"]): DeployManifest["images"] {
  const images = config.images;
  const hosts = new Set<string>([
    ...(images?.domains ?? []),
    ...(images?.remotePatterns ?? []).map((p) => p.hostname),
  ]);
  return {
    optimizer: mode !== "spa" && images?.unoptimized !== true,
    endpoint: "/_denext/image",
    remoteHosts: [...hosts].sort(),
  };
}

/** The cache store the config picks. */
function cacheOf(config: DenextConfig): DeployManifest["cache"] {
  const store = config.cache?.store;
  if (store === undefined) return { store: "default" };
  return { store: store === "sqlite" || store === "memory" ? store : "custom" };
}

/** Options for {@linkcode collectDeployManifest}. */
export interface CollectOptions {
  /** What `build --compile` produced (null: no executable). */
  readonly compile?: DeployCompile | null;
}

/**
 * Collect the deploy manifest of a project from its sources and its build directory.
 *
 * @param paths The resolved project.
 * @param options The `--compile` output, when there was one.
 * @returns The manifest.
 */
export async function collectDeployManifest(
  paths: ProjectPaths,
  options: CollectOptions = {},
): Promise<DeployManifest> {
  const config = paths.config ?? {};
  const mode = await modeOf(paths);
  const flags = compileBuildFlags(config.compile);
  const i18n = config.i18n
    ? { locales: [...config.i18n.locales], defaultLocale: config.i18n.defaultLocale }
    : null;
  return {
    version: DEPLOY_MANIFEST_VERSION,
    denext: VERSION,
    mode,
    basePath: config.basePath ?? "",
    trailingSlash: config.trailingSlash === true,
    i18n,
    routes: await collectRoutes(paths, mode),
    assets: await collectAssets(paths),
    server: {
      command: await serverCommand(paths.projectDir, flags),
      port: DEFAULT_PORT,
      portEnv: "PORT",
      healthPath: "/_denext/health",
      drain: { ms: DEFAULT_DRAIN_MS, env: "DENEXT_SHUTDOWN_DRAIN_MS" },
      buildDir: rel(paths.projectDir, paths.outDir),
      idleTrim: pinnedIdleTrim(config.start?.idleTrim === false, readEnv),
      limits: resourceLimitFlags(config.start?.limits),
    },
    ...await collectJobs(paths, config),
    services: (await conventionModules(join(paths.projectDir, "services"))).map((m) => ({
      name: m.name,
      source: rel(paths.projectDir, m.path),
    })),
    env: await collectEnv(paths.projectDir),
    permissions: {
      flags,
      allowAll: flags.includes("--allow-all"),
      net: deployNet(config.compile),
    },
    images: imagesOf(config, mode),
    cache: cacheOf(config),
    compile: options.compile ?? null,
  };
}

/** The manifest's path for a build directory. */
function deployManifestPath(outDir: string): string {
  return join(outDir, DEPLOY_MANIFEST_FILE);
}

/**
 * Serialize a manifest the way it is written (two-space JSON, trailing newline).
 *
 * @param manifest The manifest.
 * @returns The file's contents.
 */
export function serializeDeployManifest(manifest: DeployManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Collect the manifest and write it to `<outDir>/deploy-manifest.json` (a temp file + rename, so a
 * reader never sees half of it).
 *
 * @param paths The resolved project.
 * @param options The `--compile` output, when there was one.
 * @returns The manifest written.
 */
export async function writeDeployManifest(
  paths: ProjectPaths,
  options: CollectOptions = {},
): Promise<DeployManifest> {
  const manifest = await collectDeployManifest(paths, options);
  await Deno.mkdir(paths.outDir, { recursive: true });
  const path = deployManifestPath(paths.outDir);
  await Deno.writeTextFile(`${path}.tmp`, serializeDeployManifest(manifest));
  await Deno.rename(`${path}.tmp`, path);
  return manifest;
}

/**
 * Read the manifest a build wrote, or `null` when there is none (or it is another version).
 *
 * @param outDir The build directory.
 * @returns The manifest, or `null`.
 */
export async function readDeployManifest(outDir: string): Promise<DeployManifest | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(deployManifestPath(outDir)));
    return parsed?.version === DEPLOY_MANIFEST_VERSION ? parsed as DeployManifest : null;
  } catch {
    return null;
  }
}

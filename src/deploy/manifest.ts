// The deploy manifest: what `denext build` tells a deploy adapter about the app it built, as a
// stable, versioned JSON document (`.denext/deploy-manifest.json`). Pure types and constants —
// no imports — so a third-party adapter (and `denext/plugin-kit`) can depend on the shape alone.
//
// Stability: a field is only ever ADDED within a version, never renamed, removed or re-typed; a
// change that breaks a reader bumps {@linkcode DEPLOY_MANIFEST_VERSION}. Every list is sorted and
// every path is project-relative and `/`-separated, so two builds of one tree write the same bytes
// (tests/deploy-manifest.test.ts pins both).

/** The manifest format version {@linkcode DeployManifest.version} carries. */
export const DEPLOY_MANIFEST_VERSION = 1;

/** The manifest's file name, under the build directory (`.denext/deploy-manifest.json`). */
export const DEPLOY_MANIFEST_FILE = "deploy-manifest.json";

/**
 * How a route is served, as a host needs to know it:
 * - `"static"` — rendered once (at build or on the first request) and the same for everyone:
 *   `denext export` writes it, and a CDN may cache it until the next deploy.
 * - `"isr"` — cached and re-rendered in the background every {@linkcode DeployRoute.revalidate}
 *   seconds (`export const revalidate = N`): needs the server.
 * - `"dynamic"` — rendered per request (`dynamic = "force-dynamic"`, a request API such as
 *   `cookies()`, or a dynamic segment with no `generateStaticParams`): needs the server.
 * - `"route-handler"` — a `route.ts` (or a metadata route such as `sitemap.ts`): needs the server.
 * - `"middleware"` — the root `middleware.ts` / `proxy.ts`: runs before every matched request.
 */
export type DeployRouteKind = "static" | "isr" | "dynamic" | "route-handler" | "middleware";

/** One route of the app, classified for a host. */
export interface DeployRoute {
  /** The route pattern (`/blog/[slug]`); the middleware's is `"*"`. */
  path: string;
  /** How it is served. */
  kind: DeployRouteKind;
  /** The module that defines it, project-relative. */
  source: string;
  /** Why it is not `"static"` (absent for a static route). */
  reason?: string;
  /** An `"isr"` route's revalidation period, in seconds. */
  revalidate?: number;
  /** A route handler's exported HTTP methods (`["GET", "POST"]`), when they could be read. */
  methods?: string[];
  /** The middleware's `config.matcher` patterns, when given as literals (absent: every path). */
  matcher?: string[];
  /** A metadata route (`sitemap.ts`, `robots.ts`, `manifest.ts`), served by the server. */
  metadata?: boolean;
}

/** One directory of files the server serves as they are, with the `Cache-Control` it sends. */
export interface DeployAssetGroup {
  /** The URL prefix the files are served under (`/_denext/client/`, `/`). */
  urlPrefix: string;
  /** The directory, project-relative (`.denext/client`, `public`). */
  dir: string;
  /** The `Cache-Control` the production server sends for these files. */
  cacheControl: string;
  /** Whether the files are content-hashed (safe to cache forever). */
  immutable: boolean;
  /** The files, relative to {@linkcode dir}, sorted (precompressed `.gz` siblings left out). */
  files: string[];
}

/** How the production server is started. */
export interface DeployServer {
  /** The command that serves the built app (`deno run --allow-… jsr:@denext/denext/cli start .`). */
  command: string[];
  /** The port it listens on unless `PORT` says otherwise. */
  port: number;
  /** The environment variable the port is read from. */
  portEnv: "PORT";
  /** The liveness/readiness endpoint (`200` while up; `503` when a registered check fails). */
  healthPath: string;
  /** How long `SIGTERM` drains in-flight requests by default (ms), and the variable that sets it. */
  drain: { ms: number; env: "DENEXT_SHUTDOWN_DRAIN_MS" };
  /** The build directory the server reads, and writes its durable cache to, project-relative. */
  buildDir: string;
  /**
   * Whether a server started on denext's pinned Deno toolchain should run with its idle trim
   * (`DENO_UNSTABLE_IDLE_TRIM=1`: a full GC and `malloc_trim(0)` once the event loop goes idle):
   * the pinned toolchain has it (3.0.0-rc.5 or later) and the project does not opt out
   * (`start: { idleTrim: false }`, `DENEXT_IDLE_TRIM=0` when the manifest was written). A
   * `--compile` executable has it baked in already. Absent in a manifest from before denext 4.8.1.
   */
  idleTrim?: boolean;
  /**
   * The resource-limit flags the project's `start.limits` asks for (`--max-memory=512m`,
   * `--max-cpu-time=<n>`, `--max-time=<n>`; empty when nothing is limited), for a server started on
   * denext's Deno from runtime 3.0.0-rc.2: a generator puts them on the server's `deno run`
   * (a `--compile` executable has them baked in already). Absent in a manifest from before denext
   * 4.10.
   */
  limits?: string[];
  /**
   * `start.tls` — the server serves HTTPS itself — with each certificate's host names and the
   * environment variables naming its PEM files (never the paths or the files), for a generator to
   * pass those variables through, make the files readable and probe health over `https:`; `null`
   * when the server serves plain HTTP. Several certificates need denext's Deno from runtime
   * 3.0.0-denext.3 with the unstable net APIs on. Absent in a manifest from before denext 4.10.3.
   */
  tls?: DeployServerTls | null;
}

/** {@linkcode DeployServer.tls}: the certificates the server serves HTTPS with. */
export interface DeployServerTls {
  /** One entry per certificate, in config order. */
  certificates: DeployTlsCertificate[];
}

/** One certificate of {@linkcode DeployServerTls}. */
export interface DeployTlsCertificate {
  /** The host names it serves (exact, a one-label `*.` wildcard, or `"*"`). */
  hostnames: string[];
  /** The environment variable holding the certificate (chain) file's path. */
  certFileEnv: string;
  /** The environment variable holding the private key file's path. */
  keyFileEnv: string;
}

/** A job under `jobs/`. */
export interface DeployJob {
  /** The job's name (its path under `jobs/` without the extension). */
  name: string;
  /** Its module, project-relative. */
  source: string;
}

/** One scheduled run: a job and the cron expression (UTC, POSIX weekdays) that fires it. */
export interface DeploySchedule {
  /** The cron expression. */
  cron: string;
  /** The job it runs. */
  job: string;
  /** Where the schedule is declared: `denext.config`'s `scheduledJobs`, or the job's own file. */
  from: "config" | "job";
}

/** A supervised service under `services/`, started with the server. */
export interface DeployService {
  /** The service's name (its path under `services/` without the extension). */
  name: string;
  /** Its module, project-relative. */
  source: string;
}

/** An environment variable the app reads. */
export interface DeployEnvVar {
  /** The variable. */
  name: string;
  /**
   * Whether the app cannot run without it: a secret the detected stack needs (`AUTH_SECRET`,
   * `DATABASE_URL`, …) or a read the source asserts (`Deno.env.get("X")!`).
   */
  required: boolean;
  /** A `DENEXT_PUBLIC_` / `NEXT_PUBLIC_` variable: shipped to the browser. */
  public: boolean;
  /** Where it was found: project-relative files, or `"stack"` for the detected services. */
  sources: string[];
}

/** The Deno permissions the production server runs with. */
export interface DeployPermissions {
  /**
   * The `--allow-*` flags (the least-privilege `start` set plus `compile.permissions`), for any
   * Deno: the network grant is the one `--allow-net`.
   */
  flags: string[];
  /** Whether the app opted into `--allow-all` (`compile.permissions: "all"`). */
  allowAll: boolean;
  /**
   * The network grant by direction, for a runtime that splits `--allow-net` (denext's Deno from
   * 3.0.0-rc.2: `--allow-net-connect` / `--allow-net-listen`). `["*"]` is a direction left
   * unscoped. `listen` is `["*"]` unless `compile.permissions.netListen` names addresses: an
   * adapter that knows the port it serves on scopes it there (`:<port>`, or `<host>:<port>`),
   * so nothing else in the process can open a listener. `null` under `allowAll`.
   */
  net: DeployNetPermissions | null;
}

/** {@linkcode DeployPermissions.net}: the outbound hosts and the listen addresses. */
export interface DeployNetPermissions {
  /** `--allow-net-connect` hosts (`["*"]`: unscoped). */
  connect: string[];
  /** `--allow-net-listen` addresses (`["*"]`: unscoped, for the adapter to scope to its port). */
  listen: string[];
}

/** The built-in image optimizer. */
export interface DeployImages {
  /** Whether `<Image>` requests go through the server's optimizer (`images.unoptimized` off). */
  optimizer: boolean;
  /** The optimizer's endpoint. */
  endpoint: string;
  /** The remote hosts it may fetch (`images.remotePatterns` / `images.domains` hostnames). */
  remoteHosts: string[];
}

/** The data / page (ISR) cache store the config chooses. */
export interface DeployCache {
  /**
   * `"default"` (`node:sqlite` in `.denext/` where the disk is writable, else memory),
   * `"sqlite"`, `"memory"`, or `"custom"` (a store object, e.g. Redis or Deno KV).
   */
  store: "default" | "sqlite" | "memory" | "custom";
}

/** What `denext build --compile` produced. */
export interface DeployCompile {
  /** The executable, project-relative. */
  output: string;
  /** The `deno compile --target` triple (absent: the build machine's). */
  target?: string;
  /** The `--allow-*` baked into it. */
  permissions: string[];
}

/** The deploy manifest `denext build` writes to `.denext/deploy-manifest.json`. */
export interface DeployManifest {
  /** The format version ({@linkcode DEPLOY_MANIFEST_VERSION}). */
  version: 1;
  /** The denext version that wrote it. */
  denext: string;
  /** `"app"` (App Router), `"spa"` (`mode: "spa"`) or `"pages"` (no `app/`; a router plugin). */
  mode: "app" | "spa" | "pages";
  /** `basePath` (`""` when none). */
  basePath: string;
  /** `trailingSlash`. */
  trailingSlash: boolean;
  /** The i18n locales, when the app is localized. */
  i18n: { locales: string[]; defaultLocale: string } | null;
  /** Every route, sorted by path then kind. */
  routes: DeployRoute[];
  /** The files served as they are. */
  assets: DeployAssetGroup[];
  /** How the server starts. */
  server: DeployServer;
  /** The jobs under `jobs/`. */
  jobs: DeployJob[];
  /** Every schedule the server registers. */
  schedules: DeploySchedule[];
  /** The services under `services/`. */
  services: DeployService[];
  /** The environment variables the app reads. */
  env: DeployEnvVar[];
  /** The Deno permissions the server needs. */
  permissions: DeployPermissions;
  /** The image optimizer. */
  images: DeployImages;
  /** The cache store. */
  cache: DeployCache;
  /** The `build --compile` executable, or `null` when the build made none. */
  compile: DeployCompile | null;
}

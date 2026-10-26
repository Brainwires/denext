// The Docker templates `denext generate docker` and the `denext ui` Docker panel both emit:
// the production `Dockerfile` (SSR or static), `docker-compose.yml` and `.dockerignore`.
//
// Two consumers, one source of truth. The CLI verb renders the defaults; the UI panel renders
// the same templates with options (port, Deno tag, a real Postgres service) and diffs the result
// against what is on disk before it overwrites anything. Overwriting is gated on
// {@linkcode DOCKER_SENTINEL}: every file this module emits carries that header comment, so a
// hand-edited file (sentinel deleted, or never generated) is never clobbered — the same
// never-clobber honesty `denext migrate` applies with its own generated-file marker.
//
// Build-time only; never imported by a shipped bundle. This module only EMITS: it never parses
// a compose file. Editing an existing one in place (keeping its comments and every line an edit
// does not touch) is `compose-edit.ts`'s job, which the UI panel's compose editor calls — a
// regeneration and a round-trip edit are two separate paths, and only the first comes through
// here. (`compose-scan.ts` imports this module's sentinel check, so the dependency runs one way.)

import { isAbsolute, join, relative } from "@std/path";
import { currentDenoIdentity, denoReleaseVersion } from "./deno-version.ts";
import { splitNetFlag } from "./net-permissions.ts";
import {
  DOCKER_SENTINEL,
  isStack,
  renderComposeDev,
  renderEnvExample,
  renderStackCompose,
  type StackOptions,
} from "./docker-stack.ts";

export { DOCKER_SENTINEL };

/** How the generated Docker image serves the app. */
export type DockerMode = "server" | "static";

/** The port the image exposes and the server binds when nothing else is asked for. */
const DEFAULT_PORT = 3000;

/**
 * What the Docker templates are rendered with: the image, plus the stack's services and secrets
 * ({@linkcode StackOptions} — Postgres, pgvector, MinIO storage, migrations, the dev overlay).
 */
export interface DockerOptions extends StackOptions {
  /** SSR image (build + `deno task start`) or static image (`deno task export` + file server). */
  readonly mode: DockerMode;
  /** The port the container exposes and the server binds (default 3000). */
  readonly port?: number;
  /** The `denoland/deno:` tag to pin (default: the Deno version rendering this file). */
  readonly denoTag?: string;
  /**
   * Bake the network grant split by direction into the server's command (listen only on the
   * served port, connect anywhere). Default: on (denext's Deno toolchain, which the image runs its
   * server on, has the split).
   */
  readonly netSplit?: boolean;
  /**
   * Run the server with denext's Deno's idle trim (`ENV DENO_UNSTABLE_IDLE_TRIM=1`): a full GC and
   * `malloc_trim(0)` once the event loop goes idle. `resolveDocker()` sets it unless the project opts
   * out (`start: { idleTrim: false }`, `DENEXT_IDLE_TRIM=0`). Default: off.
   */
  readonly idleTrim?: boolean;
}

/** One file a Docker regeneration would produce, next to what is on disk today. */
export interface DockerPlanFile {
  /** Absolute path the file would be written to. */
  readonly path: string;
  /** The contents the current options render. */
  readonly contents: string;
  /** The file's current contents, when it already exists. */
  readonly existing?: string;
  /** Whether the existing file carries {@linkcode DOCKER_SENTINEL} (false when absent). */
  readonly generated: boolean;
}

/**
 * Whether `text` was emitted by these templates (and may therefore be regenerated).
 *
 * @param text A file's current contents.
 * @returns Whether the generated-file sentinel is present.
 */
export function isGeneratedDockerFile(text: string): boolean {
  return text.includes(DOCKER_SENTINEL);
}

/**
 * Pick the Docker mode: an explicit `server`/`ssr` or `spa`/`static` override wins;
 * otherwise auto-detect from `denext.config.*` (`mode: "spa"` → a static export image,
 * anything else → the App Router / SSR production server).
 *
 * @param projectDir The project to inspect.
 * @param override An explicit `server` | `ssr` | `spa` | `static` (or `docker`, the verb's own
 * kind name, which is treated as "no override").
 * @returns The mode to render.
 * @throws When `override` names something else.
 */
export async function detectDockerMode(
  projectDir: string,
  override?: string,
): Promise<DockerMode> {
  const o = (override ?? "").trim().toLowerCase();
  if (o === "spa" || o === "static") return "static";
  if (o === "server" || o === "ssr") return "server";
  if (o && o !== "docker") {
    throw new Error(
      `denext: unknown docker target "${override}" (expected: server | spa).`,
    );
  }
  for (const f of ["denext.config.ts", "denext.config.js", "denext.config.mjs"]) {
    try {
      const text = await Deno.readTextFile(join(projectDir, f));
      if (/\bmode\s*:\s*["']spa["']/.test(text)) return "static";
    } catch { /* config absent — fall through to the server default */ }
  }
  return "server";
}

// ---- templates -------------------------------------------------------------

/** The port to render (the default when none was asked for). */
function portOf(options: DockerOptions): number {
  return options.port ?? DEFAULT_PORT;
}

/** The Deno base image, pinned to the requested tag or to the version generating this file. */
function denoImage(options: DockerOptions): string {
  return `denoland/deno:${options.denoTag ?? denoReleaseVersion(currentDenoIdentity())}`;
}

/** The three-line banner both Dockerfiles open with (sentinel + "bump it deliberately"). */
function header(lead: string): string {
  return `# Production image for a denext ${lead}
${DOCKER_SENTINEL}. Pinned to the Deno version this was
# generated with — bump it deliberately.`;
}

/** An exec-form instruction's JSON array, spaced as the rest of the file is. */
function execForm(words: readonly string[]): string {
  return `[${words.map((w) => JSON.stringify(w)).join(", ")}]`;
}

/**
 * The `start` task's command as the image runs it, or `undefined` (none usable): on a toolchain
 * that splits the network grant ({@linkcode DockerOptions.netSplit}), its unscoped `--allow-net`
 * becomes `--allow-net-connect --allow-net-listen=:<port>,[::]:<port>`.
 */
function imageStartCommand(port: number, options: DockerOptions): readonly string[] | undefined {
  const task = options.startCommand;
  if (!task || !(options.netSplit ?? true)) return task;
  // `:<port>` is 0.0.0.0, 127.0.0.1 and localhost; `[::]` is the server bound to IPv6's any.
  return splitNetFlag(task, [`:${port}`, `[::]:${port}`]);
}

/**
 * The SSR image's `ENV PORT` + `ENTRYPOINT` + `CMD`. `denext start` reads `$PORT` (what a PaaS
 * injects), so a non-default port rides in the environment: `deno task` forwards a literal `--`
 * to the task, and `start` would then treat `--port` as passthrough and ignore it.
 *
 * Shutdown: `docker stop` sends SIGTERM to PID 1 (the image's `tini`), which passes it to its
 * child. `deno task` does not forward it to the server it started, so the server never drained
 * and was SIGKILLed after the grace period (no plugin teardowns). The `start` task's own
 * `deno run` line is therefore the `CMD` when it needs no shell, and `tini -g` signals the whole
 * process group either way (which also covers a `deno task start` fallback).
 */
function serverCmd(port: number, options: DockerOptions): string {
  const lines = [`ENTRYPOINT ["/tini", "-g", "--", "docker-entrypoint.sh"]`, "STOPSIGNAL SIGTERM"];
  const start = imageStartCommand(port, options);
  if (start) {
    lines.push("# The `start` task's own command, run directly (not through `deno task`).");
  }
  if (start && start.length !== options.startCommand?.length) {
    lines.push(
      `# Its --allow-net is split by direction (the toolchain's Deno has it): the server may listen`,
      `# only on port ${port} (0.0.0.0, [::], 127.0.0.1, localhost) and connect anywhere, so no`,
      `# dependency can open a listener of its own. A new port needs --allow-net-listen changed too.`,
    );
  }
  if (port !== DEFAULT_PORT) lines.push(`ENV PORT=${port}`);
  lines.push(`CMD ${start ? execForm(start) : `["deno", "task", "start"]`}`);
  return lines.join("\n");
}

/**
 * The image's `HEALTHCHECK`, against the built-in probe. `deno eval` runs with every
 * permission, so no flags; the probe is GET-only and always 200 while the server is up
 * (its body — not the status — says whether the cache store is durable).
 */
function healthcheck(port: number): string {
  return `HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \\
  CMD deno eval "fetch('http://127.0.0.1:${port}/_denext/health').then((r)=>Deno.exit(r.ok?0:1)).catch(()=>Deno.exit(1))"`;
}

/**
 * Put denext's Deno toolchain (which the build above already downloaded into `DENO_DIR`, checked
 * against the SHA-256 the CLI pins) first on `PATH`, so the server, its health probe, `deno task`
 * and the stack's services all run on it — the runtime `dev` and `build` use. The image's own Deno
 * only bootstraps the CLI: the least-privilege `start` task has no `--allow-run` to re-exec onto
 * the toolchain by itself, and on any other Deno `Deno.SQL` (`postgresClient()`, the Prisma
 * adapter) and the toolchain's other changes would be missing.
 */
function toolchainLayer(options: DockerOptions): string {
  const cli = (options.cli ?? ["jsr:@denext/denext/cli"]).join(" ");
  return `
# Run on denext's Deno toolchain, as \`dev\` and \`build\` do (Deno.SQL / postgresClient(), the
# Prisma adapter). The build above already downloaded it into DENO_DIR and verified its SHA-256;
# \`toolchain path\` re-verifies it and the link puts it first on PATH for everything below.
RUN mkdir -p /deno-dir/toolchain-bin && \\
  ln -sf "$(deno run -A ${cli} toolchain path)" /deno-dir/toolchain-bin/deno
ENV PATH=/deno-dir/toolchain-bin:$PATH
`;
}

/**
 * The server's idle trim ({@linkcode DockerOptions.idleTrim}), or nothing. `ENV` rather than a
 * flag on the `CMD`, so the `deno task start` fallback gets it too; any other `deno` the container
 * runs (the health probe) exits long before its loop could go idle.
 */
function idleTrimLayer(options: DockerOptions): string {
  if (!options.idleTrim) return "";
  return `# Hand the memory a load burst leaves behind back to the OS once the server goes idle (a full
# GC, then malloc_trim; denext's Deno toolchain from runtime 3.0.0-rc.5). Opt out with
# \`start: { idleTrim: false }\` in denext.config and regenerate, or \`-e DENO_UNSTABLE_IDLE_TRIM=0\`.
ENV DENO_UNSTABLE_IDLE_TRIM=1

`;
}

/**
 * For a Gleam app: the CA certificates the Gleam compiler's package fetch (TLS) needs, which the
 * `denoland/deno` image doesn't ship. Installed as root, before the build runs as `deno`.
 */
function caCertificates(options: DockerOptions): string {
  if (!options.gleam) return "";
  return `# The Gleam compiler fetches its packages over TLS; the base image ships no CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \\
  rm -rf /var/lib/apt/lists/*
`;
}

/** Dockerfile for an App Router / SSR app: build, then run the production server. */
function dockerfileServerSource(options: DockerOptions): string {
  const port = portOf(options);
  return `${header("(App Router / SSR) app.")}
FROM ${denoImage(options)}

# Build and run as the image's unprivileged \`deno\` user (never root). /app must be its own:
# the build writes \`.denext/\` there, and at runtime the durable node:sqlite cache
# (\`.denext/cache.db\`) needs the same directory writable — a root-owned tree would
# silently downgrade the cache to the per-process memory store.
WORKDIR /app
${caCertificates(options)}RUN chown deno:deno /app
USER deno
ENV DENO_DIR=/deno-dir

# Dependency layer: only deno.json / deno.lock — cached until the dependencies change.
# denext fetches its framework + deps from JSR/npm here, so this stage needs network.
COPY --chown=deno:deno deno.json deno.lock* ./
RUN deno install

# The sources change every build; the dependency layer above stays cached.
COPY --chown=deno:deno . .
RUN deno task build
${toolchainLayer(options)}
${
    idleTrimLayer(options)
  }# One access-log line per request (JSON, with its request id; every response carries the id in
# x-request-id). Set DENEXT_LOG=1 for a compact human line, or remove it to log none.
ENV DENEXT_LOG=json

# The production server listens on ${port} and binds 0.0.0.0 by default (see
# \`deno task start\`). Change the port with \`ENV PORT=<n>\`
# (and EXPOSE) — \`start\` reads $PORT.
EXPOSE ${port}

# The built-in liveness probe. Its JSON body also reports the cache store
# ({"cache":"ok","cacheStore":"sqlite"}); "memory" there means the write grant is missing.
${healthcheck(port)}

# \`deno task start\` is the least-privilege task \`denext create\` writes:
#   --allow-net --allow-read --allow-env --allow-write=.denext
# The write grant is what keeps the cache durable — make sure your start task has it.
${serverCmd(port, options)}
`;
}

/** Dockerfile for a static/SPA app: export to out/, serve it as static files. */
function dockerfileStaticSource(options: DockerOptions): string {
  const port = portOf(options);
  return `${header('static / SPA app (`mode: "spa"`).')}
FROM ${denoImage(options)}

# Build and serve as the image's unprivileged \`deno\` user (never root).
WORKDIR /app
${caCertificates(options)}RUN chown deno:deno /app
USER deno
ENV DENO_DIR=/deno-dir

# Dependency layer: only deno.json / deno.lock — cached until the dependencies change.
COPY --chown=deno:deno deno.json deno.lock* ./
RUN deno install

# Build the static export into out/ (denext fetches deps from JSR/npm here).
COPY --chown=deno:deno . .
RUN deno task export
${toolchainLayer(options)}
# Serve the static export with Deno's std file server (each route is a real
# index.html, so no SPA history-fallback is needed).
EXPOSE ${port}
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD deno eval "fetch('http://127.0.0.1:${port}/').then((r)=>Deno.exit(r.ok?0:1)).catch(()=>Deno.exit(1))"
${staticCmd(port, options)}
`;
}

/**
 * The static image's `CMD`: Deno's std file server on the export. It only listens, so where the
 * toolchain splits the network grant it gets `--allow-net-listen` for its port and no outbound
 * access at all; elsewhere `--allow-net`.
 */
function staticCmd(port: number, options: DockerOptions): string {
  const split = options.netSplit ?? true;
  const net = split ? [`--allow-net-listen=0.0.0.0:${port}`] : ["--allow-net"];
  const cmd = [
    "deno",
    "run",
    ...net,
    "--allow-read",
    "--allow-sys",
    "jsr:@std/http/file-server",
    "out",
    "--host",
    "0.0.0.0",
    "--port",
    `${port}`,
  ];
  const note = split
    ? "# Listen-only: the file server may bind its port and reach nothing (no outbound access).\n"
    : "";
  return `${note}CMD ${execForm(cmd)}`;
}

/**
 * The `Dockerfile` for these options.
 *
 * @param options Mode, port, Deno tag.
 * @returns The file's contents.
 */
export function renderDockerfile(options: DockerOptions): string {
  return options.mode === "static"
    ? dockerfileStaticSource(options)
    : dockerfileServerSource(options);
}

/**
 * The Postgres service, written once — commented out when it is only an example. Its port is
 * published to `127.0.0.1` rather than every interface: a compose file is routinely run on a
 * laptop on a café network, and a database whose credentials are the literal `denext:denext`
 * must not be reachable from it. Change the prefix deliberately if you want it exposed.
 */
const DB_SERVICE = `  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: denext
      POSTGRES_PASSWORD: denext
      POSTGRES_DB: denext
    volumes:
      - denext-db:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"`;

/** The named volume the Postgres service keeps its data in. */
const DB_VOLUMES = `volumes:
  denext-db:`;

/** Comment `text` out, inserting `# ` after `indent` leading spaces of every non-empty line. */
function commentOut(text: string, indent: number): string {
  return text
    .split("\n")
    .map((line) => line === "" ? line : line.slice(0, indent) + "# " + line.slice(indent))
    .join("\n");
}

/**
 * `docker-compose.yml`. With any stack service switched on (Postgres, storage, migrations) it is
 * the self-hosted stack ({@linkcode renderStackCompose}); otherwise the app service alone, next
 * to the commented Postgres example every generated project has shipped with.
 *
 * @param options Mode, port, the stack's services.
 * @returns The file's contents.
 */
export function renderCompose(options: DockerOptions): string {
  const port = portOf(options);
  if (isStack(options)) return renderStackCompose(options, port, options.mode === "static");
  return `${DOCKER_SENTINEL}.
services:
  web:
    build: .
    ports:
      - "${port}:${port}"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    # SIGTERM drains in-flight requests (DENEXT_SHUTDOWN_DRAIN_MS, 10 s by default) first.
    stop_grace_period: 30s
    # Load secrets / runtime env from a file (uncomment and create .env):
    # env_file: .env

  # Example Postgres service — uncomment, then wire DATABASE_URL into \`web\`
  # (or regenerate with \`denext generate docker --postgres\` for the full wiring).
${commentOut(DB_SERVICE, 2)}

${commentOut(DB_VOLUMES, 0)}
`;
}

/**
 * `.dockerignore` — keep build cache, VCS, local env, and the image files out.
 *
 * @returns The file's contents.
 */
export function renderDockerignore(): string {
  return `${DOCKER_SENTINEL}.
.git
.gitignore
node_modules
.denext
out
*.log
.env
.env.*
!.env.example
Dockerfile
docker-compose.yml
compose.yaml
compose.yml
compose.*.yml
docker-compose.*.yml
.dockerignore
desktop-icon.png
`;
}

// ---- the plan --------------------------------------------------------------

/**
 * The file's current contents, or `undefined` when it does not exist — or when it resolves
 * (through a symlink) outside `projectDir`: a plan never reads a file from beyond the project
 * into a preview, and a write there is refused by the caller's own containment gate.
 */
async function readIfPresent(projectDir: string, path: string): Promise<string | undefined> {
  try {
    const rel = relative(await Deno.realPath(projectDir), await Deno.realPath(path));
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

/** The compose file names Docker Compose looks for, in its own order of precedence. */
export const COMPOSE_FILE_NAMES: readonly string[] = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

/** The development overlay `--dev` writes beside the compose file. */
const DEV_COMPOSE_FILE = "compose.dev.yml";

/** The name a new compose file is written under (the one `denext generate docker` has always used). */
export const DEFAULT_COMPOSE_FILE = "docker-compose.yml";

/**
 * The compose file a project already has, by Docker Compose's precedence — a symlink out of the
 * project doesn't count — or `null` when it has none.
 *
 * @param projectDir The project root.
 * @returns The file's name, relative to `projectDir`, or `null`.
 */
export async function findComposeFile(projectDir: string): Promise<string | null> {
  for (const name of COMPOSE_FILE_NAMES) {
    if (await readIfPresent(projectDir, join(projectDir, name)) !== undefined) return name;
  }
  return null;
}

/**
 * What a Docker (re)generation would write at the project root, next to what is there now —
 * the single plan both `denext generate docker` and the UI panel act on, so a preview and a
 * write can never disagree.
 *
 * @param projectDir The project root the three files live at.
 * @param options Mode, port, Deno tag, Postgres toggle.
 * @returns One entry per file, in write order, each carrying its on-disk state.
 */
export async function dockerPlan(
  projectDir: string,
  options: DockerOptions,
): Promise<DockerPlanFile[]> {
  const rendered: readonly (readonly [string, string])[] = [
    ["Dockerfile", renderDockerfile(options)],
    // An existing compose file under any of Docker Compose's names is the one regenerated.
    [(await findComposeFile(projectDir)) ?? DEFAULT_COMPOSE_FILE, renderCompose(options)],
    [".dockerignore", renderDockerignore()],
    ...(isStack(options) ? [[".env.example", renderEnvExample(options)] as const] : []),
    ...(options.dev
      ? [[DEV_COMPOSE_FILE, renderComposeDev(options, portOf(options))] as const]
      : []),
  ];
  const plan: DockerPlanFile[] = [];
  for (const [name, contents] of rendered) {
    const path = join(projectDir, name);
    const existing = await readIfPresent(projectDir, path);
    plan.push({
      path,
      contents,
      ...(existing === undefined ? {} : { existing }),
      generated: existing !== undefined && isGeneratedDockerFile(existing),
    });
  }
  return plan;
}

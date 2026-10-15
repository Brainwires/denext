// Which services `denext generate docker` puts in a project's stack, read from the project
// itself: `@denext/backend` (or a Postgres `DATABASE_URL`) → Postgres; an `s3()` storage driver
// → MinIO with its bucket; `migrations/` with `jobs/migrate.ts` (or `@denext/backend`) → the
// migrations service; a `vector` extension in a migration → the pgvector image. Every decision carries the reason it
// was made, so the CLI and the `denext ui` Docker panel can say why a service is in the stack,
// and an explicit flag (`--postgres` / `--no-postgres`, …) overrides what was detected.
//
// Build-time only; never imported by a shipped bundle. It only reads text (no config is
// imported or executed), so it is safe on any project.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import { isStack, type StackOptions } from "./docker-stack.ts";
import { detectDockerMode, type DockerOptions } from "./docker-template.ts";
import { usesPostgres } from "./generate-ops.ts";

/**
 * A requested app port (a whole number, 1–65535) and `denoland/deno` image tag (an image-tag-safe
 * string), validated — the rule behind `denext generate docker --port / --deno-tag` and the MCP
 * `denext_generate` tool's `port` / `denoTag`.
 *
 * @param port The port as given (`undefined`: not set).
 * @param tag The tag as given (`undefined`: not set).
 * @returns The validated values (absent when not set).
 * @throws When either is invalid.
 */
export function dockerPortAndTag(port: unknown, tag: unknown): { port?: number; tag?: string } {
  const n = port === undefined ? undefined : Number(port);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 65535)) {
    throw new Error(`invalid --port "${port}" (expected a whole number between 1 and 65535)`);
  }
  const t = tag === undefined ? undefined : String(tag);
  if (t !== undefined && !/^[\w.\-]+$/.test(t)) {
    throw new Error(`invalid --deno-tag "${t}" (letters, digits, dot, dash and underscore only)`);
  }
  return { port: n, tag: t };
}

/** The stack services a flag (or a detection) switches on and off. */
export const STACK_FEATURES = ["postgres", "pgvector", "storage", "migrate", "dashboard"] as const;

/** One of {@linkcode STACK_FEATURES}. */
export type StackFeature = typeof STACK_FEATURES[number];

/** What each stack switch adds — the `--help` of `denext generate docker` and the MCP tool's. */
export const STACK_FEATURE_HELP: Readonly<Record<StackFeature, string>> = {
  postgres: "Postgres 17 service + DATABASE_URL (detected: @denext/backend / a Postgres URL)",
  pgvector: "Use the pgvector/pgvector:pg17 image (detected: the vector extension in migrations/)",
  storage: "MinIO S3 store + a one-shot bucket bootstrap (detected: an s3() storage driver)",
  migrate: "One-shot migrations service the app waits for: `denext migration up` with " +
    "@denext/backend, else `denext job migrate` (detected: migrations/ + jobs/migrate.ts or " +
    "@denext/backend)",
  dashboard: "The database dashboard (denext dashboard) on 127.0.0.1:3100, behind " +
    "DASHBOARD_PASSWORD (on with Postgres)",
};

/** What detection found, with the reason behind every service it switched on. */
export interface StackDetection {
  /** The detected value of each feature. */
  readonly features: Readonly<Record<StackFeature, boolean>>;
  /** Why each switched-on feature is on (absent when it is off). */
  readonly reasons: Readonly<Partial<Record<StackFeature, string>>>;
  /** The app uses `denextAuth` (its secret goes into `.env.example`). */
  readonly auth: boolean;
  /** The app uses `@denext/backend`. */
  readonly backend: boolean;
  /** `@denext/backend` storage is configured (any driver). */
  readonly backendStorage: boolean;
  /** `@denext/backend`'s `vault` is configured. */
  readonly backendVault: boolean;
  /** `@denext/backend`'s realtime reads the write-ahead log (`source: "logical"`). */
  readonly realtimeLogical: boolean;
  /** The S3 bucket named literally in `s3({ bucket: "…" })`, when there is one. */
  readonly bucket?: string;
  /** The `deno run -A` arguments that run denext's CLI (`--config deno.json jsr:…/cli`). */
  readonly cli: readonly string[];
  /** What the migrations service runs. */
  readonly migrateCommand: readonly string[];
  /** The `start` task as an exec-form command, when it is a plain `deno run` line. */
  readonly startCommand?: readonly string[];
  /** Things the user should know (a half-set-up migration runner, …). */
  readonly warnings: readonly string[];
}

/** A file's text, or `""` when it can't be read. */
async function readText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `denext.config.*` the project has, concatenated (they are only searched). */
async function configText(dir: string): Promise<string> {
  const texts = await Promise.all(
    ["ts", "js", "mjs", "mts"].map((ext) => readText(join(dir, `denext.config.${ext}`))),
  );
  return texts.join("\n");
}

/** The project's `deno.json(c)`: its name and parsed contents (empty when absent/unreadable). */
async function denoJson(dir: string): Promise<{ name?: string; json: Record<string, unknown> }> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await readText(join(dir, name));
    if (!text) continue;
    try {
      const parsed = parseJsonc(text);
      if (parsed && typeof parsed === "object") {
        return { name, json: parsed as Record<string, unknown> };
      }
    } catch { /* unparsable: treated as absent */ }
  }
  return { json: {} };
}

/** Every `migrations/*.sql`, concatenated. */
async function migrationsText(dir: string): Promise<string> {
  const parts: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(dir, "migrations"))) {
      if (entry.isFile && entry.name.endsWith(".sql")) {
        parts.push(await readText(join(dir, "migrations", entry.name)));
      }
    }
  } catch { /* no migrations dir */ }
  return parts.join("\n");
}

/** A `jsr:` / `npm:` / URL specifier of denext's CLI found in one of the project's tasks. */
const CLI_SPEC = /(?:^|\s)((?:jsr:|npm:|https?:\/\/)\S*?denext\S*?\/cli(?:\.ts)?)(?=\s|$)/;

/**
 * The `deno run -A` arguments that run denext's CLI the way the project's own tasks do: the
 * project's config named explicitly (so a remote CLI module resolves the project's imports), then
 * the CLI specifier its `start` / `build` / `dev` task uses (so the version matches the one the
 * image was built with), else the CLI from JSR.
 */
function cliArgsOf(json: Record<string, unknown>, configName?: string): string[] {
  const tasks = (json.tasks ?? {}) as Record<string, unknown>;
  const config = configName ? ["--config", configName] : [];
  for (const name of ["start", "build", "dev"]) {
    const task = tasks[name];
    const text = typeof task === "string"
      ? task
      : (task as { command?: unknown } | undefined)?.command;
    const match = typeof text === "string" ? CLI_SPEC.exec(text) : null;
    if (match) return [...config, match[1]];
  }
  return [...config, "jsr:@denext/denext/cli"];
}

/**
 * What the migrations service runs. With `@denext/backend` in the config, `denext migration up`:
 * the backend's own migrations first (the `anon` / `authenticated` roles, the `auth` functions,
 * the storage and realtime schemas — which the server's start would otherwise be the first to
 * apply, after the app's migrations that grant to them), then `migrations/`. Otherwise the
 * project's `migrate` task, else `denext job migrate`.
 */
function migrateCommandOf(
  json: Record<string, unknown>,
  cli: readonly string[],
  backend: boolean,
): string[] {
  const tasks = (json.tasks ?? {}) as Record<string, unknown>;
  if (backend) return ["deno", "run", "-A", ...cli, "migration", "up"];
  if (tasks.migrate !== undefined) return ["deno", "task", "migrate"];
  return ["deno", "run", "-A", ...cli, "job", "migrate"];
}

/** Anything that makes a task line need a shell (operators, expansion, quoting, env prefixes). */
const SHELL_SYNTAX = /[;&|<>$`'"\\(){}*?~#]|(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The project's `start` task as an exec-form command: `deno run|serve …` split on whitespace,
 * when the line needs no shell. The image then runs the server as tini's direct child, so a
 * `docker stop` SIGTERM drains it — `deno task` would swallow the signal.
 */
function startCommandOf(json: Record<string, unknown>): string[] | undefined {
  const task = ((json.tasks ?? {}) as Record<string, unknown>).start;
  const text = typeof task === "string"
    ? task
    : (task as { command?: unknown } | undefined)?.command;
  if (typeof text !== "string" || SHELL_SYNTAX.test(text)) return undefined;
  const words = text.trim().split(/\s+/);
  return words[0] === "deno" && (words[1] === "run" || words[1] === "serve") ? words : undefined;
}

/** `s3({ … bucket: "name" … })` — the bucket when it is a literal. */
const S3_BUCKET =
  /\bs3\s*\(\s*\{[^}]*?\bbucket\s*:\s*["'`]([a-z0-9][a-z0-9.\-]{1,61}[a-z0-9])["'`]/;

/** `create extension [if not exists] vector` in a migration. */
const VECTOR_EXTENSION = /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?["']?vector\b/i;

/** Which `@denext/backend` services the config text sets (only when the backend is in it). */
function backendServices(
  config: string,
  backendInConfig: boolean,
): { backendStorage: boolean; backendVault: boolean; realtimeLogical: boolean } {
  if (!backendInConfig) {
    return { backendStorage: false, backendVault: false, realtimeLogical: false };
  }
  return {
    backendStorage: /\bstorage\s*:/.test(config),
    backendVault: /\bvault\s*:/.test(config),
    realtimeLogical: /\bsource\s*:\s*["'`]logical["'`]/.test(config),
  };
}

/**
 * Why the migrations service is on (`reason`), and what to say about it: `migrations/` with
 * `@denext/backend` (it runs `denext migration up`), or with a `jobs/migrate.ts` runner.
 */
async function migrateReason(
  dir: string,
  json: Record<string, unknown>,
  backendInConfig: boolean,
): Promise<{ reason?: string; warnings: string[] }> {
  if (!await exists(join(dir, "migrations"))) return { warnings: [] };
  if (backendInConfig) {
    const task = ((json.tasks ?? {}) as Record<string, unknown>).migrate !== undefined;
    return {
      reason: "migrations/ + @denext/backend: denext migration up",
      warnings: task
        ? [
          "the migrations service runs `denext migration up` (the backend's own migrations, then " +
          "migrations/), not the project's `migrate` task.",
        ]
        : [],
    };
  }
  if (await exists(join(dir, "jobs", "migrate.ts"))) {
    return { reason: "migrations/ + jobs/migrate.ts", warnings: [] };
  }
  return {
    warnings: [
      "migrations/ has no jobs/migrate.ts runner — `denext generate migration <name>` writes one; " +
      "the migrations service stays off until it exists (or pass --migrate).",
    ],
  };
}

/**
 * Detect the stack a project needs from its `denext.config.*`, `deno.json`, `.env` and
 * `migrations/` — by reading text only (nothing is imported).
 *
 * @param dir The project root.
 * @returns The detected features, why each is on, and the secrets the app needs.
 */
export async function detectDockerStack(dir: string): Promise<StackDetection> {
  const config = await configText(dir);
  const { name: configName, json } = await denoJson(dir);
  const cli = cliArgsOf(json, configName);
  const startCommand = startCommandOf(json);
  const imports = (json.imports ?? {}) as Record<string, unknown>;
  const backend = /["']@denext\/backend["']/.test(config) ||
    Object.keys(imports).some((k) => k === "@denext/backend");
  const backendInConfig = /\bbackend\s*\(/.test(config) && backend;
  const s3 = backendInConfig && /\bs3\s*\(/.test(config);
  const reasons: Partial<Record<StackFeature, string>> = {};
  const warnings: string[] = [];

  if (backendInConfig) reasons.postgres = "@denext/backend in denext.config";
  else if (await usesPostgres(dir)) reasons.postgres = "a Postgres DATABASE_URL / postgres: key";
  if (s3) reasons.storage = "an s3() storage driver in denext.config";

  const migrate = await migrateReason(dir, json, backendInConfig);
  if (migrate.reason) reasons.migrate = migrate.reason;
  warnings.push(...migrate.warnings);
  if (VECTOR_EXTENSION.test(await migrationsText(dir)) || /\bpgvector\b/.test(config)) {
    reasons.pgvector = "the vector extension in migrations/";
  }

  if (reasons.postgres) reasons.dashboard = "a database to manage";

  const bucket = s3 ? S3_BUCKET.exec(config)?.[1] : undefined;
  return {
    features: {
      postgres: reasons.postgres !== undefined,
      pgvector: reasons.pgvector !== undefined,
      storage: reasons.storage !== undefined,
      migrate: reasons.migrate !== undefined,
      dashboard: reasons.dashboard !== undefined,
    },
    reasons,
    auth: /\bdenextAuth\s*\(/.test(config),
    backend,
    ...backendServices(config, backendInConfig),
    ...(bucket ? { bucket } : {}),
    cli,
    migrateCommand: migrateCommandOf(json, cli, backendInConfig),
    ...(startCommand ? { startCommand } : {}),
    warnings,
  };
}

/** Explicit per-feature switches (`--postgres` → true, `--no-postgres` → false). */
export type StackOverrides = Partial<Record<StackFeature, boolean>>;

/**
 * The stack options for a detection plus explicit overrides. The detection is the default;
 * `all` (`--stack`) also switches Postgres on when nothing detected it. An override always wins,
 * and pgvector implies Postgres (unless Postgres is switched off explicitly).
 *
 * @param detection What {@linkcode detectDockerStack} found.
 * @param overrides Explicit switches.
 * @param all `--stack`: everything detected, and Postgres regardless.
 * @returns The resolved stack options (secrets included).
 */
export function resolveStack(
  detection: StackDetection,
  overrides: StackOverrides = {},
  all = false,
): StackOptions {
  const pick = (f: StackFeature): boolean => overrides[f] ?? detection.features[f];
  const pgvector = pick("pgvector") && overrides.postgres !== false;
  const postgres = (overrides.postgres ?? (detection.features.postgres || all)) || pgvector;
  return {
    postgres,
    pgvector,
    storage: pick("storage"),
    migrate: pick("migrate"),
    // On with Postgres (detected or asked for) unless switched off; never without it.
    dashboard: postgres && (overrides.dashboard ?? true),
    auth: detection.auth,
    backend: detection.backend,
    backendStorage: detection.backendStorage,
    backendVault: detection.backendVault,
    realtimeLogical: detection.realtimeLogical,
    ...(detection.bucket ? { bucket: detection.bucket } : {}),
    cli: detection.cli,
    migrateCommand: detection.migrateCommand,
    ...(detection.startCommand ? { startCommand: detection.startCommand } : {}),
  };
}

/** Everything `denext generate docker` (and the `denext ui` Docker panel) can be asked for. */
export interface DockerRequest {
  /** `server` | `spa` (else auto-detected from the config). */
  readonly target?: string;
  /** Explicit per-feature switches. */
  readonly overrides?: StackOverrides;
  /** `--stack` / `--all`. */
  readonly all?: boolean;
  /** The port the app listens on. */
  readonly port?: number;
  /** The `denoland/deno` tag. */
  readonly denoTag?: string;
  /** Publish Postgres on loopback. */
  readonly exposeDb?: boolean;
  /** Also write the development overlay. */
  readonly dev?: boolean;
  /** The dashboard's log relay (it mounts the Docker socket). */
  readonly dashboardLogs?: boolean;
}

/** The resolved options, and what detection found (for the report). */
export interface ResolvedDocker {
  /** What the templates are rendered with. */
  readonly options: DockerOptions;
  /** What detection found. */
  readonly detection: StackDetection;
  /** Warnings to show (detection's, plus anything resolving dropped). */
  readonly warnings: readonly string[];
}

/**
 * The stack a static (SPA) image gets: no server for a database or a store to serve, so the
 * detected services are dropped with a warning — and asking for one explicitly is an error.
 *
 * @throws When a stack service (or `--stack`) was asked for explicitly.
 */
function withoutServerServices(
  stack: StackOptions,
  request: DockerRequest,
  warnings: string[],
): StackOptions {
  const asked = STACK_FEATURES.filter((f) => request.overrides?.[f] === true);
  if (asked.length || request.all) {
    throw new Error(
      `denext: the static (SPA) image has no server for ${
        asked.length ? asked.map((f) => `--${f}`).join(", ") : "--stack"
      } — use the server image (\`denext generate docker server\`).`,
    );
  }
  warnings.push("static (SPA) image: the detected stack services were left out.");
  return {
    ...stack,
    postgres: false,
    pgvector: false,
    storage: false,
    migrate: false,
    dashboard: false,
  };
}

/** `--dashboard-logs`, when the dashboard it serves is there (else left out, with a warning). */
function dashboardLogsOf(
  request: DockerRequest,
  stack: StackOptions,
  warnings: string[],
): { dashboardLogs?: true } {
  if (!request.dashboardLogs) return {};
  if (stack.dashboard) return { dashboardLogs: true };
  warnings.push("--dashboard-logs needs the dashboard (and Postgres): the relay was left out.");
  return {};
}

/**
 * Resolve a Docker request against the project: the image mode, the detected stack, and the
 * explicit switches on top. A static (SPA) image has no server for a database or a store to
 * serve, so detected services are dropped there with a warning — and asking for one explicitly
 * is an error.
 *
 * @param dir The project root.
 * @param request The flags.
 * @returns The options to render, the detection, and the warnings.
 * @throws When the target is unknown, or a stack service is asked for on a static image.
 */
export async function resolveDocker(
  dir: string,
  request: DockerRequest = {},
): Promise<ResolvedDocker> {
  const mode = await detectDockerMode(dir, request.target || undefined);
  const detection = await detectDockerStack(dir);
  const warnings = [...detection.warnings];
  let stack = resolveStack(detection, request.overrides, request.all === true);
  if (mode === "static" && isStack(stack)) stack = withoutServerServices(stack, request, warnings);
  const options: DockerOptions = {
    ...stack,
    mode,
    ...(request.port !== undefined ? { port: request.port } : {}),
    ...(request.denoTag ? { denoTag: request.denoTag } : {}),
    ...(request.exposeDb ? { exposeDb: true } : {}),
    ...(request.dev ? { dev: true } : {}),
    ...dashboardLogsOf(request, stack, warnings),
  };
  return { options, detection, warnings };
}

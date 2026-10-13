// Which services `denext generate docker` puts in a project's stack, read from the project
// itself: `@denext/backend` (or a Postgres `DATABASE_URL`) → Postgres; an `s3()` storage driver
// → MinIO with its bucket; `migrations/` with `jobs/migrate.ts` → the migrations service; a
// `vector` extension in a migration → the pgvector image. Every decision carries the reason it
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

/** The stack services a flag (or a detection) switches on and off. */
export const STACK_FEATURES = ["postgres", "pgvector", "storage", "migrate"] as const;

/** One of {@linkcode STACK_FEATURES}. */
export type StackFeature = typeof STACK_FEATURES[number];

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
  /** The S3 bucket named literally in `s3({ bucket: "…" })`, when there is one. */
  readonly bucket?: string;
  /** The `deno run -A` arguments that run denext's CLI (`--config deno.json jsr:…/cli`). */
  readonly cli: readonly string[];
  /** What the migrations service runs. */
  readonly migrateCommand: readonly string[];
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

/** What the migrations service runs: the project's `migrate` task, else `denext job migrate`. */
function migrateCommandOf(json: Record<string, unknown>, cli: readonly string[]): string[] {
  const tasks = (json.tasks ?? {}) as Record<string, unknown>;
  if (tasks.migrate !== undefined) return ["deno", "task", "migrate"];
  return ["deno", "run", "-A", ...cli, "job", "migrate"];
}

/** `s3({ … bucket: "name" … })` — the bucket when it is a literal. */
const S3_BUCKET =
  /\bs3\s*\(\s*\{[^}]*?\bbucket\s*:\s*["'`]([a-z0-9][a-z0-9.\-]{1,61}[a-z0-9])["'`]/;

/** `create extension [if not exists] vector` in a migration. */
const VECTOR_EXTENSION = /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?["']?vector\b/i;

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

  const hasMigrations = await exists(join(dir, "migrations"));
  const hasRunner = await exists(join(dir, "jobs", "migrate.ts"));
  if (hasMigrations && hasRunner) reasons.migrate = "migrations/ + jobs/migrate.ts";
  else if (hasMigrations) {
    warnings.push(
      "migrations/ has no jobs/migrate.ts runner — `denext generate migration <name>` writes one; " +
        "the migrations service stays off until it exists (or pass --migrate).",
    );
  }
  if (VECTOR_EXTENSION.test(await migrationsText(dir)) || /\bpgvector\b/.test(config)) {
    reasons.pgvector = "the vector extension in migrations/";
  }

  const bucket = s3 ? S3_BUCKET.exec(config)?.[1] : undefined;
  return {
    features: {
      postgres: reasons.postgres !== undefined,
      pgvector: reasons.pgvector !== undefined,
      storage: reasons.storage !== undefined,
      migrate: reasons.migrate !== undefined,
    },
    reasons,
    auth: /\bdenextAuth\s*\(/.test(config),
    backend,
    backendStorage: backendInConfig && /\bstorage\s*:/.test(config),
    ...(bucket ? { bucket } : {}),
    cli,
    migrateCommand: migrateCommandOf(json, cli),
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
    auth: detection.auth,
    backend: detection.backend,
    backendStorage: detection.backendStorage,
    ...(detection.bucket ? { bucket: detection.bucket } : {}),
    cli: detection.cli,
    migrateCommand: detection.migrateCommand,
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
  if (mode === "static" && isStack(stack)) {
    const asked = STACK_FEATURES.filter((f) => request.overrides?.[f] === true);
    if (asked.length || request.all) {
      throw new Error(
        `denext: the static (SPA) image has no server for ${
          asked.length ? asked.map((f) => `--${f}`).join(", ") : "--stack"
        } — use the server image (\`denext generate docker server\`).`,
      );
    }
    warnings.push("static (SPA) image: the detected stack services were left out.");
    stack = { ...stack, postgres: false, pgvector: false, storage: false, migrate: false };
  }
  const options: DockerOptions = {
    ...stack,
    mode,
    ...(request.port !== undefined ? { port: request.port } : {}),
    ...(request.denoTag ? { denoTag: request.denoTag } : {}),
    ...(request.exposeDb ? { exposeDb: true } : {}),
    ...(request.dev ? { dev: true } : {}),
  };
  return { options, detection, warnings };
}

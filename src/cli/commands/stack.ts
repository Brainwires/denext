// `denext stack <up|down|status|logs>` — the Supabase CLI's `start` / `stop` / `status` over the
// Docker Compose stack `denext generate docker` writes:
//
//   up [--dev] [--build] [generate docker flags]   write the stack when it is missing (with
//        --stack unless flags say otherwise), fill a missing .env with generated secrets, then
//        `docker compose up -d --wait`, then print `status`
//   down [--volumes]                               `docker compose down` (-v drops the data)
//   status [--json] [--show-secrets]               the API URL, the database URL, the keys
//   logs [service] [--follow]                      `docker compose logs`
//
// Secrets: `status` prints the publishable key; the secret key, the database password and
// the S3 secret only with --show-secrets. A generated .env is written 0600.

import { join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { parseEnv } from "../../server/env.ts";
import { generateSupabaseKeys } from "../../server/auth/gotrue/keys.ts";
import { DOCKER_FLAGS, runDocker } from "./generate-docker.ts";

/** How the verb reaches Docker and the files (injectable for tests). */
export interface StackIo {
  /** Run `docker` with `args` in `cwd`; output streams through unless `capture`. */
  docker(
    args: string[],
    cwd: string,
    capture: boolean,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Write `docker-compose.yml` & co. (`denext generate docker`). */
  generate(ctx: CommandContext, dir: string): Promise<void>;
  log(line: string): void;
  error(line: string): void;
}

/**
 * Run `docker` (the default {@linkcode StackIo.docker}): streamed through, or captured.
 *
 * @param args The arguments.
 * @param cwd The project.
 * @param capture Capture stdout / stderr instead of streaming them.
 * @returns The exit code and the captured output.
 */
export async function dockerCli(
  args: string[],
  cwd: string,
  capture: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = capture ? "piped" : "inherit";
  const out = await new Deno.Command("docker", { args, cwd, stdout: io, stderr: io }).output()
    .catch((error) => {
      throw error instanceof Deno.errors.NotFound
        ? new Error("docker is not on PATH: install Docker (with the compose plugin)")
        : error;
    });
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return {
    code: out.code,
    stdout: capture ? text(out.stdout) : "",
    stderr: capture ? text(out.stderr) : "",
  };
}

const defaultIo: StackIo = {
  docker: dockerCli,
  generate: (ctx, dir) => runDocker(ctx, dir, "", {}),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The compose files: the stack, plus the dev overlay with `--dev`. */
function composeArgs(ctx: CommandContext): string[] {
  const files = ["-f", "docker-compose.yml"];
  if (ctx.flags.dev === true) files.push("-f", "compose.dev.yml");
  return ["compose", ...files];
}

/** Random bytes as hex / base64. */
function random(kind: "hex" | "base64", bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return kind === "hex"
    ? Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("")
    : btoa(String.fromCharCode(...data));
}

/** The value `.env.example`'s `# Generate:` hint asks for, or `undefined` when it can't make one. */
async function generated(
  name: string,
  hint: string,
  keys: () => Promise<Awaited<ReturnType<typeof generateSupabaseKeys>>>,
): Promise<string | undefined> {
  if (hint.includes("rand -hex")) return random("hex", 24);
  if (hint.includes("rand -base64")) return random("base64", 32);
  if (!hint.startsWith("denext backend keys") || hint.includes("--legacy")) return undefined;
  const k = await keys();
  const values: Record<string, string> = {
    DENEXT_PUBLISHABLE_KEY: k.publishableKey,
    DENEXT_SECRET_KEY: k.secretKey,
    DENEXT_JWT_SIGNING_KEYS: `'${JSON.stringify([k.signingKey])}'`,
  };
  return values[name];
}

/**
 * `.env.example` with every empty secret filled in: random passwords and keys, and a fresh
 * `denext backend keys` set for the Supabase keys.
 *
 * @param example The `.env.example` text.
 * @returns The `.env` text, and the names it filled.
 */
export async function fillEnv(example: string): Promise<{ text: string; filled: string[] }> {
  let cached: Awaited<ReturnType<typeof generateSupabaseKeys>> | undefined;
  const keys = async () => cached ??= await generateSupabaseKeys({ legacy: false });
  const filled: string[] = [];
  const lines: string[] = [];
  let hint = "";
  for (const line of example.split("\n")) {
    const empty = /^([A-Z][A-Z0-9_]*)=$/.exec(line);
    const value = empty && hint ? await generated(empty[1], hint, keys) : undefined;
    if (value !== undefined) filled.push(empty![1]);
    lines.push(value !== undefined ? `${empty![1]}=${value}` : line);
    hint = /^#\s*Generate:\s*(.+)$/.exec(line)?.[1].trim() ?? (line.startsWith("#") ? hint : "");
  }
  return { text: lines.join("\n"), filled };
}

/** One service of `docker compose ps --format json`. */
interface PsRow {
  Service: string;
  State: string;
  Health?: string;
  Publishers?: { URL?: string; TargetPort: number; PublishedPort: number }[];
}

/** `docker compose ps --format json`: one JSON array, or one object per line (older compose). */
export function parsePs(text: string): PsRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as PsRow[];
  return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as PsRow);
}

/** The loopback URL a service's published port answers on. */
function published(row: PsRow | undefined, target?: number): number | undefined {
  const pub = row?.Publishers?.find((p) =>
    p.PublishedPort > 0 && (target === undefined || p.TargetPort === target)
  );
  return pub?.PublishedPort;
}

/** What `status` reports. */
export interface StackStatus {
  services: { name: string; state: string; health?: string }[];
  apiUrl?: string;
  restUrl?: string;
  databaseUrl?: string;
  s3Url?: string;
  publishableKey?: string;
  secretKey?: string;
}

/**
 * The stack's status from `docker compose ps` and `.env`.
 *
 * @param rows The services.
 * @param env The `.env` values.
 * @param showSecrets Include the secret key and the passwords.
 * @returns The status.
 */
export function stackStatus(
  rows: PsRow[],
  env: Record<string, string>,
  showSecrets: boolean,
): StackStatus {
  const by = (name: string) => rows.find((r) => r.Service === name);
  const status: StackStatus = {
    services: rows.map((r) => ({
      name: r.Service,
      state: r.State,
      ...(r.Health ? { health: r.Health } : {}),
    })),
  };
  const web = published(by("web"));
  if (web) {
    status.apiUrl = `http://localhost:${web}`;
    status.restUrl = `${status.apiUrl}/rest/v1`;
  }
  const db = published(by("db"), 5432);
  if (db) {
    const user = env.POSTGRES_USER || "denext";
    const password = showSecrets ? env.POSTGRES_PASSWORD ?? "" : "•••";
    status.databaseUrl = `postgres://${user}:${password}@localhost:${db}/${
      env.POSTGRES_DB || "denext"
    }`;
  }
  const s3 = published(by("minio"), 9000);
  if (s3) status.s3Url = `http://localhost:${s3}`;
  if (env.DENEXT_PUBLISHABLE_KEY) status.publishableKey = env.DENEXT_PUBLISHABLE_KEY;
  if (showSecrets && env.DENEXT_SECRET_KEY) status.secretKey = env.DENEXT_SECRET_KEY;
  return status;
}

async function readEnvFile(dir: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await Deno.readTextFile(join(dir, ".env")));
  } catch {
    return {};
  }
}

async function statusAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const ps = await io.docker([...composeArgs(ctx), "ps", "--all", "--format", "json"], dir, true);
  if (ps.code !== 0) throw new Error(`docker compose ps failed: ${ps.stderr.trim()}`);
  const status = stackStatus(
    parsePs(ps.stdout),
    await readEnvFile(dir),
    ctx.flags["show-secrets"] === true,
  );
  if (ctx.global.json) {
    io.log(JSON.stringify(status, null, 2));
    return;
  }
  if (!status.services.length) {
    io.log("The stack is not running (denext stack up).");
    return;
  }
  for (const s of status.services) {
    io.log(`  ${s.name.padEnd(12)} ${s.state}${s.health ? ` (${s.health})` : ""}`);
  }
  const rows: [string, string | undefined][] = [
    ["API URL", status.apiUrl],
    ["REST URL", status.restUrl],
    ["DB URL", status.databaseUrl],
    ["S3 URL", status.s3Url],
    ["Publishable key", status.publishableKey],
    ["Secret key", status.secretKey],
  ];
  io.log("");
  for (const [label, value] of rows) if (value) io.log(`  ${label.padEnd(16)} ${value}`);
  if (!status.secretKey) io.log("  (the secret key and passwords: --show-secrets)");
}

/**
 * The stack's Postgres data volume when it already exists (Postgres keeps the password it was
 * initialised with), else `undefined` — also when compose or Docker can't say.
 */
async function existingDbVolume(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
): Promise<string | undefined> {
  const config = await io.docker(
    [...composeArgs(ctx), "config", "--no-interpolate", "--format", "json"],
    dir,
    true,
  );
  if (config.code !== 0) return undefined;
  let parsed: { name?: unknown; services?: Record<string, unknown> };
  try {
    parsed = JSON.parse(config.stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed.name !== "string" || !parsed.services?.db) return undefined;
  const volume = `${parsed.name}_db-data`;
  const inspect = await io.docker(["volume", "inspect", volume], dir, true);
  return inspect.code === 0 ? volume : undefined;
}

/**
 * Fill a missing `.env` from `.env.example` with generated secrets — unless the stack's database
 * volume already exists (its superuser password would no longer match).
 */
async function writeEnvIfMissing(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const envPath = join(dir, ".env");
  if (!await exists(envPath) && await exists(join(dir, ".env.example"))) {
    const volume = await existingDbVolume(ctx, dir, io);
    if (volume) {
      throw new Error(
        `.env is missing but the database volume ${volume} already exists: a new .env would ` +
          "generate a POSTGRES_PASSWORD that database does not accept (every query would fail " +
          'with "password authentication failed"). Restore the .env it was created with, or ' +
          "drop the data first: denext stack down --volumes",
      );
    }
    const { text, filled } = await fillEnv(await Deno.readTextFile(join(dir, ".env.example")));
    await Deno.writeTextFile(envPath, text, { mode: 0o600 });
    io.log(`Wrote .env from .env.example with generated secrets (${filled.join(", ")}).`);
  }
}

async function upAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  if (!await exists(join(dir, "docker-compose.yml"))) {
    const custom = DOCKER_FLAGS.some((f) => ctx.flags[f.name] !== undefined && f.name !== "dev");
    await io.generate(custom ? ctx : { ...ctx, flags: { ...ctx.flags, stack: true } }, dir);
  }
  if (ctx.flags.dev === true && !await exists(join(dir, "compose.dev.yml"))) {
    throw new Error("--dev needs compose.dev.yml: denext generate docker --dev --force");
  }
  await writeEnvIfMissing(ctx, dir, io);
  const args = [...composeArgs(ctx), "up", "-d", "--wait"];
  if (ctx.flags.build === true) args.push("--build");
  const up = await io.docker(args, dir, false);
  if (up.code !== 0) throw new Error(`docker compose up exited ${up.code}`);
  await statusAction(ctx, dir, io);
}

async function downAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const args = [...composeArgs(ctx), "down"];
  if (ctx.flags.volumes === true) args.push("--volumes");
  const down = await io.docker(args, dir, false);
  if (down.code !== 0) throw new Error(`docker compose down exited ${down.code}`);
  io.log(ctx.flags.volumes === true ? "Stopped; the data volumes were removed." : "Stopped.");
}

async function logsAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const args = [...composeArgs(ctx), "logs"];
  if (ctx.flags.follow === true) args.push("--follow");
  if (ctx.positionals[1]) args.push(ctx.positionals[1]);
  const logs = await io.docker(args, dir, false);
  if (logs.code !== 0) throw new Error(`docker compose logs exited ${logs.code}`);
}

const ACTIONS: Record<string, typeof upAction> = {
  up: upAction,
  down: downAction,
  status: statusAction,
  logs: logsAction,
};

/**
 * Run one `denext stack` action; resolves the exit code.
 *
 * @param ctx The invocation.
 * @param io Docker and file access.
 * @returns The exit code.
 */
export async function runStack(ctx: CommandContext, io: StackIo = defaultIo): Promise<number> {
  const name = ctx.positionals[0] ?? "";
  const action = ACTIONS[name];
  if (!action) {
    io.error(
      `denext stack: ${
        name ? `unknown action "${name}"` : "no action"
      } (expected up | down | status | logs)`,
    );
    return 1;
  }
  try {
    await action(ctx, ctx.global.cwd ?? ".", io);
    return 0;
  } catch (error) {
    io.error(`denext stack ${name}: ${(error as Error)?.message ?? error}`);
    return 1;
  }
}

export const stackCommand: CommandSpec = {
  name: "stack",
  summary:
    "Start, stop and inspect the local Docker stack (app, Postgres, MinIO), like supabase start",
  usage: [
    "Usage: denext stack <up|down|status|logs> [flags]",
    "",
    "  up      Write the stack if missing (denext generate docker --stack, or your flags), fill a",
    "          missing .env with generated secrets, docker compose up -d --wait, then status",
    "          (--dev: the dev overlay; --build: rebuild the app image)",
    "  down    Stop it (--volumes also drops the database and storage data)",
    "  status  The API, REST, database and S3 URLs and the publishable key (--json;",
    "          --show-secrets adds the secret key and the passwords)",
    "  logs    docker compose logs [service] (--follow)",
  ].join("\n"),
  positionals: [
    { name: "action", help: "up | down | status | logs", required: true },
    { name: "service", help: "logs: one service" },
  ],
  flags: [
    { name: "build", type: "boolean", help: "up: rebuild the app image" },
    { name: "volumes", type: "boolean", help: "down: remove the data volumes too" },
    { name: "follow", type: "boolean", help: "logs: keep following" },
    { name: "show-secrets", type: "boolean", help: "status: print the secret key and passwords" },
    ...DOCKER_FLAGS,
  ],
  run: async (ctx) => {
    const dir = resolve(ctx.global.cwd ?? ".");
    const code = await runStack({ ...ctx, global: { ...ctx.global, cwd: dir } });
    if (code !== 0) Deno.exit(code);
  },
};

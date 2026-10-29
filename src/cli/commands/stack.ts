// `denext stack <action>` — the Supabase CLI's `start` / `stop` / `status` and the self-hosted
// stack's operations, over the Docker Compose stack `denext generate docker` writes:
//
//   up [--dev] [--build] [generate docker flags]   write the stack when it is missing (with
//        --stack unless flags say otherwise), fill a missing .env with generated secrets, then
//        `docker compose up -d --wait`, then print `status`
//   down [--volumes]                               `docker compose down` (-v drops the data)
//   status [--json] [--show-secrets]               the API URL, the database URL, the keys
//   logs [service] [filters] [--follow]            `docker compose logs` (stack-health.ts)
//   health [--json] [--watch [s]]                  every service's health check + the app's
//   passwd / roll                                  change passwords / keys (stack-ops.ts)
//   backup / restore                               the database and storage (stack-backup.ts)
//
// Secrets: `status` prints the publishable key; the secret key, the database password and
// the S3 secret only with --show-secrets. A generated .env is written 0600.

import { join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { generateSupabaseKeys } from "../../server/auth/gotrue/keys.ts";
import { exitedOutput } from "../../build/exited-output.ts";
import { DOCKER_FLAGS, runDocker } from "./generate-docker.ts";
import { backupAction, restoreAction } from "./stack-backup.ts";
import { generatePassword } from "./stack-env.ts";
import { healthAction, logsAction } from "./stack-health.ts";
import {
  composeArgs,
  exists,
  hostFreeBytes,
  NO_DOCKER,
  type PsRow,
  psRows,
  published,
  readEnvFile,
  type StackIo,
  terminalIo,
} from "./stack-io.ts";
import { passwdAction, rollAction } from "./stack-ops.ts";

/**
 * How long a probe of Docker ({@linkcode dockerProbe}) may take: a healthy engine answers `ps` /
 * `config` / `info` in well under a second, and a wedged one never does.
 */
const DOCKER_PROBE_DEADLINE_MS = 30_000;

/**
 * Whether `args` only ask Docker a question (`compose ps`, `compose config`, `compose version`,
 * `info`, `version`, `volume inspect`, …): the calls a hung engine must not hang the CLI on. The
 * work a person asked for (`up`, `logs --follow`, a backup's `cp`, `stop`) is never one: it takes
 * as long as it takes.
 *
 * @param args The `docker` arguments.
 * @returns Whether the call is a probe.
 */
export function dockerProbe(args: readonly string[]): boolean {
  let i = 0;
  if (args[0] === "compose") {
    i = 1;
    // The compose file / project flags before the subcommand (`-f docker-compose.yml`).
    while (i < args.length && args[i].startsWith("-")) {
      i += /^-[fp]$|^--(file|project-name|env-file)$/.test(args[i]) ? 2 : 1;
    }
    return ["ps", "config", "version", "ls", "images"].includes(args[i] ?? "");
  }
  if (["info", "version"].includes(args[i] ?? "")) return true;
  return ["volume", "image", "container", "network"].includes(args[i] ?? "") &&
    ["inspect", "ls"].includes(args[i + 1] ?? "");
}

/** The error for a Docker probe still running at its deadline. */
function dockerUnresponsive(args: readonly string[], deadlineMs: number): string {
  return `Docker did not answer \`docker ${args.join(" ")}\` within ${deadlineMs / 1000} s: ` +
    "the Docker engine looks unresponsive. Restart Docker (Docker Desktop: Troubleshoot → " +
    "Restart) and try again.";
}

/** Kill `pid` and its children, by that exact pid (`taskkill /T` on Windows, `pkill -P` elsewhere). */
async function killDockerTree(pid: number): Promise<void> {
  const [cmd, ...args] = Deno.build.os === "windows"
    ? ["taskkill", "/PID", String(pid), "/T", "/F"]
    : ["pkill", "-KILL", "-P", String(pid)];
  await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output().catch(() => {});
  try {
    Deno.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

/**
 * A captured {@linkcode dockerProbe} call with a deadline: past it the `docker` process and its
 * children (the compose plugin) are killed and the call throws {@linkcode dockerUnresponsive}.
 */
async function boundedDocker(
  args: string[],
  cwd: string,
  deadlineMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("docker", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw error instanceof Deno.errors.NotFound ? new Error(NO_DOCKER) : error;
  }
  const output = exitedOutput(child, { stdout: true, stderr: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => timer = setTimeout(() => r("late"), deadlineMs));
  const done = await Promise.race([output, late]);
  clearTimeout(timer);
  if (done === "late") {
    await killDockerTree(child.pid);
    await output.catch(() => {});
    throw new Error(dockerUnresponsive(args, deadlineMs));
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: done.code, stdout: text(done.stdout), stderr: text(done.stderr) };
}

/**
 * Run `docker` (the default {@linkcode StackIo.docker}): streamed through, or captured. A captured
 * probe ({@linkcode dockerProbe}) gets `probeDeadlineMs`.
 *
 * @param args The arguments.
 * @param cwd The project.
 * @param capture Capture stdout / stderr instead of streaming them.
 * @param probeDeadlineMs The deadline of a probe.
 * @returns The exit code and the captured output.
 */
export async function dockerCli(
  args: string[],
  cwd: string,
  capture: boolean,
  probeDeadlineMs: number = DOCKER_PROBE_DEADLINE_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (capture && dockerProbe(args)) return await boundedDocker(args, cwd, probeDeadlineMs);
  const io = capture ? "piped" : "inherit";
  let out: Deno.CommandOutput;
  try {
    // `output()` throws a missing binary synchronously, so a `.catch()` on it never sees one.
    out = await new Deno.Command("docker", { args, cwd, stdout: io, stderr: io }).output();
  } catch (error) {
    throw error instanceof Deno.errors.NotFound ? new Error(NO_DOCKER) : error;
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return {
    code: out.code,
    stdout: capture ? text(out.stdout) : "",
    stderr: capture ? text(out.stderr) : "",
  };
}

const defaultIo: StackIo = {
  ...terminalIo,
  docker: dockerCli,
  generate: (ctx, dir) => runDocker(ctx, dir, "", {}),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  freeBytes: hostFreeBytes,
};

/** The value `.env.example`'s `# Generate:` hint asks for, or `undefined` when it can't make one. */
async function generated(
  name: string,
  hint: string,
  keys: () => Promise<Awaited<ReturnType<typeof generateSupabaseKeys>>>,
): Promise<string | undefined> {
  if (hint.includes("rand -hex")) return generatePassword(24);
  if (hint.includes("rand -base64")) {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  }
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

/** What `status` reports. */
export interface StackStatus {
  services: { name: string; state: string; health?: string }[];
  apiUrl?: string;
  restUrl?: string;
  databaseUrl?: string;
  s3Url?: string;
  dashboardUrl?: string;
  dashboardPassword?: string;
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
  const dashboard = published(by("dashboard"), 3100);
  if (dashboard) {
    // 127.0.0.1, not localhost: the dashboard's session cookie stays on the address it is opened at.
    status.dashboardUrl = `http://127.0.0.1:${dashboard}`;
    if (showSecrets && env.DASHBOARD_PASSWORD) status.dashboardPassword = env.DASHBOARD_PASSWORD;
  }
  if (env.DENEXT_PUBLISHABLE_KEY) status.publishableKey = env.DENEXT_PUBLISHABLE_KEY;
  if (showSecrets && env.DENEXT_SECRET_KEY) status.secretKey = env.DENEXT_SECRET_KEY;
  return status;
}

async function statusAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const status = stackStatus(
    await psRows(ctx, dir, io),
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
    ["Dashboard URL", status.dashboardUrl],
    ["Dashboard password", status.dashboardPassword],
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

/** One action: resolves nothing (success) or an exit code. */
type StackAction = (ctx: CommandContext, dir: string, io: StackIo) => Promise<void | number>;

const ACTIONS: Record<string, StackAction> = {
  up: upAction,
  down: downAction,
  status: statusAction,
  logs: logsAction,
  health: healthAction,
  passwd: passwdAction,
  roll: rollAction,
  backup: backupAction,
  restore: restoreAction,
};

/** The actions, as help and completions list them. */
const ACTION_NAMES = Object.keys(ACTIONS).join(" | ");

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
      `denext stack: ${name ? `unknown action "${name}"` : "no action"} (expected ${ACTION_NAMES})`,
    );
    return 1;
  }
  try {
    return await action(ctx, ctx.global.cwd ?? ".", io) ?? 0;
  } catch (error) {
    io.error(`denext stack ${name}: ${(error as Error)?.message ?? error}`);
    return 1;
  }
}

export const stackCommand: CommandSpec = {
  name: "stack",
  summary:
    "Start, stop, inspect and operate the local Docker stack (app, Postgres, MinIO), like supabase start",
  usage: [
    "Usage: denext stack <action> [flags]",
    "",
    "  up       Write the stack if missing (denext generate docker --stack, or your flags), fill",
    "           a missing .env with generated secrets, docker compose up -d --wait, then status",
    "           (--dev: the dev overlay; --build: rebuild the app image)",
    "  down     Stop it (--volumes also drops the database and storage data)",
    "  status   The API, REST, database and S3 URLs and the publishable key (--json;",
    "           --show-secrets adds the secret key and the passwords)",
    "  logs     docker compose logs [service] (--follow). Filters: --service <s> (repeatable),",
    "           --level debug|info|warn|error (that level and above), --since / --until",
    "           (2026-10-14T09:00:00Z or 30m), --grep <text> or --grep '/regex/i'",
    "  health   Each service's health check and the app's /_denext/health checks, as a table",
    "           (--json; --watch [seconds], default 5). Exits 1 when anything is unhealthy",
    "  passwd   New passwords: --postgres (the superuser from stdin or --generate, the app",
    "           role a fresh one; ALTER ROLE runs in the database first) and / or --dashboard",
    "           (DASHBOARD_PASSWORD). One password per line on stdin; never as an argument",
    "  roll     New publishable and secret keys; --include-secret also new JWT signing keys /",
    "           DENEXT_JWT_SECRET, which ends every issued token (confirm, or --yes).",
    "           --keep-old starts a rotation: the previous keys stay valid next to the new",
    "           ones (the legacy DENEXT_JWT_SECRET is left as it is); --drop-old finishes it",
    "  backup   [file] The database (pg_dump custom format, default under .denext/backups/);",
    "           --full: one .tar.gz with roles, extensions, the dump, settings, storage and a",
    "           MANIFEST.txt of the restore order",
    "  restore  <file> A dump or a full backup (detected); a database with tables needs --yes.",
    "           A full backup expands to at most --max-size (default: the free space where it",
    "           is extracted, minus a margin). Restore only a backup you trust: its SQL runs",
    "           as the database superuser",
    "",
    "passwd and roll edit .env in place, then --restart recreates the affected containers,",
    "--no-restart leaves them, and with neither a terminal is asked (else the command printed).",
    "--show-secrets prints the new secrets.",
  ].join("\n"),
  positionals: [
    { name: "action", help: ACTION_NAMES, required: true },
    {
      name: "target",
      help: "logs: a service; backup / restore: the file; health --watch: the seconds",
    },
  ],
  flags: [
    { name: "build", type: "boolean", help: "up: rebuild the app image" },
    { name: "volumes", type: "boolean", help: "down: remove the data volumes too" },
    { name: "follow", type: "boolean", help: "logs: keep following" },
    {
      name: "show-secrets",
      type: "boolean",
      help: "status / passwd / roll: print the secret key and passwords",
    },
    {
      name: "service",
      type: "string",
      repeatable: true,
      valueName: "<name>",
      help: "logs: only this service (repeatable)",
    },
    {
      name: "level",
      type: "string",
      valueName: "<level>",
      help: "logs: debug | info | warn | error and above",
    },
    { name: "since", type: "string", valueName: "<time>", help: "logs: from (timestamp or 30m)" },
    { name: "until", type: "string", valueName: "<time>", help: "logs: until (timestamp or 5m)" },
    {
      name: "grep",
      type: "string",
      valueName: "<text>",
      help: "logs: lines containing the text, or matching /regex/flags",
    },
    { name: "watch", type: "boolean", help: "health: repeat every [seconds] (default 5)" },
    {
      name: "dashboard",
      type: "boolean",
      help: "passwd: the dashboard password (DASHBOARD_PASSWORD); up: the dashboard service",
    },
    { name: "generate", type: "boolean", help: "passwd: generate strong passwords" },
    {
      name: "include-secret",
      type: "boolean",
      help: "roll: also the JWT signing keys / DENEXT_JWT_SECRET (ends every issued token)",
    },
    {
      name: "keep-old",
      type: "boolean",
      help: "roll: keep the previous keys valid next to the new ones (a rotation window)",
    },
    {
      name: "drop-old",
      type: "boolean",
      help: "roll: finish a rotation, keeping only the newest key of each kind",
    },
    { name: "restart", type: "boolean", help: "passwd / roll: restart the affected containers" },
    { name: "no-restart", type: "boolean", help: "passwd / roll: leave the containers running" },
    {
      name: "yes",
      type: "boolean",
      help: "roll --include-secret / restore: go ahead without asking",
    },
    { name: "full", type: "boolean", help: "backup: roles, settings, extensions and storage too" },
    {
      name: "max-size",
      type: "string",
      valueName: "<size>",
      help: "restore: the most a full backup may expand to, e.g. 20G (default: the free space " +
        "where it is extracted, minus a margin)",
    },
    {
      name: "storage-dir",
      type: "string",
      valueName: "<dir>",
      help: "backup / restore: the fs storage driver's dir in the app container",
    },
    // `--dashboard` is declared above (passwd's target, and up's docker switch alike).
    ...DOCKER_FLAGS.filter((f) => f.name !== "dashboard"),
  ],
  run: async (ctx) => {
    const dir = resolve(ctx.global.cwd ?? ".");
    const code = await runStack({ ...ctx, global: { ...ctx.global, cwd: dir } });
    if (code !== 0) Deno.exit(code);
  },
};

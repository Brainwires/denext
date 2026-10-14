// `denext stack passwd` and `denext stack roll`: change the stack's passwords and keys in `.env`
// (in place, comments and layout kept, see `stack-env.ts`), then offer to restart the containers
// that read them.
//
//   passwd --postgres | --dashboard [--generate]   a new value per target from stdin (no echo
//        on a terminal) or generated; never from argv, where `ps` would show it. --postgres
//        first runs ALTER ROLE for the superuser and the app role inside the running database,
//        in one transaction, and touches .env only when that succeeded.
//   roll [--include-secret [--yes]]                new publishable and secret keys; with
//        --include-secret also new JWT signing keys / DENEXT_JWT_SECRET (every issued token
//        stops working: warned, then confirmed).
//
// Restarting: --restart recreates the affected containers at once, --no-restart leaves them;
// with neither, a terminal is asked, and anything else gets the command printed.

import { join } from "@std/path";
import type { CommandContext } from "../command.ts";
import { generateSupabaseKeys, SUPABASE_KEY_ENV } from "../../server/auth/gotrue/keys.ts";
import { parseEnv } from "../../server/env.ts";
import { generatePassword, prepareWrite, setEnvValues, writeFileAtomic } from "./stack-env.ts";
import { composeArgs, ioMember, psRows, requireRunning, type StackIo } from "./stack-io.ts";

/** The `.env` variable the stack's dashboard password lives in (Supabase's self-hosted name). */
const DASHBOARD_PASSWORD = "DASHBOARD_PASSWORD";

/** The `.env` text and its parsed values, or an error when the stack has none. */
async function loadEnv(
  dir: string,
): Promise<{ path: string; text: string; env: Record<string, string> }> {
  const path = join(dir, ".env");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new Error(".env is missing: start the stack first (denext stack up)");
  }
  return { path, text, env: parseEnv(text) };
}

/** The `docker compose up` that recreates `services` with the new `.env`. */
function restartArgs(ctx: CommandContext, services: readonly string[]): string[] {
  return [...composeArgs(ctx), "up", "-d", "--wait", ...services];
}

/**
 * After a `.env` change: recreate `services` (`--restart`), leave them (`--no-restart`), ask on a
 * terminal, or print the command.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker and the terminal.
 * @param services The containers that read the changed variables.
 */
async function offerRestart(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  services: readonly string[],
): Promise<void> {
  const args = restartArgs(ctx, services);
  const command = `docker ${args.join(" ")}`;
  if (ctx.flags["no-restart"] === true) {
    io.log(`Not restarted; the change takes effect after: ${command}`);
    return;
  }
  let restart = ctx.flags.restart === true;
  if (!restart && io.isTerminal?.()) {
    restart = await io.confirm?.(`Restart ${services.join(", ")} now?`) ?? false;
  }
  if (!restart) {
    io.log(`Restart to apply it: ${command}`);
    return;
  }
  const up = await io.docker(args, dir, false);
  if (up.code !== 0) throw new Error(`docker compose up exited ${up.code}`);
  io.log(`Restarted ${services.join(", ")}.`);
}

/** Refuse `--restart` with `--no-restart`. */
function checkRestartFlags(ctx: CommandContext): void {
  if (ctx.flags.restart === true && ctx.flags["no-restart"] === true) {
    throw new Error("--restart and --no-restart contradict each other");
  }
}

/** A password typed or piped in, checked for what it has to fit into. */
async function readPassword(io: StackIo, label: string, urlSafe: boolean): Promise<string> {
  const value = (await ioMember(io, "readSecret")(`New ${label} password: `)).trim();
  if (value.length < 12) throw new Error(`the ${label} password needs at least 12 characters`);
  if (urlSafe && !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error(
      `the ${label} password may use only A-Z a-z 0-9 . _ ~ - (it goes into DATABASE_URL); ` +
        "--generate makes one",
    );
  }
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f']/.test(value)) {
    throw new Error(`the ${label} password may not contain a control character or a quote`);
  }
  return value;
}

/** A SQL string literal (standard_conforming_strings: only `'` needs doubling). */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A SQL identifier. */
function sqlIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** The `psql` that runs as the database's superuser inside the db container (local socket). */
const PSQL_AS_SUPERUSER = [
  "sh",
  "-c",
  'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
];

/**
 * ALTER ROLE the superuser and the app role in the running database, in one transaction. The
 * SQL (with the passwords) goes in on stdin, never on a command line.
 */
async function alterPostgresRoles(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  appUser: string,
  passwords: { superuser: string; app: string },
): Promise<void> {
  requireRunning(await psRows(ctx, dir, io), "db");
  const sql = [
    "BEGIN;",
    `ALTER ROLE CURRENT_USER PASSWORD ${sqlLiteral(passwords.superuser)};`,
    `ALTER ROLE ${sqlIdent(appUser)} PASSWORD ${sqlLiteral(passwords.app)};`,
    "COMMIT;",
    "",
  ].join("\n");
  const args = [...composeArgs(ctx), "exec", "-T", "db", ...PSQL_AS_SUPERUSER];
  const out = await ioMember(io, "pipe")(args, dir, { input: sql });
  if (out.code !== 0) {
    throw new Error(
      `ALTER ROLE failed, .env left unchanged: ${out.stderr.trim() || `exit ${out.code}`}`,
    );
  }
}

/** The values `passwd` writes, read or generated per target. */
async function newPasswords(
  ctx: CommandContext,
  io: StackIo,
): Promise<{ postgres?: { superuser: string; app: string }; dashboard?: string }> {
  const generate = ctx.flags.generate === true;
  const out: { postgres?: { superuser: string; app: string }; dashboard?: string } = {};
  if (ctx.flags.postgres === true) {
    out.postgres = {
      superuser: generate ? generatePassword() : await readPassword(io, "Postgres", true),
      // Only the app reads it (from .env, inside DATABASE_URL): always a fresh random one.
      app: generatePassword(),
    };
  }
  if (ctx.flags.dashboard === true) {
    out.dashboard = generate ? generatePassword() : await readPassword(io, "dashboard", false);
  }
  return out;
}

/**
 * `denext stack passwd`: new Postgres (superuser + app role) and / or dashboard passwords.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker and the terminal.
 */
export async function passwdAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  checkRestartFlags(ctx);
  if (ctx.flags.postgres !== true && ctx.flags.dashboard !== true) {
    throw new Error("say which password: --postgres and / or --dashboard");
  }
  const { path, text, env } = await loadEnv(dir);
  const values = await newPasswords(ctx, io);
  const updates: Record<string, string> = {};
  if (values.postgres) {
    updates.POSTGRES_PASSWORD = values.postgres.superuser;
    updates.POSTGRES_APP_PASSWORD = values.postgres.app;
  }
  if (values.dashboard !== undefined) updates[DASHBOARD_PASSWORD] = values.dashboard;
  // Staged before the database changes, so a .env that can't be written stops it first.
  const staged = await prepareWrite(
    path,
    setEnvValues(text, updates, {
      [DASHBOARD_PASSWORD]: "The stack dashboard's password (denext stack passwd --dashboard).",
    }),
  );
  try {
    if (values.postgres) {
      const appUser = env.POSTGRES_APP_USER || "denext_app";
      await alterPostgresRoles(ctx, dir, io, appUser, values.postgres);
    }
  } catch (error) {
    await staged.discard();
    throw error;
  }
  await staged.commit();
  io.log(`Updated .env: ${Object.keys(updates).join(", ")}.`);
  if (ctx.flags["show-secrets"] === true) {
    for (const [name, value] of Object.entries(updates)) io.log(`  ${name}=${value}`);
  } else if (ctx.flags.generate === true) {
    io.log("  (the generated passwords are in .env; --show-secrets prints them)");
  }
  await offerRestart(ctx, dir, io, ["web"]);
}

/** Ask before rolling the JWT keys: a terminal confirms, anything else needs `--yes`. */
async function confirmSecretRoll(ctx: CommandContext, io: StackIo): Promise<void> {
  io.error(
    "Warning: --include-secret replaces the JWT signing keys. Every access token, refresh " +
      "session and legacy anon / service_role JWT already issued stops working; every signed-in " +
      "user has to sign in again.",
  );
  if (ctx.flags.yes === true) return;
  if (io.isTerminal?.() && await io.confirm?.("Roll the JWT signing keys too?")) return;
  throw new Error("not confirmed: pass --yes to roll the JWT signing keys");
}

/** The new values `roll` writes. */
async function rolledKeys(
  env: Record<string, string>,
  text: string,
  includeSecret: boolean,
): Promise<{ updates: Record<string, string>; legacy?: { anon: string; service: string } }> {
  const legacy = includeSecret && !!env[SUPABASE_KEY_ENV.jwtSecret];
  const keys = await generateSupabaseKeys({ legacy });
  const updates: Record<string, string> = {
    [SUPABASE_KEY_ENV.publishableKey]: keys.publishableKey,
    [SUPABASE_KEY_ENV.secretKey]: keys.secretKey,
  };
  if (!includeSecret) return { updates };
  if (new RegExp(`^\\s*(export\\s+)?${SUPABASE_KEY_ENV.signingKeys}\\s*=`, "m").test(text)) {
    updates[SUPABASE_KEY_ENV.signingKeys] = JSON.stringify([keys.signingKey]);
  }
  if (!legacy || !keys.jwtSecret) return { updates };
  updates[SUPABASE_KEY_ENV.jwtSecret] = keys.jwtSecret;
  return { updates, legacy: { anon: keys.anonKey!, service: keys.serviceRoleKey! } };
}

/**
 * `denext stack roll`: new publishable and secret keys; `--include-secret` also new JWT signing
 * keys / legacy JWT secret.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker and the terminal.
 */
export async function rollAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  checkRestartFlags(ctx);
  const { path, text, env } = await loadEnv(dir);
  if (!(SUPABASE_KEY_ENV.publishableKey in env) && !(SUPABASE_KEY_ENV.secretKey in env)) {
    throw new Error(
      `.env has no ${SUPABASE_KEY_ENV.publishableKey} / ${SUPABASE_KEY_ENV.secretKey}: this ` +
        "stack does not use @denext/backend's keys",
    );
  }
  const includeSecret = ctx.flags["include-secret"] === true;
  if (includeSecret) await confirmSecretRoll(ctx, io);
  const { updates, legacy } = await rolledKeys(env, text, includeSecret);
  await writeFileAtomic(path, setEnvValues(text, updates));
  io.log(`Updated .env: ${Object.keys(updates).join(", ")}.`);
  io.log(`  New publishable key: ${updates[SUPABASE_KEY_ENV.publishableKey]}`);
  if (legacy) io.log(`  New legacy anon key: ${legacy.anon}`);
  if (ctx.flags["show-secrets"] === true) {
    io.log(`  New secret key: ${updates[SUPABASE_KEY_ENV.secretKey]}`);
    if (legacy) io.log(`  New legacy service_role key: ${legacy.service}`);
  } else {
    io.log("  (the new secret key is in .env; --show-secrets prints it)");
  }
  io.log("  Clients holding the old keys need the new ones.");
  await offerRestart(ctx, dir, io, ["web"]);
}

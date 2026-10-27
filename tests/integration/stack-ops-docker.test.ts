// `denext stack passwd | health | backup | restore` against a real Postgres container (skipped
// where Docker or its daemon is missing): the new passwords authenticate and `.env` holds them,
// a full backup brings back a dropped table, its rows, a role, its membership, an extension and a
// database setting, and a plain dump restores too.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { runStack } from "../../src/cli/commands/stack.ts";
import { parseEnv } from "../../src/server/env.ts";
import { dockerReady } from "../helpers/docker-probe.ts";

/** The stack's MinIO image (`src/build/docker-stack.ts`), which ships `mc`. */
const MINIO_IMAGE =
  "bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20";

const COMPOSE = `services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \\"$$POSTGRES_USER\\" -d \\"$$POSTGRES_DB\\""]
      interval: 2s
      timeout: 5s
      retries: 30
  minio:
    image: ${MINIO_IMAGE}
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    # The stack's check (src/build/docker-stack.ts): healthy only after the image's setup server
    # was stopped and the real one started, so \`docker compose up --wait\` never returns inside that gap.
    healthcheck:
      test:
        - CMD-SHELL
        - "! grep -qx entrypoint.sh /proc/1/comm && curl -fsS http://127.0.0.1:9000/minio/health/live"
      interval: 2s
      timeout: 5s
      retries: 30
volumes:
  db-data:
`;

const ENV = [
  "# The stack's secrets.",
  "POSTGRES_USER=denext",
  "POSTGRES_PASSWORD=initial-superuser-password",
  "",
  "POSTGRES_APP_USER=denext_app",
  "POSTGRES_APP_PASSWORD=initial-app-password",
  "POSTGRES_DB=denext",
  "MINIO_ROOT_USER=denext",
  "MINIO_ROOT_PASSWORD=minio-root-password",
  "S3_BUCKET=media",
  "",
].join("\n");

async function compose(dir: string, args: string[], input?: string, env: string[] = []) {
  const child = new Deno.Command("docker", {
    args: ["compose", ...args.slice(0, 1), ...env, ...args.slice(1)],
    cwd: dir,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(input));
    await w.close();
  }
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** psql as the superuser over the socket, rows only. */
async function sql(dir: string, query: string): Promise<string> {
  const out = await compose(
    dir,
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "denext",
      "-d",
      "denext",
    ],
    query,
  );
  if (out.code !== 0) throw new Error(out.stderr);
  return out.stdout.trim();
}

/**
 * Whether `user` signs in with `password` over the compose network (the image trusts the socket
 * and loopback; its network address needs the password).
 */
async function signsIn(dir: string, user: string, password: string): Promise<boolean> {
  const out = await compose(
    dir,
    ["exec", "-T", "db", "psql", "-h", "db", "-U", user, "-d", "denext", "-c", "select 1"],
    undefined,
    ["-e", `PGPASSWORD=${password}`],
  );
  return out.code === 0;
}

/** `mc` inside the MinIO container, as its root user. */
async function mc(dir: string, script: string): Promise<string> {
  const out = await compose(dir, [
    "exec",
    "-T",
    "minio",
    "sh",
    "-c",
    'export MC_CONFIG_DIR=/tmp/.mc-test MC_HOST_s="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000"; ' +
    script,
  ]);
  if (out.code !== 0) throw new Error(out.stderr);
  return out.stdout.trim();
}

function ctx(dir: string, positionals: string[], flags: Record<string, string | boolean> = {}) {
  return {
    positionals,
    flags,
    global: { cwd: dir, json: false, verbose: false, quiet: true },
    rest: [],
  };
}

Deno.test({
  name: "stack ops on a real Postgres: passwd, health, full backup (Postgres + MinIO) and restore",
  ignore: !(await dockerReady()),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-stackops-it-" });
    try {
      await Deno.writeTextFile(join(dir, "docker-compose.yml"), COMPOSE);
      await Deno.writeTextFile(join(dir, ".env"), ENV, { mode: 0o600 });
      const up = await compose(dir, ["up", "-d", "--wait"]);
      assertEquals(up.code, 0, up.stderr);
      await sql(
        dir,
        `CREATE ROLE denext_app LOGIN PASSWORD 'initial-app-password';
         CREATE ROLE reader NOLOGIN;
         GRANT reader TO denext_app;
         CREATE EXTENSION pgcrypto;
         CREATE TABLE notes (id int PRIMARY KEY, body text);
         INSERT INTO notes VALUES (1, 'one'), (2, 'two');
         ALTER TABLE notes OWNER TO denext_app;
         ALTER DATABASE denext SET statement_timeout = '7s';
         ALTER ROLE denext_app SET work_mem = '8MB';`,
      );

      await mc(
        dir,
        "mc mb --ignore-existing s/media && echo hello | mc pipe s/media/avatars/a.txt",
      );

      // passwd: both roles change inside the database, then .env.
      assertEquals(
        await runStack(
          ctx(dir, ["passwd"], { postgres: true, generate: true, "no-restart": true }),
        ),
        0,
      );
      const envText = await Deno.readTextFile(join(dir, ".env"));
      const env = parseEnv(envText);
      assertMatch(env.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
      assert(await signsIn(dir, "denext", env.POSTGRES_PASSWORD), "the superuser's new password");
      assert(await signsIn(dir, "denext_app", env.POSTGRES_APP_PASSWORD), "the app's new password");
      assert(!await signsIn(dir, "denext_app", "initial-app-password"), "the old one is gone");
      assert(
        envText.startsWith("# The stack's secrets.\nPOSTGRES_USER=denext\nPOSTGRES_PASSWORD="),
      );
      assertEquals((await Deno.stat(join(dir, ".env"))).mode! & 0o777, 0o600);

      assertEquals(await runStack(ctx(dir, ["health"])), 0);

      // Backups: a plain dump and a full one.
      assertEquals(await runStack(ctx(dir, ["backup", "plain.dump"])), 0);
      assertEquals(await runStack(ctx(dir, ["backup", "full.tar.gz"], { full: true })), 0);

      // Lose things, then restore the full backup.
      await sql(
        dir,
        `DROP TABLE notes; ALTER DATABASE denext RESET statement_timeout;
         ALTER ROLE denext_app RESET work_mem; DROP EXTENSION pgcrypto;
         REVOKE reader FROM denext_app; DROP ROLE reader;
         CREATE TABLE stray (id int);`,
      );
      await mc(dir, "mc rm s/media/avatars/a.txt");
      assertEquals(await runStack(ctx(dir, ["restore", "full.tar.gz"])), 1, "not empty");
      assertEquals(await runStack(ctx(dir, ["restore", "full.tar.gz"], { yes: true })), 0);
      assertEquals(
        await sql(dir, "SELECT string_agg(body, ',' ORDER BY id) FROM notes"),
        "one,two",
      );
      assertEquals(
        await sql(dir, "SELECT tableowner FROM pg_tables WHERE tablename = 'notes'"),
        "denext_app",
      );
      assertEquals(
        await sql(dir, "SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'"),
        "1",
      );
      assertEquals(
        await sql(dir, "SELECT pg_has_role('denext_app', 'reader', 'MEMBER')::text"),
        "true",
      );
      const settings = await sql(
        dir,
        "SELECT string_agg(c, ' ' ORDER BY c) FROM pg_db_role_setting, unnest(setconfig) c",
      );
      assertMatch(settings, /statement_timeout=7s/);
      assertMatch(settings, /work_mem=8MB/);
      assert(await signsIn(dir, "denext_app", env.POSTGRES_APP_PASSWORD), "passwords untouched");
      assertEquals(await mc(dir, "mc cat s/media/avatars/a.txt"), "hello", "the object is back");

      // A plain dump restores over it as well.
      await sql(dir, "DELETE FROM notes WHERE id = 2");
      assertEquals(await runStack(ctx(dir, ["restore", "plain.dump"], { yes: true })), 0);
      assertEquals(await sql(dir, "SELECT count(*) FROM notes"), "2");
    } finally {
      await compose(dir, ["down", "--volumes", "--remove-orphans"]);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

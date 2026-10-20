// Networked e2e: Prisma ORM end to end over `denext/prisma-adapter` (`Deno.SQL`), with no npm
// database driver installed. For SQLite (always) and Postgres (with DENEXT_TEST_POSTGRES_URL),
// it writes a Prisma project with relations and every scalar Prisma maps, runs the real
// `prisma migrate dev` and `prisma generate`, checks node_modules holds no `pg`,
// `better-sqlite3`, `postgres` or `@prisma/adapter-*`, then runs CRUD, relation queries,
// interactive and batch transactions, constraint errors and raw queries through the adapter.
//
// Opt-in + NETWORK-REQUIRED (installs @prisma/client and runs the prisma CLI):
// `deno task test:e2e`. Skipped on a runtime whose Deno.SQL reports no result columns (before
// denext's Deno runtime 3.0.0-rc.1), and when setup can't complete (offline).

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join } from "@std/path";
import { denoSqlHasColumns } from "../../src/server/prisma-adapter/mod.ts";

const ADAPTER_SRC = fromFileUrl(new URL("../../src/server/prisma-adapter/", import.meta.url));
const PRISMA = "npm:prisma@6.19.3";
const PG_URL = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SETUP_TIMEOUT_MS = 300_000;
const reason = (await denoSqlHasColumns())
  ? undefined
  : "needs Deno.SQL result columns (denext's Deno runtime 3.0.0-rc.1+)";

async function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = SETUP_TIMEOUT_MS,
) {
  const out = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(timeoutMs),
  }).output();
  const dec = new TextDecoder();
  return {
    ok: out.success,
    stdout: dec.decode(out.stdout),
    out: dec.decode(out.stdout) + dec.decode(out.stderr),
  };
}

const POSTGRES_ONLY = `
  tags      String[]
  roles     Role[]
  uid       String    @default(uuid()) @db.Uuid
  birthday  DateTime? @db.Date
  wakeAt    DateTime? @db.Time(3)
  seenAt    DateTime? @db.Timestamptz(3)
  scores    Float[]
  bigs      BigInt[]
  decs      Decimal[]
  blobs     Bytes[]
  jsons     Json[]`;

function schema(provider: "sqlite" | "postgresql"): string {
  return `generator client {
  provider        = "prisma-client"
  output          = "../generated/client"
  runtime         = "deno"
  moduleFormat    = "esm"
  previewFeatures = ["queryCompiler", "driverAdapters"]
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  balance   Decimal  @default(0)
  big       BigInt   @default(0)
  score     Float    @default(0)
  active    Boolean  @default(true)
  avatar    Bytes?
  profile   Json?
  createdAt DateTime @default(now())
  posts     Post[]${provider === "postgresql" ? POSTGRES_ONLY : ""}
}

model Post {
  id        Int     @id @default(autoincrement())
  title     String
  published Boolean @default(false)
  author    User    @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId  Int
}
`;
}

// The CRUD script: prints one JSON object of what it saw.
const CRUD = `
import { Prisma, PrismaClient } from "./generated/client/client.ts";
import { PrismaDenoSql } from "denext/prisma-adapter";

const pg = Deno.args[0] === "postgresql";
const prisma = new PrismaClient({ adapter: new PrismaDenoSql(Deno.env.get("DATABASE_URL")!) });
const out: Record<string, unknown> = {};
const extra = pg
  ? {
    tags: ["a", "b,c", '"q"'], roles: ["USER", "ADMIN"], birthday: new Date("1990-05-17T00:00:00Z"),
    wakeAt: new Date("1970-01-01T06:30:15.250Z"), seenAt: new Date("2024-06-01T10:00:00.500Z"),
    scores: [1.5, -2], bigs: [9007199254740993n], decs: [new Prisma.Decimal("1.10")],
    blobs: [new Uint8Array([7])], jsons: [{ a: 1 }, "s"],
  }
  : {};
const ada = await prisma.user.create({
  data: {
    email: "ada@example.com", name: "Ada", role: "ADMIN", balance: new Prisma.Decimal("12.34"),
    big: 9007199254740993n, score: 1.5, avatar: new Uint8Array([1, 2, 255]),
    profile: { langs: ["en", "fr"], n: 1 }, createdAt: new Date("2024-03-10T02:30:00.123Z"),
    posts: { create: [{ title: "First", published: true }, { title: "Draft" }] },
    ...extra,
  } as Prisma.UserCreateInput,
  include: { posts: { orderBy: { id: "asc" } } },
});
const u = ada as unknown as Record<string, unknown>;
out.created = {
  role: ada.role, balance: ada.balance.toString(), big: ada.big.toString(), score: ada.score,
  active: ada.active, avatar: Array.from(ada.avatar!), profile: ada.profile,
  createdAt: ada.createdAt.toISOString(), posts: ada.posts.map((p) => [p.title, p.published]),
  ...(pg
    ? {
      tags: u.tags, roles: u.roles, uid: typeof u.uid, birthday: (u.birthday as Date).toISOString(),
      wakeAt: (u.wakeAt as Date).toISOString(), seenAt: (u.seenAt as Date).toISOString(),
      scores: u.scores, bigs: (u.bigs as bigint[]).map(String), decs: (u.decs as unknown[]).map(String),
      blobs: (u.blobs as Uint8Array[]).map((b) => Array.from(b)), jsons: u.jsons,
    }
    : {}),
};
const found = await prisma.user.findUnique({
  where: { email: "ada@example.com" },
  include: { posts: { where: { published: true } } },
});
out.found = found?.posts.map((p) => p.title);
await prisma.user.update({ where: { id: ada.id }, data: { name: "Ada L.", big: { increment: 1 } } });
const updated = await prisma.user.findFirst({ select: { name: true, big: true, _count: { select: { posts: true } } } });
out.updated = [updated?.name, updated?.big.toString(), updated?._count.posts];
try { await prisma.user.create({ data: { email: "ada@example.com" } }); } catch (e) { out.unique = (e as { code?: string }).code; }
try { await prisma.post.create({ data: { title: "x", authorId: 999999 } }); } catch (e) { out.foreignKey = (e as { code?: string }).code; }
try {
  await prisma.$transaction(async (tx) => {
    await tx.post.create({ data: { title: "rolled back", authorId: ada.id } });
    throw new Error("rollback");
  });
} catch (e) { out.rolledBack = (e as Error).message; }
await prisma.$transaction(async (tx) => {
  await tx.post.create({ data: { title: "committed", authorId: ada.id } });
}, { isolationLevel: "Serializable" });
await prisma.$transaction([prisma.post.create({ data: { title: "batch", authorId: ada.id } })]);
out.posts = (await prisma.post.findMany({ orderBy: { id: "asc" } })).map((p) => p.title);
const raw = await prisma.$queryRaw<{ n: bigint }[]>\`select count(*) as n from "Post" where "authorId" = \${ada.id}\`;
out.raw = Number(raw[0].n);
out.executed = await prisma.$executeRaw\`update "Post" set published = true where "authorId" = \${ada.id}\`;
await prisma.user.delete({ where: { id: ada.id } });
out.afterCascade = await prisma.post.count();
await prisma.$disconnect();
console.log(JSON.stringify(out));
`;

/** Write the project, install, migrate, generate; null (with a warning) when offline. */
async function setUp(dir: string, provider: "sqlite" | "postgresql", env: Record<string, string>) {
  await Deno.mkdir(join(dir, "prisma"), { recursive: true });
  await copy(ADAPTER_SRC, join(dir, "vendor", "prisma-adapter"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      nodeModulesDir: "manual",
      imports: {
        "@prisma/client": "npm:@prisma/client@6.19.3",
        "denext/prisma-adapter": "./vendor/prisma-adapter/mod.ts",
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "prisma", "schema.prisma"), schema(provider));
  await Deno.writeTextFile(join(dir, "crud.ts"), CRUD);
  for (
    const args of [
      ["install"],
      ["run", "-A", "--no-config", PRISMA, "migrate", "dev", "--name", "init", "--skip-generate"],
      ["run", "-A", "--no-config", PRISMA, "generate"],
    ]
  ) {
    const r = await run(args, dir, env);
    if (!r.ok) {
      console.warn(`e2e: \`deno ${args.join(" ")}\` failed (offline?) — skipping.\n${r.out}`);
      return false;
    }
  }
  return true;
}

/** Installed npm packages (`node_modules/.deno/<name>@<version>`). */
async function installed(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(join(dir, "node_modules", ".deno"))) names.push(e.name);
  return names;
}

const EXPECTED_COMMON = {
  role: "ADMIN",
  balance: "12.34",
  big: "9007199254740993",
  score: 1.5,
  active: true,
  avatar: [1, 2, 255],
  profile: { langs: ["en", "fr"], n: 1 },
  createdAt: "2024-03-10T02:30:00.123Z",
  posts: [["First", true], ["Draft", false]],
};

async function crud(provider: "sqlite" | "postgresql", url: (dir: string) => string) {
  const dir = await Deno.makeTempDir({ prefix: `denext-prisma-${provider}-` });
  try {
    const env = { DATABASE_URL: url(dir) };
    if (!(await setUp(dir, provider, env))) return;
    const drivers = (await installed(dir)).filter((n) =>
      /^(pg|pg-[\w-]+|better-sqlite3|postgres|mariadb|@prisma\+adapter-[\w-]+)@/.test(n)
    );
    assertEquals(drivers, [], "no npm database driver is installed");
    // TZ: a zone whose DST gap holds 2024-03-10 02:30 (the createdAt) — read back exactly.
    const r = await run(
      ["run", "-A", "crud.ts", provider],
      dir,
      { ...env, TZ: "America/Chicago" },
      120_000,
    );
    assert(r.ok, r.out);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    const created = provider === "postgresql"
      ? {
        ...EXPECTED_COMMON,
        tags: ["a", "b,c", '"q"'],
        roles: ["USER", "ADMIN"],
        uid: "string",
        birthday: "1990-05-17T00:00:00.000Z",
        wakeAt: "1970-01-01T06:30:15.250Z",
        seenAt: "2024-06-01T10:00:00.500Z",
        scores: [1.5, -2],
        bigs: ["9007199254740993"],
        decs: ["1.1"],
        blobs: [[7]],
        jsons: [{ a: 1 }, "s"],
      }
      : EXPECTED_COMMON;
    assertEquals(out, {
      created,
      found: ["First"],
      updated: ["Ada L.", "9007199254740994", 2],
      unique: "P2002",
      foreignKey: "P2003",
      rolledBack: "rollback",
      posts: ["First", "Draft", "committed", "batch"],
      raw: 4,
      executed: 4,
      afterCascade: 0,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: `e2e: Prisma over denext/prisma-adapter — SQLite${reason ? ` (skipped: ${reason})` : ""}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => crud("sqlite", (dir) => `file:${join(dir, "dev.db")}`),
});

const pgReason = reason ?? (PG_URL ? undefined : "set DENEXT_TEST_POSTGRES_URL");
Deno.test({
  name: `e2e: Prisma over denext/prisma-adapter — Postgres${
    pgReason ? ` (skipped: ${pgReason})` : ""
  }`,
  ignore: pgReason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // A database of its own, so `prisma migrate dev` never resets a shared one.
    const name = `denext_prisma_e2e_${crypto.randomUUID().slice(0, 8)}`;
    const SQL = (Deno as unknown as {
      SQL: new (
        url: string,
      ) => { unsafe(t: string): { simple(): Promise<unknown> }; close(): Promise<void> };
    }).SQL;
    const admin = new SQL(PG_URL!);
    await admin.unsafe(`create database "${name}"`).simple();
    try {
      await crud("postgresql", () => {
        const u = new URL(PG_URL!);
        u.pathname = `/${name}`;
        u.searchParams.set("schema", "public");
        return u.href;
      });
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`).simple();
      await admin.close();
    }
  },
});

// Drives the migrated app's Prisma client against the live database: CRUD over every scalar
// family, relations, interactive and batch transactions (commit and rollback), a unique
// violation's error code, and raw queries. Prints PRISMA CHECK OK when everything held.
import { prisma } from "../lib/db.ts";

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
}

await prisma.post.deleteMany();
await prisma.user.deleteMany();

// CRUD, with JSON, Decimal, BigInt, Bytes and DateTime round-tripping through the adapter.
const ada = await prisma.user.create({
  data: {
    email: "ada@example.com",
    name: "Ada",
    profile: { theme: "dark", tags: ["a", "b"] },
    balance: "12.50",
    visits: 9007199254740993n,
    avatar: new Uint8Array([1, 2, 3]),
  },
});
const read = await prisma.user.findUnique({ where: { id: ada.id } });
check(read?.name === "Ada", "read back the created row");
check(read?.createdAt instanceof Date, "DateTime is a Date");
check((read?.profile as { theme?: string })?.theme === "dark", "Json round-trips");
check(read?.balance?.toString() === "12.5", `Decimal round-trips (${read?.balance})`);
check(read?.visits === 9007199254740993n, `BigInt round-trips (${read?.visits})`);
check(read?.avatar?.[2] === 3 && read?.avatar?.length === 3, "Bytes round-trip");
await prisma.user.update({ where: { id: ada.id }, data: { name: "Ada L." } });
check((await prisma.user.findFirst({ where: { name: "Ada L." } }))?.id === ada.id, "update");

// Relations: a nested create, an include, a relation filter.
await prisma.user.update({
  where: { id: ada.id },
  data: { posts: { create: [{ title: "first" }, { title: "second", published: true }] } },
});
const withPosts = await prisma.user.findUnique({
  where: { id: ada.id },
  include: { posts: { orderBy: { title: "asc" } } },
});
check(withPosts?.posts.map((p) => p.title).join() === "first,second", "include posts");
const published = await prisma.post.findMany({
  where: { published: true, author: { email: "ada@example.com" } },
  include: { author: true },
});
check(published.length === 1 && published[0].author.name === "Ada L.", "relation filter");

// Transactions: interactive commit, interactive rollback, a batch.
await prisma.$transaction(async (tx) => {
  await tx.post.create({ data: { title: "in-tx", authorId: ada.id } });
});
check(await prisma.post.count({ where: { title: "in-tx" } }) === 1, "interactive commit");
await prisma.$transaction(async (tx) => {
  await tx.post.create({ data: { title: "rolled-back", authorId: ada.id } });
  throw new Error("abort");
}).catch(() => {});
check(await prisma.post.count({ where: { title: "rolled-back" } }) === 0, "interactive rollback");
const [, renamed] = await prisma.$transaction([
  prisma.post.create({ data: { title: "batch", authorId: ada.id } }),
  prisma.post.updateMany({ where: { title: "first" }, data: { title: "first!" } }),
]);
check(renamed.count === 1, "batch transaction");

// A unique violation surfaces as Prisma's P2002.
const dup = await prisma.user.create({ data: { email: "ada@example.com", name: "x" } }).then(
  () => null,
  (e: { code?: string }) => e.code,
);
check(dup === "P2002", `unique violation is P2002 (got ${dup})`);

// Raw queries.
const rows = await prisma.$queryRaw<Array<{ title: string; n: bigint | number }>>`
  SELECT title, COUNT(*) AS n FROM posts WHERE author_id = ${ada.id} GROUP BY title ORDER BY title`;
check(rows.map((r) => r.title).join() === "batch,first!,in-tx,second", "$queryRaw rows");
check(Number(rows[0].n) === 1, "$queryRaw aggregate");
const changed = await prisma
  .$executeRaw`UPDATE posts SET published = ${true} WHERE title = ${"batch"}`;
check(changed === 1, `$executeRaw count (${changed})`);
const unsafe = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
  "SELECT email FROM users WHERE name = " +
    (Deno.env.get("PRISMA_PROVIDER") === "mysql" ? "?" : "$1"),
  "Ada L.",
);
check(unsafe[0]?.email === "ada@example.com", "$queryRawUnsafe with a parameter");

// Delete (cascades to the posts).
await prisma.user.delete({ where: { id: ada.id } });
check(await prisma.post.count() === 0, "cascade delete");

await prisma.$disconnect();
console.log("PRISMA CHECK OK");

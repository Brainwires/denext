// `denext migrate` on a `next-auth` app: the major it is written for, the NextAuth.js v4 APIs its
// source uses (a Pages Router `[...nextauth]` route, `getServerSession`, `next-auth/next`,
// `next-auth/middleware`), the Auth.js adapters from its own dependencies, the v4 subpaths in the
// alias map, and the report in `--check` and the CLI output.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { nextAuthMajor, nextAuthMigrateInfo } from "../src/build/next-auth-migrate.ts";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import { migrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** Write `files` under a fresh temp dir. */
async function app(files: Record<string, string | object>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_next_auth_mig_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** A NextAuth.js v4 Pages Router app with an adapter and the v4 middleware. */
const V4_APP = {
  "package.json": {
    name: "v4",
    dependencies: {
      next: "14.2.33",
      react: "18.3.1",
      "react-dom": "18.3.1",
      "next-auth": "^4.24.11",
      "@next-auth/prisma-adapter": "^1.0.7",
      "@auth/drizzle-adapter": "^1.11.3",
    },
  },
  "pages/api/auth/[...nextauth].ts":
    `import NextAuth from "next-auth";\nimport { authOptions } from "../../../lib/auth";\n` +
    `export default NextAuth(authOptions);\n`,
  "pages/index.tsx": `import { getServerSession } from "next-auth/next";\n` +
    `export async function getServerSideProps({ req, res }) {\n` +
    `  return { props: { s: await getServerSession(req, res, {}) } };\n}\n` +
    `export default function Home() { return null; }\n`,
  "middleware.ts": `export { default } from "next-auth/middleware";\n`,
  "lib/auth.ts":
    `import type { Adapter } from "next-auth/adapters";\nexport const authOptions = {};\n`,
};

Deno.test("next-auth migrate: the major a range installs", () => {
  const cases: Array<[string, "v4" | "v5"]> = [
    ["^4.24.11", "v4"],
    ["4.24.11", "v4"],
    ["~4.22.0", "v4"],
    [">=4", "v4"],
    ["latest", "v4"],
    ["*", "v4"],
    ["5.0.0-beta.29", "v5"],
    ["^5.0.0-beta.25", "v5"],
    ["beta", "v5"],
    ["npm:next-auth@5.0.0-beta.30", "v5"],
  ];
  for (const [range, major] of cases) assertEquals(nextAuthMajor(range), major, range);
});

Deno.test("next-auth migrate: a v4 app's APIs, adapters and notes", async () => {
  const dir = await app(V4_APP);
  try {
    const deps = (V4_APP["package.json"] as { dependencies: Record<string, string> }).dependencies;
    const info = await nextAuthMigrateInfo(dir, deps, true);
    assertEquals(info?.version, "v4");
    assertEquals(info?.v4Apis, [
      "pages/api/auth/[...nextauth].ts",
      "next-auth/next",
      "getServerSession",
      "next-auth/middleware",
      "next-auth/adapters",
    ]);
    assertEquals(info?.adapters, ["@auth/drizzle-adapter", "@next-auth/prisma-adapter"]);
    assertStringIncludes(info!.notes[0], "NEXTAUTH_URL");
    assert(info!.notes.some((n) => n.includes('strategy: "database"')));
    // Without the plugin, the Pages API route is called out.
    const unplugged = await nextAuthMigrateInfo(dir, deps, false);
    assert(unplugged!.notes.some((n) => n.includes("@denext/pages-router")));
    assertEquals(await nextAuthMigrateInfo(dir, { next: "15" }, true), undefined);
    const v5 = await nextAuthMigrateInfo(dir, { "next-auth": "5.0.0-beta.29" }, true);
    assertEquals(v5?.version, "v5");
    assertStringIncludes(v5!.notes[0], "AUTH_URL");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-auth migrate: a v4 app's aliases, --check findings and CLI report", async () => {
  const dir = await app(V4_APP);
  try {
    const report = await checkMigration(dir, { denextLocalPath: REPO });
    assertEquals(report.source, "next-pages-router");
    const notes = report.review.filter((f) => f.item === "next-auth").map((f) => f.reason);
    assert(notes.some((n) => n.includes("NEXTAUTH_URL")), JSON.stringify(report.review));
    const result = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(result.nextAuth?.version, "v4");
    const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
    for (
      const [spec, file] of [
        ["next-auth/next", "next.ts"],
        ["next-auth/middleware", "middleware.ts"],
        ["next-auth/adapters", "adapters.ts"],
      ]
    ) {
      assert(String(imports[spec]).endsWith(`/src/compat/next-auth/${file}`), spec);
    }
    // The adapters stay the app's own npm dependencies.
    assert(String(imports["@auth/drizzle-adapter"]).startsWith("npm:@auth/drizzle-adapter@"));
    const cap = capture();
    try {
      await migrateCommand.run(
        makeCtx({ positionals: [dir], flags: { "denext-local-path": REPO } }),
      );
    } finally {
      cap.restore();
    }
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "NextAuth.js v4 detected");
    assertStringIncludes(out, "v4 APIs: pages/api/auth/[...nextauth].ts, next-auth/next");
    assertStringIncludes(out, "adapters (from your dependencies): @auth/drizzle-adapter");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

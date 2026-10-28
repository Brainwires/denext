// `denext upgrade` across 4.x → 5.0 (src/build/upgrade-auth.ts + src/cli/commands/upgrade.ts):
// the auth layer left @denext/denext for @denext/auth, so the upgrade splits the auth imports,
// pins @denext/auth beside denext and points the next-auth aliases at its shim. The fixture
// project (tests/fixtures/upgrade-auth-5) is upgraded in a temp copy and compared file by file
// with its expected result; the registry is injected, so nothing touches the network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import {
  AUTH_KEPT_NAMES,
  AUTH_MOVED_NAMES,
  authSpecifierFor,
  crossesAuthSplit,
  planAuthSourceRewrites,
  rewriteAuthConfig,
  rewriteAuthImports,
} from "../src/build/upgrade-auth.ts";
import type { UpgradeLookups } from "../src/build/upgrade.ts";
import { runUpgrade } from "../src/cli/commands/upgrade.ts";
import type { CommandContext } from "../src/cli/command.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "upgrade-auth-5");

/** Every file under `dir`, relative, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string) => {
    for await (const e of Deno.readDir(at)) {
      const path = join(at, e.name);
      if (e.isDirectory) await walk(path);
      else out.push(relative(dir, path).replaceAll("\\", "/"));
    }
  };
  await walk(dir);
  return out.sort();
}

/** The names a module re-exports (`export { a, type B as C } from …` → `a`, `C`). */
function reexportedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const item of m[1].split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** A fake registry: versions per package, the denext range each declares, publish times. */
function registry(
  packages: Record<string, Record<string, string | null>>,
  published: Record<string, Record<string, string>> = {},
): UpgradeLookups {
  return {
    versions: (name) => {
      const versions = Object.keys(packages[name] ?? {});
      return Promise.resolve(
        versions.length ? { latest: versions.at(-1)!, versions, published: published[name] } : null,
      );
    },
    denextRange: (name, version) => {
      const range = packages[name]?.[version];
      return Promise.resolve(range === undefined ? undefined : range);
    },
  };
}

/** 4.9.0 and 5.0.0 of denext, @denext/auth 5.0.0 pinning denext 5.0.0 exactly. */
const REGISTRY = {
  "@denext/denext": { "4.9.0": null, "5.0.0": null },
  "@denext/auth": { "5.0.0": "5.0.0" },
};

/** Run `denext upgrade` over a temp copy of the fixture's `before/`; returns it and the output. */
async function upgradeFixture(
  flags: Record<string, string | boolean>,
  lookups: UpgradeLookups = registry(REGISTRY),
  options: Parameters<typeof runUpgrade>[3] = {},
  json = false,
) {
  const dir = await Deno.makeTempDir({ prefix: "denext_upgrade_auth_" });
  await copy(join(FIXTURE, "before"), dir, { overwrite: true });
  // A dependency's own sources are never rewritten.
  await Deno.mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  const dep = 'import { denextAuth } from "denext/server";\n';
  await Deno.writeTextFile(join(dir, "node_modules", "dep", "mod.ts"), dep);
  const printed: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.error = console.log;
  try {
    const code = await runUpgrade(
      {
        positionals: [dir],
        flags,
        global: { json, verbose: false, quiet: false },
        rest: [],
      } as CommandContext,
      lookups,
      () => Promise.resolve(true),
      options,
    );
    return { dir, code, out: printed.join("\n"), dep };
  } finally {
    [console.log, console.error] = [log, err];
  }
}

Deno.test("upgrade 4.x → 5.0: every fixture module and deno.json match the expected rewrite", async () => {
  const run = await upgradeFixture({});
  try {
    assertEquals(run.code, 0, run.out);
    const expected = await filesUnder(join(FIXTURE, "after"));
    const actual = (await filesUnder(run.dir)).filter((f) => !f.startsWith("node_modules/"));
    assertEquals(actual, expected);
    for (const file of expected) {
      assertEquals(
        await Deno.readTextFile(join(run.dir, file)),
        await Deno.readTextFile(join(FIXTURE, "after", file)),
        `${file} differs from tests/fixtures/upgrade-auth-5/after/${file}`,
      );
    }
    assertEquals(
      await Deno.readTextFile(join(run.dir, "node_modules", "dep", "mod.ts")),
      run.dep,
      "node_modules is never rewritten",
    );
    assertStringIncludes(run.out, "Moved the auth imports to jsr:@denext/auth@^5.0.0");
    for (const f of ["app/page.tsx", "denext.config.ts", "lib/session.ts", "lib/types.ts"]) {
      assertStringIncludes(run.out, f);
    }
    // The namespace import can't be split: left as is, and named.
    assertStringIncludes(run.out, "lib/everything.ts: import * as server");
  } finally {
    await Deno.remove(run.dir, { recursive: true });
  }
});

Deno.test("upgrade 4.x → 5.0: --dry-run reports the rewrite and writes nothing; --json carries it", async () => {
  const dry = await upgradeFixture({ "dry-run": true });
  try {
    assertEquals(dry.code, 0, dry.out);
    assertStringIncludes(dry.out, "Would move the auth imports to jsr:@denext/auth@^5.0.0");
    for (const file of await filesUnder(join(FIXTURE, "before"))) {
      assertEquals(
        await Deno.readTextFile(join(dry.dir, file)),
        await Deno.readTextFile(join(FIXTURE, "before", file)),
        `${file} was written by a dry run`,
      );
    }
  } finally {
    await Deno.remove(dry.dir, { recursive: true });
  }
  const json = await upgradeFixture({ check: true }, undefined, {}, true);
  try {
    assertEquals(json.code, 1);
    const doc = JSON.parse(json.out.split("\n").find((l) => l.startsWith("{"))!);
    assertEquals(doc.authPackage.spec, "jsr:@denext/auth@^5.0.0");
    assert(doc.authPackage.files.includes("denext.config.ts"));
    assertEquals(doc.written, false);
  } finally {
    await Deno.remove(json.dir, { recursive: true });
  }
});

Deno.test("upgrade 4.x → 5.0: an @denext/auth the dependency-age hold still holds fails the plan, writes nothing", async () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const lookups = registry(REGISTRY, {
    "@denext/denext": { "4.9.0": "2026-10-01T00:00:00Z", "5.0.0": "2026-10-20T00:00:00Z" },
    "@denext/auth": { "5.0.0": "2026-10-31T23:00:00Z" }, // an hour old: held
  });
  const rule = { cutoff: new Date(now.getTime() - 2 * 86_400_000), exclude: [], source: "default" };
  const run = await upgradeFixture({}, lookups, { rule: rule as never, now });
  try {
    assertEquals(run.code, 1, run.out);
    assertFalse(run.out.includes("Moved the auth imports"), run.out);
    assertEquals(
      await Deno.readTextFile(join(run.dir, "denext.config.ts")),
      await Deno.readTextFile(join(FIXTURE, "before", "denext.config.ts")),
    );
  } finally {
    await Deno.remove(run.dir, { recursive: true });
  }
});

Deno.test("upgrade within 4.x leaves the auth imports alone", async () => {
  const run = await upgradeFixture(
    {},
    registry({ "@denext/denext": { "4.9.0": null, "4.10.0": null } }),
  );
  try {
    assertEquals(run.code, 0, run.out);
    assertEquals(
      await Deno.readTextFile(join(run.dir, "denext.config.ts")),
      await Deno.readTextFile(join(FIXTURE, "before", "denext.config.ts")),
    );
    assertStringIncludes(await Deno.readTextFile(join(run.dir, "deno.json")), '"denext/auth"');
  } finally {
    await Deno.remove(run.dir, { recursive: true });
  }
});

Deno.test("rewriteAuthImports: kept names stay on denext/server, moved ones go to @denext/auth", () => {
  const cases: [string, string][] = [
    // Nothing moved: byte-identical.
    [
      `import { auth, cookies } from "denext/server";`,
      `import { auth, cookies } from "denext/server";`,
    ],
    // All moved: the specifier changes in place.
    [`import { denextAuth } from "denext/server";`, `import { denextAuth } from "@denext/auth";`],
    // The @denext/denext/<sub> spelling a library uses.
    [
      `import { activeAuthConfig, auth } from "@denext/denext/server";`,
      `import { auth } from "@denext/denext/server";\nimport { activeAuthConfig } from "@denext/auth";`,
    ],
    // `import type` and inline `type` modifiers survive.
    [
      `import type { AuthConfig, AuthUser } from "denext/server";`,
      `import type { AuthUser } from "denext/server";\nimport type { AuthConfig } from "@denext/auth";`,
    ],
    [
      `import { type AuthAdapter, getSession } from "denext/server";`,
      `import { getSession } from "denext/server";\nimport { type AuthAdapter } from "@denext/auth";`,
    ],
    // denext/auth splits the other way: what stays in core goes to denext/server.
    [
      `import { auth, RateLimitStore, saml } from "denext/auth";`,
      `import { auth, RateLimitStore } from "denext/server";\nimport { saml } from "@denext/auth";`,
    ],
    [`import { requireAuth } from "denext/auth";`, `import { requireAuth } from "denext/server";`],
    // A pinned jsr: specifier keeps its range on the half that stays.
    [
      `import { auth, github } from "jsr:@denext/denext@^4.9.0/auth";`,
      `import { auth } from "jsr:@denext/denext@^4.9.0/server";\nimport { github } from "@denext/auth";`,
    ],
    // The second line keeps the original statement's indentation.
    [
      `  import { github, headers } from "denext/server";`,
      `  import { headers } from "denext/server";\n  import { github } from "@denext/auth";`,
    ],
    // Other modules are never touched.
    [`import { denextAuth } from "./my-auth.ts";`, `import { denextAuth } from "./my-auth.ts";`],
    [`import { github } from "denext/client";`, `import { github } from "denext/client";`],
  ];
  for (const [before, after] of cases) assertEquals(rewriteAuthImports(before).text, after, before);
  const moved = rewriteAuthImports(`import { okta } from "denext/server";`);
  assert(moved.changed && moved.needsAuth);
  const kept = rewriteAuthImports(`import { auth } from "denext/auth";`);
  assert(kept.changed && !kept.needsAuth, "a denext/auth import of kept names needs no package");
});

Deno.test("rewriteAuthImports: a namespace import, re-export or import() is reported, not changed", () => {
  for (
    const text of [
      `import * as s from "denext/server";`,
      `export * from "denext/auth";`,
      `const m = await import("denext/auth");`,
    ]
  ) {
    const out = rewriteAuthImports(text);
    assertEquals(out.text, text);
    assertEquals(out.warnings.length, 1, text);
  }
  assertEquals(rewriteAuthImports(`import * as d from "denext";`).warnings, []);
});

Deno.test("rewriteAuthConfig: denext/auth becomes @denext/auth, next-auth aliases move, comments stay", async () => {
  const jsonc = `{
  // keep me
  "imports": {
    "denext/auth": "jsr:@denext/denext@~4.9.0/auth",
    "next-auth/": "jsr:/@denext/denext@~4.9.0/next-auth/", // a prefix
    "next-auth/jwt": "jsr:@denext/denext@~4.9.0/next-auth/jwt"
  }
}
`;
  const out = await rewriteAuthConfig(jsonc, "jsr:@denext/auth@~5.0.0", false);
  assert(out.changed);
  assertEquals(
    out.text,
    `{
  // keep me
  "imports": {
    "@denext/auth": "jsr:@denext/auth@~5.0.0",
    "next-auth/": "jsr:/@denext/auth@~5.0.0/next-auth/", // a prefix
    "next-auth/jwt": "jsr:@denext/auth@~5.0.0/next-auth/jwt"
  }
}
`,
  );
  // An existing @denext/auth entry wins; the stale denext/auth one is dropped.
  const both = await rewriteAuthConfig(
    `{ "imports": { "@denext/auth": "jsr:@denext/auth@^5.0.0", "denext/auth": "./x.ts" } }`,
    "jsr:@denext/auth@^5.0.0",
    true,
  );
  assertFalse(both.text.includes('"denext/auth"'));
  assertStringIncludes(both.text, '"@denext/auth": "jsr:@denext/auth@^5.0.0"');
  // No entry: added only when a source needs it.
  const bare = `{ "imports": { "denext": "jsr:@denext/denext@^5.0.0" } }`;
  assertEquals((await rewriteAuthConfig(bare, "jsr:@denext/auth@^5.0.0", false)).changed, false);
  const added = await rewriteAuthConfig(bare, "jsr:@denext/auth@^5.0.0", true);
  assertEquals(JSON.parse(added.text).imports["@denext/auth"], "jsr:@denext/auth@^5.0.0");
});

Deno.test("planAuthSourceRewrites: walks the project, skips dependencies and build output", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_auth_walk_" });
  try {
    const moved = `import { github } from "denext/server";\n`;
    for (const sub of ["app", "node_modules/x", ".denext", "dist", "out"]) {
      await Deno.mkdir(join(dir, sub), { recursive: true });
      await Deno.writeTextFile(join(dir, sub, "a.ts"), moved);
    }
    await Deno.writeTextFile(join(dir, "app", "b.md"), moved); // not a module
    const plan = await planAuthSourceRewrites(dir);
    assertEquals(plan.files.map((f) => f.path), ["app/a.ts"]);
    assert(plan.needsAuth);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("crossesAuthSplit / authSpecifierFor", () => {
  assert(crossesAuthSplit("4.9.0", "5.0.0"));
  assert(crossesAuthSplit("4.10.0", "5.0.0-rc.1"));
  assertFalse(crossesAuthSplit("4.9.0", "4.10.0"));
  assertFalse(crossesAuthSplit("5.0.0", "5.1.0"));
  assertEquals(authSpecifierFor(`"jsr:@denext/denext@~4.9.0"`, "5.0.0"), "jsr:@denext/auth@~5.0.0");
  assertEquals(authSpecifierFor(`"jsr:@denext/denext@4.9.0"`, "5.0.0"), "jsr:@denext/auth@5.0.0");
  assertEquals(authSpecifierFor(`{}`, "5.0.0"), "jsr:@denext/auth@^5.0.0");
});

Deno.test("the moved and kept name lists match @denext/auth and denext/server", async () => {
  const authMod = await Deno.readTextFile(join(ROOT, "packages", "auth", "mod.ts"));
  assertEquals([...reexportedNames(authMod)].sort(), [...AUTH_MOVED_NAMES].sort());
  const serverMod = reexportedNames(await Deno.readTextFile(join(ROOT, "src", "server", "mod.ts")));
  for (const name of AUTH_KEPT_NAMES) {
    assert(serverMod.has(name), `${name} stays in denext/server`);
    assertFalse(AUTH_MOVED_NAMES.has(name), `${name} is both kept and moved`);
  }
});

Deno.test("rewriteAuthImports: formatting kept when a statement moves whole; long splits wrap; doc comments keep ` * `", () => {
  const multi = `import {\n  denextAuth,\n  github,\n} from "denext/server";\n`;
  assertEquals(rewriteAuthImports(multi).text, multi.replace('"denext/server"', '"@denext/auth"'));
  const long = `import { cookies, currentSessionId, denextAuth, headers, revokeAllSessions, ` +
    `revokeSession, sqliteSessionStore } from "denext/server";`;
  assertEquals(
    rewriteAuthImports(long).text,
    `import { cookies, headers } from "denext/server";\nimport {\n  currentSessionId,\n` +
      `  denextAuth,\n  revokeAllSessions,\n  revokeSession,\n  sqliteSessionStore,\n} from "@denext/auth";`,
  );
  const doc = ` * import { fromPostgresJs, postgresAuthAdapter } from "denext/server";\n`;
  assertEquals(
    rewriteAuthImports(doc).text,
    ` * import { fromPostgresJs } from "denext/server";\n * import { postgresAuthAdapter } from "@denext/auth";\n`,
  );
});

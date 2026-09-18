// The native-path server-only leak check: a route that hydrates as a whole (a hook or
// event handler, no `"use client"` boundary) bundles its page + layouts + imports for the
// browser, and `deno bundle --platform=browser` emits a `node:` import / `Deno.env.get`
// verbatim — so `lib/db.ts` used to ship and fail only in the browser. Now the build fails,
// naming the module, the route that pulled it in, and the fix.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../src/build/build.ts";
import { bundleRoutes } from "../src/build/bundle.ts";
import { resetModuleGraphCache } from "../src/build/module-graph.ts";
import { serverOnlySignals } from "../src/build/server-only-scan.ts";

// ── serverOnlySignals (pure) ─────────────────────────────────────────────────────

Deno.test("serverOnlySignals: node: imports, the server-only marker, and Deno.* access", () => {
  assertEquals(
    serverOnlySignals(
      `import { DatabaseSync } from "node:sqlite";\n` +
        `const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");`,
    ),
    ["node-import", "deno-global"],
  );
  assertEquals(serverOnlySignals(`export * from "node:path";`), ["node-import"]);
  assertEquals(serverOnlySignals(`import {\n  readFile,\n} from "node:fs/promises";`), [
    "node-import",
  ]);
  assertEquals(serverOnlySignals(`import "server-only";\nexport const x = 1;`), [
    "server-only-marker",
  ]);
  assertEquals(serverOnlySignals(`import "denext/server-only";`), ["server-only-marker"]);
  assertEquals(serverOnlySignals(`import "jsr:@denext/denext/server-only";`), [
    "server-only-marker",
  ]);
  assertEquals(serverOnlySignals(`import { serverOnly } from "denext";\nserverOnly("db");`), [
    "server-only-marker",
  ]);
  // A mixed list still imports a value.
  assertEquals(serverOnlySignals(`import { type A, DatabaseSync } from "node:sqlite";`), [
    "node-import",
  ]);
});

Deno.test("serverOnlySignals: no false positives for strings, comments, types, guards, dynamic imports", () => {
  // Quoted in a string / template / comment (a docs page's code sample).
  assertEquals(
    serverOnlySignals(
      `export const doc = "import x from \\"node:fs\\"; Deno.env.get";\n` +
        `// Deno.env in a comment\n` +
        'const t = `from "node:fs" Deno.`;',
    ),
    [],
  );
  // Type-only imports are elided by the bundler.
  assertEquals(serverOnlySignals(`import type { DatabaseSync } from "node:sqlite";`), []);
  assertEquals(serverOnlySignals(`import { type DatabaseSync } from "node:sqlite";`), []);
  assertEquals(
    serverOnlySignals(`export const a = 1\nimport type x from "node:fs"\nexport const b = 2`),
    [],
  );
  // An isomorphic module guards its Deno access.
  assertEquals(
    serverOnlySignals(
      `export const port = typeof Deno !== "undefined" ? Deno.env.get("PORT") : undefined;`,
    ),
    [],
  );
  // A dynamic import loads nothing at link time (the guarded isomorphic pattern).
  assertEquals(serverOnlySignals(`export async function f() { await import("node:fs"); }`), []);
  // `import.meta`, an identifier named `from`, JSX handlers mentioning Deno in a string.
  assertEquals(serverOnlySignals(`const u = new URL("./x", import.meta.url);`), []);
  assertEquals(serverOnlySignals(`import { from } from "./x.ts"; export const y = from;`), []);
  assertEquals(
    serverOnlySignals(
      `"use client";\nexport default function P() { return <b onClick={() => alert("Deno.env")}/> }`,
    ),
    [],
  );
});

// ── The fixture app, built for real ────────────────────────────────────────────────

/** The framework import map a temp project needs to build against this checkout. */
function denoJson(): string {
  const fw = (p: string) => new URL(`../${p}`, import.meta.url).href;
  return JSON.stringify({
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
    imports: {
      "denext": fw("mod.ts"),
      "denext/jsx-runtime": fw("src/jsx/jsx-runtime.ts"),
      "denext/server": fw("src/server/mod.ts"),
      "denext/client": fw("src/client/mod.ts"),
      "server-only": fw("src/compat/server-only.ts"),
    },
  });
}

/** `lib/db.ts` — Deno's built-in SQLite, opened once at module scope (the AGENTS.md recipe). */
const DB_MODULE = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? ":memory:");
db.exec("create table if not exists notes (title text)");
export const listNotes = () => db.prepare("select title from notes").all() as { title: string }[];
`;

const LAYOUT = `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;

/** Write a project: `app/layout.tsx`, `app/page.tsx`, `lib/db.ts` (+ extra files). */
async function writeProject(
  dir: string,
  page: string,
  extra: Record<string, string> = {},
  db = DB_MODULE,
): Promise<void> {
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.mkdir(join(dir, "lib"), { recursive: true });
  await Deno.writeTextFile(join(dir, "deno.json"), denoJson());
  await Deno.writeTextFile(join(dir, "app/layout.tsx"), LAYOUT);
  await Deno.writeTextFile(join(dir, "app/page.tsx"), page);
  await Deno.writeTextFile(join(dir, "lib/db.ts"), db);
  for (const [name, text] of Object.entries(extra)) {
    await Deno.writeTextFile(join(dir, name), text);
  }
}

// The page has a hook and no "use client" boundary, so it hydrates as a whole: its own
// module — and `lib/db.ts` with it — is what the browser entry imports.
const LEAKY_PAGE = `import { useState } from "denext";
import { listNotes } from "../lib/db.ts";
export default function Page() {
  const [n, setN] = useState(0);
  const notes = listNotes();
  return <button type="button" onClick={() => setN(n + 1)}>{notes.length} / {n}</button>;
}
`;

Deno.test({
  name:
    "build fails when a hydrating route's tree would ship node:sqlite + Deno.env to the browser",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_leak_" });
    try {
      await writeProject(dir, LEAKY_PAGE);
      resetModuleGraphCache();
      const err = await assertRejects(() => build(dir), Error);
      assertStringIncludes(err.message, "denext: server-only code would ship to the browser");
      // The module, why, and the route that shipped it.
      assertStringIncludes(
        err.message,
        "lib/db.ts — imports a node: built-in; uses the Deno global",
      );
      assertStringIncludes(err.message, "shipped by the route of app/page.tsx");
      // The fix.
      assertStringIncludes(err.message, `"use client" component`);
      assertStringIncludes(err.message, `import "server-only"`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// The same app, fixed the way the report says: the db module is marked server-only and the
// interactive part is a "use client" island, so the page stays a Server Component.
const FIXED_PAGE = `import { listNotes } from "../lib/db.ts";
import { Counter } from "./counter.tsx";
export default function Page() {
  const notes = listNotes();
  return <Counter count={notes.length} />;
}
`;
const COUNTER = `"use client";
import { useState } from "denext";
export function Counter({ count }: { count: number }) {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{count} / {n}</button>;
}
`;

Deno.test({
  name: "build succeeds once the db module is server-only and the interactive part is an island",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_leak_fixed_" });
    try {
      await writeProject(
        dir,
        FIXED_PAGE,
        { "app/counter.tsx": COUNTER },
        `import "server-only";\n${DB_MODULE}`,
      );
      resetModuleGraphCache();
      const result = await build(dir);
      // The Flight islands bundle ships the island and nothing server-only.
      const client = join(result.outDir, "client");
      let all = "";
      for await (const f of Deno.readDir(client)) {
        if (f.isFile && f.name.endsWith(".js")) {
          all += await Deno.readTextFile(join(client, f.name));
        }
      }
      assert(all.length > 0, "a client bundle was emitted");
      assert(!all.includes("node:sqlite"), "node:sqlite must not reach the browser bundle");
      assert(!all.includes("DB_PATH"), "the db module must not reach the browser bundle");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// A server-only helper the browser entry never uses is tree-shaken away — the check reads
// what the bundle actually emitted, not just the import graph, so it is not a leak.
const SHAKEN_PAGE = `import { useState } from "denext";
import { secret } from "../lib/db.ts";
export function generateMetadata() { return { title: secret() }; }
export default function Page() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{n}</button>;
}
`;

Deno.test({
  name: "a pure server helper imported only by a non-shipped export is tree-shaken, not a leak",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_leak_shaken_" });
    try {
      // Pure (no module-scope side effect), so the bundler drops it with `generateMetadata`.
      await writeProject(
        dir,
        SHAKEN_PAGE,
        {},
        `export const secret = () => Deno.env.get("SECRET");\n`,
      );
      resetModuleGraphCache();
      const result = await build(dir);
      assertEquals(result.routes.length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// An entry denext did not generate (a plugin's / SPA's own entry through the public
// `bundleRoutes` primitive) is bundled as given — the check is keyed on denext's headers.
Deno.test("bundleRoutes leaves a foreign (non-generated) entry unchecked", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_leak_foreign_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), denoJson());
    await Deno.writeTextFile(
      join(dir, "env.ts"),
      `export const home = () => globalThis.Deno.env.get("HOME");\n`,
    );
    const source = `import { home } from "${new URL("env.ts", `file://${dir}/`).href}";\n` +
      `console.log(home());\n`;
    const out = await bundleRoutes([{ key: "plugin", source }], {
      configPath: join(dir, "deno.json"),
    });
    assertStringIncludes(out.files.get(out.entries.get("plugin")!)!, "Deno.env.get");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

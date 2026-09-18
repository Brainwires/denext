// The unbundled dev loop never bundles, so the bundle-time server-only check
// (tests/server-only-leak.test.ts) never runs there; the route entry does its own graph check
// before it is served. What must hold: an interactive route that reaches a server-only module
// is refused with the same message `denext build` prints; a `"use server"` module is never
// counted (the transform ships an action stub, not the module); and a route `denext build`
// would ship without JavaScript is left alone, however server-only its imports are.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parsePattern } from "../src/router/segments.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { assertNoDevServerOnlyLeaks } from "../src/build/dev-unbundled/entries.ts";
import type { UnbundledState } from "../src/build/dev-unbundled/state.ts";

function route(filePath: string): PageRoute {
  return {
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/x",
    filePath,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  } as PageRoute;
}

/** A temp project holding `files`, and the state slice the check reads. */
async function project(
  files: Record<string, string>,
): Promise<{ dir: string; st: UnbundledState }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_leak_" });
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return { dir, st: { opts: { projectDir: dir } } as unknown as UnbundledState };
}

const DB =
  `import { DatabaseSync } from "node:sqlite";\nexport const db = new DatabaseSync(":memory:");\n`;
const IMPORTS = `import { db } from "../lib/db.ts";\n`;

Deno.test("an interactive route that reaches a server-only module is refused with the leak", async () => {
  const { dir, st } = await project({
    "lib/db.ts": DB,
    "app/page.tsx": IMPORTS +
      `import { useState } from "denext";\nexport default function P() { const [n] = useState(0); return <p>{String(db)}{n}</p>; }\n`,
  });
  try {
    const err = await assertRejects(() =>
      assertNoDevServerOnlyLeaks(st, route(join(dir, "app/page.tsx")))
    );
    const message = err instanceof Error ? err.message : String(err);
    assertStringIncludes(message, "lib/db.ts");
    assertStringIncludes(message, "imports a node: built-in");
    assertStringIncludes(message, "the route of /x");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a route the build would ship without JavaScript is not checked", async () => {
  const { dir, st } = await project({
    "lib/db.ts": DB,
    "app/page.tsx": IMPORTS +
      `export default function P() { return <p>{String(db)}</p>; }\n`,
  });
  try {
    assertEquals(await assertNoDevServerOnlyLeaks(st, route(join(dir, "app/page.tsx"))), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a "use server" module in the graph is an action stub, not a leak', async () => {
  const { dir, st } = await project({
    "app/actions.ts": `"use server";\nimport { DatabaseSync } from "node:sqlite";\n` +
      `export async function save() { return new DatabaseSync(":memory:") && 1; }\n`,
    "app/page.tsx": `import { save } from "./actions.ts";\nimport { useState } from "denext";\n` +
      `export default function P() { const [n] = useState(0); return <form action={save}>{n}</form>; }\n`,
  });
  try {
    assertEquals(await assertNoDevServerOnlyLeaks(st, route(join(dir, "app/page.tsx"))), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

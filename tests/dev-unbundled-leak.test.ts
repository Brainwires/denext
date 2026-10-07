// The unbundled dev loop never bundles, so the bundle-time server-only check
// (tests/server-only-leak.test.ts) never runs there; the route entry does its own graph check
// before it is served. What must hold: an interactive route that reaches a server-only module
// is refused with the same message `denext build` prints; a `"use server"` module is never
// counted (the transform ships an action stub, not the module); and a route `denext build`
// would ship without JavaScript is left alone, however server-only its imports are.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { createUnbundledDev } from "../src/build/dev-unbundled.ts";
import { actionIdFor } from "../src/runtime/server-action.ts";
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
    assertStringIncludes(message, join("lib", "db.ts")); // named as an OS path
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

// The browser never receives a `"use server"` module's source in dev: asked for by any spelling
// (the importer's rewritten `@fs` URL, or directly), it is served as its action stub, named by
// the dev boundary's id when the boundary holds it.
Deno.test('unbundled dev serves a "use server" module as its action stub', async () => {
  const root = new URL("../", import.meta.url).href;
  const { dir: written } = await project({
    "deno.json": JSON.stringify({
      imports: { "denext": `${root}mod.ts`, "@/": "./", "#actions": "./app/actions.ts" },
    }),
    "app/actions.ts": `"use server";\nconst SECRET = "DEV_SECRET_99";\n` +
      `export async function save() { return SECRET; }\n`,
    "app/Alias.tsx":
      `"use client";\nimport { save } from "@/app/actions.ts";\nexport const A = save;\n`,
    "app/Hash.tsx": `"use client";\nimport { save } from "#actions";\nexport const H = save;\n`,
  });
  const dir = await Deno.realPath(written); // the transform names modules by their real path
  const dev = createUnbundledDev({
    projectDir: dir,
    appDir: join(dir, "app"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    compat: false,
    serverModules:
      () => [["known1", { url: toFileUrl(join(dir, "app/actions.ts")).href, exports: ["save"] }]],
  });
  try {
    const actions = join(dir, "app", "actions.ts");
    for (const importer of ["Alias.tsx", "Hash.tsx"]) {
      const code = (await dev._internal.transform(join(dir, "app", importer))).code;
      assertStringIncludes(code, `/_denext/@fs${actions}`); // resolved to the module's URL…
    }
    const served = (await dev._internal.transform(actions)).code; // …which serves the stub
    assertEquals(served.includes("DEV_SECRET_99"), false);
    assertStringIncludes(served, actionIdFor("known1", "save"));
    assertStringIncludes(served, "clientActionStub");
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  actionIdFor,
  getServerAction,
  isServerAction,
  registerServerReference,
  tagServerExports,
} from "../src/runtime/server-action.ts";
import { bundleFlightEntry, generateServerStub } from "../src/build/bundle.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";

Deno.test("registerServerReference registers + tags a handler", () => {
  const ref = registerServerReference("mod#save", (x: number) => x + 1);
  assert(isServerAction(ref));
  assertEquals(ref.denextActionId, "mod#save");
  assertEquals(getServerAction("mod#save")?.(2), 3);
});

Deno.test("tagServerExports auto-registers use-server exports in place", async () => {
  function save(v: string) {
    return "saved:" + v;
  }
  const mod = { save };
  tagServerExports(mod as Record<string, unknown>, "acts");
  // The original exported function is tagged (so it serializes as an action ref).
  assert(isServerAction(save));
  assertEquals(
    (save as unknown as { denextActionId: string }).denextActionId,
    actionIdFor("acts", "save"),
  );
  // And registered for RPC dispatch.
  assertEquals(await getServerAction(actionIdFor("acts", "save"))?.("x"), "saved:x");
});

Deno.test("generateServerStub emits client dispatch stubs per export", () => {
  const stub = generateServerStub("acts", ["save", "default"]);
  assertStringIncludes(stub, `clientActionStub(${JSON.stringify(actionIdFor("acts", "save"))})`);
  assertStringIncludes(
    stub,
    `export default clientActionStub(${JSON.stringify(actionIdFor("acts", "default"))})`,
  );
  assertStringIncludes(stub, `from "denext/client-runtime"`);
});

// A client component importing a "use server" function bundles with a stub; the
// server handler's code is stripped from the browser bundle.
Deno.test("bundleFlightEntry strips server-action code, keeps a dispatch stub", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_serveraction_" });
  try {
    const root = new URL("../", import.meta.url).href;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/client": `${root}src/client/mod.ts`,
          "denext/client-runtime": `${root}src/client/client-runtime.ts`,
        },
      }),
    );
    // A server-action module with a secret.
    const actionsPath = join(dir, "actions.ts");
    await Deno.writeTextFile(
      actionsPath,
      `"use server"\nexport function save(v){ const SECRET = "ACTION_SECRET_TOKEN_77"; return SECRET + v; }\n`,
    );
    // A client component that imports + calls the server action.
    const widgetPath = join(dir, "Widget.tsx");
    await Deno.writeTextFile(
      widgetPath,
      `"use client"\nimport { save } from "./actions.ts";\n` +
        `export function Widget(){ return <button onClick={() => save("x")}>GO_MARKER</button>; }\n`,
    );

    const boundary: BoundaryManifest = {
      client: new Map([["c_widget", { url: toFileUrl(widgetPath).href, exports: ["Widget"] }]]),
      server: new Map([["a_actions", { url: toFileUrl(actionsPath).href, exports: ["save"] }]]),
    };

    const output = await bundleFlightEntry(boundary, { configPath: join(dir, "deno.json") });
    // Concatenate every emitted file so the leak check covers split chunks too.
    const bundle = [...output.files.values()].join("\n");

    assertStringIncludes(bundle, "GO_MARKER"); // client code present
    assert(!bundle.includes("ACTION_SECRET_TOKEN_77"), "server-action code leaked into bundle");
    assertStringIncludes(bundle, actionIdFor("a_actions", "save")); // dispatch stub wired to the opaque id
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** An app whose island imports a secret-holding action through `spec` (an alias by default). */
async function aliasActionApp(
  spec = "@/actions.ts",
): Promise<{ dir: string; boundary: BoundaryManifest }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_alias_action_" }));
  const root = new URL("../", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/client": `${root}src/client/mod.ts`,
        "denext/client-runtime": `${root}src/client/client-runtime.ts`,
        "@/": "./",
      },
    }),
  );
  const actionsPath = join(dir, "actions.ts");
  await Deno.writeTextFile(
    actionsPath,
    `"use server"\nconst SECRET = "ALIAS_SECRET_TOKEN_88";\nexport function save(v){ return SECRET + v; }\n`,
  );
  const widgetPath = join(dir, "Widget.tsx");
  await Deno.writeTextFile(
    widgetPath,
    `"use client"\nimport { save } from "${spec}";\n` +
      `export function Widget(){ return <button onClick={() => save("x")}>GO_MARKER</button>; }\n`,
  );
  return {
    dir,
    boundary: {
      client: new Map([["c_widget", { url: toFileUrl(widgetPath).href, exports: ["Widget"] }]]),
      server: new Map([["a_actions", { url: toFileUrl(actionsPath).href, exports: ["save"] }]]),
    },
  };
}

// The leak 3.2.0 fixed: an island importing its action through an import-map alias bundled the
// action's source (the stub was keyed by file URL, which `deno bundle` never maps an alias to).
Deno.test("bundleFlightEntry: an action imported through an import-map alias ships as its stub", async () => {
  const { dir, boundary } = await aliasActionApp();
  try {
    const output = await bundleFlightEntry(boundary, { configPath: join(dir, "deno.json") });
    const bundle = [...output.files.values()].join("\n");
    assertStringIncludes(bundle, "GO_MARKER");
    assert(!bundle.includes("ALIAS_SECRET_TOKEN_88"), "server-action code leaked into bundle");
    assertStringIncludes(bundle, actionIdFor("a_actions", "save"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Fail closed: with the stub mapping broken (the bundle is told of no server modules), the
// bundle that ships the action's source is refused, naming the module and its importer.
Deno.test('bundleFlightEntry: a bundle that ships a "use server" module fails', async () => {
  const { dir, boundary } = await aliasActionApp("./actions.ts");
  try {
    const err = await assertRejects(() =>
      bundleFlightEntry(boundary, { configPath: join(dir, "deno.json"), server: [] })
    );
    const message = err instanceof Error ? err.message : String(err);
    assertStringIncludes(message, `a "use server" module would ship to the browser`);
    assertStringIncludes(message, "  actions.ts\n    imported through Widget.tsx");
    assertStringIncludes(message, `shipped by the "use client" islands bundle`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

import { assert, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { bundleSource, generateFlightEntry } from "../src/build/bundle.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";

// Bundling shells out to `deno bundle`; give it room.
Deno.test("flight bundle contains client code but NOT server-component code", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_flightbundle_" });
  try {
    const root = new URL("../", import.meta.url).pathname; // repo root
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    // A client island (goes into the bundle).
    const clientPath = join(dir, "Widget.tsx");
    await Deno.writeTextFile(
      clientPath,
      `"use client"\nexport function Widget(){ return <span>CLIENT_MARKER</span>; }\n`,
    );
    // A server component holding a secret; it is NOT imported by any client
    // module, so it must never appear in the client bundle.
    await Deno.writeTextFile(
      join(dir, "page.tsx"),
      `import { Widget } from "./Widget.tsx";\n` +
        `const DB_SECRET = "SUPER_SECRET_TOKEN_9animal";\n` +
        `export default function Page(){ return <div>{DB_SECRET}<Widget/></div>; }\n`,
    );

    const boundary: BoundaryManifest = {
      client: new Map([["c_widget", { url: toFileUrl(clientPath).href, exports: ["Widget"] }]]),
      server: new Map(),
    };

    const bundle = await bundleSource(generateFlightEntry(boundary), {
      configPath: join(dir, "deno.json"),
    });

    // Client code is present; server-only secret is provably absent.
    assertStringIncludes(bundle, "CLIENT_MARKER");
    assert(!bundle.includes("SUPER_SECRET_TOKEN_9animal"), "server secret leaked into bundle");
    assertStringIncludes(bundle, "c_widget"); // registry wiring present
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

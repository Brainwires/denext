import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildBoundaryManifest,
  clientIdFor,
  crawlLocalModules,
  shortHash,
} from "../src/build/module-graph.ts";
import { toFileUrl } from "@std/path";

Deno.test("shortHash is stable and deterministic", () => {
  assertEquals(shortHash("a/b/c.tsx"), shortHash("a/b/c.tsx"));
  assert(shortHash("a") !== shortHash("b"));
});

Deno.test("crawl + classify discovers a use client leaf imported by a server page", async () => {
  const app = await Deno.makeTempDir();
  try {
    // A server page importing a client island that itself imports a shared util.
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `"use server"\nimport { Button } from "./Button.tsx";\n` +
        `export default function Page() { return Button; }`,
    );
    await Deno.writeTextFile(
      join(app, "Button.tsx"),
      `"use client"\nimport { label } from "./util.ts";\n` +
        `export function Button() { return label; }`,
    );
    await Deno.writeTextFile(
      join(app, "util.ts"),
      `export const label = "x";`, // undirected/shared
    );

    const entry = join(app, "page.tsx");

    // Crawl reaches all three app modules (plus framework internals, filtered by
    // restricting to paths under the app dir here).
    const locals = await crawlLocalModules([entry]);
    const names = locals
      .filter((p) => p.startsWith(app))
      .map((p) => p.slice(app.length + 1))
      .sort();
    assertEquals(names, ["Button.tsx", "page.tsx", "util.ts"]);

    // Classification: page -> server, Button -> client, util -> neither.
    const bm = await buildBoundaryManifest(app, [entry]);
    const clientUrls = [...bm.client.values()].map((r) => r.url);
    const serverUrls = [...bm.server.values()].map((r) => r.url);
    assertEquals(clientUrls, [toFileUrl(join(app, "Button.tsx")).href]);
    assertEquals(serverUrls, [toFileUrl(join(app, "page.tsx")).href]);
    // util.ts (undirected) is in neither map.
    assertEquals(bm.client.size + bm.server.size, 2);

    // The client id is the derived stable id.
    const expectedId = clientIdFor(app, toFileUrl(join(app, "Button.tsx")).href);
    assert(bm.client.has(expectedId));
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("exportsOf populates ref export names when provided", async () => {
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `"use client"\nexport function A() {}\nexport function B() {}`,
    );
    const bm = await buildBoundaryManifest(app, [join(app, "page.tsx")], {
      exportsOf: () => ["A", "B"],
    });
    const ref = [...bm.client.values()][0];
    assertEquals(ref.exports, ["A", "B"]);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

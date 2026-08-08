import { assertEquals } from "@std/assert";
import { readDirective, scanDirective } from "../src/build/directives.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { join } from "@std/path";

// ---- scanDirective ---------------------------------------------------------

Deno.test("scanDirective detects a leading use client / use server", () => {
  assertEquals(scanDirective(`"use client";\nexport default function () {}`), "client");
  assertEquals(scanDirective(`'use server'\nexport const save = () => {}`), "server");
  assertEquals(scanDirective(`export default function () {}`), null);
});

Deno.test("scanDirective honors the directive prologue (after other directives)", () => {
  assertEquals(scanDirective(`"use strict";\n"use client";\ncode()`), "client");
});

Deno.test("scanDirective skips shebang and leading comments", () => {
  assertEquals(scanDirective(`#!/usr/bin/env -S deno run\n"use client"`), "client");
  assertEquals(scanDirective(`// header\n/* block */\n"use server"`), "server");
  assertEquals(scanDirective(`"use client" // trailing comment\ncode()`), "client");
});

Deno.test("scanDirective ignores non-directive occurrences", () => {
  // Not the leading statement.
  assertEquals(scanDirective(`foo();\n"use client";`), null);
  // A string used in an expression, not a statement.
  assertEquals(scanDirective(`const x = "use client";`), null);
  assertEquals(scanDirective(`"use client" + "!";`), null);
  assertEquals(scanDirective(`"use client".length;`), null);
  // Inside a function body.
  assertEquals(scanDirective(`function f() { return "use server"; }`), null);
  assertEquals(scanDirective(``), null);
});

// ---- readDirective + manifest population -----------------------------------

Deno.test("readDirective reads only the file head", async () => {
  const dir = await Deno.makeTempDir();
  const f = join(dir, "c.tsx");
  await Deno.writeTextFile(f, `"use client"\nexport default function C() { return null }`);
  assertEquals(await readDirective(f), "client");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readDirective grows past a large banner to find the directive", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // SECURITY: a license banner longer than the initial read window must NOT
    // hide the directive — that would fail open and leak a "use server" module
    // into the client bundle. Read window grows until the prologue is resolved.
    const banner = "/*\n" + " * MIT License blah blah\n".repeat(400) + " */\n"; // ~10KB
    const server = join(dir, "s.ts");
    await Deno.writeTextFile(server, `${banner}"use server"\nexport const save = () => {}`);
    assertEquals(await readDirective(server, 512), "server");

    // A banner-topped undirected module still resolves to null (no directive).
    const shared = join(dir, "u.ts");
    await Deno.writeTextFile(shared, `${banner}export const x = 1\n`);
    assertEquals(await readDirective(shared, 512), null);

    // A banner-topped client module too.
    const client = join(dir, "c.tsx");
    await Deno.writeTextFile(client, `${banner}"use client"\nexport default function C() {}`);
    assertEquals(await readDirective(client, 512), "client");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanRoutes records directives per component module", async () => {
  const app = await Deno.makeTempDir();
  // A server layout wrapping a client page.
  await Deno.writeTextFile(
    join(app, "layout.tsx"),
    `"use server"\nexport default function L({ children }) { return children }`,
  );
  await Deno.writeTextFile(
    join(app, "page.tsx"),
    `"use client"\nexport default function P() { return null }`,
  );
  // An undirected (shared) nested page.
  await Deno.mkdir(join(app, "about"));
  await Deno.writeTextFile(
    join(app, "about", "page.tsx"),
    `export default function A() { return null }`,
  );

  const manifest = await scanRoutes(app);
  const d = manifest.directives!;
  assertEquals(d.get(join(app, "layout.tsx")), "server");
  assertEquals(d.get(join(app, "page.tsx")), "client");
  // Undirected modules are absent from the map.
  assertEquals(d.has(join(app, "about", "page.tsx")), false);

  await Deno.remove(app, { recursive: true });
});

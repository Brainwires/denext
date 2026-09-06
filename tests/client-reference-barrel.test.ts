// `tagClientModules` over many islands imports them through ONE data: barrel module (one
// module-graph build) — and tags the very module instances a page imports.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { clientRefOf, tagClientModules } from "../src/runtime/client-reference.ts";

Deno.test("tagClientModules: many islands are tagged via one barrel import", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_barrel_" }));
  try {
    const clients = new Map<string, { url: string }>();
    for (let i = 0; i < 12; i++) {
      const file = join(dir, `island${i}.ts`);
      await Deno.writeTextFile(
        file,
        `"use client";\nexport default function Island${i}() {}\nexport function Extra${i}() {}`,
      );
      clients.set(`c_barrel_${i}`, { url: toFileUrl(file).href });
    }
    await tagClientModules(clients);
    // The same module instance a server page would import is the tagged one.
    const mod = await import(toFileUrl(join(dir, "island7.ts")).href);
    const info = clientRefOf(mod.default);
    assert(info, "default export tagged");
    assertEquals(info.clientId, "c_barrel_7");
    assertEquals(info.id, "c_barrel_7#default");
    assert(clientRefOf(mod.Extra7), "named export tagged");
    // Idempotent: a second call re-imports nothing and doesn't throw.
    await tagClientModules(clients);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A "use client" module's memo()/forwardRef() exports are non-callable element objects; they
// must be tagged too, or the Flight renderer invokes them as server components.
Deno.test("tagClientExports: memo and forwardRef exports are tagged as client references", async () => {
  const { tagClientExports } = await import("../src/runtime/client-reference.ts");
  const { forwardRef, memo } = await import("../src/compat/react.ts");
  const Plain = () => null;
  const Wrapped = forwardRef(() => null);
  // deno-lint-ignore no-explicit-any
  const Memoed = memo((() => null) as any);
  const mod = { Plain, Wrapped, Memoed, NOT_A_COMPONENT: 42 } as Record<string, unknown>;
  tagClientExports(mod, "c_brands");
  assertEquals(clientRefOf(Plain)?.id, "c_brands#Plain");
  assertEquals(clientRefOf(Wrapped)?.id, "c_brands#Wrapped");
  assertEquals(clientRefOf(Memoed)?.id, "c_brands#Memoed");
  assertEquals(clientRefOf(42), null);
  assertEquals(clientRefOf({}), null);
});

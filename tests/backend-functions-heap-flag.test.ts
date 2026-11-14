// @denext/backend Edge Functions: a heap size in DENO_V8_FLAGS overrides `memoryMb` (V8 takes it
// over a worker's own heap cap), so `setupFunctions` warns once at startup. Apart from
// backend-functions.test.ts because it sets DENO_V8_FLAGS for the process (a serial test).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { backend } from "../packages/backend/mod.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";

Deno.test("functions: setupFunctions warns once when DENO_V8_FLAGS raises memoryMb", async () => {
  const root = await Deno.makeTempDir();
  const load = ((path: string) => import(path)) as unknown as ModuleLoader;
  const before = Deno.env.get("DENO_V8_FLAGS");
  const warn = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => void seen.push(args.join(" "));
  const apply = async (functions: Record<string, unknown>) => {
    resetPlugins();
    const config = { plugins: [backend({ functions })] } as DenextConfig;
    await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "prod", load });
  };
  try {
    await Deno.writeTextFile(`${root}/deno.json`, `{ "unstable": ["worker-options"] }`);
    Deno.env.set("DENO_V8_FLAGS", "--max-old-space-size=4321");
    await apply({}); // no cap: nothing to say
    await apply({ memoryMb: 64 });
    await apply({ memoryMb: 64 }); // the same warning again: said once
    const heap = seen.filter((m) => m.includes("--max-old-space-size=4321"));
    assertEquals(heap.length, 1);
    assertStringIncludes(heap[0], "overrides functions.memoryMb");
    Deno.env.delete("DENO_V8_FLAGS");
    await apply({ memoryMb: 48 }); // no flag: nothing to say
    assertEquals(seen.filter((m) => m.includes("DENO_V8_FLAGS")).length, 1);
  } finally {
    console.warn = warn;
    if (before === undefined) Deno.env.delete("DENO_V8_FLAGS");
    else Deno.env.set("DENO_V8_FLAGS", before);
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});

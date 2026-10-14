// `denext db seed`'s storage half: the config's buckets are created and
// `supabase/buckets/<bucket>/**` uploaded into them, through the plugin's real storage (the fs
// driver and the SQLite metadata store).

import { assertEquals } from "@std/assert";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { backend, fs } from "../packages/backend/mod.ts";
import { storage } from "../packages/backend/server.ts";
import { installRuntime } from "../packages/backend/src/runtime.ts";
import { seedBuckets } from "../packages/backend/src/storage-seed.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;

Deno.test({
  name: "seedBuckets: config buckets, then supabase/buckets/<bucket>/** uploaded",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const root = await Deno.makeTempDir({ prefix: "dnx-seed-buckets-" });
  try {
    await Deno.mkdir(`${root}/app`);
    await Deno.mkdir(`${root}/supabase/buckets/avatars/team`, { recursive: true });
    await Deno.mkdir(`${root}/supabase/buckets/ghost`, { recursive: true });
    await Deno.writeTextFile(`${root}/supabase/buckets/avatars/team/readme.txt`, "hello");
    await Deno.writeFile(`${root}/supabase/buckets/avatars/a.bin`, new Uint8Array([1, 2, 3]));
    await Deno.writeTextFile(`${root}/supabase/buckets/ghost/x.txt`, "nobody");
    await Deno.writeTextFile(`${root}/supabase/buckets/loose.txt`, "no bucket dir");
    resetPlugins();
    installRuntime(undefined);
    const config = {
      plugins: [backend({
        storage: {
          secret: "storage-secret-at-least-32-characters",
          driver: fs({ dir: ".storage" }),
          buckets: { avatars: {}, docs: {} },
        },
      })],
    } as DenextConfig;
    await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
    const hooks = (globalThis as Record<symbol, unknown>)[Symbol.for("denext.backend.db")] as {
      seedBuckets?: (dir: string) => Promise<string[]>;
      actions: Record<string, unknown>;
    };
    assertEquals(Object.keys(hooks.actions), [], "storage only: no Postgres actions");
    const lines = await hooks.seedBuckets!(root);
    assertEquals(lines, [
      "bucket avatars",
      "bucket docs",
      "uploaded avatars/a.bin",
      "uploaded avatars/team/readme.txt",
      "skipped ghost/x.txt (no bucket ghost)",
    ]);
    const text = await storage.bucket("avatars", { service: true }).download("team/readme.txt");
    assertEquals(text?.contentType, "text/plain");
    assertEquals(await new Response(text!.body).text(), "hello");
    // Idempotent: a second seed replaces the objects.
    assertEquals((await seedBuckets(root)).length, 5);
  } finally {
    await runPluginTeardown();
    resetPlugins();
    installRuntime(undefined);
    await Deno.remove(root, { recursive: true });
  }
});

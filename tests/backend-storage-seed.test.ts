// `denext db seed`'s storage half: the config's buckets are created and
// `supabase/buckets/<bucket>/**` uploaded into them, through the plugin's real storage (the fs
// driver and the SQLite metadata store).

import { assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test({
  name: "denext storage ls / cp / mv / rm over the app's storage",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { createStorageCommand, parseStoragePath } = await import(
    "../packages/backend/src/storage-command.ts"
  );
  assertEquals(parseStoragePath("ss:///a/b/c.txt"), { bucket: "a", key: "b/c.txt" });
  assertEquals(parseStoragePath("ss://a/b"), { bucket: "a", key: "b" });
  assertEquals(parseStoragePath("ss:///"), { bucket: "", key: "" });
  assertEquals(parseStoragePath("./local"), undefined);
  const root = await Deno.makeTempDir({ prefix: "dnx-storage-cli-" });
  try {
    await Deno.mkdir(`${root}/app`);
    await Deno.mkdir(`${root}/local/tree/sub`, { recursive: true });
    await Deno.writeTextFile(`${root}/local/one.txt`, "one");
    await Deno.writeTextFile(`${root}/local/tree/a.json`, "{}");
    await Deno.writeTextFile(`${root}/local/tree/sub/b.txt`, "b");
    resetPlugins();
    installRuntime(undefined);
    const config = {
      plugins: [backend({
        storage: {
          secret: "storage-secret-at-least-32-characters",
          driver: fs({ dir: ".storage" }),
          buckets: { files: { public: true }, other: {} },
        },
      })],
    } as DenextConfig;
    await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
    const lines: string[] = [];
    const errors: string[] = [];
    let code = 0;
    const command = createStorageCommand({
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      exit: (c) => (code = c),
    });
    const run = async (positionals: string[], flags: Record<string, unknown> = {}) => {
      lines.length = 0;
      await command.run({ positionals, flags, global: { cwd: root }, rest: [] } as never);
      return lines;
    };
    assertEquals(await run(["ls"]), ["files/  (public)", "other/"]);
    assertEquals(await run(["cp", "local/one.txt", "ss:///files/"]), [
      `uploaded ${root}/local/one.txt → ss:///files/one.txt`,
    ]);
    await run(["cp", "local/tree", "ss:///files/tree"], {
      recursive: true,
      "cache-control": "max-age=60",
    });
    assertEquals(lines.length, 2);
    assertEquals(await run(["ls", "ss:///files"]), ["tree/", "one.txt"]);
    assertEquals(await run(["ls", "ss:///files/tree"]), ["sub/", "a.json"]);
    assertEquals(await run(["ls", "ss:///files"], { recursive: true }), [
      "files/one.txt",
      "files/tree/a.json",
      "files/tree/sub/b.txt",
    ]);
    // bucket → bucket, bucket → local
    await run(["cp", "ss:///files/tree", "ss:///other/copy"], { recursive: true });
    assertEquals(lines, [
      "copied ss:///files/tree/a.json → ss:///other/copy/a.json",
      "copied ss:///files/tree/sub/b.txt → ss:///other/copy/sub/b.txt",
    ]);
    await run(["cp", "ss:///other/copy", "out"], { recursive: true });
    assertEquals(await Deno.readTextFile(`${root}/out/sub/b.txt`), "b");
    await run(["cp", "ss:///files/one.txt", "single.txt"]);
    assertEquals(await Deno.readTextFile(`${root}/single.txt`), "one");
    await run(["mv", "ss:///files/one.txt", "ss:///other/moved.txt"]);
    assertEquals(lines, ["moved ss:///files/one.txt → ss:///other/moved.txt"]);
    await run(["mv", "ss:///other/copy", "ss:///files/back"], { recursive: true });
    assertEquals(lines.length, 2);
    assertEquals(await run(["rm", "ss:///other/moved.txt"]), ["removed ss:///other/moved.txt"]);
    await run(["rm", "ss:///files/back", "ss:///files/tree"], { recursive: true });
    assertEquals(lines.length, 4);
    assertEquals(await run(["ls", "ss:///files"], { recursive: true }), []);
    // Refusals
    for (
      const [args, message] of [
        [["cp", "a", "b"], "storage path"],
        [["cp", "a"], "source and a destination"],
        [["mv", "local/one.txt", "ss:///files/x"], "use cp"],
        [["rm"], "one or more"],
        [["rm", "local"], "not a storage path"],
        [["ls", "local"], "ss:///"],
        [["cp", "ss:///files/missing", "x"], "not found"],
        [["wat"], "unknown action"],
      ] as const
    ) {
      code = 0;
      await run([...args]);
      assertEquals(code, 1, args.join(" "));
      assertStringIncludes(errors.at(-1)!, message);
    }
  } finally {
    await runPluginTeardown();
    resetPlugins();
    installRuntime(undefined);
    await Deno.remove(root, { recursive: true });
  }
});

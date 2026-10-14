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

Deno.test("denext storage cp -r: an object key cannot write outside the destination folder", async () => {
  const { createStorageCommand } = await import("../packages/backend/src/storage-command.ts");
  const { storage: store } = await import("../packages/backend/src/storage.ts");
  const root = await Deno.makeTempDir({ prefix: "dnx-storage-escape-" });
  const original = store.bucket;
  let keys: string[] = [];
  // A bucket other tooling wrote to: its keys are whatever it put there.
  store.bucket = (() => ({
    list: (prefix: string) =>
      Promise.resolve({
        objects: keys.filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
    download: () => Promise.resolve({ body: new TextEncoder().encode("x") }),
  })) as unknown as typeof store.bucket;
  try {
    await Deno.mkdir(`${root}/work`);
    const errors: string[] = [];
    let code = 0;
    const command = createStorageCommand({
      log: () => {},
      error: (l) => errors.push(l),
      exit: (c) => (code = c),
    });
    const cp = async (src: string) => {
      code = 0;
      await command.run(
        {
          positionals: ["cp", src, "out"],
          flags: { recursive: true },
          global: { cwd: `${root}/work` },
          rest: [],
        } as never,
      );
    };
    for (
      const bad of [
        "a/../../escape.txt",
        "../escape.txt",
        "p/../../../escape.txt",
        "p//escape.txt", // under prefix `p`: `/escape.txt`, an absolute path
        "C:/escape.txt",
        "c:escape.txt",
        "a\\..\\..\\escape.txt",
        "nul\0.txt",
      ]
    ) {
      keys = ["good.txt", bad];
      await cp(bad.startsWith("p/") ? "ss:///b/p" : "ss:///b");
      assertEquals(code, 1, bad);
      assertStringIncludes(errors.at(-1)!, "outside", bad);
      // Refused before anything is written, inside the folder or out of it.
      const written = [];
      for await (const entry of Deno.readDir(root)) written.push(entry.name);
      assertEquals(written, ["work"], bad);
      assertEquals([...Deno.readDirSync(`${root}/work`)].length, 0, bad);
    }
    // Ordinary keys (dots in names included) still land inside the folder.
    keys = ["good.txt", "sub/..x/a.txt", "sub/./b.txt"];
    await cp("ss:///b");
    assertEquals(code, 0);
    assertEquals(await Deno.readTextFile(`${root}/work/out/good.txt`), "x");
    assertEquals(await Deno.readTextFile(`${root}/work/out/sub/..x/a.txt`), "x");
    assertEquals(await Deno.readTextFile(`${root}/work/out/sub/b.txt`), "x");
  } finally {
    store.bucket = original;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("denext storage rm -r on a remote store needs --yes or a yes at the terminal", async () => {
  const { createStorageCommand, remoteStore } = await import(
    "../packages/backend/src/storage-command.ts"
  );
  const { FakeS3 } = await import("./_fake-s3.ts");
  const { backendApp } = await import("./_backend-app.ts");
  const { s3 } = await import("../packages/backend/mod.ts");
  assertEquals(remoteStore(undefined), undefined, "fs: local");
  assertEquals(remoteStore("http://127.0.0.1:9000"), undefined);
  assertEquals(remoteStore("http://localhost:9000"), undefined);
  assertEquals(remoteStore("http://[::1]:9000"), undefined);
  assertEquals(
    remoteStore("https://s3.us-east-1.amazonaws.com"),
    "https://s3.us-east-1.amazonaws.com",
  );
  assertEquals(remoteStore("http://minio.internal:9000"), "http://minio.internal:9000");
  for (const endpoint of ["http://s3.test", "http://127.0.0.1:9"]) {
    const fake = new FakeS3();
    const app = await backendApp({
      driver: s3({
        endpoint,
        region: "us-east-1",
        bucket: fake.bucket,
        credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret-test-key" },
        fetch: fake.fetch,
      }),
      buckets: { files: { authorize: () => true } },
    });
    try {
      const files = storage.bucket("files", { service: true });
      const errors: string[] = [];
      const asked: string[] = [];
      let code = 0;
      const rmTree = async (flags: Record<string, unknown>, answer?: boolean) => {
        for (const key of ["tree/a.txt", "tree/b.txt"]) await files.upload(key, "x");
        code = 0;
        const command = createStorageCommand({
          log: () => {},
          error: (l) => errors.push(l),
          exit: (c) => (code = c),
          ...(answer === undefined ? {} : {
            confirm: (question: string) => (asked.push(question), Promise.resolve(answer)),
          }),
        });
        await command.run(
          {
            positionals: ["rm", "ss:///files/tree"],
            flags: { recursive: true, ...flags },
            global: { cwd: app.root },
            rest: [],
          } as never,
        );
        return (await files.list("tree/")).objects.length;
      };
      if (endpoint === "http://s3.test") {
        // No terminal, no --yes: refused before anything is deleted.
        assertEquals(await rmTree({}), 2);
        assertEquals(code, 1);
        assertStringIncludes(
          errors.at(-1)!,
          "on the remote store http://s3.test: run it with --yes",
        );
        // A "no" cancels; a "yes", or --yes, deletes.
        assertEquals(await rmTree({}, false), 2);
        assertStringIncludes(errors.at(-1)!, "cancelled");
        assertStringIncludes(asked.at(-1)!, 'rm -r deletes everything under "ss:///files/tree"');
        assertEquals(await rmTree({}, true), 0);
        assertEquals(code, 0);
        assertEquals(await rmTree({ yes: true }), 0);
        assertEquals(asked.length, 2, "--yes does not ask");
      } else {
        // A store on this machine's loopback is local: no question.
        assertEquals(await rmTree({}), 0);
        assertEquals([code, asked.length], [0, 0]);
      }
    } finally {
      await app.close();
    }
  }
});

Deno.test({
  name: "denext storage cp -r: a symbolic link inside the destination is never written through",
  ignore: Deno.build.os === "windows", // creating a symlink needs a privilege there
}, async () => {
  const { createStorageCommand } = await import("../packages/backend/src/storage-command.ts");
  const { storage: store } = await import("../packages/backend/src/storage.ts");
  const root = await Deno.makeTempDir({ prefix: "dnx-storage-symlink-" });
  const original = store.bucket;
  const keys = ["a.txt", "sub/b.txt", "c.txt"];
  store.bucket = (() => ({
    list: (prefix: string) =>
      Promise.resolve({
        objects: keys.filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
    download: () => Promise.resolve({ body: new TextEncoder().encode("from the bucket") }),
  })) as unknown as typeof store.bucket;
  try {
    await Deno.mkdir(`${root}/work/out`, { recursive: true });
    await Deno.mkdir(`${root}/elsewhere`);
    await Deno.writeTextFile(`${root}/elsewhere/c.txt`, "precious");
    const errors: string[] = [];
    let code = 0;
    const command = createStorageCommand({
      log: () => {},
      error: (l) => errors.push(l),
      exit: (c) => (code = c),
    });
    const cp = async () => {
      code = 0;
      await command.run(
        {
          positionals: ["cp", "ss:///b", "out"],
          flags: { recursive: true },
          global: { cwd: `${root}/work` },
          rest: [],
        } as never,
      );
    };
    const outside = () => [...Deno.readDirSync(`${root}/elsewhere`)].map((e) => e.name).sort();
    // A directory link inside the destination.
    await Deno.symlink(`${root}/elsewhere`, `${root}/work/out/sub`);
    await cp();
    assertEquals(code, 1);
    assertStringIncludes(errors.at(-1)!, "is a symbolic link");
    assertEquals(outside(), ["c.txt"], "nothing written through the link");
    assertEquals([...Deno.readDirSync(`${root}/work/out`)].map((e) => e.name), ["sub"]);
    // A file link inside the destination.
    await Deno.remove(`${root}/work/out/sub`);
    await Deno.symlink(`${root}/elsewhere/c.txt`, `${root}/work/out/c.txt`);
    await cp();
    assertEquals(code, 1);
    assertStringIncludes(errors.at(-1)!, "is a symbolic link");
    assertEquals(await Deno.readTextFile(`${root}/elsewhere/c.txt`), "precious");
    // Without the links, the tree is written.
    await Deno.remove(`${root}/work/out/c.txt`);
    await cp();
    assertEquals(code, 0);
    assertEquals(await Deno.readTextFile(`${root}/work/out/sub/b.txt`), "from the bucket");
    assertEquals(await Deno.readTextFile(`${root}/elsewhere/c.txt`), "precious");
  } finally {
    store.bucket = original;
    await Deno.remove(root, { recursive: true });
  }
});

// The 4.8 toolchain audit's regressions (plans: audit-4.8-toolchain): a download cache another
// user can write is refused before its lock files are opened or a cached binary is trusted; the
// cached Tailwind binary is re-verified against its pin before it runs; an empty network direction
// in `compile.permissions` is refused instead of baking that direction unscoped; and the CLI
// helpers that run inside long-lived processes read a child's output until it exits, not until
// every copy of its pipes closes.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { type DenoToolchainPin, ensureDenoToolchain } from "../src/build/deno-toolchain.ts";
import {
  assertTrustedCacheDirs,
  cacheDirChain,
  UntrustedCacheDirError,
} from "../src/build/verified-download.ts";
import { compileTailwind } from "../src/build/tailwind.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { compileBuildFlags } from "../src/build/compile-app.ts";
import { runSecureCli } from "../src/desktop/caps/secure-store.ts";
import { adbRunner } from "../src/profile/android.ts";
import { sha256Hex } from "./_archive-fixtures.ts";

const WINDOWS = Deno.build.os === "windows";

/** A `Deno.FileInfo` with just the fields the trust check reads. */
function info(uid: number | null, mode: number | null): Deno.FileInfo {
  return { uid, mode, isDirectory: true } as unknown as Deno.FileInfo;
}

Deno.test("assertTrustedCacheDirs: another user's or a world-writable directory is refused", async () => {
  const at = (map: Record<string, Deno.FileInfo>) => (p: string) =>
    map[p] ? Promise.resolve(map[p]) : Promise.reject(new Deno.errors.NotFound(p));
  const seams = (map: Record<string, Deno.FileInfo>) => ({ os: "linux", uid: 501, stat: at(map) });
  // Ours, root's, a sticky world-writable one (/tmp) and a missing one are all fine.
  await assertTrustedCacheDirs(
    ["/c", "/c/d", "/tmp", "/gone"],
    seams({
      "/c": info(501, 0o40755),
      "/c/d": info(0, 0o40755),
      "/tmp": info(0, 0o41777),
    }),
  );
  // Group-writable stays allowed (a umask of 002 with per-user groups is common).
  await assertTrustedCacheDirs(["/c"], seams({ "/c": info(501, 0o40775) }));
  await assertRejects(
    () =>
      assertTrustedCacheDirs(
        ["/c", "/c/d"],
        seams({ "/c": info(501, 0o40755), "/c/d": info(502, 0o40755) }),
      ),
    UntrustedCacheDirError,
    "owned by user 502",
  );
  await assertRejects(
    () => assertTrustedCacheDirs(["/c"], seams({ "/c": info(501, 0o40777) })),
    UntrustedCacheDirError,
    "writable by every user",
  );
  // Without its own uid it still refuses a world-writable directory.
  await assertRejects(
    () =>
      assertTrustedCacheDirs(["/c"], {
        os: "linux",
        uid: null,
        stat: at({ "/c": info(7, 0o40777) }),
      }),
    UntrustedCacheDirError,
  );
  // Windows has ACLs, not mode bits: not checked.
  await assertTrustedCacheDirs(["/c"], {
    os: "windows",
    uid: 501,
    stat: at({ "/c": info(7, 0o40777) }),
  });
});

Deno.test("cacheDirChain: every directory from DENO_DIR down to the binary's", () => {
  assertEquals(cacheDirChain("/d", "/d/denext-deno/1.0/linux"), [
    "/d",
    "/d/denext-deno",
    "/d/denext-deno/1.0",
    "/d/denext-deno/1.0/linux",
  ]);
  assertEquals(cacheDirChain("/d", "/d"), ["/d"]);
  assertEquals(cacheDirChain("/d", "/elsewhere/x"), ["/d", "/elsewhere/x"]);
});

Deno.test({
  name: "ensureDenoToolchain: a world-writable cache is refused before anything is fetched or run",
  ignore: WINDOWS,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "denext-audit-cache-" });
    try {
      const denoDir = join(tmp, "deno");
      await Deno.mkdir(denoDir);
      await Deno.chmod(denoDir, 0o777); // a DENO_DIR anyone could have pre-created and filled
      const body = new TextEncoder().encode("#!/bin/sh\necho planted\n");
      const target = "linux-x86_64";
      const pin: DenoToolchainPin = {
        schema: 1,
        version: "9.9.9-denext.1",
        targets: {
          [target]: {
            file: "deno",
            url: "http://127.0.0.1:9/deno",
            sha256: await sha256Hex(body),
            size: body.byteLength,
            format: "binary",
          },
        },
      };
      let fetched = 0;
      const fakeFetch: typeof fetch = () => {
        fetched++;
        return Promise.resolve(new Response(body));
      };
      await assertRejects(
        () =>
          ensureDenoToolchain({
            pin,
            target,
            os: "linux",
            cacheRoot: join(denoDir, "denext-deno"),
            fetch: fakeFetch,
            log: () => {},
          }),
        UntrustedCacheDirError,
        "writable by every user",
      );
      assertEquals(fetched, 0);
      // Its lock files were never created there either.
      assertEquals(
        await Deno.stat(join(denoDir, "denext-deno", ".package-cache")).catch(() => null),
        null,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "compileTailwind: a cached binary that does not hash to its pin is replaced, never run",
  ignore: WINDOWS,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "denext-audit-tw-" });
    const saved = [
      "XDG_CACHE_HOME",
      "DENEXT_TAILWIND_VERSION",
      "DENEXT_TAILWIND_SHA256",
      "TAILWIND_BIN",
    ]
      .map((k) => [k, Deno.env.get(k)] as const);
    const realFetch = globalThis.fetch;
    try {
      const good = "#!/bin/sh\nprintf 'pinned' > \"$4\"\n";
      Deno.env.set("XDG_CACHE_HOME", tmp);
      Deno.env.set("DENEXT_TAILWIND_VERSION", "v0.0.0-audit");
      Deno.env.set("DENEXT_TAILWIND_SHA256", await sha256Hex(new TextEncoder().encode(good)));
      Deno.env.delete("TAILWIND_BIN");
      // What another process (or a crashed download) left in the cache.
      const cached = join(tmp, "denext", "tailwind", "v0.0.0-audit", "tailwindcss");
      await Deno.mkdir(join(cached, ".."), { recursive: true });
      await Deno.writeTextFile(cached, "#!/bin/sh\nprintf 'planted' > \"$4\"\n", { mode: 0o755 });
      await Deno.chmod(cached, 0o755);
      let fetched = 0;
      globalThis.fetch = (() => {
        fetched++;
        return Promise.resolve(new Response(good));
      }) as typeof fetch;
      const input = join(tmp, "in.css");
      const output = join(tmp, "out.css");
      await Deno.writeTextFile(input, "@import 'tailwindcss';");
      const log = console.log;
      console.log = () => {};
      try {
        await compileTailwind({ input, output, cwd: tmp });
      } finally {
        console.log = log;
      }
      assertEquals(await Deno.readTextFile(output), "pinned");
      assertEquals(fetched, 1);
      assertEquals(await Deno.readTextFile(cached), good);
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test("compile.permissions: an empty network direction is refused, not baked unscoped", () => {
  const ok = (permissions: unknown) =>
    validateDenextConfig({ compile: { permissions } } as DenextConfig);
  // Why: an empty list is no scope to Deno, so it would bake the direction wide open.
  assertEquals(
    compileBuildFlags({ permissions: { netConnect: [], netListen: [":3000"] } }, { netSplit: true })
      .slice(0, 2),
    ["--allow-net-connect", "--allow-net-listen=:3000"],
  );
  assertThrows(() => ok({ netConnect: [], netListen: [":3000"] }), Error, "netConnect` is empty");
  assertThrows(() => ok({ netListen: [] }), Error, "netListen` is empty");
  ok({ netConnect: ["*"], netListen: [":3000"] });
  ok({ netListen: [":3000"] });
});

/** An executable `sh` script that leaves a background process holding its stdout and stderr. */
async function pipeHolder(dir: string, pidFile: string, out: string): Promise<string> {
  const path = join(dir, "held");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\nsleep 40 &\necho $! > '${pidFile}'\nprintf '${out}'\nexit 0\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

/** Kill the background holder the stand-in recorded. */
async function killHolder(pidFile: string): Promise<void> {
  try {
    Deno.kill(Number((await Deno.readTextFile(pidFile)).trim()), "SIGKILL");
  } catch { /* gone, or never started */ }
}

for (
  const [name, run] of [
    ["runSecureCli (the desktop secure-store cap)", (cmd: string) => runSecureCli(cmd, [])],
    ["adbRunner (profile --android)", (cmd: string) => adbRunner(cmd)([])],
  ] as const
) {
  Deno.test({
    name: `${name}: returns once the CLI exits while a process it left holds its pipes`,
    ignore: WINDOWS,
    fn: async () => {
      const dir = await Deno.makeTempDir({ prefix: "denext-audit-pipe-" });
      const pidFile = join(dir, "pid");
      try {
        const cmd = await pipeHolder(dir, pidFile, "ok");
        const t0 = Date.now();
        const out = await run(cmd);
        const took = Date.now() - t0;
        assert(took < 20_000, `took ${took} ms (waited on the pipe holder)`);
        assertEquals(out.code, 0);
        assertEquals(out.stdout, "ok");
      } finally {
        await killHolder(pidFile);
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

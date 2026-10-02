// src/build/desktop-runtime.ts: the pinned Deno Desktop runtime — download from a LOCAL fixture
// server (no network), size + SHA-256 verification before extraction, the verified cache and its
// marker, concurrency, offline reuse, the deno version gate, the env overrides — plus the pin
// generator (scripts/desktop-pin-runtime.ts).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  denoCacheDir,
  denoVersionMismatchMessage,
  desktopRuntimeDir,
  DesktopRuntimeDownloadError,
  type DesktopRuntimePin,
  desktopRuntimeTarget,
  ensureDesktopRuntime,
  projectDesktopBackend,
  resolveDesktopRuntimeEnv,
  RUNTIME_MARKER,
  verifiedRuntime,
} from "../src/build/desktop-runtime.ts";
import {
  main as pinRuntimeMain,
  parseSha256Sums,
  pinFromRelease,
} from "../scripts/desktop-pin-runtime.ts";
import { desktopRuntimeCheck } from "../src/cli/commands/doctor.ts";
import { sha256Hex, tarGz } from "./_archive-fixtures.ts";

const TARGET = "x86_64-unknown-linux-gnu";
const LIB = "libdenort.so";

async function fixtureArchive(extra: string = ""): Promise<Uint8Array> {
  return await tarGz([
    { name: "./", type: "5", mode: 0o755 },
    { name: `./${LIB}`, data: `runtime${extra}`, mode: 0o755 },
    { name: "./laufey/", type: "5", mode: 0o755 },
    { name: "./laufey/webview/build/laufey_webview", data: "host", mode: 0o755 },
    { name: "./BUILD_INFO.json", data: "{}" },
  ]);
}

interface Fixture {
  pin: DesktopRuntimePin;
  cacheRoot: string;
  hits: () => number;
  setBody: (b: Uint8Array | ((req: Request) => Response)) => void;
  close: () => Promise<void>;
}

/** A local HTTP server serving the archive + a pin pointing at it. */
async function fixture(archive: Uint8Array): Promise<Fixture> {
  let hits = 0;
  let body: Uint8Array | ((req: Request) => Response) = archive;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    hits++;
    return typeof body === "function" ? body(req) : new Response(body as BodyInit);
  });
  const file = `deno-desktop-runtime-9.9.9-denext.1-${TARGET}-webview.tar.gz`;
  const pin: DesktopRuntimePin = {
    schema: 1,
    version: "9.9.9-denext.1",
    tag: "denext-runtime-v9.9.9-denext.1",
    repository: "https://github.com/Brainwires/deno",
    deno: "9.9.9",
    denoSha: "",
    laufeySha: "",
    laufeyApiVersion: null,
    targets: {
      [TARGET]: {
        runtimeLib: LIB,
        webview: {
          file,
          url: `http://127.0.0.1:${server.addr.port}/${file}`,
          sha256: await sha256Hex(archive),
          size: archive.byteLength,
          format: "tar.gz",
        },
      },
    },
  };
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-rt-cache-" });
  return {
    pin,
    cacheRoot,
    hits: () => hits,
    setBody: (b) => void (body = b),
    close: async () => {
      await server.shutdown();
      await Deno.remove(cacheRoot, { recursive: true }).catch(() => {});
    },
  };
}

const quiet = () => {};
const offline: typeof fetch = () => Promise.reject(new TypeError("network unreachable"));

function ensure(f: Fixture, extra: Partial<Parameters<typeof ensureDesktopRuntime>[0]> = {}) {
  return ensureDesktopRuntime({
    target: TARGET,
    backend: "webview",
    pin: f.pin,
    cacheRoot: f.cacheRoot,
    log: quiet,
    harmonize: false,
    ...extra,
  });
}

/** Everything under `dir` (relative), to assert nothing was left behind. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for await (const e of Deno.readDir(d)) {
      out.push(rel + e.name);
      if (e.isDirectory) await walk(join(d, e.name), `${rel}${e.name}/`);
    }
  };
  await walk(dir, "").catch(() => {});
  return out.sort();
}

Deno.test("ensureDesktopRuntime downloads, verifies, extracts and marks the runtime", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    const rt = await ensure(f);
    assertEquals(rt.cached, false);
    assertEquals(rt.dir, desktopRuntimeDir(f.cacheRoot, f.pin, TARGET, "webview"));
    assertEquals(rt.runtimeLib, join(rt.dir, LIB));
    assertEquals(rt.laufeyDir, join(rt.dir, "laufey"));
    assertEquals(await Deno.readTextFile(rt.runtimeLib), "runtime");
    const marker = JSON.parse(await Deno.readTextFile(join(rt.dir, RUNTIME_MARKER)));
    assertEquals(marker.archive.sha256, f.pin.targets[TARGET].webview!.sha256);
    assertEquals(marker.files[LIB].size, "runtime".length);
    // No temp dirs or archive left behind next to the installed tree.
    assertEquals(
      await tree(join(f.cacheRoot, f.pin.version)),
      [
        `${TARGET}-webview`,
        ...(await tree(rt.dir)).map((p) => `${TARGET}-webview/${p}`),
      ].sort(),
    );
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime reuses the cache with no network (offline with cache)", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    await ensure(f);
    assertEquals(f.hits(), 1);
    const again = await ensure(f, { fetch: offline });
    assertEquals(again.cached, true);
    const verified = await ensure(f, { fetch: offline, verify: true });
    assertEquals(verified.cached, true);
    assertEquals(f.hits(), 1);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime offline with no cache: a clear error, nothing installed", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    const err = await assertRejects(
      () => ensure(f, { fetch: offline }),
      DesktopRuntimeDownloadError,
    );
    assertStringIncludes(err.message, "offline");
    assertStringIncludes(err.message, "DENEXT_DESKTOP_RUNTIME_DIR");
    assertEquals(await tree(join(f.cacheRoot, f.pin.version)), []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime refuses a checksum mismatch and extracts nothing", async () => {
  const good = await fixtureArchive();
  const f = await fixture(good);
  try {
    // Same size, different bytes (a tampered archive).
    const evil = good.slice();
    evil[evil.length - 10] ^= 0xff;
    f.setBody(evil);
    const err = await assertRejects(() => ensure(f), Error);
    assertStringIncludes(err.message, "SHA-256 mismatch");
    assertStringIncludes(err.message, "Nothing was extracted");
    assertEquals(await tree(join(f.cacheRoot, f.pin.version)), []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime refuses an oversized and a truncated download", async () => {
  const good = await fixtureArchive();
  const f = await fixture(good);
  try {
    const bigger = new Uint8Array(good.byteLength + 100);
    bigger.set(good);
    f.setBody(bigger);
    assertStringIncludes(
      (await assertRejects(() => ensure(f), Error)).message,
      "larger than its pinned",
    );
    f.setBody(good.subarray(0, good.byteLength - 50));
    assertStringIncludes(
      (await assertRejects(() => ensure(f), Error)).message,
      "truncated download",
    );
    // A connection that dies mid-body.
    f.setBody(() =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(good.subarray(0, 20));
            c.error(new Error("connection reset"));
          },
        }),
      )
    );
    await assertRejects(() => ensure(f));
    f.setBody(() => new Response("nope", { status: 404 }));
    assertStringIncludes((await assertRejects(() => ensure(f), Error)).message, "404");
    assertEquals(await tree(join(f.cacheRoot, f.pin.version)), []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime: two concurrent installs end with one verified tree", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    const [a, b, c] = await Promise.all([ensure(f), ensure(f), ensure(f)]);
    assertEquals(a.dir, b.dir);
    assertEquals(b.dir, c.dir);
    const art = f.pin.targets[TARGET].webview!;
    assert(await verifiedRuntime(a.dir, f.pin, art, true));
    assertEquals(
      await tree(join(f.cacheRoot, f.pin.version)),
      [
        `${TARGET}-webview`,
        ...(await tree(a.dir)).map((p) => `${TARGET}-webview/${p}`),
      ].sort(),
    );
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime re-downloads a damaged cache (cheap size check, full --verify)", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    const rt = await ensure(f);
    // Same size, different bytes: the cheap check passes, --verify catches it.
    await Deno.writeTextFile(rt.runtimeLib, "RUNTIME");
    assertEquals((await ensure(f)).cached, true);
    const fixed = await ensure(f, { verify: true });
    assertEquals(fixed.cached, false);
    assertEquals(await Deno.readTextFile(rt.runtimeLib), "runtime");
    // A truncated file fails the cheap check.
    await Deno.writeTextFile(rt.runtimeLib, "r");
    assertEquals((await ensure(f)).cached, false);
    // A marker for a different archive is not trusted.
    const marker = JSON.parse(await Deno.readTextFile(join(rt.dir, RUNTIME_MARKER)));
    marker.archive.sha256 = "0".repeat(64);
    await Deno.writeTextFile(join(rt.dir, RUNTIME_MARKER), JSON.stringify(marker));
    assertEquals((await ensure(f)).cached, false);
    assertEquals(f.hits(), 4);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime refuses an archive without the runtime lib", async () => {
  const archive = await tarGz([{ name: "laufey/x", data: "y" }]);
  const f = await fixture(archive);
  try {
    assertStringIncludes((await assertRejects(() => ensure(f), Error)).message, `no ${LIB}`);
    assertEquals(await tree(join(f.cacheRoot, f.pin.version)), []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime attest: runs gh on the archive; a cached unattested copy is refetched", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    await ensure(f);
    const calls: string[][] = [];
    const rt = await ensure(f, {
      attest: true,
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        return Promise.resolve(0);
      },
    });
    assertEquals(rt.cached, false);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].slice(0, 3), ["gh", "attestation", "verify"]);
    assertEquals(calls[0].slice(-2), ["-R", "Brainwires/deno"]);
    assertEquals((await ensure(f, { attest: true, fetch: offline })).cached, true);
    // Cached AND attested: no download and no gh run (a failing gh would throw).
    const cached = await ensure(f, {
      attest: true,
      verify: true,
      fetch: offline,
      run: () => Promise.resolve(1),
    });
    assertEquals(cached.cached, true);
    const failing = await fixture(await fixtureArchive("x"));
    try {
      const err = await assertRejects(
        () => ensure(failing, { attest: true, run: () => Promise.resolve(1) }),
        Error,
      );
      assertStringIncludes(err.message, "provenance check failed");
      assertEquals(await tree(join(failing.cacheRoot, failing.pin.version)), []);
    } finally {
      await failing.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test("ensureDesktopRuntime re-signs laufey's Mach-Os once at install, then the cache verifies", async () => {
  const app = "laufey/webview/build/laufey_webview.app/Contents";
  const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  const archive = await tarGz([
    { name: LIB, data: "runtime" },
    { name: `${app}/Info.plist`, data: "<plist/>" },
    { name: `${app}/MacOS/laufey_webview`, data: macho, mode: 0o755 },
    { name: `${app}/MacOS/launcher.sh`, data: "#!/bin/sh" },
    { name: "laufey/cef/build/Release/laufey.app/Contents/MacOS/laufey", data: macho },
    { name: "laufey/cef/build/Release/laufey.app/Contents/Info.plist", data: "<plist/>" },
  ]);
  const f = await fixture(archive);
  try {
    const calls: string[][] = [];
    // A fake plutil / codesign: the webview app's binary has the wrong identifier (re-signed,
    // which rewrites it), the cef one already matches (left alone).
    const capture = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const path = args[args.length - 1];
      if (cmd === "plutil") return { code: 0, text: "com.deno.desktop\n" };
      if (args[0] === "-dv") {
        return {
          code: 0,
          // Match the laufey/cef/ path SEGMENT: the absolute path also holds random temp-dir
          // names (hex), which contain "cef" now and then.
          text: /[\\/]laufey[\\/]cef[\\/]/.test(path)
            ? "Identifier=com.deno.desktop\n"
            : "Identifier=laufey\n",
        };
      }
      await Deno.writeFile(path, new Uint8Array([...macho, 9, 9, 9]));
      await Deno.mkdir(join(path, "..", "..", "_CodeSignature"), { recursive: true });
      await Deno.writeTextFile(join(path, "..", "..", "_CodeSignature", "CodeResources"), "sig");
      return { code: 0, text: "" };
    };
    const rt = await ensure(f, { harmonize: true, capture });
    const signs = calls.filter((c) => c[0] === "codesign" && c[1] === "--force");
    assertEquals(signs.length, 1);
    assertEquals(signs[0].slice(1, 6), [
      "--force",
      "--identifier",
      "com.deno.desktop",
      "--sign",
      "-",
    ]);
    assert(signs[0][6].endsWith("laufey_webview"));
    // The launcher script is not Mach-O: never shown to codesign.
    assert(!calls.some((c) => c[c.length - 1].endsWith("launcher.sh")));
    const marker = JSON.parse(await Deno.readTextFile(join(rt.dir, RUNTIME_MARKER)));
    assertEquals(marker.files[`${app}/MacOS/laufey_webview`].size, macho.length + 3);
    assert(marker.files[`${app}/_CodeSignature/CodeResources`]);
    const art = f.pin.targets[TARGET].webview!;
    assert(await verifiedRuntime(rt.dir, f.pin, art, true));
    // A codesign failure fails the install and leaves nothing behind.
    const g = await fixture(archive);
    try {
      const failing = (cmd: string, args: string[]) =>
        Promise.resolve(
          cmd === "plutil"
            ? { code: 0, text: "id" }
            : args[0] === "-dv"
            ? { code: 1, text: "" }
            : { code: 1, text: "boom" },
        );
      const err = await assertRejects(
        () => ensure(g, { harmonize: true, capture: failing }),
        Error,
      );
      assertStringIncludes(err.message, "codesign failed");
      assertEquals(await tree(join(g.cacheRoot, g.pin.version)), []);
    } finally {
      await g.close();
    }
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------------------------
// resolveDesktopRuntimeEnv: the version gate and the overrides.

function envOf(vars: Record<string, string>) {
  return (k: string) => vars[k];
}

Deno.test("resolveDesktopRuntimeEnv: the pinned runtime's env for a matching deno", async () => {
  const f = await fixture(await fixtureArchive());
  const project = await Deno.makeTempDir();
  try {
    const r = await resolveDesktopRuntimeEnv({
      projectDir: project,
      target: TARGET,
      hostOs: "linux",
      pin: f.pin,
      cacheRoot: f.cacheRoot,
      env: envOf({}),
      denoVersion: () => Promise.resolve("9.9.9"),
      log: quiet,
    });
    assertEquals(r.mode, "pinned");
    const dir = desktopRuntimeDir(f.cacheRoot, f.pin, TARGET, "webview");
    assertEquals(r.env, {
      DENORT_DESKTOP_BIN: join(dir, LIB),
      LAUFEY_DEV_DIR: join(dir, "laufey"),
    });
  } finally {
    await f.close();
    await Deno.remove(project, { recursive: true });
  }
});

Deno.test("resolveDesktopRuntimeEnv: a deno version mismatch fails with the install command", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    const err = await assertRejects(
      () =>
        resolveDesktopRuntimeEnv({
          projectDir: ".",
          target: TARGET,
          hostOs: "linux",
          pin: f.pin,
          cacheRoot: f.cacheRoot,
          env: envOf({}),
          denoVersion: () => Promise.resolve("2.9.6"),
          log: quiet,
        }),
      Error,
    );
    assertEquals(err.message, denoVersionMismatchMessage("2.9.6", f.pin));
    assertStringIncludes(err.message, "deno upgrade --version 9.9.9");
    assertStringIncludes(err.message, "DENEXT_DESKTOP_RUNTIME=stock");
    assertEquals(f.hits(), 0);
  } finally {
    await f.close();
  }
});

Deno.test("resolveDesktopRuntimeEnv: DENEXT_DESKTOP_RUNTIME=stock → no env, a warning, no checks", async () => {
  const logs: string[] = [];
  const r = await resolveDesktopRuntimeEnv({
    projectDir: ".",
    target: TARGET,
    env: envOf({ DENEXT_DESKTOP_RUNTIME: "stock" }),
    denoVersion: () => Promise.reject(new Error("must not be called")),
    log: (l) => logs.push(l),
  });
  assertEquals(r, { mode: "stock", env: {} });
  assertStringIncludes(logs.join("\n"), "deep links");
  await assertRejects(
    () =>
      resolveDesktopRuntimeEnv({
        projectDir: ".",
        target: TARGET,
        env: envOf({ DENEXT_DESKTOP_RUNTIME: "bogus" }),
        log: quiet,
      }),
    Error,
    "must be",
  );
});

Deno.test("resolveDesktopRuntimeEnv: DENEXT_DESKTOP_RUNTIME_DIR uses a local build, unverified", async () => {
  const local = await Deno.makeTempDir();
  try {
    const logs: string[] = [];
    const run = (vars: Record<string, string>) =>
      resolveDesktopRuntimeEnv({
        projectDir: ".",
        target: TARGET,
        env: envOf(vars),
        fetch: offline,
        denoVersion: () => Promise.reject(new Error("must not be called")),
        log: (l) => logs.push(l),
      });
    await assertRejects(() => run({ DENEXT_DESKTOP_RUNTIME_DIR: local }), Error, `no ${LIB}`);
    await Deno.writeTextFile(join(local, LIB), "x");
    await assertRejects(() => run({ DENEXT_DESKTOP_RUNTIME_DIR: local }), Error, "no laufey/");
    await Deno.mkdir(join(local, "laufey"));
    const r = await run({ DENEXT_DESKTOP_RUNTIME_DIR: local });
    assertEquals(r.mode, "local");
    assertEquals(r.env, {
      DENORT_DESKTOP_BIN: join(local, LIB),
      LAUFEY_DEV_DIR: join(local, "laufey"),
    });
    assertStringIncludes(logs.join("\n"), "not downloaded, pinned or verified");
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test("resolveDesktopRuntimeEnv: refuses a Windows target from a non-Windows host (and back)", async () => {
  for (const [hostOs, target] of [["darwin", "x86_64-pc-windows-msvc"], ["windows", TARGET]]) {
    await assertRejects(
      () =>
        resolveDesktopRuntimeEnv({
          projectDir: ".",
          target,
          hostOs,
          env: envOf({}),
          denoVersion: () => Promise.resolve("2.9.7"),
          log: quiet,
        }),
      Error,
      "executable suffix",
    );
  }
});

Deno.test("resolveDesktopRuntimeEnv: an unpinned target names the stock opt-out", async () => {
  const f = await fixture(await fixtureArchive());
  try {
    const err = await assertRejects(
      () =>
        resolveDesktopRuntimeEnv({
          projectDir: ".",
          target: "aarch64-unknown-linux-gnu",
          hostOs: "linux",
          pin: f.pin,
          cacheRoot: f.cacheRoot,
          env: envOf({}),
          denoVersion: () => Promise.resolve("9.9.9"),
          log: quiet,
        }),
      Error,
    );
    assertStringIncludes(err.message, "has no webview build for aarch64-unknown-linux-gnu");
  } finally {
    await f.close();
  }
});

Deno.test("projectDesktopBackend reads deno.json desktop.backend", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await projectDesktopBackend(dir), "webview");
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": { "backend": "cef" } }');
    assertEquals(await projectDesktopBackend(dir), "cef");
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": { "backend": "raw" } }');
    await assertRejects(() => projectDesktopBackend(dir), Error, "stock");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoCacheDir / desktopRuntimeTarget follow Deno's own defaults", () => {
  assertEquals(denoCacheDir(envOf({ DENO_DIR: "/d" }), "linux"), "/d");
  assertEquals(
    denoCacheDir(envOf({ HOME: "/h" }), "darwin"),
    join("/h", "Library", "Caches", "deno"),
  );
  assertEquals(denoCacheDir(envOf({ HOME: "/h" }), "linux"), join("/h", ".cache", "deno"));
  assertEquals(
    denoCacheDir(envOf({ HOME: "/h", XDG_CACHE_HOME: "/x" }), "linux"),
    join("/x", "deno"),
  );
  assertEquals(denoCacheDir(envOf({ LOCALAPPDATA: "C:/L" }), "windows"), join("C:/L", "deno"));
  assertEquals(desktopRuntimeTarget("darwin", "x86_64"), "x86_64-apple-darwin");
  assertEquals(desktopRuntimeTarget("linux", "aarch64"), "aarch64-unknown-linux-gnu");
  assertEquals(desktopRuntimeTarget("windows", "x86_64"), "x86_64-pc-windows-msvc");
});

// ---------------------------------------------------------------------------------------------
// `denext doctor`.

Deno.test("doctor desktopRuntimeCheck: version, cache state and the deno match", async () => {
  const f = await fixture(await fixtureArchive());
  const project = await Deno.makeTempDir();
  try {
    const opts = {
      target: TARGET,
      pin: f.pin,
      cacheRoot: f.cacheRoot,
      env: envOf({}),
      denoVersion: () => Promise.resolve("9.9.9"),
    };
    // Not a desktop project: no check.
    assertEquals(await desktopRuntimeCheck(project, opts), null);
    await Deno.writeTextFile(join(project, "desktop.ts"), "");
    let c = (await desktopRuntimeCheck(project, opts))!;
    assertEquals(c.ok, true);
    assertEquals(c.critical, false);
    assertStringIncludes(c.detail, "runtime 9.9.9-denext.1");
    assertStringIncludes(c.detail, "not cached yet");
    assertEquals(f.hits(), 0); // doctor never downloads
    const rt = await ensure(f);
    c = (await desktopRuntimeCheck(project, opts))!;
    assertStringIncludes(c.detail, "cached + verified");
    assertStringIncludes(c.detail, "deno 9.9.9 ✓");
    await Deno.writeTextFile(rt.runtimeLib, "r");
    c = (await desktopRuntimeCheck(project, opts))!;
    assertEquals(c.ok, false);
    assertStringIncludes(c.detail, "FAILED verification");
    c = (await desktopRuntimeCheck(project, {
      ...opts,
      denoVersion: () => Promise.resolve("2.9.6"),
    }))!;
    assertEquals(c.ok, false);
    assertStringIncludes(c.detail, "deno upgrade --version 9.9.9");
    c = (await desktopRuntimeCheck(project, {
      ...opts,
      env: envOf({ DENEXT_DESKTOP_RUNTIME: "stock" }),
    }))!;
    assertEquals(c.ok, true);
    assertStringIncludes(c.detail, "stock");
  } finally {
    await f.close();
    await Deno.remove(project, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The pin generator.

const TAG = "denext-runtime-v2.9.7-denext.1";
const fileOf = (t: string, b: string) =>
  `deno-desktop-runtime-2.9.7-denext.1-${t}-${b}.${t.includes("windows") ? "zip" : "tar.gz"}`;

function release() {
  const sha = (n: number) => n.toString(16).padStart(64, "0");
  const targets: Record<string, Record<string, unknown>> = {};
  const sums: string[] = [];
  let n = 1;
  for (const t of ["x86_64-apple-darwin", "x86_64-pc-windows-msvc"]) {
    const lib = t.includes("windows") ? "denort.dll" : "libdenort.dylib";
    targets[t] = { runtimeLib: lib };
    for (const b of ["webview", "cef"]) {
      const file = fileOf(t, b);
      targets[t][b] = {
        file,
        url: `https://github.com/Brainwires/deno/releases/download/${TAG}/${file}`,
        sha256: sha(n),
        size: 1000 + n,
        format: t.includes("windows") ? "zip" : "tar.gz",
      };
      sums.push(`${sha(n++)}  ${file}`);
    }
  }
  const manifest = {
    schema: 1,
    name: "deno-desktop-runtime",
    version: "2.9.7-denext.1",
    tag: TAG,
    deno: { version: "2.9.7", sha: "abc" },
    laufey: { sha: "def", apiVersion: 3 },
    targets,
  };
  return { manifest, sums: sums.join("\n") + "\n" };
}

Deno.test("pinFromRelease builds the pin and cross-checks SHA256SUMS", () => {
  const { manifest, sums } = release();
  const pin = pinFromRelease(TAG, manifest, sums);
  assertEquals(pin.deno, "2.9.7");
  assertEquals(pin.version, "2.9.7-denext.1");
  assertEquals(pin.laufeyApiVersion, 3);
  assertEquals(pin.targets["x86_64-pc-windows-msvc"].runtimeLib, "denort.dll");
  assertEquals(pin.targets["x86_64-pc-windows-msvc"].cef?.format, "zip");
  assertEquals(parseSha256Sums(sums).size, 4);
});

Deno.test("pinFromRelease refuses any inconsistency", () => {
  const cases: Array<[string, (r: ReturnType<typeof release>) => void]> = [
    ["SHA256SUMS", (r) => (r.sums = r.sums.replace(/^[0-9a-f]{64}/, "f".repeat(64)))],
    ["not in SHA256SUMS", (r) => (r.sums = r.sums.split("\n").slice(1).join("\n"))],
    [
      "SHA256SUMS only",
      (r) => (r.sums += `${"e".repeat(64)}  ${fileOf("x86_64-unknown-linux-gnu", "cef")}\n`),
    ],
    ["expected https://github.com", (r) => {
      // deno-lint-ignore no-explicit-any
      (r.manifest.targets["x86_64-apple-darwin"].webview as any).url = "https://evil.example/x";
    }],
    ["not ", (r) => (r.manifest.tag = "denext-runtime-v2.9.8-denext.1")],
    ["bad deno version", (r) => (r.manifest.deno.version = "2.9.8")],
  ];
  for (const [msg, mutate] of cases) {
    const r = release();
    mutate(r);
    let err: unknown;
    try {
      pinFromRelease(TAG, r.manifest, r.sums);
    } catch (e) {
      err = e;
    }
    assert(err instanceof Error, msg);
    assertStringIncludes(err.message, msg);
  }
});

Deno.test("pinFromRelease refuses a malformed manifest or archive entry", () => {
  // deno-lint-ignore no-explicit-any
  type R = { manifest: any; sums: string };
  const mac = (r: R) => r.manifest.targets["x86_64-apple-darwin"];
  const cases: Array<[string, (r: R) => void]> = [
    ["not a schema-1 runtime manifest", (r) => (r.manifest.schema = 2)],
    ["not a schema-1 runtime manifest", (r) => (r.manifest.name = "something-else")],
    ["does not match version", (r) => (r.manifest.version = "2.9.7-denext.2")],
    ["bad deno version", (r) => (r.manifest.deno = {})],
    ["unexpected runtimeLib", (r) => (mac(r).runtimeLib = "../evil.dylib")],
    ["expected deno-desktop-runtime", (r) => (mac(r).webview.file = "other.tar.gz")],
    ["format zip, expected tar.gz", (r) => (mac(r).webview.format = "zip")],
    ["bad sha256", (r) => (mac(r).webview.sha256 = "ABC")],
    ["bad size", (r) => (mac(r).webview.size = 0)],
    ["bad size", (r) => (mac(r).webview.size = 1.5)],
    ["lists no archives", (r) => {
      for (const t of Object.values(r.manifest.targets) as Array<Record<string, unknown>>) {
        delete t.webview;
        delete t.cef;
      }
    }],
  ];
  for (const [msg, mutate] of cases) {
    const r = release() as R;
    mutate(r);
    const err = (() => {
      try {
        pinFromRelease(TAG, r.manifest, r.sums);
      } catch (e) {
        return e;
      }
    })();
    assert(err instanceof Error, msg);
    assertStringIncludes(err.message, `desktop:pin-runtime: `);
    assertStringIncludes(err.message, msg);
  }
});

Deno.test("pinFromRelease: a target may ship one backend; laufey's api version is optional", () => {
  const r = release();
  // deno-lint-ignore no-explicit-any
  const m = r.manifest as any;
  const cefFile = m.targets["x86_64-apple-darwin"].cef.file;
  delete m.targets["x86_64-apple-darwin"].cef;
  r.sums = r.sums.split("\n").filter((l) => !l.endsWith(cefFile)).join("\n");
  delete m.laufey;
  const pin = pinFromRelease(TAG, m, r.sums);
  assertEquals(Object.keys(pin.targets["x86_64-apple-darwin"]), ["runtimeLib", "webview"]);
  assertEquals(pin.laufeyApiVersion, null);
  assertEquals(pin.laufeySha, "");
  // Targets are written sorted, whatever the manifest's order.
  assertEquals(Object.keys(pin.targets), ["x86_64-apple-darwin", "x86_64-pc-windows-msvc"]);
});

Deno.test("parseSha256Sums: text and binary mode lines, CRLF; anything else is skipped", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const sums = parseSha256Sums(
    `${a}  one.tar.gz\r\n${b} *two.zip\r\n# comment\n${
      "C".repeat(64)
    }  upper.zip\nshort  x.zip\n\n`,
  );
  assertEquals([...sums], [["one.tar.gz", a], ["two.zip", b]]);
});

Deno.test("desktop:pin-runtime CLI: fetches the tag's manifest + SHA256SUMS and writes the pin", async () => {
  const { manifest, sums } = release();
  const dir = await Deno.makeTempDir();
  const out = join(dir, "pin.json");
  const fetched: string[] = [];
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const logged: string[] = [];
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url.endsWith("/manifest.json")) return Promise.resolve(Response.json(manifest));
    if (url.endsWith("/SHA256SUMS")) return Promise.resolve(new Response(sums));
    return Promise.resolve(new Response("nope", { status: 404, statusText: "Not Found" }));
  };
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await pinRuntimeMain([TAG], out);
    const base = `https://github.com/Brainwires/deno/releases/download/${TAG}`;
    assertEquals(fetched, [`${base}/manifest.json`, `${base}/SHA256SUMS`]);
    const text = await Deno.readTextFile(out);
    assert(text.endsWith("}\n"));
    assertEquals(JSON.parse(text), pinFromRelease(TAG, manifest, sums));
    assertStringIncludes(logged.join("\n"), "runtime 2.9.7-denext.1 (deno 2.9.7), 4 archives");

    // A failed download is an error naming the URL and status; nothing is written.
    globalThis.fetch = () =>
      Promise.resolve(new Response("gone", { status: 404, statusText: "Not Found" }));
    await Deno.remove(out);
    const err = await assertRejects(() => pinRuntimeMain([TAG], out));
    assertStringIncludes((err as Error).message, `GET ${base}/manifest.json: 404 Not Found`);
    await assertRejects(() => Deno.stat(out), Deno.errors.NotFound);
  } finally {
    globalThis.fetch = prevFetch;
    console.log = prevLog;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop:pin-runtime CLI: local --manifest/--sums never fetch; a bad release writes nothing", async () => {
  const { manifest, sums } = release();
  const dir = await Deno.makeTempDir();
  const out = join(dir, "pin.json");
  const mf = join(dir, "manifest.json");
  const sf = join(dir, "SHA256SUMS");
  await Deno.writeTextFile(mf, JSON.stringify(manifest));
  await Deno.writeTextFile(sf, sums);
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  globalThis.fetch = () => Promise.reject(new Error("must not fetch"));
  console.log = () => {};
  try {
    await pinRuntimeMain([TAG, "--manifest", mf, "--sums", sf], out);
    assertEquals(JSON.parse(await Deno.readTextFile(out)).tag, TAG);
    // Usage errors: no tag, or a flag where the tag goes.
    for (const args of [[], ["--manifest", mf]]) {
      const err = await assertRejects(() => pinRuntimeMain(args, out));
      assertStringIncludes((err as Error).message, "usage: deno task desktop:pin-runtime <tag>");
    }
    // A SHA256SUMS that disagrees with the manifest refuses before writing.
    await Deno.remove(out);
    await Deno.writeTextFile(sf, sums.replace(/^[0-9a-f]{64}/, "f".repeat(64)));
    await assertRejects(() => pinRuntimeMain([TAG, "--manifest", mf, "--sums", sf], out));
    await assertRejects(() => Deno.stat(out), Deno.errors.NotFound);
  } finally {
    globalThis.fetch = prevFetch;
    console.log = prevLog;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the checked-in pin is the deno version denext's runtime targets", async () => {
  const { DESKTOP_RUNTIME_PIN } = await import("../src/build/desktop-runtime.ts");
  assertEquals(DESKTOP_RUNTIME_PIN.deno, "2.9.7");
  assert(DESKTOP_RUNTIME_PIN.version.startsWith("2.9.7-denext."));
});

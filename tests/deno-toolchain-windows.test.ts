// src/build/deno-toolchain.ts on Windows: the `windows-<arch>` targets, the cache under a
// Windows-shaped DENO_DIR / %LOCALAPPDATA% / %USERPROFILE%, a Windows-made release zip (entries
// without Unix modes) holding `deno.exe` + `esbuild.exe`, no chmod for `os: "windows"`, the stamp's
// reuse and re-download, a corrupt download, and `DENEXT_DENO` as a cmd.exe user sets it. Every
// download comes from a local server; the OS is injected through the module's `os` options, so
// the file runs on any host — and on a Windows host the paths are real drive-letter paths.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, resolve, SEPARATOR } from "@std/path";
import {
  DENO_TOOLCHAIN,
  denoToolchainCacheRoot,
  DenoToolchainHashError,
  type DenoToolchainPin,
  DenoToolchainRequiredError,
  denoToolchainStatus,
  denoToolchainTarget,
  DenoToolchainUnavailableError,
  ensureDenoToolchain,
  resolveDenoToolchain,
  TOOLCHAIN_STAMP,
  toolchainEsbuild,
} from "../src/build/deno-toolchain.ts";
import { denoCacheDir } from "../src/build/desktop-runtime.ts";
import { ESBUILD_VERSION } from "../src/build/esbuild/version.ts";
import { sha256Hex, zip, type ZipEntry } from "./_archive-fixtures.ts";

const WIN = "windows-x86_64";
const PINNED = "9.9.9-denext.7";
const DENO_EXE = "MZ fake deno.exe\r\n";
const ESBUILD_EXE = "MZ fake esbuild.exe\r\n";
const onWindows = Deno.build.os === "windows";
const silent = () => {};
const noNetwork: typeof fetch = () => Promise.reject(new TypeError("network unreachable"));
const granted = () => Promise.resolve([]);
const envFrom = (vars: Record<string, string>) => (k: string) => vars[k];

/** A Windows-made zip: no entry carries a Unix mode (as `Compress-Archive` / 7-Zip write them). */
const winZip = (entries: Record<string, string>) =>
  zip(Object.entries(entries).map(([name, data]): ZipEntry => ({ name, data })));

const releaseZip = (deno = DENO_EXE) =>
  winZip({ "deno.exe": deno, "esbuild.exe": ESBUILD_EXE, "esbuild.LICENSE": "MIT" });

interface WinServer {
  readonly pin: DenoToolchainPin;
  cache: string;
  requests: () => number;
  serve: (body: Uint8Array) => void;
  repin: (body: Uint8Array) => Promise<void>;
  dispose: () => Promise<void>;
}

/** A loopback server for a Windows release zip, a pin naming it (and its esbuild), a temp cache. */
async function winServer(body: Uint8Array, esbuildPinned = true): Promise<WinServer> {
  let requests = 0;
  let current = body;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => {
    requests++;
    return new Response(current as BodyInit);
  });
  const file = `deno-cli-${PINNED}-x86_64-pc-windows-msvc.zip`;
  const artifactFor = async (b: Uint8Array) => ({
    file,
    url: `http://127.0.0.1:${server.addr.port}/${file}`,
    sha256: await sha256Hex(b),
    size: b.byteLength,
    format: "zip" as const,
    ...(esbuildPinned
      ? {
        esbuild: {
          version: ESBUILD_VERSION,
          sha256: await sha256Hex(new TextEncoder().encode(ESBUILD_EXE)),
        },
      }
      : {}),
  });
  const pinFor = async (b: Uint8Array): Promise<DenoToolchainPin> => ({
    schema: 1,
    version: PINNED,
    targets: { [WIN]: await artifactFor(b) },
  });
  let pin = await pinFor(body);
  const cache = await Deno.makeTempDir({ prefix: "denext-wintc-" });
  return {
    get pin() {
      return pin;
    },
    cache,
    requests: () => requests,
    serve: (b) => void (current = b),
    repin: async (b) => {
      current = b;
      pin = await pinFor(b);
    },
    dispose: async () => {
      await server.shutdown();
      await Deno.remove(cache, { recursive: true }).catch(() => {});
    },
  };
}

function ensureWin(s: WinServer, extra: Parameters<typeof ensureDenoToolchain>[0] = {}) {
  return ensureDenoToolchain({
    pin: s.pin,
    target: WIN,
    os: "windows",
    cacheRoot: s.cache,
    log: silent,
    ...extra,
  });
}

const installDir = (s: WinServer) => join(s.cache, PINNED, WIN);

/** The names directly under `dir` (none when it does not exist). */
async function entries(dir: string): Promise<string[]> {
  if (!(await Deno.stat(dir).catch(() => null))?.isDirectory) return [];
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("windows targets: x86_64 and aarch64 names; the checked-in pin's Windows entry", async () => {
  assertEquals(denoToolchainTarget("windows", "x86_64"), "windows-x86_64");
  assertEquals(denoToolchainTarget("windows", "aarch64"), "windows-aarch64");
  if (DENO_TOOLCHAIN.version !== null) {
    const a = DENO_TOOLCHAIN.targets[WIN];
    assert(a, "the pin carries a windows-x86_64 build");
    assert(a.file.endsWith("-x86_64-pc-windows-msvc.zip"), a.file);
    assertEquals(a.format ?? "zip", "zip");
    if (a.esbuild) assertEquals(a.esbuild.version, ESBUILD_VERSION);
    // Windows on Arm is pinned too (2.9.7-denext.21 on), with its own esbuild.exe.
    const arm = DENO_TOOLCHAIN.targets["windows-aarch64"];
    assert(arm, "the pin carries a windows-aarch64 build");
    assert(arm.file.endsWith("-aarch64-pc-windows-msvc.zip"), arm.file);
    if (arm.esbuild) assertEquals(arm.esbuild.version, ESBUILD_VERSION);
    assert(DENO_TOOLCHAIN.denort?.["windows-aarch64"], "the pin carries a windows-aarch64 denort");
  }
  // A pin without a windows-aarch64 build (before 2.9.7-denext.21): a clear refusal before any
  // download, and no other Deno on its own: the resolver refuses with the fix.
  const s = await winServer(await releaseZip());
  try {
    const err = await assertRejects(
      () => ensureWin(s, { target: "windows-aarch64" }),
      DenoToolchainUnavailableError,
    );
    assertStringIncludes(err.message, `has no build for windows-aarch64 (it has: ${WIN})`);
    const refused = await assertRejects(
      () =>
        resolveDenoToolchain({
          env: envFrom({}),
          pin: s.pin,
          target: "windows-aarch64",
          os: "windows",
          cacheRoot: s.cache,
          log: silent,
          missingGrants: granted,
        }),
      DenoToolchainRequiredError,
    );
    assertStringIncludes(refused.message, "has no build for windows-aarch64");
    assertStringIncludes(refused.message, "DENEXT_DENO=stock");
    assertEquals(s.requests(), 0);
  } finally {
    await s.dispose();
  }
});

Deno.test("windows install: a windows-aarch64 build installs under its own key", async () => {
  const s = await winServer(await releaseZip());
  try {
    const arm = "windows-aarch64";
    const pin = { ...s.pin, targets: { [arm]: s.pin.targets[WIN] } };
    const rt = await ensureWin(s, { pin, target: arm });
    assertEquals(rt.target, arm);
    assertEquals(rt.deno, join(s.cache, PINNED, arm, "deno.exe"));
    assertEquals(await Deno.readTextFile(rt.deno), DENO_EXE);
    assertEquals(s.requests(), 1);
  } finally {
    await s.dispose();
  }
});

Deno.test("windows cache root: DENO_DIR, then %LOCALAPPDATA%\\deno, then %USERPROFILE%\\AppData\\Local\\deno", () => {
  const sep = (...parts: string[]) => parts.join(SEPARATOR);
  const denoDir = "C:\\Users\\ci\\deno-cache";
  assertEquals(
    denoToolchainCacheRoot(envFrom({ DENO_DIR: denoDir, LOCALAPPDATA: "D:\\ignored" })),
    sep(denoDir, "denext-deno"),
  );
  const local = "C:\\Users\\ci\\AppData\\Local";
  assertEquals(denoCacheDir(envFrom({ LOCALAPPDATA: local }), "windows"), sep(local, "deno"));
  assertEquals(
    denoCacheDir(envFrom({ USERPROFILE: "C:\\Users\\ci" }), "windows"),
    sep("C:\\Users\\ci", "AppData", "Local", "deno"),
  );
  if (onWindows) {
    // The host's own path rules: backslashes throughout, forward slashes normalized.
    assertEquals(
      denoToolchainCacheRoot(envFrom({ DENO_DIR: denoDir })),
      "C:\\Users\\ci\\deno-cache\\denext-deno",
    );
    assertEquals(
      denoToolchainCacheRoot(envFrom({ DENO_DIR: "E:/caches/deno/" })),
      "E:\\caches\\deno\\denext-deno",
    );
    assertEquals(
      denoCacheDir(envFrom({ LOCALAPPDATA: local }), "windows"),
      "C:\\Users\\ci\\AppData\\Local\\deno",
    );
  }
});

Deno.test("windows install: deno.exe + esbuild.exe from a Windows-made zip, stamped, never chmod'ed", async () => {
  const s = await winServer(await releaseZip());
  try {
    const rt = await ensureWin(s);
    assertEquals(rt, {
      deno: join(installDir(s), "deno.exe"),
      version: PINNED,
      target: WIN,
      cached: false,
    });
    assertEquals(await Deno.readTextFile(rt.deno), DENO_EXE);
    assertEquals(await entries(installDir(s)), [
      TOOLCHAIN_STAMP,
      "deno.exe",
      "esbuild.LICENSE",
      "esbuild.exe",
    ]);
    if (!onWindows) {
      // `os: "windows"` skips the chmod: the zip's non-Unix entries extract 0o644 and stay so.
      for (const f of ["deno.exe", "esbuild.exe"]) {
        assertEquals((await Deno.stat(join(installDir(s), f))).mode! & 0o111, 0, f);
      }
    }
    const stamp = JSON.parse(await Deno.readTextFile(join(installDir(s), TOOLCHAIN_STAMP)));
    assertEquals([stamp.version, stamp.target], [PINNED, WIN]);
    assertEquals(stamp.archive, {
      file: s.pin.targets[WIN].file,
      sha256: s.pin.targets[WIN].sha256,
    });
    assertEquals(stamp.binary.sha256, await sha256Hex(new TextEncoder().encode(DENO_EXE)));
    assertEquals(stamp.esbuild.version, ESBUILD_VERSION);
    const opts = { env: envFrom({}), pin: s.pin, target: WIN, os: "windows", cacheRoot: s.cache };
    const esb = await toolchainEsbuild({ ...opts, verify: true });
    assertEquals([esb.state, esb.path], ["ok", join(installDir(s), "esbuild.exe")]);
    const status = await denoToolchainStatus({ ...opts, verify: true, running: PINNED });
    assertEquals([status.state, status.path, status.active], ["cached", rt.deno, true]);
  } finally {
    await s.dispose();
  }
});

Deno.test("windows install: a zip with `deno` but no deno.exe is refused; an esbuild without .exe is recorded, not installed", async () => {
  const unixNamed = await winServer(await winZip({ deno: DENO_EXE }));
  try {
    await assertRejects(() => ensureWin(unixNamed), Error, "has no top-level deno.exe");
    assertEquals(await entries(installDir(unixNamed)), []);
  } finally {
    await unixNamed.dispose();
  }
  const s = await winServer(await winZip({ "deno.exe": DENO_EXE, esbuild: ESBUILD_EXE }));
  try {
    const rt = await ensureWin(s);
    assertEquals(rt.deno, join(installDir(s), "deno.exe"));
    assertEquals(await entries(installDir(s)), [TOOLCHAIN_STAMP, "deno.exe"]);
    const esb = await toolchainEsbuild({
      env: envFrom({}),
      pin: s.pin,
      target: WIN,
      os: "windows",
      cacheRoot: s.cache,
    });
    assertEquals(esb.state, "refused");
    assertStringIncludes(esb.detail, "has no top-level esbuild.exe");
  } finally {
    await s.dispose();
  }
});

Deno.test("windows stamp: reused offline; a rewritten deno.exe or a new pinned archive re-downloads", async () => {
  const s = await winServer(await releaseZip());
  try {
    const rt = await ensureWin(s);
    assertEquals((await ensureWin(s, { fetch: noNetwork })).cached, true, "stamp reused");
    // Only the mtime moved (an AV scanner or a backup touching it): re-hashed, kept.
    const later = new Date(Date.now() + 120_000);
    await Deno.utime(rt.deno, later, later);
    assertEquals((await ensureWin(s, { fetch: noNetwork })).cached, true);
    // Same size, other bytes: the hash no longer matches the stamp → a fresh download.
    await Deno.writeTextFile(rt.deno, DENO_EXE.replace("fake", "evil"));
    const logs: string[] = [];
    assertEquals((await ensureWin(s, { log: (l) => logs.push(l) })).cached, false);
    assertStringIncludes(logs.join("\n"), "failed verification; re-downloading");
    assertEquals(await Deno.readTextFile(rt.deno), DENO_EXE);
    assertEquals(s.requests(), 2);
    // A new archive pinned under the same version: the stamp names the old one → re-download.
    const next = DENO_EXE.replace("fake", "next");
    await s.repin(await releaseZip(next));
    assertEquals((await ensureWin(s)).cached, false);
    assertEquals(await Deno.readTextFile(rt.deno), next);
    assertEquals(s.requests(), 3);
  } finally {
    await s.dispose();
  }
});

Deno.test("windows corrupt download: DenoToolchainHashError, nothing installed, stock with a loud warning", async () => {
  const good = await releaseZip();
  const s = await winServer(good);
  try {
    const corrupt = good.slice();
    corrupt[corrupt.length >> 1] ^= 0xff; // same size: only the SHA-256 can catch it
    s.serve(corrupt);
    const err = await assertRejects(() => ensureWin(s), DenoToolchainHashError);
    assertStringIncludes(err.message, "SHA-256 mismatch");
    assertStringIncludes(err.message, s.pin.targets[WIN].file);
    assertEquals(await entries(installDir(s)), [], "no deno.exe, no stamp, no temp dir");
    const refused = await assertRejects(
      () =>
        resolveDenoToolchain({
          env: envFrom({}),
          pin: s.pin,
          target: WIN,
          os: "windows",
          cacheRoot: s.cache,
          log: silent,
          missingGrants: granted,
        }),
      DenoToolchainRequiredError,
    );
    assertStringIncludes(refused.message, "REFUSING");
    assertStringIncludes(refused.message, "denext toolchain install");
  } finally {
    await s.dispose();
  }
});

Deno.test("windows resolve: the pinned deno.exe under DENO_DIR's denext-deno", async () => {
  const s = await winServer(await releaseZip());
  try {
    const choice = await resolveDenoToolchain({
      env: envFrom({ DENO_DIR: s.cache }),
      pin: s.pin,
      target: WIN,
      os: "windows",
      log: silent,
      missingGrants: granted,
    });
    assertEquals(choice, {
      kind: "toolchain",
      deno: join(s.cache, "denext-deno", PINNED, WIN, "deno.exe"),
      version: PINNED,
    });
  } finally {
    await s.dispose();
  }
});

Deno.test("windows DENEXT_DENO=<path>: a drive-letter path (as cmd.exe sets it) runs unverified", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-wintc-path-" });
  try {
    const exe = join(dir, "deno.exe");
    await Deno.writeTextFile(exe, DENO_EXE);
    const forms = [exe, `${exe} `]; // `set DENEXT_DENO=… && …` keeps the trailing space
    if (onWindows) forms.push(exe.replaceAll("\\", "/"));
    for (const raw of forms) {
      const choice = await resolveDenoToolchain({ env: envFrom({ DENEXT_DENO: raw }) });
      assert(choice.kind === "toolchain" && choice.warning, JSON.stringify(raw));
      assertEquals([choice.deno, choice.version], [resolve(exe), "path"]);
      assertStringIncludes(choice.warning, "not downloaded, pinned or verified");
    }
    if (onWindows) assert(/^[A-Za-z]:\\/.test(resolve(exe)), resolve(exe));
    const missing = "C:\\Program Files\\denext-missing\\deno.exe";
    const gone = await assertRejects(
      () => resolveDenoToolchain({ env: envFrom({ DENEXT_DENO: missing }) }),
      DenoToolchainRequiredError,
    );
    assertStringIncludes(gone.message, "is not a file");
    assertStringIncludes(gone.message, "deno.exe");
    const status = await denoToolchainStatus({
      env: envFrom({ DENEXT_DENO: exe }),
      pin: DENO_TOOLCHAIN,
      target: WIN,
      os: "windows",
    });
    assertEquals([status.mode, status.path, status.ok], ["path", exe, true]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("windows DENEXT_DENO=stock: any case, cmd's trailing space, never touches the cache", async () => {
  for (const raw of ["stock", "STOCK", "stock "]) {
    const choice = await resolveDenoToolchain({
      env: envFrom({ DENEXT_DENO: raw }),
      pin: { schema: 1, version: PINNED, targets: {} },
      target: WIN,
      os: "windows",
      cacheRoot: "Z:\\nonexistent\\denext-deno",
      fetch: noNetwork,
    });
    assertEquals(choice, { kind: "stock", reason: "DENEXT_DENO=stock" }, JSON.stringify(raw));
  }
  const status = await denoToolchainStatus({
    env: envFrom({ DENEXT_DENO: "stock " }),
    pin: DENO_TOOLCHAIN,
    target: WIN,
    os: "windows",
  });
  assertEquals([status.mode, status.ok, status.path], ["stock", true, null]);
  assertEquals(status.esbuild.state, "n/a");
});

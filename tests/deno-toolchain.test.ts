// src/build/deno-toolchain.ts: denext's managed Deno toolchain — the pin table and its target
// selection, download from a LOCAL fixture server (no network) with SHA-256 verification before
// anything is made executable or renamed, the stamp and the cheap/full re-verification, locked
// concurrent installs across processes, the choice of Deno a command runs on (opt-outs and every
// fallback warning), `status`, `link` / `unlink`, and `denext doctor`'s check.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  DENO_TOOLCHAIN,
  DenoToolchainDownloadError,
  DenoToolchainHashError,
  type DenoToolchainPin,
  denoToolchainStatus,
  denoToolchainTarget,
  DenoToolchainUnavailableError,
  ensureDenoToolchain,
  linkDenoToolchain,
  loadDenoToolchainPin,
  resolveDenoToolchain,
  staleToolchainLink,
  TOOLCHAIN_STAMP,
  unlinkDenoToolchain,
} from "../src/build/deno-toolchain.ts";
import { denoToolchainCheck } from "../src/cli/commands/doctor.ts";
import { DESKTOP_RUNTIME_PIN, desktopRuntimeStatus } from "../src/build/desktop-runtime.ts";
import { sha256Hex, zip } from "./_archive-fixtures.ts";

const TARGET = "linux-x86_64";
const VERSION = "9.9.9-denext.1";
const BINARY = "#!/bin/sh\necho fake deno\n";
const quiet = () => {};
const offline: typeof fetch = () => Promise.reject(new TypeError("network unreachable"));
const allGranted = () => Promise.resolve([]);

interface Fixture {
  pin: DenoToolchainPin;
  root: string;
  hits: () => number;
  setBody: (b: Uint8Array) => void;
  close: () => Promise<void>;
}

/** A local server serving `body`, a pin for TARGET pointing at it, and a temp cache root. */
async function fixture(
  body: Uint8Array,
  format: "zip" | "binary" = "zip",
  sha256?: string,
): Promise<Fixture> {
  let hits = 0;
  let served = body;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => {
    hits++;
    return new Response(served as BodyInit);
  });
  const file = format === "zip" ? `deno-${TARGET}.zip` : `deno-${TARGET}`;
  const pin: DenoToolchainPin = {
    schema: 1,
    version: VERSION,
    targets: {
      [TARGET]: {
        file,
        url: `http://127.0.0.1:${server.addr.port}/${file}`,
        sha256: sha256 ?? await sha256Hex(body),
        size: body.byteLength,
        format,
      },
    },
  };
  const root = await Deno.makeTempDir({ prefix: "denext-toolchain-" });
  return {
    pin,
    root,
    hits: () => hits,
    setBody: (b) => void (served = b),
    close: async () => {
      await server.shutdown();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

const zipped = (data = BINARY) => zip([{ name: "deno", data, unixMode: 0o100755 }]);

function ensure(f: Fixture, extra: Parameters<typeof ensureDenoToolchain>[0] = {}) {
  return ensureDenoToolchain({
    pin: f.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: f.root,
    log: quiet,
    ...extra,
  });
}

/** Every name under `dir`, recursively (to assert nothing was left behind). */
async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await Deno.stat(dir).catch(() => null))?.isDirectory) return out;
  for await (const e of Deno.readDir(dir)) {
    out.push(e.name);
    if (e.isDirectory) out.push(...(await names(join(dir, e.name))).map((n) => `${e.name}/${n}`));
  }
  return out.sort();
}

const binDir = (f: Fixture) => join(f.root, VERSION, TARGET);

Deno.test("denoToolchainTarget names hosts", () => {
  assertEquals(denoToolchainTarget("darwin", "aarch64"), "darwin-aarch64");
  assertEquals(denoToolchainTarget("windows", "x86_64"), "windows-x86_64");
  assertEquals(denoToolchainTarget(), `${Deno.build.os}-${Deno.build.arch}`);
});

Deno.test("the checked-in pin: a schema-1 table whose entries carry url + sha256 (or a placeholder)", () => {
  assertEquals(DENO_TOOLCHAIN.schema, 1);
  if (DENO_TOOLCHAIN.version === null) {
    assertEquals(Object.keys(DENO_TOOLCHAIN.targets), [], "a placeholder pins no targets");
    return;
  }
  assert(/^\d+\.\d+\.\d+-denext\.\d+$/.test(DENO_TOOLCHAIN.version), DENO_TOOLCHAIN.version);
  for (const [target, a] of Object.entries(DENO_TOOLCHAIN.targets)) {
    assert(/^(darwin|linux|windows)-(x86_64|aarch64)$/.test(target), target);
    assert(/^https:\/\//.test(a.url), `${target}: an https url`);
    assert(/^[0-9a-f]{64}$/.test(a.sha256), `${target}: a SHA-256`);
  }
});

Deno.test("pin selection: no pin yet, an unpinned host — each a clear unavailable error", async () => {
  const placeholder: DenoToolchainPin = { schema: 1, version: null, targets: {} };
  const err = await assertRejects(
    () => ensureDenoToolchain({ pin: placeholder, target: TARGET, cacheRoot: "/nonexistent" }),
    DenoToolchainUnavailableError,
  );
  assertStringIncludes(err.message, "not available for this denext version");
  const f = await fixture(await zipped());
  try {
    const other = await assertRejects(
      () => ensure(f, { target: "windows-aarch64" }),
      DenoToolchainUnavailableError,
    );
    assertStringIncludes(other.message, `has no build for windows-aarch64 (it has: ${TARGET})`);
    assertEquals(f.hits(), 0);
  } finally {
    await f.close();
  }
});

Deno.test("loadDenoToolchainPin: the override file replaces the built-in pin; a bad one is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "pin.json");
    await Deno.writeTextFile(file, JSON.stringify({ schema: 1, version: VERSION, targets: {} }));
    const env = (k: string) => k === "DENEXT_TOOLCHAIN_PIN_FILE" ? file : undefined;
    assertEquals(loadDenoToolchainPin(env).version, VERSION);
    assertEquals(loadDenoToolchainPin(() => undefined), DENO_TOOLCHAIN);
    await Deno.writeTextFile(file, JSON.stringify({ schema: 2 }));
    assertStringIncludes(
      (() => {
        try {
          loadDenoToolchainPin(env);
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })(),
      "not a schema-1 toolchain pin",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureDenoToolchain downloads a zip, verifies it, installs deno + its stamp", async () => {
  const f = await fixture(await zipped());
  try {
    const rt = await ensure(f);
    assertEquals(rt, {
      deno: join(binDir(f), "deno"),
      version: VERSION,
      target: TARGET,
      cached: false,
    });
    assertEquals(await Deno.readTextFile(rt.deno), BINARY);
    if (Deno.build.os !== "windows") {
      assertEquals(
        (await Deno.stat(rt.deno)).mode! & 0o777,
        0o755,
        "executable only once verified",
      );
    }
    const stamp = JSON.parse(await Deno.readTextFile(join(binDir(f), TOOLCHAIN_STAMP)));
    assertEquals(stamp.version, VERSION);
    assertEquals(stamp.archive.sha256, f.pin.targets[TARGET].sha256);
    assertEquals(stamp.binary.sha256, await sha256Hex(new TextEncoder().encode(BINARY)));
    assertEquals(await names(binDir(f)), [TOOLCHAIN_STAMP, "deno"], "no temp file is left behind");
    // Cached: no network at all.
    assertEquals(await ensure(f, { fetch: offline }), { ...rt, cached: true });
    assertEquals(f.hits(), 1);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDenoToolchain takes a bare binary and names it deno.exe on Windows", async () => {
  const bytes = new TextEncoder().encode(BINARY);
  const f = await fixture(bytes, "binary");
  try {
    const rt = await ensure(f, { os: "windows" });
    assertEquals(rt.deno, join(binDir(f), "deno.exe"));
    assertEquals(await Deno.readTextFile(rt.deno), BINARY);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDenoToolchain REFUSES a SHA-256 mismatch: the file is deleted, never installed", async () => {
  const f = await fixture(await zipped(), "zip", "0".repeat(64));
  try {
    const err = await assertRejects(() => ensure(f), DenoToolchainHashError);
    assertStringIncludes(err.message, "SHA-256 mismatch");
    assertStringIncludes(err.message, "deleted unexecuted");
    assertEquals(await names(binDir(f)), [], "nothing at all remains");
  } finally {
    await f.close();
  }
});

Deno.test("ensureDenoToolchain refuses an oversized or truncated download, and offline is clear", async () => {
  const body = await zipped();
  const f = await fixture(body);
  try {
    f.setBody(new Uint8Array([...body, 1, 2, 3]));
    const big = await assertRejects(() => ensure(f), DenoToolchainDownloadError);
    assertStringIncludes(big.message, "larger than its pinned");
    f.setBody(body.slice(0, 10));
    const short = await assertRejects(() => ensure(f), DenoToolchainDownloadError);
    assertStringIncludes(short.message, "truncated download");
    const off = await assertRejects(
      () => ensure(f, { fetch: offline }),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(off.message, "Are you offline?");
    const notFound: typeof fetch = () => Promise.resolve(new Response("no", { status: 404 }));
    const http = await assertRejects(
      () => ensure(f, { fetch: notFound }),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(http.message, "404");
    assertEquals(await names(binDir(f)), []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDenoToolchain refuses a verified zip without a top-level deno", async () => {
  const f = await fixture(await zip([{ name: "bin/deno", data: BINARY }]));
  try {
    await assertRejects(() => ensure(f), Error, "has no top-level deno");
    assertEquals(await names(binDir(f)), []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDenoToolchain re-verifies: a changed binary or a lost stamp re-downloads; a touched one is re-hashed", async () => {
  const f = await fixture(await zipped());
  try {
    const rt = await ensure(f);
    // Only the mtime moved: re-hashed against the stamp, kept, no download.
    const later = new Date(Date.now() + 60_000);
    await Deno.utime(rt.deno, later, later);
    assertEquals((await ensure(f, { fetch: offline })).cached, true);
    const stamp = JSON.parse(await Deno.readTextFile(join(binDir(f), TOOLCHAIN_STAMP)));
    assertEquals(stamp.binary.mtimeMs, later.getTime(), "the stamp follows the re-hashed file");
    // Same size, different bytes, new mtime: the re-hash fails → a fresh download.
    await Deno.writeTextFile(rt.deno, BINARY.replace("fake", "evil"));
    const logs: string[] = [];
    assertEquals((await ensure(f, { log: (l) => logs.push(l) })).cached, false);
    assertStringIncludes(logs.join("\n"), "failed verification; re-downloading");
    assertEquals(await Deno.readTextFile(rt.deno), BINARY);
    // No stamp: never trusted.
    await Deno.remove(join(binDir(f), TOOLCHAIN_STAMP));
    assertEquals((await ensure(f)).cached, false);
    assertEquals(f.hits(), 3);
  } finally {
    await f.close();
  }
});

Deno.test("ensureDenoToolchain: two processes installing at once download once (the cache lock)", async () => {
  const f = await fixture(await zipped());
  const dir = await Deno.makeTempDir();
  try {
    const pinFile = join(dir, "pin.json");
    await Deno.writeTextFile(pinFile, JSON.stringify(f.pin));
    const script = join(dir, "install.ts");
    const mod = toFileUrl(join(Deno.cwd(), "src/build/deno-toolchain.ts")).href;
    await Deno.writeTextFile(
      script,
      `import { ensureDenoToolchain, loadDenoToolchainPin } from ${JSON.stringify(mod)};\n` +
        `const rt = await ensureDenoToolchain({ pin: loadDenoToolchainPin(), target: ${
          JSON.stringify(TARGET)
        }, os: "linux", cacheRoot: ${JSON.stringify(f.root)}, log: () => {} });\n` +
        "console.log(rt.deno);\n",
    );
    const run = () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(Deno.cwd(), "deno.json"), script],
        env: { DENEXT_TOOLCHAIN_PIN_FILE: pinFile },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const [a, b] = await Promise.all([run(), run()]);
    const text = (o: Deno.CommandOutput) => new TextDecoder().decode(o.stdout).trim();
    assertEquals(
      [a.code, b.code],
      [0, 0],
      new TextDecoder().decode(a.stderr) + new TextDecoder().decode(b.stderr),
    );
    assertEquals(text(a), join(binDir(f), "deno"));
    assertEquals(text(b), text(a));
    assertEquals(f.hits(), 1, "the second waited on the lock, then adopted the first's binary");
    assertEquals(await names(binDir(f)), [TOOLCHAIN_STAMP, "deno"]);
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

/** An env reader over a record. */
const envOf = (vars: Record<string, string>) => (k: string) => vars[k];

Deno.test("resolveDenoToolchain: the pinned binary when it verifies", async () => {
  const f = await fixture(await zipped());
  try {
    const choice = await resolveDenoToolchain({
      env: envOf({}),
      pin: f.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: f.root,
      log: quiet,
      missingGrants: allGranted,
    });
    assertEquals(choice, { kind: "toolchain", deno: join(binDir(f), "deno"), version: VERSION });
  } finally {
    await f.close();
  }
});

Deno.test("resolveDenoToolchain: opt-outs and a missing pin are silent; every failure warns once and falls back", async () => {
  const f = await fixture(await zipped(), "zip", "f".repeat(64));
  const base = {
    pin: f.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: f.root,
    log: quiet,
    missingGrants: allGranted,
  };
  try {
    assertEquals(await resolveDenoToolchain({ ...base, env: envOf({ DENEXT_DENO: "stock" }) }), {
      kind: "stock",
      reason: "DENEXT_DENO=stock",
    });
    const unpinned = await resolveDenoToolchain({
      ...base,
      env: envOf({}),
      pin: { schema: 1, version: null, targets: {} },
    });
    assertEquals(unpinned, { kind: "stock", reason: "not available for this denext version" });

    const other = await resolveDenoToolchain({ ...base, env: envOf({}), target: "linux-riscv64" });
    assert(other.kind === "stock" && other.warning);
    assertStringIncludes(other.warning, "has no build for linux-riscv64");
    assertStringIncludes(other.warning, "DENEXT_DENO=stock");

    const grants = await resolveDenoToolchain({
      ...base,
      env: envOf({}),
      missingGrants: () => Promise.resolve(["--allow-run"]),
    });
    // A process scoped down on purpose (the least-privilege `start` task) stays on the Deno that
    // launched it without a warning on every start.
    assert(grants.kind === "stock" && grants.warning === undefined);
    assertStringIncludes(grants.reason, "lacks --allow-run");

    const off = await resolveDenoToolchain({ ...base, env: envOf({}), fetch: offline });
    assert(off.kind === "stock" && off.warning);
    assertStringIncludes(off.warning, "Are you offline?");
    assertStringIncludes(off.warning, "Running on stock Deno");

    const tampered = await resolveDenoToolchain({ ...base, env: envOf({}) });
    assert(tampered.kind === "stock" && tampered.warning);
    assertStringIncludes(tampered.warning, "REFUSING");
    assertStringIncludes(tampered.warning, "⚠ Running on stock Deno");
    assertEquals(await names(binDir(f)), [], "the mismatched file was deleted");

    const badPin = await resolveDenoToolchain({
      env: envOf({ DENEXT_TOOLCHAIN_PIN_FILE: join(f.root, "missing.json") }),
      missingGrants: allGranted,
    });
    assert(badPin.kind === "stock" && badPin.warning);
    assertStringIncludes(badPin.warning, "is not a readable pin");
  } finally {
    await f.close();
  }
});

Deno.test("resolveDenoToolchain: DENEXT_DENO=<path> runs that binary unverified, with a warning", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bin = join(dir, "deno");
    await Deno.writeTextFile(bin, BINARY);
    const ok = await resolveDenoToolchain({ env: envOf({ DENEXT_DENO: bin }) });
    assertEquals(ok.kind, "toolchain");
    assert(ok.kind === "toolchain" && ok.warning);
    assertEquals([ok.deno, ok.version], [bin, "path"]);
    assertStringIncludes(ok.warning, "not downloaded, pinned or verified");
    const missing = await resolveDenoToolchain({ env: envOf({ DENEXT_DENO: join(dir, "nope") }) });
    assert(missing.kind === "stock" && missing.warning);
    assertStringIncludes(missing.warning, "is not a file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoToolchainStatus: each cache state, the opt-outs, and whether this run is on it", async () => {
  const f = await fixture(await zipped());
  const opts = { pin: f.pin, target: TARGET, os: "linux", cacheRoot: f.root };
  try {
    const missing = await denoToolchainStatus({ ...opts, env: envOf({}), running: "2.9.6" });
    assertEquals([missing.state, missing.ok, missing.active], ["missing", true, false]);
    assertStringIncludes(missing.detail, `toolchain ${VERSION} for ${TARGET}`);
    assertStringIncludes(missing.detail, "running on deno 2.9.6");
    const rt = await ensure(f);
    const cached = await denoToolchainStatus({ ...opts, env: envOf({}), running: VERSION });
    assertEquals([cached.state, cached.path, cached.active], ["cached", rt.deno, true]);
    assertStringIncludes(cached.detail, "running on it");
    const marked = await denoToolchainStatus({
      ...opts,
      env: envOf({ DENEXT_TOOLCHAIN_ACTIVE: VERSION }),
      running: "2.9.7",
    });
    assertFalse(marked.active, "a marker on a Deno of another version is not the toolchain");
    const older = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      running: "2.9.7-denext.14",
    });
    assertFalse(older.active, "an older -denext.N build (a stale link) is not the toolchain");
    // A same-size rewrite keeps the mtime check honest only with --verify.
    const stat = await Deno.stat(rt.deno);
    await Deno.writeTextFile(rt.deno, BINARY.replace("fake", "evil"));
    await Deno.utime(rt.deno, stat.atime!, stat.mtime!);
    assertEquals((await denoToolchainStatus({ ...opts, env: envOf({}) })).state, "cached");
    const verified = await denoToolchainStatus({ ...opts, env: envOf({}), verify: true });
    assertEquals([verified.state, verified.ok], ["invalid", false]);
    const unpinned = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      pin: { schema: 1, version: null, targets: {} },
    });
    assertEquals(unpinned.state, "unpinned");
    assertStringIncludes(unpinned.detail, "not available for this denext version");
    assertEquals(
      (await denoToolchainStatus({ ...opts, env: envOf({}), target: "linux-riscv64" })).state,
      "unsupported",
    );
    const stock = await denoToolchainStatus({ ...opts, env: envOf({ DENEXT_DENO: "stock" }) });
    assertEquals([stock.mode, stock.ok], ["stock", true]);
    const path = await denoToolchainStatus({ ...opts, env: envOf({ DENEXT_DENO: "/nope/deno" }) });
    assertEquals([path.mode, path.ok], ["path", false]);
    assertStringIncludes(path.detail, "NOT FOUND");
  } finally {
    await f.close();
  }
});

Deno.test("link / unlink touch only what link created", async () => {
  const home = await Deno.makeTempDir();
  const root = join(home, "cache", "denext-deno");
  const bin = join(root, VERSION, TARGET, "deno");
  await Deno.mkdir(join(root, VERSION, TARGET), { recursive: true });
  await Deno.writeTextFile(bin, BINARY);
  const env = envOf({ HOME: home });
  const link = join(home, ".denext", "bin", "deno");
  try {
    if (Deno.build.os !== "windows") {
      const made = await linkDenoToolchain(bin, { env, os: "linux", cacheRoot: root });
      assertEquals(made.link, link);
      assertStringIncludes(made.pathLine, `export PATH="${join(home, ".denext", "bin")}:$PATH"`);
      assertEquals(await Deno.readLink(link), bin);
      await linkDenoToolchain(bin, { env, os: "linux", cacheRoot: root }); // re-link: replaced
      const pin = { schema: 1 as const, version: VERSION, targets: {} };
      const lopts = { env, os: "linux", cacheRoot: root };
      assertEquals(await staleToolchainLink({ ...lopts, pin }), null, "current");
      const stale = await staleToolchainLink({
        ...lopts,
        pin: { ...pin, version: "9.9.9-denext.2" },
      });
      assertStringIncludes(stale ?? "", "not the pinned toolchain 9.9.9-denext.2");
      assertEquals(
        await staleToolchainLink({ ...lopts, pin: { ...pin, version: null } }),
        null,
        "nothing pinned",
      );
      assertEquals(await unlinkDenoToolchain({ env, os: "linux", cacheRoot: root }), link);
      assertEquals(await Deno.lstat(link).catch(() => null), null);
      assertEquals(await unlinkDenoToolchain({ env, os: "linux", cacheRoot: root }), null);
    }
    // Windows: a .cmd shim carrying its mark (written the same on any host).
    const shim = await linkDenoToolchain(bin, { env, os: "windows", cacheRoot: root });
    assertEquals(shim.link, `${link}.cmd`);
    assertStringIncludes(await Deno.readTextFile(shim.link), `"${bin}" %*`);
    const wpin = { schema: 1 as const, version: "9.9.9-denext.2", targets: {} };
    assertStringIncludes(
      (await staleToolchainLink({ env, os: "windows", cacheRoot: root, pin: wpin })) ?? "",
      `points at ${bin}`,
    );
    assertStringIncludes(shim.pathLine, "setx PATH");
    assertEquals(await unlinkDenoToolchain({ env, os: "windows", cacheRoot: root }), shim.link);
    // Someone else's file is never replaced or removed.
    await Deno.writeTextFile(`${link}.cmd`, "@echo mine\r\n");
    await assertRejects(
      () => linkDenoToolchain(bin, { env, os: "windows", cacheRoot: root }),
      Error,
      "was not created by `denext toolchain link`",
    );
    await assertRejects(
      () => unlinkDenoToolchain({ env, os: "windows", cacheRoot: root }),
      Error,
      "left alone",
    );
    assertEquals(await Deno.readTextFile(`${link}.cmd`), "@echo mine\r\n");
    if (Deno.build.os !== "windows") {
      await Deno.symlink("/usr/bin/env", link);
      await assertRejects(() => unlinkDenoToolchain({ env, os: "linux", cacheRoot: root }));
      assertEquals(await Deno.readLink(link), "/usr/bin/env");
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("doctor's deno toolchain check: status, plus tasks that run deno test on stock Deno", async () => {
  const f = await fixture(await zipped());
  const dir = await Deno.makeTempDir();
  const opts = { pin: f.pin, target: TARGET, os: "linux", cacheRoot: f.root, env: envOf({}) };
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        tasks: {
          test: "deno test -A",
          ci: { command: "deno fmt --check && deno test" },
          ok: "deno run -A jsr:@denext/denext/cli test",
        },
      }),
    );
    const check = await denoToolchainCheck(dir, opts);
    assertEquals([check.name, check.ok, check.critical], ["deno toolchain", false, false]);
    assertStringIncludes(check.detail, 'tasks "test", "ci" run `deno test` on stock Deno');
    assertStringIncludes(check.detail, "use `denext test`");
    const stock = await denoToolchainCheck(dir, { ...opts, env: envOf({ DENEXT_DENO: "stock" }) });
    assertEquals(stock.ok, true, "nothing to say about tasks once stock Deno was chosen");
    const bad = await denoToolchainCheck(dir, {
      env: envOf({ DENEXT_TOOLCHAIN_PIN_FILE: join(dir, "missing.json") }),
    });
    assertEquals(bad.ok, false);
    assertStringIncludes(bad.detail, "is not a readable pin");
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the desktop runtime accepts the toolchain's deno as its Deno release", async () => {
  const root = await Deno.makeTempDir();
  try {
    const status = await desktopRuntimeStatus({
      projectDir: root,
      target: "x86_64-unknown-linux-gnu",
      backend: "webview",
      cacheRoot: root,
      env: () => undefined,
      denoVersion: () => Promise.resolve(`${DESKTOP_RUNTIME_PIN.deno}-denext.15`),
    });
    assertEquals(status.deno.found, `${DESKTOP_RUNTIME_PIN.deno}-denext.15`);
    assert(status.ok, status.detail);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

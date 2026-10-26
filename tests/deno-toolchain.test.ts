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
import { parse as parseYaml } from "@std/yaml";
import {
  DENO_TOOLCHAIN,
  denortTargetKey,
  DenoToolchainDownloadError,
  DenoToolchainHashError,
  type DenoToolchainPin,
  DenoToolchainRequiredError,
  denoToolchainStatus,
  denoToolchainTarget,
  DenoToolchainUnavailableError,
  ensureDenort,
  ensureDenoToolchain,
  linkDenoToolchain,
  loadDenoToolchainPin,
  resolveDenoToolchain,
  staleToolchainLink,
  TOOLCHAIN_STAMP,
  toolchainEnvValue,
  unlinkDenoToolchain,
} from "../src/build/deno-toolchain.ts";
import { denoToolchainCheck } from "../src/cli/commands/doctor.ts";
import { downloadTimeoutMs } from "../src/build/verified-download.ts";
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
  // `<deno>-denext.N` up to 2.9.7-denext.22, the fork's own `3.0.0-rc.N` from then on.
  assert(
    /^(\d+\.\d+\.\d+-denext\.\d+|\d+\.\d+\.\d+-rc\.\d+|\d+\.\d+\.\d+)$/.test(
      DENO_TOOLCHAIN.version,
    ),
    DENO_TOOLCHAIN.version,
  );
  for (const [target, a] of Object.entries(DENO_TOOLCHAIN.targets)) {
    assert(/^(darwin|linux|windows)-(x86_64|aarch64)$/.test(target), target);
    assert(/^https:\/\//.test(a.url), `${target}: an https url`);
    assert(/^[0-9a-f]{64}$/.test(a.sha256), `${target}: a SHA-256`);
  }
});

Deno.test("ci.yml's backend-integration toolchain matches the checked-in linux-x86_64 pin", async () => {
  const ci = await Deno.readTextFile(new URL("../.github/workflows/ci.yml", import.meta.url));
  const env = (name: string) => ci.match(new RegExp(`^\\s+${name}:\\s*(\\S+)\\s*$`, "m"))?.[1];
  const pin = DENO_TOOLCHAIN.targets["linux-x86_64"];
  if (DENO_TOOLCHAIN.version === null || !pin) return;
  assertEquals(env("DENEXT_DENO_RELEASE"), `denext-runtime-v${DENO_TOOLCHAIN.version}`);
  assertEquals(env("DENEXT_DENO_ZIP"), pin.file);
  assertEquals(env("DENEXT_DENO_SHA256"), pin.sha256, "re-pin ci.yml's hash with the toolchain");
});

/** A ci.yml step, as parsed. */
interface CiStep {
  name?: string;
  uses?: string;
  run?: string;
}

Deno.test("ci.yml: tests and the type-check run on the toolchain; stock Deno only for fmt / lint / doc-lint", async () => {
  const ci = parseYaml(
    await Deno.readTextFile(new URL("../.github/workflows/ci.yml", import.meta.url)),
  ) as { jobs: Record<string, { steps: CiStep[] }> };
  const onPath = (s: CiStep) => s.run?.includes("scripts/ci/toolchain-on-path.ts") ?? false;
  // A step that runs project code under `deno`: a test, a task that tests or builds, a type-check.
  const runsDeno = (s: CiStep) =>
    /\bdeno (?:test|check|task (?!doc-lint\b))/.test(s.run ?? "") && !onPath(s);
  const stockOnly = (s: CiStep) => /\bdeno (?:fmt|lint|task doc-lint)\b/.test(s.run ?? "");
  const switched: string[] = [];
  for (const [name, job] of Object.entries(ci.jobs)) {
    const setup = job.steps.findIndex((s) => s.uses?.startsWith("denoland/setup-deno@") ?? false);
    // coverage: stock Deno starts scripts/test-run.ts, which runs every pass on the toolchain under
    // --coverage; backend-integration installs the toolchain itself (the test above); cargo-audit
    // runs only scripts/cargo-audit.ts (cargo-audit over the wasm packages' lockfiles), no project
    // code, so it stays on the stock Deno.
    if (setup === -1 || name === "coverage" || name === "cargo-audit") continue;
    const at = job.steps.findIndex(onPath);
    assert(at > setup, `${name}: puts the toolchain on PATH after setting up the stock Deno`);
    job.steps.forEach((s, i) => {
      if (runsDeno(s)) assert(i > at, `${name}: "${s.name}" runs on the toolchain`);
      if (stockOnly(s)) assert(i < at, `${name}: "${s.name}" stays on the stock Deno`);
    });
    switched.push(name);
  }
  for (const job of ["check", "integration", "windows-tests", "macos-tests"]) {
    assert(switched.includes(job), `${job} runs on the toolchain`);
  }
});

Deno.test("ensureDenort: the pinned denort, verified into its own cache dir; a mismatch is refused", async () => {
  const body = await zip([{ name: "denort", data: "fake denort", unixMode: 0o100755 }]);
  const f = await fixture(body);
  try {
    const denortPin: DenoToolchainPin = { ...f.pin, targets: {}, denort: f.pin.targets };
    const opts = { pin: denortPin, target: TARGET, cacheRoot: f.root, log: quiet };
    const first = await ensureDenort(opts);
    assertEquals(first.cached, false);
    assertEquals(first.denort, join(f.root, VERSION, `${TARGET}-denort`, "denort"));
    assertEquals(await Deno.readTextFile(first.denort), "fake denort");
    assertEquals((await ensureDenort(opts)).cached, true);
    assertEquals(f.hits(), 1);
    // The toolchain's own directory is untouched: the two never share a stamp.
    assertEquals(await names(binDir(f)), []);
    // A Windows target's binary is denort.exe.
    const win = { ...denortPin, denort: { "windows-x86_64": f.pin.targets[TARGET] } };
    const err = await assertRejects(
      () => ensureDenort({ ...opts, pin: win, target: "windows-x86_64" }),
      Error,
    );
    assertStringIncludes(err.message, "no top-level denort.exe");
    // A tampered download is refused and nothing is installed.
    const bad = { ...denortPin, version: "9.9.9-denext.2" };
    f.setBody(new TextEncoder().encode("tampered"));
    await assertRejects(() => ensureDenort({ ...opts, pin: bad }), DenoToolchainDownloadError);
    assertEquals(await names(join(f.root, "9.9.9-denext.2", `${TARGET}-denort`)), []);
    // A pin without denort archives (before 2.9.7-denext.20): unavailable.
    const none = await assertRejects(
      () => ensureDenort({ ...opts, pin: f.pin }),
      DenoToolchainUnavailableError,
    );
    assertStringIncludes(none.message, "has no denort for linux-x86_64");
  } finally {
    await f.close();
  }
});

Deno.test("denortTargetKey: deno compile's triples to the pin's keys", () => {
  assertEquals(denortTargetKey("x86_64-unknown-linux-gnu"), "linux-x86_64");
  assertEquals(denortTargetKey("aarch64-apple-darwin"), "darwin-aarch64");
  assertEquals(denortTargetKey("x86_64-pc-windows-msvc"), "windows-x86_64");
  assertEquals(denortTargetKey("aarch64-pc-windows-msvc"), "windows-aarch64");
  assertEquals(denortTargetKey("riscv64gc-unknown-linux-gnu"), undefined);
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

Deno.test("downloadTimeoutMs: the variable's milliseconds, 0 for none, else the default", () => {
  const env = (v?: string) => () => v;
  assertEquals(downloadTimeoutMs("DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS", 60_000, env()), 60_000);
  assertEquals(downloadTimeoutMs("DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS", 60_000, env("5000")), 5_000);
  assertEquals(downloadTimeoutMs("DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS", 60_000, env("0")), Infinity);
  assertEquals(downloadTimeoutMs("DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS", 60_000, env("1m")), 60_000);
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
    assertEquals(choice, { deno: join(binDir(f), "deno"), version: VERSION });
  } finally {
    await f.close();
  }
});

/** The message of the `DenoToolchainRequiredError` `p` rejects with (and that it is one). */
async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await assertRejects(() => p, DenoToolchainRequiredError);
  assert(err.message.startsWith("denext: "), err.message);
  return err.message;
}

Deno.test("resolveDenoToolchain: DENEXT_DENO=stock, a missing pin and every failure refuse with the fix", async () => {
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
    // denext 5.0 runs only on its own runtime: the old opt-out is a refusal naming the change.
    const stock = await refusal(
      resolveDenoToolchain({ ...base, env: envOf({ DENEXT_DENO: "stock" }) }),
    );
    for (
      const text of [
        "DENEXT_DENO=stock is no longer supported",
        "denext 5.0",
        "denext toolchain install",
        "DENEXT_DENO=<path>",
      ]
    ) assertStringIncludes(stock, text);
    const unpinned = await refusal(resolveDenoToolchain({
      ...base,
      env: envOf({}),
      pin: { schema: 1, version: null, targets: {} },
    }));
    assertStringIncludes(unpinned, "pins no Deno toolchain");
    assertStringIncludes(unpinned, "denext toolchain install");

    const other = await refusal(resolveDenoToolchain({
      ...base,
      env: envOf({}),
      target: "linux-riscv64",
    }));
    assertStringIncludes(other, "has no build for linux-riscv64");
    assertStringIncludes(other, "DENEXT_DENO=<path>");
    assertFalse(other.includes("DENEXT_DENO=stock"), "no stock opt-out any more");

    // A process scoped down (a least-privilege `start` launched on another Deno) can't start the
    // toolchain: a refusal naming every way out, never a run on this Deno.
    const grants = await refusal(resolveDenoToolchain({
      ...base,
      env: envOf({}),
      missingGrants: () => Promise.resolve(["--allow-run"]),
    }));
    for (const text of ["--allow-run", "denext task start", "denext toolchain path"]) {
      assertStringIncludes(grants, text);
    }
    assertFalse(grants.includes("DENEXT_DENO=stock"), grants);

    const off = await refusal(resolveDenoToolchain({ ...base, env: envOf({}), fetch: offline }));
    assertStringIncludes(off, "Are you offline?");
    assertStringIncludes(off, "Fix: run `denext toolchain install`");
    assertStringIncludes(off, "stock Deno is no longer supported");
    assertStringIncludes(off, "DENEXT_DENO=<path>");

    const tampered = await refusal(resolveDenoToolchain({ ...base, env: envOf({}) }));
    assertStringIncludes(tampered, "REFUSING");
    assertStringIncludes(tampered, "denext toolchain install");
    assertEquals(await names(binDir(f)), [], "the mismatched file was deleted");

    const badPin = await refusal(resolveDenoToolchain({
      env: envOf({ DENEXT_TOOLCHAIN_PIN_FILE: join(f.root, "missing.json") }),
      missingGrants: allGranted,
    }));
    assertStringIncludes(badPin, "is not a readable pin");
  } finally {
    await f.close();
  }
});

/** What `deno --version` of denext's runtime of `version` says. */
const denextIdentity = (version: string) => ({ deno: version, denext: version });

Deno.test("resolveDenoToolchain: DENEXT_DENO=<path> runs a verified build of denext's runtime", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bin = join(dir, "deno");
    await Deno.writeTextFile(bin, BINARY);
    const as = (identity: { deno: string; denext?: string } | null) => () =>
      Promise.resolve(identity);
    const ok = await resolveDenoToolchain({
      env: envOf({ DENEXT_DENO: bin }),
      identify: as(denextIdentity("3.0.0-rc.6")),
    });
    // The marker is the build's own version (its identity line), never an unknown "path".
    assertEquals([ok.deno, ok.version], [bin, "3.0.0-rc.6"]);
    assert(ok.warning);
    assertStringIncludes(ok.warning, "not downloaded, pinned or hash-checked");
    const upstream = await refusal(resolveDenoToolchain({
      env: envOf({ DENEXT_DENO: bin }),
      identify: as({ deno: "2.9.8" }),
    }));
    assertStringIncludes(upstream, "is upstream Deno 2.9.8");
    assertStringIncludes(upstream, "denext toolchain install");
    const old = await refusal(resolveDenoToolchain({
      env: envOf({ DENEXT_DENO: bin }),
      identify: as(denextIdentity("3.0.0-rc.4")),
    }));
    assertStringIncludes(old, "older than 3.0.0-rc.5");
    const garbage = await refusal(resolveDenoToolchain({
      env: envOf({ DENEXT_DENO: bin }),
      identify: as(null),
    }));
    assertStringIncludes(garbage, "not a deno binary");
    // The default identifies the binary by running `--version`: this one is a shell script.
    await refusal(resolveDenoToolchain({ env: envOf({ DENEXT_DENO: bin }) }));
    const missing = await refusal(
      resolveDenoToolchain({ env: envOf({ DENEXT_DENO: join(dir, "nope") }) }),
    );
    assertStringIncludes(missing, "is not a file");
    assertFalse(missing.includes("DENEXT_DENO=stock"), missing);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveDenoToolchain: a DENO_BIN the user set is verified like DENEXT_DENO=<path>", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bin = join(dir, "deno");
    await Deno.writeTextFile(bin, BINARY);
    const denext = () => Promise.resolve(denextIdentity("3.0.0-rc.5"));
    const ok = await resolveDenoToolchain({ env: envOf({ DENO_BIN: bin }), identify: denext });
    assertEquals([ok.deno, ok.version], [bin, "3.0.0-rc.5"]);
    assertStringIncludes(ok.warning!, "(DENO_BIN)");
    const upstream = await refusal(resolveDenoToolchain({
      env: envOf({ DENO_BIN: bin }),
      identify: () => Promise.resolve({ deno: "2.9.8" }),
    }));
    assertStringIncludes(upstream, `DENO_BIN=${bin} is upstream Deno 2.9.8`);
    // DENEXT_DENO wins over DENO_BIN.
    const both = await refusal(resolveDenoToolchain({
      env: envOf({ DENEXT_DENO: "stock", DENO_BIN: bin }),
      identify: denext,
    }));
    assertStringIncludes(both, "DENEXT_DENO=stock is no longer supported");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("DENEXT_DENO: one pair of matching surrounding quotes is stripped (Windows cmd keeps them)", async () => {
  // `set DENEXT_DENO="C:\Program Files\deno\deno.exe"` stores the quotes in the value.
  const value = (raw: string) => toolchainEnvValue(envOf({ DENEXT_DENO: raw }));
  assertEquals(value('"C:\\Program Files\\deno\\deno.exe"'), "C:\\Program Files\\deno\\deno.exe");
  assertEquals(value("  'stock'  "), "stock");
  assertEquals(value('""'), "");
  assertEquals(value('""stock""'), '"stock"', "only ONE pair is stripped");
  for (const mismatched of [`"stock'`, `'stock"`, `"stock`, `stock"`, `"`]) {
    assertEquals(value(mismatched), mismatched, `${mismatched} is left as is`);
  }
  assertEquals(toolchainEnvValue(envOf({})), "");

  const dir = await Deno.makeTempDir({ prefix: "denext path with space " });
  try {
    const bin = join(dir, "deno");
    await Deno.writeTextFile(bin, BINARY);
    const identify = () => Promise.resolve(denextIdentity("3.0.0-rc.5"));
    for (const quoted of [`"${bin}"`, `'${bin}'`]) {
      const choice = await resolveDenoToolchain({ env: envOf({ DENEXT_DENO: quoted }), identify });
      assertEquals(
        [choice.deno, choice.version],
        [bin, "3.0.0-rc.5"],
        `${quoted} names the binary`,
      );
    }
    for (const stock of [`"stock"`, `'STOCK'`]) {
      const refused = await refusal(resolveDenoToolchain({ env: envOf({ DENEXT_DENO: stock }) }));
      assertStringIncludes(refused, "is no longer supported");
    }
    // Mismatched quotes stay part of the value: a path that is not a file.
    const mismatched = await refusal(
      resolveDenoToolchain({ env: envOf({ DENEXT_DENO: `"${bin}'` }), identify }),
    );
    assertStringIncludes(mismatched, "is not a file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoToolchainStatus: each cache state, the opt-outs, and whether this run is on it", async () => {
  const f = await fixture(await zipped());
  const opts = { pin: f.pin, target: TARGET, os: "linux", cacheRoot: f.root };
  try {
    const missing = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      running: { deno: "2.9.6" },
    });
    assertEquals([missing.state, missing.ok, missing.active], ["missing", true, false]);
    assertStringIncludes(missing.detail, `toolchain ${VERSION} for ${TARGET}`);
    assertStringIncludes(missing.detail, "running on deno 2.9.6");
    const rt = await ensure(f);
    const cached = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      running: { deno: VERSION },
    });
    assertEquals([cached.state, cached.path, cached.active], ["cached", rt.deno, true]);
    assertStringIncludes(cached.detail, "running on it");
    const marked = await denoToolchainStatus({
      ...opts,
      env: envOf({ DENEXT_TOOLCHAIN_ACTIVE: VERSION }),
      running: { deno: "2.9.7" },
    });
    assertFalse(marked.active, "a marker on a Deno of another version is not the toolchain");
    const older = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      running: { deno: "2.9.7-denext.14" },
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
    assertEquals([unpinned.state, unpinned.ok], ["unpinned", false]);
    assertStringIncludes(
      unpinned.detail,
      "not available for this denext version (commands refuse)",
    );
    const other = await denoToolchainStatus({ ...opts, env: envOf({}), target: "linux-riscv64" });
    assertEquals([other.state, other.ok], ["unsupported", false]);
    const stock = await denoToolchainStatus({ ...opts, env: envOf({ DENEXT_DENO: "stock" }) });
    assertEquals([stock.mode, stock.ok, stock.path], ["refused", false, null]);
    assertStringIncludes(stock.detail, "DENEXT_DENO=stock is no longer supported");
    const path = await denoToolchainStatus({ ...opts, env: envOf({ DENEXT_DENO: "/nope/deno" }) });
    assertEquals([path.mode, path.ok], ["path", false]);
    assertStringIncludes(path.detail, "NOT FOUND");
    const upstream = await denoToolchainStatus({
      ...opts,
      env: envOf({ DENEXT_DENO: rt.deno }),
      identify: () => Promise.resolve({ deno: "2.9.8" }),
    });
    assertEquals([upstream.mode, upstream.ok], ["path", false]);
    assertStringIncludes(upstream.detail, "REFUSED: upstream Deno 2.9.8");
    const build = await denoToolchainStatus({
      ...opts,
      env: envOf({ DENEXT_DENO: rt.deno, DENEXT_TOOLCHAIN_ACTIVE: "3.0.0-rc.6" }),
      identify: () => Promise.resolve(denextIdentity("3.0.0-rc.6")),
      running: denextIdentity("3.0.0-rc.6"),
    });
    assertEquals([build.mode, build.ok, build.active], ["path", true, true]);
    assertStringIncludes(build.detail, "denext's Deno 3.0.0-rc.6, not pinned or hash-checked");
  } finally {
    await f.close();
  }
});

Deno.test("denoToolchainStatus: a compiled executable names the Deno its commands run on", async () => {
  const f = await fixture(await zipped());
  const opts = { pin: f.pin, target: TARGET, os: "linux", cacheRoot: f.root, standalone: true };
  try {
    // The executable's embedded Deno (2.9.7 here) runs only the CLI; every child runs the toolchain.
    const missing = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      running: { deno: "2.9.7" },
    });
    assertStringIncludes(missing.detail, "downloaded on the first denext command");
    assertStringIncludes(missing.detail, "denext runs every command on it");
    assertStringIncludes(missing.detail, "embeds deno 2.9.7 for itself only");
    assertFalse(missing.detail.includes("running on deno"), missing.detail);
    await ensure(f);
    const cached = await denoToolchainStatus({
      ...opts,
      env: envOf({}),
      running: { deno: "2.9.7" },
    });
    assertEquals(cached.state, "cached");
    assertStringIncludes(cached.detail, "denext runs every command on it");
  } finally {
    await f.close();
  }
});

Deno.test("link / unlink use $DENEXT_INSTALL/bin, the custom-prefix install's bin", async () => {
  const home = await Deno.makeTempDir();
  const root = join(home, "cache", "denext-deno");
  const bin = join(root, VERSION, TARGET, "deno");
  await Deno.mkdir(join(root, VERSION, TARGET), { recursive: true });
  await Deno.writeTextFile(bin, BINARY);
  const prefix = join(home, "opt", "denext");
  const env = envOf({ HOME: home, DENEXT_INSTALL: prefix });
  try {
    for (const os of Deno.build.os === "windows" ? ["windows"] : ["windows", "linux"]) {
      const made = await linkDenoToolchain(bin, { env, os, cacheRoot: root });
      const name = os === "windows" ? "deno.cmd" : "deno";
      assertEquals(made.link, join(prefix, "bin", name));
      assertStringIncludes(made.pathLine, join(prefix, "bin"));
      assertEquals(
        await Deno.lstat(join(home, ".denext")).catch(() => null),
        null,
        "not ~/.denext",
      );
      const pin = { schema: 1 as const, version: "9.9.9-denext.2", targets: {} };
      assertStringIncludes(
        (await staleToolchainLink({ env, os, cacheRoot: root, pin })) ?? "",
        join(prefix, "bin", name),
      );
      assertEquals(await unlinkDenoToolchain({ env, os, cacheRoot: root }), made.link);
    }
    // An empty DENEXT_INSTALL is unset, as `${DENEXT_INSTALL:-…}` reads it in install.sh.
    const fallback = await linkDenoToolchain(bin, {
      env: envOf({ HOME: home, DENEXT_INSTALL: "" }),
      os: "windows",
      cacheRoot: root,
    });
    assertEquals(fallback.link, join(home, ".denext", "bin", "deno.cmd"));
  } finally {
    await Deno.remove(home, { recursive: true });
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

Deno.test("doctor's deno toolchain check: status, plus tasks that run deno test on another Deno", async () => {
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
    assertStringIncludes(
      check.detail,
      'tasks "test", "ci" run `deno test` on whatever `deno` started a plain `deno task`',
    );
    assertStringIncludes(check.detail, "use `denext test`");
    const stock = await denoToolchainCheck(dir, { ...opts, env: envOf({ DENEXT_DENO: "stock" }) });
    assertEquals(stock.ok, false, "DENEXT_DENO=stock is refused since 5.0");
    assertStringIncludes(stock.detail, "DENEXT_DENO=stock is no longer supported");
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

Deno.test("the desktop runtime refuses a toolchain build from before 5.0's minimum", async () => {
  const root = await Deno.makeTempDir();
  try {
    // A pre-marker build (`2.9.8-denext.15`) was once accepted by its version; denext 5.0 builds
    // only on its runtime from 3.0.0-rc.5, told by the identity line.
    const status = await desktopRuntimeStatus({
      projectDir: root,
      target: "x86_64-unknown-linux-gnu",
      backend: "webview",
      cacheRoot: root,
      env: () => undefined,
      denoVersion: () => Promise.resolve(`${DESKTOP_RUNTIME_PIN.deno}-denext.15`),
    });
    assertEquals(status.deno.found, `${DESKTOP_RUNTIME_PIN.deno}-denext.15`);
    assertFalse(status.ok, status.detail);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a pin under the fork's own version (3.0.0-rc.1): parsed, downloaded, cached and run", async () => {
  const OWN = "3.0.0-rc.1";
  const f = await fixture(await zipped());
  const dir = await Deno.makeTempDir();
  try {
    // An override pin file (a fake release manifest's toolchain pin) with the new version parses.
    const file = join(dir, "pin.json");
    await Deno.writeTextFile(file, JSON.stringify({ ...f.pin, version: OWN, deno: "2.9.7" }));
    const pin = loadDenoToolchainPin((k) => k === "DENEXT_TOOLCHAIN_PIN_FILE" ? file : undefined);
    assertEquals([pin.version, pin.deno], [OWN, "2.9.7"]);
    // It downloads into <root>/3.0.0-rc.1/<target>/, verified and stamped with that version.
    const rt = await ensureDenoToolchain({
      pin,
      target: TARGET,
      os: "linux",
      cacheRoot: f.root,
      log: quiet,
    });
    assertEquals(rt, {
      deno: join(f.root, OWN, TARGET, "deno"),
      version: OWN,
      target: TARGET,
      cached: false,
    });
    const stamp = JSON.parse(await Deno.readTextFile(join(f.root, OWN, TARGET, TOOLCHAIN_STAMP)));
    assertEquals(stamp.version, OWN);
    const opts = { pin, target: TARGET, os: "linux", cacheRoot: f.root, env: envOf({}) };
    const on = await denoToolchainStatus({ ...opts, running: { deno: OWN } });
    assertEquals([on.state, on.active], ["cached", true]);
    // A run on the last old-scheme toolchain (a stale link) is not this pin.
    assertFalse(
      (await denoToolchainStatus({ ...opts, running: { deno: "2.9.7-denext.22" } })).active,
    );
    // From 3.0.0-rc.3 the pin is recognised by the identity marker: upstream Deno of the pinned
    // version (no Deno.build.denext) is not the toolchain.
    const marked = { ...opts, pin: { ...pin, version: "3.0.0-rc.3" } };
    const withMarker = { deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" };
    assert((await denoToolchainStatus({ ...marked, running: withMarker })).active);
    assertFalse((await denoToolchainStatus({ ...marked, running: { deno: "3.0.0-rc.3" } })).active);
    const choice = await resolveDenoToolchain({
      pin,
      target: TARGET,
      os: "linux",
      cacheRoot: f.root,
      env: envOf({}),
      fetch: offline,
      missingGrants: allGranted,
      log: quiet,
    });
    assertEquals(choice, { deno: rt.deno, version: OWN });
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the desktop runtime accepts the toolchain under its own version (3.0.0-rc.N)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const marked = (v: string) => ({ deno: v, denext: v });
    for (const found of [marked("3.0.0-rc.5"), marked("3.0.0-rc.6+ci.42"), marked("3.0.0")]) {
      const status = await desktopRuntimeStatus({
        projectDir: root,
        target: "x86_64-unknown-linux-gnu",
        backend: "webview",
        cacheRoot: root,
        env: () => undefined,
        denoVersion: () => Promise.resolve(found),
      });
      assert(status.ok, `${found.deno}: ${status.detail}`);
      assertEquals(status.deno.denext, found.denext);
    }
    // denext's own runtime from before 5.0's minimum (3.0.0-rc.5) is refused too.
    const old = await desktopRuntimeStatus({
      projectDir: root,
      target: "x86_64-unknown-linux-gnu",
      backend: "webview",
      cacheRoot: root,
      env: () => undefined,
      denoVersion: () => Promise.resolve(marked("3.0.0-rc.3")),
    });
    assertFalse(old.ok, old.detail);
    // Upstream Deno's 3.0.0-rc.N / 3.0.0 (no identity line) is not the runtime's Deno 2.9.7.
    for (const found of ["3.0.0-rc.3", "3.0.0-rc.4", "3.0.0"]) {
      const status = await desktopRuntimeStatus({
        projectDir: root,
        target: "x86_64-unknown-linux-gnu",
        backend: "webview",
        cacheRoot: root,
        env: () => undefined,
        denoVersion: () => Promise.resolve(found),
      });
      assertFalse(status.ok, found);
      assertStringIncludes(status.detail, `deno ${found} ✗`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

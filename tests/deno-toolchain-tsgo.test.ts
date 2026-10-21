// The native TypeScript compiler half of src/build/deno-toolchain.ts and src/ts/engine.ts:
// a toolchain zip's `typescript-check/` is installed beside `deno` only when its binary and whole directory
// hash to the pin (else refused and recorded in the stamp), `toolchain status` reports it, and the
// type-check engine decision falls back to the runtime's in-process TypeScript when the compiler
// is unverified or the project opts out. Served from a LOCAL fixture server; no network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type DenoToolchainPin,
  denoToolchainStatus,
  type DenoToolchainTsgo,
  ensureDenoToolchain,
  TOOLCHAIN_STAMP,
  toolchainTsgo,
  toolchainTsgoLsp,
  tsgoTreeSha256,
} from "../src/build/deno-toolchain.ts";
import {
  applyNativeCheckEngine,
  CHECK_ENGINE_ENV,
  nativeCheckDecision,
  runtimeSupportsNativeCheck,
} from "../src/ts/engine.ts";
import { sha256Hex, zip, type ZipEntry } from "./_archive-fixtures.ts";

const TARGET = "linux-x86_64";
const VERSION = "9.9.9-denext.22";
const quiet = () => {};
const enc = new TextEncoder();
const TSC = enc.encode("#!/bin/sh\necho Version 7.0.2\n");
const LIB = enc.encode("interface Array<T> {}\n");
const LICENSE = enc.encode("Apache License 2.0\n");
const LSP_TSC = enc.encode("#!/bin/sh\necho Version 7.1.0-dev.20261017.1\n");
const LSP_VERSION = "7.1.0-dev.20261017.1";

/** The fork's `fetch_tsgo.py` `tree_sha256`, computed here independently of the code under test. */
async function treeOf(files: Record<string, Uint8Array>): Promise<string> {
  const names = Object.keys(files).filter((n) => n !== "typescript.json").sort();
  let text = "";
  for (const n of names) text += `${n}\0${await sha256Hex(files[n])}\n`;
  return await sha256Hex(enc.encode(text));
}

interface World {
  pin: DenoToolchainPin;
  root: string;
  close: () => Promise<void>;
}

const CHECK_FILES: Record<string, Uint8Array> = {
  "tsc": TSC,
  "lib.es5.d.ts": LIB,
  "LICENSE": LICENSE,
  "typescript.json": enc.encode("{}\n"),
};
const LSP_FILES: Record<string, Uint8Array> = {
  "tsc": LSP_TSC,
  "lib.es5.d.ts": LIB,
  "LICENSE": LICENSE,
  "typescript.json": enc.encode(`{"role":"lsp","version":"${LSP_VERSION}"}\n`),
};

/** A TypeScript directory's zip entries (`tsc` executable). */
function dirEntries(dir: string, files: Record<string, Uint8Array>): ZipEntry[] {
  return Object.entries(files).map(([name, data]) => ({
    name: `${dir}/${name}`,
    data,
    unixMode: name === "tsc" ? 0o100755 : 0o100644,
  }));
}

/** The pin entry for `files` (`tsc` hashed, the tree hashed), with `over` applied. */
async function tsPin(
  version: string,
  files: Record<string, Uint8Array>,
  over: Partial<DenoToolchainTsgo>,
): Promise<DenoToolchainTsgo> {
  return {
    version,
    sha256: await sha256Hex(files["tsc"]),
    treeSha256: await treeOf(files),
    ...over,
  };
}

/**
 * A toolchain zip with `typescript-check/` (unless `noTsgo`) and `typescript-lsp/` (unless
 * `noLsp`), behind a pin whose `tsgo` entry is `pinned` and whose `tsgoLsp` entry is `lsp`
 * (`null` / absent: no `tsgoLsp` entry, as before the language server was pinned).
 */
async function world(
  opts: {
    noTsgo?: boolean;
    pinned?: Partial<DenoToolchainTsgo> | null;
    noLsp?: boolean;
    lsp?: Partial<DenoToolchainTsgo> | null;
  } = {},
): Promise<World> {
  const zipBytes = await zip([
    { name: "deno", data: "#!/bin/sh\necho deno\n", unixMode: 0o100755 },
    ...(opts.noTsgo ? [] : dirEntries("typescript-check", CHECK_FILES)),
    ...(opts.noLsp ? [] : dirEntries("typescript-lsp", LSP_FILES)),
  ]);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    () => new Response(zipBytes as BodyInit),
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const pinned = opts.pinned === null ? null : await tsPin("7.0.2", CHECK_FILES, opts.pinned ?? {});
  const lsp = opts.lsp ? await tsPin(LSP_VERSION, LSP_FILES, opts.lsp) : null;
  const pin: DenoToolchainPin = {
    schema: 1,
    version: VERSION,
    targets: {
      [TARGET]: {
        file: `deno-${TARGET}.zip`,
        url: `${base}/deno-${TARGET}.zip`,
        sha256: await sha256Hex(zipBytes),
        size: zipBytes.byteLength,
        format: "zip",
        ...(pinned ? { tsgo: pinned } : {}),
        ...(lsp ? { tsgoLsp: lsp } : {}),
      },
    },
  };
  const tmp = await Deno.makeTempDir({ prefix: "denext-tsgo-" });
  return {
    pin,
    root: join(tmp, "toolchain"),
    close: async () => {
      await server.shutdown();
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

const install = (w: World) =>
  ensureDenoToolchain({ pin: w.pin, target: TARGET, os: "linux", cacheRoot: w.root, log: quiet });
const status = (w: World, verify = false) =>
  toolchainTsgo({
    env: () => undefined,
    pin: w.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: w.root,
    verify,
  });
const lspStatus = (w: World, verify = false) =>
  toolchainTsgoLsp({
    env: () => undefined,
    pin: w.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: w.root,
    verify,
  });
const stampOf = async (w: World) =>
  JSON.parse(await Deno.readTextFile(join(w.root, VERSION, TARGET, TOOLCHAIN_STAMP)));
/** The engine decision for a process running the pinned toolchain (or `running`). */
const decide = (w: World, env: Record<string, string> = {}, running = VERSION) =>
  nativeCheckDecision({
    env: (k) => env[k],
    running,
    pin: w.pin,
    target: TARGET,
    tsgo: () => status(w),
  });

Deno.test("tsgoTreeSha256 hashes a directory the way the fork's fetch_tsgo.py does", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const files = { "tsc": TSC, "lib.es5.d.ts": LIB, "LICENSE": LICENSE };
    for (const [n, d] of Object.entries(files)) await Deno.writeFile(join(dir, n), d);
    await Deno.writeTextFile(join(dir, "typescript.json"), '{"version":"7.0.2"}'); // not hashed
    assertEquals(await tsgoTreeSha256(dir), await treeOf(files));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a pinned typescript-check/ is installed beside deno, stamped, reported, and the runtime checks natively", async () => {
  const w = await world();
  try {
    await install(w);
    const dir = join(w.root, VERSION, TARGET, "typescript-check");
    assertEquals(await Deno.readFile(join(dir, "tsc")), TSC);
    assertEquals(await Deno.readFile(join(dir, "lib.es5.d.ts")), LIB);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(join(dir, "tsc"))).mode! & 0o111, 0o111);
    }
    const stamp = await stampOf(w);
    assertEquals(stamp.tsgo.version, "7.0.2");
    assertEquals(stamp.tsgo.treeSha256, w.pin.targets[TARGET].tsgo!.treeSha256);
    const st = await status(w, true);
    assertEquals([st.state, st.path, st.version], ["ok", join(dir, "tsc"), "7.0.2"]);
    const full = await denoToolchainStatus({
      env: () => undefined,
      pin: w.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: w.root,
      running: VERSION,
      standalone: false,
    });
    assertEquals(full.tsgo.state, "ok");
    assert(runtimeSupportsNativeCheck(w.pin, TARGET, VERSION));
    assertEquals(await decide(w), { engine: null, supported: true });
  } finally {
    await w.close();
  }
});

Deno.test("a typescript-check/ that does not hash to the pin is REFUSED: not installed, the in-process checker runs, one warning", async () => {
  for (
    const [opts, why] of [
      [{ pinned: { sha256: "0".repeat(64) } }, "SHA-256 mismatch"],
      [{ pinned: { treeSha256: "0".repeat(64) } }, "files' SHA-256 mismatch"],
      [{ noTsgo: true }, "the archive has no typescript-check/tsc"],
    ] as const
  ) {
    const w = await world(opts);
    try {
      await install(w); // deno itself still installs
      assertEquals(
        await Deno.stat(join(w.root, VERSION, TARGET, "typescript-check")).catch(() => null),
        null,
      );
      assertStringIncludes((await stampOf(w)).tsgo.refused, why);
      const st = await status(w);
      assertEquals(st.state, "refused", why);
      const d = await decide(w);
      assertEquals([d.engine, d.supported], ["tsc", true]);
      assertStringIncludes(d.warning!, why);
      assertStringIncludes(d.warning!, "in-process TypeScript");
    } finally {
      await w.close();
    }
  }
});

Deno.test("a typescript-check/ file changed after install is caught by --verify (the binary by its stamp alone)", async () => {
  const w = await world();
  try {
    await install(w);
    const dir = join(w.root, VERSION, TARGET, "typescript-check");
    await Deno.writeFile(join(dir, "lib.es5.d.ts"), enc.encode("interface Array<U> {}\n"));
    assertEquals((await status(w)).state, "ok", "a lib file is only re-hashed with verify");
    const verified = await status(w, true);
    assertEquals(verified.state, "refused");
    assertStringIncludes(verified.detail, "files changed since they were installed");
    await Deno.writeFile(join(dir, "tsc"), enc.encode("#!/bin/sh\necho Version 6.6.6\n"));
    assertStringIncludes((await status(w)).detail, "changed since it was installed");
  } finally {
    await w.close();
  }
});

Deno.test("the engine decision: the user's DENO_CHECK_ENGINE wins, DENEXT_NATIVE_CHECK=0 opts out, older runtimes are left alone", async () => {
  const none = await world({ pinned: null });
  const w = await world();
  try {
    await install(none);
    assertEquals((await status(none)).state, "none");
    assert(!runtimeSupportsNativeCheck(none.pin, TARGET, VERSION));
    assertEquals(await decide(none), { engine: null, supported: false });
    // not installed yet: the runtime would refuse to check, so the in-process checker runs
    assertEquals((await decide(w)).engine, "tsc");
    assertEquals((await decide(w)).warning, undefined, "missing is not worth a warning");
    await install(w);
    assertEquals((await decide(w)).engine, null);
    for (const off of ["0", "false", "OFF"]) {
      assertEquals((await decide(w, { DENEXT_NATIVE_CHECK: off })).engine, "tsc");
    }
    assertEquals((await decide(w, { DENEXT_NATIVE_CHECK: "1" })).engine, null);
    assertEquals(
      (await decide(w, { [CHECK_ENGINE_ENV]: "native", DENEXT_NATIVE_CHECK: "0" })).engine,
      null,
    );
    // another Deno (stock, an older -denext.N build) type-checks its own way
    assertEquals(await decide(w, {}, "2.9.7"), { engine: null, supported: false });
    // applied to the environment the verb's Deno children inherit
    const set: Record<string, string> = {};
    const warned: string[] = [];
    await applyNativeCheckEngine({
      env: (k) => ({ DENEXT_NATIVE_CHECK: "0" } as Record<string, string>)[k],
      running: VERSION,
      pin: w.pin,
      target: TARGET,
      tsgo: () => status(w),
      setEnv: (k, v) => set[k] = v,
      warn: (m) => warned.push(m),
    });
    assertEquals(set, { [CHECK_ENGINE_ENV]: "tsc" });
    assertEquals(warned, []);
  } finally {
    await none.close();
    await w.close();
  }
});

Deno.test("a pinned typescript-lsp/ (the tsgo language server) is installed beside deno, verified, stamped and reported", async () => {
  const w = await world({ lsp: {} });
  try {
    assertEquals((await lspStatus(w)).state, "missing");
    await install(w);
    const dir = join(w.root, VERSION, TARGET, "typescript-lsp");
    assertEquals(await Deno.readFile(join(dir, "tsc")), LSP_TSC);
    assertEquals(await Deno.readFile(join(dir, "lib.es5.d.ts")), LIB);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(join(dir, "tsc"))).mode! & 0o111, 0o111);
    }
    const stamp = await stampOf(w);
    assertEquals(stamp.tsgoLsp.version, LSP_VERSION);
    assertEquals(stamp.tsgoLsp.treeSha256, w.pin.targets[TARGET].tsgoLsp!.treeSha256);
    // the checker beside it is its own step, untouched
    assertEquals(stamp.tsgo.version, "7.0.2");
    const st = await lspStatus(w, true);
    assertEquals([st.state, st.path, st.version], ["ok", join(dir, "tsc"), LSP_VERSION]);
    assertStringIncludes(st.detail, "language server");
    const full = await denoToolchainStatus({
      env: () => undefined,
      pin: w.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: w.root,
      running: VERSION,
      standalone: false,
    });
    assertEquals([full.tsgo.state, full.tsgoLsp.state], ["ok", "ok"]);
    // a lib file changed after install is caught by --verify
    await Deno.writeFile(join(dir, "lib.es5.d.ts"), enc.encode("interface Array<U> {}\n"));
    assertEquals((await lspStatus(w)).state, "ok");
    assertStringIncludes(
      (await lspStatus(w, true)).detail,
      "files changed since they were installed",
    );
  } finally {
    await w.close();
  }
});

Deno.test("a typescript-lsp/ that does not hash to the pin is REFUSED (not installed); deno and typescript-check/ still install", async () => {
  for (
    const [opts, why] of [
      [{ lsp: { sha256: "0".repeat(64) } }, "SHA-256 mismatch"],
      [{ lsp: { treeSha256: "0".repeat(64) } }, "files' SHA-256 mismatch"],
      [{ lsp: {}, noLsp: true }, "the archive has no typescript-lsp/tsc"],
    ] as const
  ) {
    const w = await world(opts);
    try {
      await install(w);
      const base = join(w.root, VERSION, TARGET);
      assertEquals(await Deno.stat(join(base, "typescript-lsp")).catch(() => null), null, why);
      assert((await Deno.stat(join(base, "typescript-check", "tsc"))).isFile, why);
      const stamp = await stampOf(w);
      assertStringIncludes(stamp.tsgoLsp.refused, why);
      assertStringIncludes(stamp.tsgoLsp.refused, "TypeScript language server");
      const st = await lspStatus(w);
      assertEquals(st.state, "refused", why);
      assertEquals((await status(w)).state, "ok", "the checker is unaffected");
    } finally {
      await w.close();
    }
  }
});

Deno.test("a toolchain installed before the language server was pinned re-installs to add it; an unpinned one reports none", async () => {
  const before = await world(); // no tsgoLsp in the pin: the language server is not installed
  try {
    await install(before);
    const base = join(before.root, VERSION, TARGET);
    assertEquals(await Deno.stat(join(base, "typescript-lsp")).catch(() => null), null);
    assertEquals((await lspStatus(before)).state, "none");
    assertEquals("tsgoLsp" in (await stampOf(before)), false);
    // the same archive, now pinned with its language server: the old stamp lacks the step
    const after = await world({ lsp: {} });
    try {
      const pin = {
        ...before.pin,
        targets: {
          [TARGET]: { ...before.pin.targets[TARGET], tsgoLsp: after.pin.targets[TARGET].tsgoLsp },
        },
      };
      const upgraded = { ...before, pin };
      assertEquals((await lspStatus(upgraded)).state, "missing");
      await install(upgraded);
      assertEquals((await lspStatus(upgraded, true)).state, "ok");
    } finally {
      await after.close();
    }
  } finally {
    await before.close();
  }
});

// src/build/esbuild/binary.ts + the esbuild half of src/build/deno-toolchain.ts: which esbuild
// binary denext's vendored esbuild API spawns — ESBUILD_BINARY_PATH, else the toolchain's esbuild
// (extracted from the verified toolchain zip, checked against the pin's SHA-256, recorded in the
// stamp). denext 5.0 has no npm fallback: anything else refuses with the fix. Everything is served
// from a LOCAL fixture server; nothing here touches the network.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type DenoToolchainPin,
  denoToolchainStatus,
  ensureDenoToolchain,
  TOOLCHAIN_STAMP,
  toolchainEsbuild,
} from "../src/build/deno-toolchain.ts";
import { esbuildBinaryStatus, resolveEsbuildBinary } from "../src/build/esbuild/binary.ts";
import { ESBUILD_VERSION } from "../src/build/esbuild/version.ts";
import { sha256Hex, zip, type ZipEntry } from "./_archive-fixtures.ts";

const TARGET = "linux-x86_64";
const VERSION = "9.9.9-denext.17";
const quiet = () => {};
const enc = new TextEncoder();
const TOOLCHAIN_ESBUILD = enc.encode("#!/bin/sh\necho toolchain esbuild\n");

/** A server answering every GET with `body`, counting hits. */
function serve(body: Uint8Array) {
  let hits = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => {
    hits++;
    return new Response(body as BodyInit);
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, hits: () => hits, server };
}

interface World {
  pin: DenoToolchainPin;
  /** The toolchain cache root. */
  root: string;
  close: () => Promise<void>;
}

/**
 * A toolchain zip (deno + `esbuild` when `esbuildInZip`) behind a pin whose esbuild entry is
 * `pinned` (`null` → a pin that names no esbuild).
 */
async function world(
  opts: { esbuildInZip?: boolean; pinned?: { version: string; sha256: string } | null } = {},
): Promise<World> {
  const entries: ZipEntry[] = [
    { name: "deno", data: "#!/bin/sh\necho deno\n", unixMode: 0o100755 },
  ];
  if (opts.esbuildInZip !== false) {
    entries.push({ name: "esbuild", data: TOOLCHAIN_ESBUILD, unixMode: 0o100755 });
    entries.push({ name: "esbuild.LICENSE", data: "MIT", unixMode: 0o100644 });
  }
  const zipBytes = await zip(entries);
  const tc = serve(zipBytes);
  const pinned = opts.pinned === undefined
    ? { version: ESBUILD_VERSION, sha256: await sha256Hex(TOOLCHAIN_ESBUILD) }
    : opts.pinned;
  const pin: DenoToolchainPin = {
    schema: 1,
    version: VERSION,
    targets: {
      [TARGET]: {
        file: `deno-${TARGET}.zip`,
        url: `${tc.base}/deno-${TARGET}.zip`,
        sha256: await sha256Hex(zipBytes),
        size: zipBytes.byteLength,
        format: "zip",
        ...(pinned ? { esbuild: pinned } : {}),
      },
    },
  };
  const tmp = await Deno.makeTempDir({ prefix: "denext-esbuild-bin-" });
  return {
    pin,
    root: join(tmp, "toolchain"),
    close: async () => {
      await tc.server.shutdown();
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

const install = (w: World) =>
  ensureDenoToolchain({ pin: w.pin, target: TARGET, os: "linux", cacheRoot: w.root, log: quiet });

/** resolveEsbuildBinary / esbuildBinaryStatus seams for `w`, plus env overrides. */
const seams = (w: World, env: Record<string, string> = {}) => ({
  env: (k: string) => env[k],
  pin: w.pin,
  target: TARGET,
  os: "linux",
  toolchainCacheRoot: w.root,
});

/** The refusal `resolveEsbuildBinary` gives for `w` (and that it names the fix). */
async function refusal(w: World, env: Record<string, string> = {}): Promise<string> {
  const err = await assertRejects(() => resolveEsbuildBinary(seams(w, env)));
  const message = (err as Error).message;
  assertStringIncludes(message, "denext toolchain install");
  assertStringIncludes(message, "ESBUILD_BINARY_PATH");
  return message;
}

const stampOf = async (w: World) =>
  JSON.parse(await Deno.readTextFile(join(w.root, VERSION, TARGET, TOOLCHAIN_STAMP)));

Deno.test("the toolchain zip's esbuild: installed beside deno when it hashes to the pin, and chosen", async () => {
  const w = await world();
  try {
    const rt = await install(w);
    const dir = join(w.root, VERSION, TARGET);
    assertEquals(await Deno.readFile(join(dir, "esbuild")), TOOLCHAIN_ESBUILD);
    assertEquals(await Deno.readTextFile(join(dir, "esbuild.LICENSE")), "MIT");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(join(dir, "esbuild"))).mode! & 0o777, 0o755);
    }
    const stamp = await stampOf(w);
    assertEquals(stamp.esbuild.version, ESBUILD_VERSION);
    assertEquals(stamp.esbuild.sha256, await sha256Hex(TOOLCHAIN_ESBUILD));
    assert(rt.deno.endsWith("deno"));
    const r = await resolveEsbuildBinary(seams(w));
    assertEquals(r, { path: join(dir, "esbuild"), source: "toolchain" });
    const st = await denoToolchainStatus({
      env: seams(w).env,
      pin: w.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: w.root,
    });
    assertEquals(st.esbuild.state, "ok");
    const shown = await esbuildBinaryStatus(seams(w));
    assertEquals([shown.source, shown.ok], ["toolchain", true]);
    assertStringIncludes(shown.detail, `esbuild ${ESBUILD_VERSION} (verified)`);
  } finally {
    await w.close();
  }
});

Deno.test("ESBUILD_BINARY_PATH wins over the toolchain", async () => {
  const w = await world();
  try {
    await install(w);
    const r = await resolveEsbuildBinary(seams(w, { ESBUILD_BINARY_PATH: "/opt/esbuild" }));
    assertEquals(r, { path: "/opt/esbuild", source: "env" });
    const st = await esbuildBinaryStatus(seams(w, { ESBUILD_BINARY_PATH: "/opt/esbuild" }));
    assertEquals(st.source, "env");
    assertStringIncludes(st.detail, "unverified");
  } finally {
    await w.close();
  }
});

Deno.test("a toolchain esbuild that does not hash to the pin is REFUSED: never installed, builds refuse", async () => {
  const w = await world({ pinned: { version: ESBUILD_VERSION, sha256: "0".repeat(64) } });
  try {
    await install(w); // deno itself still installs
    const dir = join(w.root, VERSION, TARGET);
    assertEquals(await Deno.stat(join(dir, "esbuild")).catch(() => null), null);
    assertStringIncludes((await stampOf(w)).esbuild.refused, "SHA-256 mismatch");
    assertStringIncludes(await refusal(w), "SHA-256 mismatch");
    const st = await esbuildBinaryStatus(seams(w));
    assertEquals([st.source, st.ok, st.path], ["toolchain", false, null]);
    assertStringIncludes(st.detail, "builds refuse until fixed");
    // ESBUILD_BINARY_PATH is still the way around it.
    const r = await resolveEsbuildBinary(seams(w, { ESBUILD_BINARY_PATH: "/opt/esbuild" }));
    assertEquals(r.source, "env");
  } finally {
    await w.close();
  }
});

Deno.test("a pin naming another esbuild version, or a zip without esbuild, is refused the same way", async () => {
  for (
    const [opts, why] of [
      [{ pinned: { version: "0.24.2", sha256: "0".repeat(64) } }, "it is esbuild 0.24.2"],
      [{ esbuildInZip: false }, "the archive has no top-level esbuild"],
    ] as const
  ) {
    const w = await world(opts);
    try {
      await install(w);
      const tc = await toolchainEsbuild({
        env: seams(w).env,
        pin: w.pin,
        target: TARGET,
        os: "linux",
        cacheRoot: w.root,
      });
      assertEquals(tc.state, "refused", why);
      assertStringIncludes(tc.detail, why);
      assertStringIncludes(await refusal(w), why);
    } finally {
      await w.close();
    }
  }
});

Deno.test("a toolchain esbuild changed after install is refused (re-hashed against the pin)", async () => {
  const w = await world();
  try {
    await install(w);
    const path = join(w.root, VERSION, TARGET, "esbuild");
    const tampered = new Uint8Array(TOOLCHAIN_ESBUILD); // same size, other bytes
    tampered[tampered.length - 2] ^= 1;
    await Deno.writeFile(path, tampered);
    await Deno.utime(path, new Date(), new Date(Date.now() + 5000));
    assertStringIncludes(await refusal(w), "changed since it was installed");
    // Touched only (same bytes): re-hashed and still accepted.
    await Deno.writeFile(path, TOOLCHAIN_ESBUILD);
    await Deno.utime(path, new Date(), new Date(Date.now() + 9000));
    assertEquals((await resolveEsbuildBinary(seams(w))).source, "toolchain");
  } finally {
    await w.close();
  }
});

Deno.test("no toolchain yet, a pin without esbuild, or DENEXT_DENO=stock: no npm fallback (5.0)", async () => {
  const fresh = await world();
  try {
    // Not installed yet: the toolchain is "missing" and a build refuses with the fix.
    assertStringIncludes(await refusal(fresh), "arrives with the toolchain");
  } finally {
    await fresh.close();
  }
  const w = await world({ pinned: null });
  try {
    await install(w);
    const tc = await toolchainEsbuild({
      env: seams(w).env,
      pin: w.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: w.root,
    });
    assertEquals(tc.state, "none");
    assertStringIncludes(await refusal(w), "ships no esbuild");
    // DENEXT_DENO=stock no longer selects another esbuild either.
    assertStringIncludes(await refusal(w, { DENEXT_DENO: "stock" }), "ships no esbuild");
  } finally {
    await w.close();
  }
});

Deno.test("under a DENEXT_DENO=<path> build, the pinned toolchain's esbuild still runs", async () => {
  const w = await world();
  try {
    await install(w);
    const r = await resolveEsbuildBinary(seams(w, { DENEXT_DENO: "/opt/denext-runtime/deno" }));
    assertEquals(r, { path: join(w.root, VERSION, TARGET, "esbuild"), source: "toolchain" });
    assert(r.path.endsWith("esbuild"));
  } finally {
    await w.close();
  }
});

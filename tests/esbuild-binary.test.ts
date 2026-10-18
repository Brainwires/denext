// src/build/esbuild/binary.ts + the esbuild half of src/build/deno-toolchain.ts: which esbuild
// binary denext's vendored esbuild API spawns — ESBUILD_BINARY_PATH, then the toolchain's esbuild
// (extracted from the verified toolchain zip, checked against the pin's SHA-256, recorded in the
// stamp), then the npm `@esbuild/<platform>` binary (integrity-checked tarball, SHA-256-checked
// binary). Everything is served from LOCAL fixture servers; nothing here touches the network.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import {
  type DenoToolchainPin,
  denoToolchainStatus,
  ensureDenoToolchain,
  TOOLCHAIN_STAMP,
  toolchainEsbuild,
} from "../src/build/deno-toolchain.ts";
import {
  denoNpmRegistryDir,
  ensureNpmEsbuild,
  esbuildBinaryStatus,
  type EsbuildNpmArtifact,
  resolveEsbuildBinary,
} from "../src/build/esbuild/binary.ts";
import { ESBUILD_VERSION } from "../src/build/esbuild/version.ts";
import { sha256Hex, tarGz, zip, type ZipEntry } from "./_archive-fixtures.ts";

const TARGET = "linux-x86_64";
const VERSION = "9.9.9-denext.17";
const quiet = () => {};
const enc = new TextEncoder();
const TOOLCHAIN_ESBUILD = enc.encode("#!/bin/sh\necho toolchain esbuild\n");
const NPM_ESBUILD = enc.encode("#!/bin/sh\necho npm esbuild\n");
const offline: typeof fetch = () => Promise.reject(new TypeError("network unreachable"));

/** A server answering every GET with `body(path)` (404 for null), counting hits. */
function serve(body: (path: string) => Uint8Array | null) {
  let hits = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    hits++;
    const b = body(new URL(req.url).pathname);
    return b ? new Response(b as BodyInit) : new Response("nope", { status: 404 });
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, hits: () => hits, server };
}

interface World {
  pin: DenoToolchainPin;
  /** The toolchain cache root. */
  root: string;
  /** denext's npm esbuild cache root. */
  npmRoot: string;
  /** A Deno cache with no npm packages (so the real one is never consulted). */
  denoDir: string;
  npm: Record<string, EsbuildNpmArtifact>;
  env: Record<string, string>;
  npmHits: () => number;
  close: () => Promise<void>;
}

/**
 * A toolchain zip (deno + `esbuild` when `esbuildInZip`) behind a pin whose esbuild entry is
 * `pinned` (omitted → a pre-denext.17 pin), and an npm registry serving the fake `@esbuild` tgz.
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
  const tgz = await tarGz([{ name: "package/bin/esbuild", data: NPM_ESBUILD, mode: 0o755 }]);
  const integrity = "sha512-" +
    encodeBase64(await crypto.subtle.digest("SHA-512", tgz as BufferSource));
  const tc = serve(() => zipBytes);
  const reg = serve((p) =>
    p === `/@esbuild/fake-x64/-/fake-x64-${ESBUILD_VERSION}.tgz` ? tgz : null
  );
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
    npmRoot: join(tmp, "npm"),
    denoDir: join(tmp, "deno"),
    npm: {
      [TARGET]: {
        pkg: "@esbuild/fake-x64",
        binary: "bin/esbuild",
        integrity,
        sha256: await sha256Hex(NPM_ESBUILD),
        size: NPM_ESBUILD.byteLength,
      },
    },
    env: { NPM_CONFIG_REGISTRY: reg.base },
    npmHits: reg.hits,
    close: async () => {
      await tc.server.shutdown();
      await reg.server.shutdown();
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

const install = (w: World) =>
  ensureDenoToolchain({ pin: w.pin, target: TARGET, os: "linux", cacheRoot: w.root, log: quiet });

/** resolveEsbuildBinary / esbuildBinaryStatus seams for `w`, plus env overrides. */
const seams = (w: World, env: Record<string, string> = {}) => ({
  env: (k: string) => ({ ...w.env, ...env })[k],
  pin: w.pin,
  target: TARGET,
  os: "linux",
  toolchainCacheRoot: w.root,
  npmCacheRoot: w.npmRoot,
  denoDir: w.denoDir,
  npm: w.npm,
  log: quiet,
});

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
    assertEquals(w.npmHits(), 0, "the npm fallback is never touched");
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

Deno.test("ESBUILD_BINARY_PATH wins over the toolchain and npm", async () => {
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

Deno.test("a toolchain esbuild that does not hash to the pin is REFUSED: never installed, npm runs, one warning", async () => {
  const w = await world({ pinned: { version: ESBUILD_VERSION, sha256: "0".repeat(64) } });
  try {
    await install(w); // deno itself still installs
    const dir = join(w.root, VERSION, TARGET);
    assertEquals(await Deno.stat(join(dir, "esbuild")).catch(() => null), null);
    assertStringIncludes((await stampOf(w)).esbuild.refused, "SHA-256 mismatch");
    const r = await resolveEsbuildBinary(seams(w));
    assertEquals(r.source, "npm");
    assertEquals(await Deno.readFile(r.path), NPM_ESBUILD);
    assertStringIncludes(r.warning!, "SHA-256 mismatch");
    assertStringIncludes(r.warning!, `using the npm esbuild ${ESBUILD_VERSION} instead`);
    const st = await esbuildBinaryStatus(seams(w));
    assertEquals([st.source, st.ok], ["npm", false]);
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
      const r = await resolveEsbuildBinary(seams(w));
      assertEquals(r.source, "npm");
      assert(r.warning, why);
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
    const r = await resolveEsbuildBinary(seams(w));
    assertEquals(r.source, "npm");
    assertStringIncludes(r.warning!, "changed since it was installed");
    // Touched only (same bytes): re-hashed and still accepted.
    await Deno.writeFile(path, TOOLCHAIN_ESBUILD);
    await Deno.utime(path, new Date(), new Date(Date.now() + 9000));
    assertEquals((await resolveEsbuildBinary(seams(w))).source, "toolchain");
  } finally {
    await w.close();
  }
});

Deno.test("a pin without esbuild (before denext.17), DENEXT_DENO=stock, or no toolchain yet: npm, silently", async () => {
  const w = await world({ pinned: null });
  try {
    // Not installed yet: the toolchain is "missing", the npm binary runs, no warning.
    const before = await resolveEsbuildBinary(seams(w));
    assertEquals([before.source, before.warning], ["npm", undefined]);
    await install(w);
    const tc = await toolchainEsbuild({
      env: seams(w).env,
      pin: w.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: w.root,
    });
    assertEquals(tc.state, "none");
    assertEquals((await resolveEsbuildBinary(seams(w))).warning, undefined);
    const stock = await resolveEsbuildBinary(seams(w, { DENEXT_DENO: "stock" }));
    assertEquals([stock.source, stock.warning], ["npm", undefined]);
    assertEquals(w.npmHits(), 1, "downloaded once, then served from denext's cache");
  } finally {
    await w.close();
  }
});

Deno.test("the npm fallback: integrity-checked download, SHA-256-checked binary, cached with a stamp", async () => {
  const w = await world({ pinned: null });
  try {
    const path = await ensureNpmEsbuild(seams(w));
    assertEquals(await Deno.readFile(path), NPM_ESBUILD);
    if (Deno.build.os !== "windows") assertEquals((await Deno.stat(path)).mode! & 0o777, 0o755);
    assertEquals(await ensureNpmEsbuild({ ...seams(w), fetch: offline }), path, "cached: offline");
    assertEquals(w.npmHits(), 1);
    // A cached binary that no longer hashes to the pin is replaced.
    await Deno.writeFile(path, enc.encode("#!/bin/sh\necho evil  esbuild\n"));
    assertEquals(await Deno.readFile(await ensureNpmEsbuild(seams(w))), NPM_ESBUILD);
    assertEquals(w.npmHits(), 2);
  } finally {
    await w.close();
  }
});

Deno.test("the npm fallback takes a verified copy from Deno's npm cache before downloading", async () => {
  const w = await world({ pinned: null });
  try {
    // Deno names a registry's folder by domain and port, `:` never in it (an IP: the port alone).
    const port = new URL(w.env.NPM_CONFIG_REGISTRY).port;
    const cached = join(w.denoDir, "npm", port, "@esbuild", "fake-x64", ESBUILD_VERSION, "bin");
    await Deno.mkdir(cached, { recursive: true });
    await Deno.writeFile(join(cached, "esbuild"), NPM_ESBUILD);
    const path = await ensureNpmEsbuild({ ...seams(w), fetch: offline });
    assertEquals(await Deno.readFile(path), NPM_ESBUILD);
    assertEquals(w.npmHits(), 0);
  } finally {
    await w.close();
  }
});

Deno.test("the npm fallback REFUSES a tarball whose integrity or binary does not match the pin", async () => {
  const w = await world({ pinned: null });
  try {
    const bad = {
      ...w.npm,
      [TARGET]: { ...w.npm[TARGET], integrity: "sha512-" + "A".repeat(86) + "==" },
    };
    const e1 = await assertRejects(() => ensureNpmEsbuild({ ...seams(w), npm: bad }));
    assertStringIncludes((e1 as Error).message, "integrity mismatch");
    const badBin = { ...w.npm, [TARGET]: { ...w.npm[TARGET], sha256: "0".repeat(64) } };
    const e2 = await assertRejects(() => ensureNpmEsbuild({ ...seams(w), npm: badBin }));
    assertStringIncludes((e2 as Error).message, "SHA-256");
    assertEquals(
      await Deno.stat(join(w.npmRoot, ESBUILD_VERSION, TARGET, "esbuild")).catch(() => null),
      null,
      "nothing unverified was installed",
    );
    const e3 = await assertRejects(() => ensureNpmEsbuild({ ...seams(w), fetch: offline }));
    assertStringIncludes((e3 as Error).message, "ESBUILD_BINARY_PATH");
    const e4 = await assertRejects(() => ensureNpmEsbuild({ ...seams(w), target: "plan9-mips" }));
    assertStringIncludes((e4 as Error).message, "no esbuild");
  } finally {
    await w.close();
  }
});

Deno.test("denoNpmRegistryDir: Deno's own folder name for a registry in its npm cache", () => {
  assertEquals(denoNpmRegistryDir("https://registry.npmjs.org"), ["registry.npmjs.org"]);
  assertEquals(denoNpmRegistryDir("http://localhost:4873/"), ["localhost_4873"]);
  assertEquals(denoNpmRegistryDir("http://127.0.0.1:4873"), ["4873"]);
  assertEquals(denoNpmRegistryDir("https://npm.example.com:443/org/x"), [
    "npm.example.com",
    "org",
    "x",
  ]);
});

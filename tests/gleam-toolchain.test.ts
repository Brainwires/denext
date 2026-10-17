// src/build/gleam-toolchain.ts: the pinned Gleam compiler — the pin table, a verified tar.gz / zip
// install from a LOCAL fixture server (no network) into the toolchain cache, the refusals (SHA-256
// mismatch, offline, network denied, no build for the host), the `DENEXT_GLEAM` override, and the
// `toolchain status` view. The real download runs only with DENEXT_TEST_GLEAM_DOWNLOAD=1.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  DenoToolchainDownloadError,
  DenoToolchainHashError,
  DenoToolchainUnavailableError,
} from "../src/build/deno-toolchain.ts";
import {
  ensureGleamToolchain,
  GLEAM_ENV,
  GLEAM_PREFETCH,
  GLEAM_TARGET_TRIPLES,
  GLEAM_TOOLCHAIN,
  type GleamToolchainPin,
  gleamToolchainStatus,
  resolveGleamToolchain,
} from "../src/build/gleam-toolchain.ts";
import { sha256Hex, tarGz, zip } from "./_archive-fixtures.ts";

const TARGET = "linux-x86_64";
const VERSION = "9.9.9";
const BINARY = "#!/bin/sh\necho gleam 9.9.9\n";
const quiet = () => {};
const offline: typeof fetch = () => Promise.reject(new TypeError("network unreachable"));
const noEnv = () => undefined;

interface Fixture {
  pin: GleamToolchainPin;
  root: string;
  hits: () => number;
  close: () => Promise<void>;
}

/** A local server serving `body`, a Gleam pin for `target` pointing at it, a temp cache root. */
async function fixture(
  body: Uint8Array,
  opts: { target?: string; format?: "tar.gz" | "zip"; sha256?: string } = {},
): Promise<Fixture> {
  let hits = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => {
    hits++;
    return new Response(body as BodyInit);
  });
  const format = opts.format ?? "tar.gz";
  const file = `gleam-v${VERSION}-fixture.${format}`;
  const pin: GleamToolchainPin = {
    schema: 1,
    version: VERSION,
    targets: {
      [opts.target ?? TARGET]: {
        file,
        url: `http://127.0.0.1:${server.addr.port}/${file}`,
        sha256: opts.sha256 ?? await sha256Hex(body),
        size: body.byteLength,
        format,
      },
    },
  };
  const root = await Deno.makeTempDir({ prefix: "denext-gleam-tc-" });
  return {
    pin,
    root,
    hits: () => hits,
    close: async () => {
      await server.shutdown();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

const tarred = (data = BINARY) => tarGz([{ name: "gleam", data, mode: 0o755 }]);

function ensure(f: Fixture, extra: Parameters<typeof ensureGleamToolchain>[0] = {}) {
  return ensureGleamToolchain({
    pin: f.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: f.root,
    log: quiet,
    env: noEnv,
    ...extra,
  });
}

Deno.test("the Gleam pin: an exact release, every platform, hashes and sizes", () => {
  assertMatch(GLEAM_TOOLCHAIN.version, /^1\.\d+\.\d+$/);
  assertEquals(GLEAM_TOOLCHAIN.tag, `v${GLEAM_TOOLCHAIN.version}`);
  // Pins are at least two weeks old when made (scripts/gleam-pin.ts refuses newer ones).
  assert(GLEAM_TOOLCHAIN.published !== undefined);
  assertEquals(
    Object.keys(GLEAM_TOOLCHAIN.targets).sort(),
    Object.keys(GLEAM_TARGET_TRIPLES).sort(),
  );
  for (const [target, a] of Object.entries(GLEAM_TOOLCHAIN.targets)) {
    const windows = target.startsWith("windows-");
    const triple = GLEAM_TARGET_TRIPLES[target];
    assertEquals(
      a.file,
      `gleam-v${GLEAM_TOOLCHAIN.version}-${triple}.${windows ? "zip" : "tar.gz"}`,
    );
    assertEquals(a.format, windows ? "zip" : "tar.gz");
    assertEquals(
      a.url,
      `https://github.com/gleam-lang/gleam/releases/download/v${GLEAM_TOOLCHAIN.version}/${a.file}`,
    );
    assertMatch(a.sha256, /^[0-9a-f]{64}$/);
    assert((a.size ?? 0) > 1_000_000, target);
  }
  // A pin bump (`deno task gleam:pin <version>`) updates the docs page that names the version.
  const page = Deno.readTextFileSync(
    fromFileUrl(new URL("../site/app/docs/gleam/content.md", import.meta.url)),
  );
  assertStringIncludes(page, `pins one Gleam release (${GLEAM_TOOLCHAIN.version} today)`);
  // Linux takes the static musl builds (any distribution).
  assertStringIncludes(GLEAM_TOOLCHAIN.targets["linux-x86_64"].file, "linux-musl");
});

Deno.test("ensureGleamToolchain: verified tar.gz install into the toolchain cache, then cached", async () => {
  const f = await fixture(await tarred());
  try {
    const first = await ensure(f);
    assertEquals(first.gleam, join(f.root, "gleam", VERSION, TARGET, "gleam"));
    assertEquals(first.cached, false);
    assertEquals(first.version, VERSION);
    assertEquals(await Deno.readTextFile(first.gleam), BINARY);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(first.gleam)).mode! & 0o111, 0o111, "executable");
    }
    const again = await ensure(f, { fetch: offline });
    assertEquals(again.cached, true);
    assertEquals(f.hits(), 1, "downloaded once");
  } finally {
    await f.close();
  }
});

Deno.test("ensureGleamToolchain: a Windows zip holding gleam.exe", async () => {
  const body = await zip([{ name: "gleam.exe", data: "MZ fake" }]);
  const f = await fixture(body, { target: "windows-aarch64", format: "zip" });
  try {
    const got = await ensure(f, { target: "windows-aarch64", os: "windows" });
    assertEquals(got.gleam, join(f.root, "gleam", VERSION, "windows-aarch64", "gleam.exe"));
    assertEquals(await Deno.readTextFile(got.gleam), "MZ fake");
  } finally {
    await f.close();
  }
});

Deno.test("ensureGleamToolchain refuses a SHA-256 mismatch: nothing extracted or installed", async () => {
  const f = await fixture(await tarred(), { sha256: "0".repeat(64) });
  try {
    const err = await assertRejects(() => ensure(f), DenoToolchainHashError);
    assertStringIncludes(err.message, "REFUSING denext's Gleam compiler");
    assertStringIncludes(err.message, "SHA-256 mismatch");
    const dir = join(f.root, "gleam", VERSION, TARGET);
    assertEquals(await Deno.stat(join(dir, "gleam")).catch(() => null), null);
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => !n.startsWith("."));
    assertEquals(left, []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureGleamToolchain offline: a clear error naming the prefetch command", async () => {
  const f = await fixture(await tarred());
  try {
    const err = await assertRejects(
      () => ensure(f, { fetch: offline }),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "Are you offline?");
    assertStringIncludes(err.message, GLEAM_PREFETCH);
    assertStringIncludes(err.message, GLEAM_ENV);
  } finally {
    await f.close();
  }
});

Deno.test("ensureGleamToolchain with the network denied (--deny-net): refused before any request", async () => {
  const f = await fixture(await tarred());
  const script = join(f.root, "probe.ts");
  const mod = new URL("../src/build/gleam-toolchain.ts", import.meta.url).href;
  await Deno.writeTextFile(
    script,
    `import { ensureGleamToolchain } from ${JSON.stringify(mod)};
const pin = JSON.parse(Deno.args[0]);
try {
  await ensureGleamToolchain({ pin, target: "${TARGET}", os: "linux", cacheRoot: Deno.args[1], log: () => {} });
  console.log("INSTALLED");
} catch (err) {
  console.log(err.name + ": " + err.message);
}
`,
  );
  try {
    const config = fromFileUrl(new URL("../deno.json", import.meta.url));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--deny-net", "--config", config, script, JSON.stringify(f.pin), f.root],
      env: { NO_COLOR: "1" },
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assertStringIncludes(text, "DenoToolchainDownloadError");
    assertStringIncludes(text, "(offline)");
    assertStringIncludes(text, GLEAM_PREFETCH);
    assertEquals(f.hits(), 0, "no request was made");
  } finally {
    await f.close();
  }
});

Deno.test("ensureGleamToolchain: no build for this host is a clear refusal naming DENEXT_GLEAM", async () => {
  const f = await fixture(await tarred());
  try {
    const err = await assertRejects(
      () => ensure(f, { target: "freebsd-x86_64" }),
      DenoToolchainUnavailableError,
    );
    assertStringIncludes(err.message, "no build for freebsd-x86_64");
    assertStringIncludes(err.message, GLEAM_ENV);
  } finally {
    await f.close();
  }
});

Deno.test("resolveGleamToolchain: DENEXT_GLEAM=<path> is honored, unverified; a missing one refused", async () => {
  const f = await fixture(await tarred());
  const own = join(f.root, "my-gleam");
  await Deno.writeTextFile(own, BINARY);
  try {
    const env = (k: string) => (k === GLEAM_ENV ? `"${own}"` : undefined);
    const got = await resolveGleamToolchain({
      pin: f.pin,
      target: TARGET,
      cacheRoot: f.root,
      env,
      fetch: offline,
    });
    assertEquals(got.gleam, own);
    assertEquals(got.version, "path");
    assertStringIncludes(got.warning!, "not downloaded, pinned or verified");
    assertEquals(f.hits(), 0);
    const missing = (k: string) => (k === GLEAM_ENV ? join(f.root, "nope") : undefined);
    await assertRejects(
      () => resolveGleamToolchain({ pin: f.pin, target: TARGET, cacheRoot: f.root, env: missing }),
      DenoToolchainUnavailableError,
      "is not a file",
    );
    // Unset: the pinned copy.
    const pinned = await resolveGleamToolchain({
      pin: f.pin,
      target: TARGET,
      os: "linux",
      cacheRoot: f.root,
      env: noEnv,
      log: quiet,
    });
    assertEquals(pinned.gleam, join(f.root, "gleam", VERSION, TARGET, "gleam"));
  } finally {
    await f.close();
  }
});

Deno.test("gleamToolchainStatus: missing, cached, tampered, an override, an unsupported host", async () => {
  const f = await fixture(await tarred());
  const opts = { pin: f.pin, target: TARGET, os: "linux", cacheRoot: f.root, env: noEnv };
  try {
    const missing = await gleamToolchainStatus(opts);
    assertEquals([missing.mode, missing.state, missing.ok], ["pinned", "missing", true]);
    assertStringIncludes(missing.detail, `gleam ${VERSION} for ${TARGET}`);
    assertStringIncludes(missing.detail, GLEAM_PREFETCH);
    assertEquals(f.hits(), 0, "status never downloads");

    await ensure(f);
    const cached = await gleamToolchainStatus({ ...opts, verify: true });
    assertEquals([cached.state, cached.ok], ["cached", true]);
    assertEquals(cached.path, join(f.root, "gleam", VERSION, TARGET, "gleam"));

    await Deno.writeTextFile(cached.path!, BINARY + "# changed\n");
    const bad = await gleamToolchainStatus(opts);
    assertEquals([bad.state, bad.ok], ["invalid", false]);
    // …and the next use re-downloads it.
    assertEquals(await Deno.readTextFile((await ensure(f)).gleam), BINARY);

    const override = await gleamToolchainStatus({
      ...opts,
      env: (k) => (k === GLEAM_ENV ? join(f.root, "nope") : undefined),
    });
    assertEquals([override.mode, override.ok], ["path", false]);
    assertStringIncludes(override.detail, "NOT FOUND");

    const other = await gleamToolchainStatus({ ...opts, target: "freebsd-x86_64" });
    assertEquals([other.state, other.path], ["unsupported", null]);
  } finally {
    await f.close();
  }
});

Deno.test({
  name: "the real pinned Gleam: download, verify, run (DENEXT_TEST_GLEAM_DOWNLOAD=1)",
  ignore: Deno.env.get("DENEXT_TEST_GLEAM_DOWNLOAD") !== "1",
}, async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-gleam-real-" });
  try {
    const got = await ensureGleamToolchain({ cacheRoot: root, env: noEnv, log: quiet });
    const out = await new Deno.Command(got.gleam, { args: ["--version"] }).output();
    assert(out.success);
    assertEquals(new TextDecoder().decode(out.stdout).trim(), `gleam ${GLEAM_TOOLCHAIN.version}`);
    assertEquals((await ensureGleamToolchain({ cacheRoot: root, env: noEnv })).cached, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gleam:pin refuses an asset GitHub records no digest for (no silent sidecar-only pin)", async () => {
  const { crossCheck } = await import("../scripts/gleam-pin.ts");
  const asset = { name: "gleam-v1-x.tar.gz", size: 1, browser_download_url: "https://x.invalid/a" };
  for (const digest of [undefined, null, "", "md5:abc"]) {
    await assertRejects(
      () => crossCheck({ ...asset, digest }, [], new Uint8Array(1), "0".repeat(64)),
      Error,
      "no sha256 digest",
    );
  }
});

// scripts/fastlane-pin.ts (`deno task fastlane:pin`): the four portable-ruby bottles read from a
// fake ghcr OCI index and checked against it, the mirror-first / ghcr-fallback pin, the fastlane
// age gate, and the regenerated Gemfile.lock (a fake `bundle lock`) checked for its platforms and
// CHECKSUMS. No network.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  bottlesFromIndex,
  buildFastlanePin,
  checkLock,
  LOCK_PLATFORMS,
  main,
  RUBY_BOTTLE_TAGS,
} from "../scripts/fastlane-pin.ts";
import type { BundleRunner } from "../src/build/fastlane-toolchain.ts";
import { sha256Hex, tarGz } from "./_archive-fixtures.ts";

const RUBY = "9.9.9_1";
const NOW = Date.parse("2026-10-18T00:00:00Z");

const LOCK = `GEM
  remote: https://rubygems.org/
  specs:
    fastlane (2.999.0)
      plist (>= 1.1)
    plist (3.7.2)

PLATFORMS
  aarch64-linux
  arm64-darwin
  ruby
  x86_64-darwin
  x86_64-linux

DEPENDENCIES
  fastlane (= 2.999.0)

CHECKSUMS
  fastlane (2.999.0) sha256=${"a".repeat(64)}
  plist (3.7.2) sha256=${"b".repeat(64)}

BUNDLED WITH
  4.0.20
`;

/** A bottle per target (distinct bytes), the OCI index naming them, and a fake fetch. */
async function fakeRegistry(opts: {
  tamper?: string;
  fastlaneDate?: string;
  dropTag?: string;
} = {}) {
  const bottles: Record<string, Uint8Array> = {};
  for (const [target, tag] of Object.entries(RUBY_BOTTLE_TAGS)) {
    bottles[target] = await tarGz([
      { name: `portable-ruby/${RUBY}/bin/ruby`, data: `#!/bin/sh\n# ${tag}\n`, mode: 0o755 },
    ]);
  }
  const index = {
    schemaVersion: 2,
    manifests: await Promise.all(
      Object.entries(RUBY_BOTTLE_TAGS)
        .filter(([, tag]) => tag !== opts.dropTag)
        .map(async ([target, tag]) => ({
          annotations: {
            "org.opencontainers.image.ref.name": `${RUBY}.${tag}`,
            "sh.brew.bottle.digest": await sha256Hex(bottles[target]),
            "sh.brew.bottle.size": String(bottles[target].byteLength),
          },
        })),
    ),
  };
  const blobs = new Map<string, Uint8Array>();
  for (const [target, b] of Object.entries(bottles)) {
    blobs.set(await sha256Hex(b), target === opts.tamper ? b.subarray(0, b.byteLength - 1) : b);
  }
  const requests: string[] = [];
  const versions = [
    { number: "3.0.0", created_at: "2026-10-17T00:00:00Z" },
    { number: "2.999.0", created_at: opts.fastlaneDate ?? "2026-09-15T10:00:00Z" },
  ];
  const blobAt = (url: string) => blobs.get(/\/blobs\/sha256:([0-9a-f]{64})$/.exec(url)?.[1] ?? "");
  // [matches, answer]: the first match answers; ghcr wants its anonymous token.
  const routes: [(url: string, auth: string | null) => boolean, (url: string) => Response][] = [
    [(u) => u.endsWith("/portable-ruby-version"), () => new Response(`${RUBY}\n`)],
    [(u) => u.startsWith("https://rubygems.org/"), () => Response.json(versions)],
    [
      (u, a) => u.startsWith("https://ghcr.io/") && a !== "Bearer QQ==",
      () => new Response("no", { status: 401 }),
    ],
    [(u) => u.endsWith(`/manifests/${RUBY}`), () => Response.json(index)],
    [(u) => blobAt(u) !== undefined, (u) => new Response(blobAt(u)! as BodyInit)],
  ];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = String(input);
    requests.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    const route = routes.find(([matches]) => matches(url, auth));
    return Promise.resolve(route ? route[1](url) : new Response("not found", { status: 404 }));
  };
  return { fetch: fakeFetch, requests, index, bottles };
}

/** A fake `bundle lock`: records its calls and writes `lock` (with a host platform first). */
function fakeBundleLock(lock = LOCK) {
  const calls: string[][] = [];
  const run: BundleRunner = async (_ruby, args, { cwd, env }) => {
    calls.push([...args]);
    assertEquals(env.BUNDLE_FROZEN, undefined, "lock is not frozen");
    assertEquals(env.BUNDLE_GEMFILE, join(cwd, "Gemfile"));
    const path = join(cwd, "Gemfile.lock");
    if (args.includes("--add-platform")) {
      await Deno.writeTextFile(
        path,
        lock.replace("PLATFORMS\n", "PLATFORMS\n  x86_64-darwin-20\n"),
      );
    } else if (args.includes("--remove-platform")) {
      await Deno.writeTextFile(path, lock);
    }
    return { code: 0, output: "" };
  };
  return { run, calls };
}

async function withOut(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-pin-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("fastlane:pin: verified bottles, mirror first + ghcr fallback, a fresh checked lock", async () => {
  await withOut(async (outDir) => {
    const reg = await fakeRegistry();
    const bundle = fakeBundleLock();
    const { pin, files } = await buildFastlanePin({
      fastlane: "2.999.0",
      outDir,
      hostTarget: "linux-x86_64",
      fetch: reg.fetch,
      run: bundle.run,
      now: () => NOW,
      log: () => {},
    });
    assertEquals(pin.fastlane, "2.999.0");
    assertEquals(pin.published, "2026-09-15");
    assertEquals(pin.ruby.version, RUBY);
    assertEquals(pin.ruby.root, `portable-ruby/${RUBY}`);
    assertEquals(Object.keys(pin.ruby.targets).sort(), Object.keys(RUBY_BOTTLE_TAGS).sort());
    for (const [target, a] of Object.entries(pin.ruby.targets)) {
      const sha = await sha256Hex(reg.bottles[target]);
      assertEquals(a, {
        file: `portable-ruby-${RUBY}.${RUBY_BOTTLE_TAGS[target]}.bottle.tar.gz`,
        url: `https://github.com/Brainwires/denext/releases/download/toolchain-assets/${a.file}`,
        sha256: sha,
        size: reg.bottles[target].byteLength,
        format: "tar.gz",
        fallbacks: [{
          url: `https://ghcr.io/v2/homebrew/core/portable-ruby/blobs/sha256:${sha}`,
          headers: { Authorization: "Bearer QQ==" },
        }],
      });
    }
    // The verified tarballs are left for the mirror upload, byte for byte.
    assertEquals(files.length, 4);
    for (const f of files) {
      assert(f.startsWith(outDir));
      assertEquals(
        await sha256Hex(await Deno.readFile(f)),
        pin.ruby.targets[
          Object.keys(RUBY_BOTTLE_TAGS).find((t) =>
            f.endsWith(`.${RUBY_BOTTLE_TAGS[t]}.bottle.tar.gz`)
          )!
        ].sha256,
      );
    }
    assertEquals(pin.gemfile, 'source "https://rubygems.org"\n\ngem "fastlane", "2.999.0"\n');
    assertEquals(pin.gemfileLock, LOCK);
    // add the platforms, drop the host-specific one, add checksums.
    assertEquals(bundle.calls, [
      ["-S", "bundle", "lock", "--add-platform", ...LOCK_PLATFORMS],
      ["-S", "bundle", "lock", "--remove-platform", "x86_64-darwin-20"],
      ["-S", "bundle", "lock", "--add-checksums"],
    ]);
    // Homebrew's vendored version was read (no --ruby).
    assert(reg.requests.some((u) => u.endsWith("/portable-ruby-version")));
  });
});

Deno.test("fastlane:pin refuses a bottle that doesn't match the ghcr index, and writes nothing", async () => {
  await withOut(async (outDir) => {
    const reg = await fakeRegistry({ tamper: "linux-aarch64" });
    const bundle = fakeBundleLock();
    const err = await assertRejects(() =>
      buildFastlanePin({
        ruby: RUBY,
        fastlane: "2.999.0",
        outDir,
        hostTarget: "linux-x86_64",
        fetch: reg.fetch,
        run: bundle.run,
        now: () => NOW,
        log: () => {},
      }), Error);
    assertStringIncludes(
      err.message,
      `portable-ruby-${RUBY}.arm64_linux.bottle.tar.gz: got sha256`,
    );
    assertStringIncludes(err.message, "the ghcr index says");
    assertEquals(bundle.calls, []);
  });
});

Deno.test("fastlane:pin refuses a fastlane under two weeks old unless --allow-new", async () => {
  await withOut(async (outDir) => {
    const reg = await fakeRegistry({ fastlaneDate: "2026-10-10T00:00:00Z" });
    const opts = {
      ruby: RUBY,
      fastlane: "2.999.0",
      outDir,
      hostTarget: "darwin-aarch64",
      fetch: reg.fetch,
      run: fakeBundleLock().run,
      now: () => NOW,
      log: () => {},
    };
    const err = await assertRejects(() => buildFastlanePin(opts), Error);
    assertStringIncludes(err.message, "at least 14 days old, or pass --allow-new");
    const { pin } = await buildFastlanePin({ ...opts, allowNew: true });
    assertEquals(pin.published, "2026-10-10");
    const missing = await assertRejects(
      () => buildFastlanePin({ ...opts, fastlane: "1.0.0" }),
      Error,
    );
    assertStringIncludes(missing.message, "fastlane 1.0.0 is not on rubygems.org");
  });
});

Deno.test("fastlane:pin: a missing bottle tag, a Windows host, a lock without checksums", async () => {
  const reg = await fakeRegistry({ dropTag: "big_sur" });
  const err = (() => {
    try {
      bottlesFromIndex(reg.index, RUBY);
    } catch (e) {
      return e as Error;
    }
  })();
  assertStringIncludes(err?.message ?? "", `no usable ${RUBY}.big_sur bottle`);
  await withOut(async (outDir) => {
    const ok = await fakeRegistry();
    const win = await assertRejects(() =>
      buildFastlanePin({
        ruby: RUBY,
        fastlane: "2.999.0",
        outDir,
        hostTarget: "windows-x86_64",
        fetch: ok.fetch,
        run: fakeBundleLock().run,
        now: () => NOW,
        log: () => {},
      }), Error);
    assertStringIncludes(win.message, "run on macOS or Linux");
    const noSums = LOCK.replace(/\nCHECKSUMS\n[\s\S]*?\n\n/, "\n");
    const bad = await assertRejects(() =>
      buildFastlanePin({
        ruby: RUBY,
        fastlane: "2.999.0",
        outDir,
        hostTarget: "linux-x86_64",
        fetch: ok.fetch,
        run: fakeBundleLock(noSums).run,
        now: () => NOW,
        log: () => {},
      }), Error);
    assertStringIncludes(
      bad.message,
      "the lock has no CHECKSUMS for fastlane (2.999.0), plist (3.7.2)",
    );
  });
  // checkLock on its own: the spec, the platforms.
  const wrongVersion = (() => {
    try {
      checkLock(LOCK, "2.998.0");
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assertEquals(wrongVersion, "the lock does not resolve fastlane 2.998.0");
  const oneMissing = (() => {
    try {
      checkLock(LOCK.replace(`  plist (3.7.2) sha256=${"b".repeat(64)}\n`, ""), "2.999.0");
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assertEquals(oneMissing, "the lock has no CHECKSUMS for plist (3.7.2)");
  const platforms = (() => {
    try {
      checkLock(LOCK.replace("  x86_64-linux\n", ""), "2.999.0");
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assertStringIncludes(platforms ?? "", "the lock lists the platforms");
});

Deno.test("fastlane:pin main: writes the pin; --upload hands the tarballs to the mirror", async () => {
  await withOut(async (dir) => {
    const pinFile = join(dir, "pin.json");
    const out = join(dir, "mirror");
    const seen: { options?: unknown; gh: string[][]; log: string[] } = { gh: [], log: [] };
    const result = { pin: { schema: 1, fastlane: "2.999.0" } as never, files: ["/m/a.tar.gz"] };
    const seams = {
      build: (options: unknown) => {
        seen.options = options;
        return Promise.resolve(result);
      },
      pinFile,
      gh: (args: string[]) => {
        seen.gh.push(args);
        return Promise.resolve(true);
      },
      log: (l: string) => seen.log.push(l),
    };
    await main(["--fastlane", "2.999.0", "--ruby", RUBY, "--allow-new", "--out", out], seams);
    assertEquals(JSON.parse(await Deno.readTextFile(pinFile)), result.pin);
    const o = seen.options as Record<string, unknown>;
    assertEquals([o.fastlane, o.ruby, o.allowNew, o.outDir], ["2.999.0", RUBY, true, out]);
    assert((await Deno.stat(out)).isDirectory);
    assertEquals(seen.gh, [], "no upload without --upload");
    assertStringIncludes(seen.log.join("\n"), "gh release upload toolchain-assets /m/a.tar.gz");
    await main(["--out", out, "--upload"], seams);
    assertEquals(seen.gh, [[
      "release",
      "upload",
      "toolchain-assets",
      "/m/a.tar.gz",
      "--clobber",
      "-R",
      "Brainwires/denext",
    ]]);
    const failing = { ...seams, gh: () => Promise.resolve(false) };
    await assertRejects(() => main(["--out", out, "--upload"], failing), Error, "upload failed");
  });
});

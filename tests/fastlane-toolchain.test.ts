// src/build/fastlane-toolchain.ts: denext's managed fastlane — the pin (portable Ruby per host +
// a Gemfile.lock with checksums), a verified install from a LOCAL fixture server (no network) with
// a fake `bundle install`, the refusals (SHA-256 mismatch, offline, no compiler, a failed gem
// build, Windows), the re-install on a changed pin, the isolated environment runs get, the
// `DENEXT_FASTLANE` override and the `toolchain status` view. `denext fastlane`'s runner
// (src/cli/commands/fastlane.ts) is covered at the end.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  DenoToolchainDownloadError,
  DenoToolchainHashError,
  DenoToolchainUnavailableError,
  downloadPinned,
} from "../src/build/deno-toolchain.ts";
import {
  type BundleRunner,
  compilerProblem,
  ensureFastlaneToolchain,
  FASTLANE_ENV,
  FASTLANE_PREFETCH,
  FASTLANE_TOOLCHAIN,
  FastlaneInstallError,
  type FastlaneToolchainPin,
  fastlaneToolchainStatus,
  FastlaneUnsupportedError,
  managedFastlaneEnv,
  pluginfileGems,
  resolveFastlane,
} from "../src/build/fastlane-toolchain.ts";
import { runFastlane } from "../src/cli/commands/fastlane.ts";
import { sha256Hex, tarGz } from "./_archive-fixtures.ts";

const TARGET = "linux-x86_64";
const RUBY = "#!/bin/sh\necho ruby 9.9.9\n";
const quiet = () => {};
const offline: typeof fetch = () => Promise.reject(new TypeError("network unreachable"));
const noEnv = () => undefined;
const hasCompiler = () => Promise.resolve(null);

interface Fixture {
  pin: FastlaneToolchainPin;
  root: string;
  hits: () => number;
  /** The Authorization header of the last request. */
  auth: () => string | null;
  close: () => Promise<void>;
}

const rubyTarball = (data = RUBY) =>
  tarGz([
    { name: "portable-ruby/9.9.9/bin/ruby", data, mode: 0o755 },
    { name: "portable-ruby/9.9.9/lib/ruby/9.9.0/fake.rb", data: "# lib\n" },
  ]);

/** A local server serving `body`, a fastlane pin for `target` pointing at it, a temp cache root. */
async function fixture(
  body: Uint8Array,
  opts: { target?: string; sha256?: string; lock?: string } = {},
): Promise<Fixture> {
  let hits = 0;
  let auth: string | null = null;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    hits++;
    auth = req.headers.get("authorization");
    return new Response(body as BodyInit);
  });
  const file = "portable-ruby-9.9.9.fixture.bottle.tar.gz";
  const pin: FastlaneToolchainPin = {
    schema: 1,
    fastlane: "2.999.0",
    ruby: {
      version: "9.9.9",
      root: "portable-ruby/9.9.9",
      targets: {
        [opts.target ?? TARGET]: {
          file,
          url: `http://127.0.0.1:${server.addr.port}/${file}`,
          sha256: opts.sha256 ?? await sha256Hex(body),
          size: body.byteLength,
          format: "tar.gz",
          headers: { Authorization: "Bearer QQ==" },
        },
      },
    },
    gemfile: 'source "https://rubygems.org"\ngem "fastlane", "2.999.0"\n',
    gemfileLock: opts.lock ?? "GEM\n  specs:\n    fastlane (2.999.0)\n\nCHECKSUMS\n",
  };
  const root = await Deno.makeTempDir({ prefix: "denext-fastlane-tc-" });
  return {
    pin,
    root,
    hits: () => hits,
    auth: () => auth,
    close: async () => {
      await server.shutdown();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

/** A fake `bundle install`: records its call and writes a gem tree (with a `.gem` cache). */
function fakeBundle(code = 0, output = "Bundle complete!\n") {
  const calls: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const run: BundleRunner = async (command, args, { cwd, env }) => {
    calls.push({ command, args, cwd, env });
    if (code === 0) {
      await Deno.mkdir(join(env.BUNDLE_PATH, "ruby", "9.9.0", "cache"), { recursive: true });
      await Deno.writeTextFile(join(env.BUNDLE_PATH, "ruby", "9.9.0", "cache", "x.gem"), "gem");
      await Deno.mkdir(join(env.BUNDLE_PATH, "ruby", "9.9.0", "gems", "fastlane-2.999.0"), {
        recursive: true,
      });
    }
    return { code, output };
  };
  return { run, calls };
}

function ensure(
  f: Fixture,
  extra: Parameters<typeof ensureFastlaneToolchain>[0] = {},
) {
  return ensureFastlaneToolchain({
    pin: f.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: f.root,
    log: quiet,
    env: noEnv,
    compiler: hasCompiler,
    ...extra,
  });
}

Deno.test("the fastlane pin: Homebrew's portable Ruby per host, a locked fastlane with checksums", () => {
  const pin = FASTLANE_TOOLCHAIN;
  assertMatch(pin.fastlane, /^2\.\d+\.\d+$/);
  assert(pin.published !== undefined);
  assertEquals(Object.keys(pin.ruby.targets).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
  ]);
  assertEquals(pin.ruby.root, `portable-ruby/${pin.ruby.version}`);
  for (const [target, a] of Object.entries(pin.ruby.targets)) {
    assertMatch(a.sha256, /^[0-9a-f]{64}$/);
    // denext's own mirror first, then ghcr (a blob by its content address: the URL names the
    // pinned hash); both are checked against the same SHA-256.
    assertEquals(
      a.url,
      `https://github.com/Brainwires/denext/releases/download/toolchain-assets/${a.file}`,
    );
    assertEquals(a.headers, undefined);
    assertEquals(a.fallbacks, [{
      url: `https://ghcr.io/v2/homebrew/core/portable-ruby/blobs/sha256:${a.sha256}`,
      headers: { Authorization: "Bearer QQ==" },
    }]);
    assertEquals(a.format, "tar.gz");
    assertStringIncludes(a.file, `portable-ruby-${pin.ruby.version}.`);
    assert((a.size ?? 0) > 10_000_000, target);
  }
  assertStringIncludes(pin.gemfile, `gem "fastlane", "${pin.fastlane}"`);
  assertStringIncludes(pin.gemfileLock, `    fastlane (${pin.fastlane})\n`);
  // Every gem's SHA-256 is pinned: Bundler refuses a gem that doesn't match.
  assertStringIncludes(pin.gemfileLock, "\nCHECKSUMS\n");
  assertStringIncludes(pin.gemfileLock, `  fastlane (${pin.fastlane}) sha256=`);
  const platforms = /\nPLATFORMS\n((?: {2}.+\n)+)/.exec(pin.gemfileLock)?.[1] ?? "";
  for (const p of ["aarch64-linux", "arm64-darwin", "ruby", "x86_64-darwin", "x86_64-linux"]) {
    assertStringIncludes(platforms, `  ${p}\n`);
  }
});

Deno.test("ensureFastlaneToolchain: verified Ruby + a frozen bundle install, stamped, then cached", async () => {
  const f = await fixture(await rubyTarball());
  const bundle = fakeBundle();
  try {
    const first = await ensure(f, { runBundle: bundle.run });
    const dir = join(f.root, "fastlane", "2.999.0", TARGET);
    assertEquals(first, {
      dir,
      ruby: join(dir, "ruby", "bin", "ruby"),
      version: "2.999.0",
      target: TARGET,
      cached: false,
    });
    assertEquals(await Deno.readTextFile(first.ruby), RUBY);
    assertEquals(await Deno.readTextFile(join(dir, "Gemfile")), f.pin.gemfile);
    assertEquals(await Deno.readTextFile(join(dir, "Gemfile.lock")), f.pin.gemfileLock);
    assertEquals(f.auth(), "Bearer QQ==", "the pin's headers are sent");
    // One bundle install, run by the pinned Ruby, frozen to the lock, in the temp dir renamed later.
    assertEquals(bundle.calls.length, 1);
    const call = bundle.calls[0];
    assertEquals(call.args, ["-S", "bundle", "install", "--jobs", "4"]);
    assertMatch(call.command, /\.tmp-linux-x86_64-[^/\\]+[/\\]ruby[/\\]bin[/\\]ruby$/);
    assertEquals(call.env.BUNDLE_FROZEN, "true");
    assertEquals(call.env.BUNDLE_GEMFILE, join(call.cwd, "Gemfile"));
    // The .gem downloads are dropped; the installed gems stay.
    assert(await Deno.stat(join(dir, "gems", "ruby", "9.9.0", "gems")).catch(() => null));
    assertEquals(
      await Deno.stat(join(dir, "gems", "ruby", "9.9.0", "cache")).catch(() => null),
      null,
    );
    const stamp = JSON.parse(await Deno.readTextFile(join(dir, ".denext-fastlane.json")));
    assertEquals(stamp.fastlane, "2.999.0");
    assertEquals(stamp.ruby.sha256, f.pin.ruby.targets[TARGET].sha256);
    // Nothing left behind beside the slot.
    assertEquals(
      [...Deno.readDirSync(join(f.root, "fastlane", "2.999.0"))].map((e) => e.name),
      [TARGET],
    );
    const again = await ensure(f, { fetch: offline, runBundle: fakeBundle(1).run });
    assertEquals(again.cached, true);
    assertEquals(f.hits(), 1, "downloaded once");
  } finally {
    await f.close();
  }
});

Deno.test("ensureFastlaneToolchain: a changed lock (or a tampered stamp) re-installs", async () => {
  const f = await fixture(await rubyTarball());
  try {
    await ensure(f, { runBundle: fakeBundle().run });
    const lines: string[] = [];
    const bumped = { ...f.pin, gemfileLock: f.pin.gemfileLock + "\n# bumped\n" };
    const again = await ensure(f, {
      pin: bumped,
      runBundle: fakeBundle().run,
      log: (l) => lines.push(l),
    });
    assertEquals(again.cached, false);
    assertEquals(f.hits(), 2);
    assert(lines.some((l) => l.includes("does not match its pin; re-installing")));
    assertEquals(
      await Deno.readTextFile(join(again.dir, "Gemfile.lock")),
      bumped.gemfileLock,
    );
  } finally {
    await f.close();
  }
});

Deno.test("ensureFastlaneToolchain refuses a SHA-256 mismatch: nothing extracted, bundle never runs", async () => {
  const f = await fixture(await rubyTarball(), { sha256: "0".repeat(64) });
  const bundle = fakeBundle();
  try {
    const err = await assertRejects(
      () => ensure(f, { runBundle: bundle.run }),
      DenoToolchainHashError,
    );
    assertStringIncludes(err.message, "REFUSING denext's fastlane Ruby");
    assertEquals(bundle.calls.length, 0);
    assertEquals([...Deno.readDirSync(join(f.root, "fastlane", "2.999.0"))], []);
  } finally {
    await f.close();
  }
});

Deno.test("ensureFastlaneToolchain offline: a clear error naming the prefetch command", async () => {
  const f = await fixture(await rubyTarball());
  try {
    const err = await assertRejects(
      () => ensure(f, { fetch: offline, runBundle: fakeBundle().run }),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "Are you offline?");
    assertStringIncludes(err.message, FASTLANE_PREFETCH);
  } finally {
    await f.close();
  }
});

Deno.test("ensureFastlaneToolchain without a C compiler: says what to install, downloads nothing", async () => {
  const f = await fixture(await rubyTarball());
  try {
    const err = await assertRejects(
      () =>
        ensure(f, {
          runBundle: fakeBundle().run,
          compiler: () => Promise.resolve({ missing: "make", fix: "install make" }),
        }),
      FastlaneInstallError,
    );
    assertStringIncludes(err.message, "this machine has no make: install make");
    assertStringIncludes(err.message, FASTLANE_PREFETCH);
    assertEquals(f.hits(), 0);
  } finally {
    await f.close();
  }
});

Deno.test("ensureFastlaneToolchain: a failed gem build shows its output and installs nothing", async () => {
  const f = await fixture(await rubyTarball());
  try {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") +
      "\nGem::Ext::BuildError: ERROR: Failed to build gem native extension.\n";
    const err = await assertRejects(
      () => ensure(f, { runBundle: fakeBundle(5, output).run }),
      FastlaneInstallError,
    );
    assertStringIncludes(err.message, "bundle install exited 5");
    assertStringIncludes(err.message, "Failed to build gem native extension");
    assert(!err.message.includes("line 0\n"), "only the tail is shown");
    assertEquals([...Deno.readDirSync(join(f.root, "fastlane", "2.999.0"))], []);
    const status = await fastlaneToolchainStatus({
      pin: f.pin,
      target: TARGET,
      cacheRoot: f.root,
      env: noEnv,
    });
    assertEquals(status.state, "missing");
  } finally {
    await f.close();
  }
});

Deno.test("ensureFastlaneToolchain on Windows: not supported, with the override named", async () => {
  const err = await assertRejects(
    () => ensureFastlaneToolchain({ target: "windows-x86_64", env: noEnv, log: quiet }),
    FastlaneUnsupportedError,
  );
  assertStringIncludes(err.message, "fastlane does not support Windows");
  assertStringIncludes(err.message, `${FASTLANE_ENV}=<path>`);
  assert(err instanceof DenoToolchainUnavailableError);
  const other = await assertRejects(
    () => ensureFastlaneToolchain({ target: "freebsd-x86_64", env: noEnv, log: quiet }),
    FastlaneUnsupportedError,
  );
  assertStringIncludes(other.message, "has no Ruby for freebsd-x86_64");
});

Deno.test("managedFastlaneEnv: the user's Ruby setup dropped, Bundler on the slot, Ruby first on PATH", () => {
  const env = managedFastlaneEnv("/c/slot", {
    PATH: "/usr/bin",
    HOME: "/home/u",
    GEM_HOME: "/home/u/.gem",
    GEM_PATH: "/x",
    BUNDLE_GEMFILE: "/project/Gemfile",
    BUNDLE_PATH: "vendor/bundle",
    RUBYOPT: "-rbundler/setup",
    RUBYLIB: "/lib",
    RBENV_VERSION: "3.3.0",
    MATCH_PASSWORD: "kept",
    FASTLANE_SKIP_UPDATE_CHECK: "0",
  });
  assertEquals(env.PATH, `${join("/c/slot", "ruby", "bin")}:/usr/bin`);
  assertEquals(env.BUNDLE_GEMFILE, join("/c/slot", "Gemfile"));
  assertEquals(env.BUNDLE_PATH, join("/c/slot", "gems"));
  assertEquals(env.BUNDLE_FROZEN, "true");
  assertEquals(env.LANG, "en_US.UTF-8");
  assertEquals(env.MATCH_PASSWORD, "kept");
  assertEquals(env.HOME, "/home/u");
  assertEquals(env.FASTLANE_SKIP_UPDATE_CHECK, "0", "the user's choice wins");
  for (const k of ["GEM_HOME", "GEM_PATH", "RUBYOPT", "RUBYLIB", "RBENV_VERSION"]) {
    assertEquals(env[k], undefined, k);
  }
  const plain = managedFastlaneEnv("/c/slot", { LC_ALL: "C.UTF-8" });
  assertEquals(plain.LANG, undefined);
  assertEquals(plain.FASTLANE_SKIP_UPDATE_CHECK, "1");
});

Deno.test("resolveFastlane: the managed one through Bundler, isolated", async () => {
  const f = await fixture(await rubyTarball());
  try {
    const got = await resolveFastlane(
      {
        pin: f.pin,
        target: TARGET,
        os: "linux",
        cacheRoot: f.root,
        log: quiet,
        env: noEnv,
        compiler: hasCompiler,
        runBundle: fakeBundle().run,
      },
      { PATH: "/usr/bin", GEM_HOME: "/g" },
    );
    const dir = join(f.root, "fastlane", "2.999.0", TARGET);
    assertEquals(got.command, join(dir, "ruby", "bin", "ruby"));
    assertEquals(got.args, ["-S", "bundle", "exec", "fastlane"]);
    assertEquals(got.version, "2.999.0");
    assertEquals(got.env.BUNDLE_GEMFILE, join(dir, "Gemfile"));
    assertEquals(got.env.GEM_HOME, undefined);
    assertEquals(got.warning, undefined);
  } finally {
    await f.close();
  }
});

Deno.test("resolveFastlane: DENEXT_FASTLANE runs that file as is (with a warning), or refuses", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-path-" });
  try {
    const exe = join(dir, "fastlane");
    await Deno.writeTextFile(exe, "#!/bin/sh\n");
    const got = await resolveFastlane(
      { env: (k) => (k === FASTLANE_ENV ? `"${exe}"` : undefined) },
      {
        GEM_HOME: "/kept",
      },
    );
    assertEquals(got.command, exe);
    assertEquals(got.args, []);
    assertEquals(got.version, "path");
    assertEquals(got.env.GEM_HOME, "/kept", "a user's own fastlane keeps their Ruby setup");
    assertStringIncludes(got.warning ?? "", "not downloaded, pinned or verified");
    const missing = join(dir, "nope");
    const err = await assertRejects(
      () => resolveFastlane({ env: (k) => (k === FASTLANE_ENV ? missing : undefined) }),
      DenoToolchainUnavailableError,
    );
    assertStringIncludes(err.message, `${FASTLANE_ENV}=${missing} is not a file`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fastlaneToolchainStatus: missing → cached → invalid (tampered), unsupported, path", async () => {
  const f = await fixture(await rubyTarball());
  try {
    const opts = { pin: f.pin, target: TARGET, cacheRoot: f.root, env: noEnv };
    const missing = await fastlaneToolchainStatus(opts);
    assertEquals([missing.state, missing.ok, missing.mode], ["missing", true, "pinned"]);
    assertStringIncludes(missing.detail, FASTLANE_PREFETCH);
    await ensure(f, { runBundle: fakeBundle().run });
    const cached = await fastlaneToolchainStatus({ ...opts, verify: true });
    assertEquals([cached.state, cached.ok], ["cached", true]);
    assertEquals(cached.path, join(f.root, "fastlane", "2.999.0", TARGET));
    // Same size, different bytes: only `--verify` (a re-hash) notices.
    const ruby = join(cached.path!, "ruby", "bin", "ruby");
    const info = await Deno.stat(ruby);
    await Deno.writeTextFile(ruby, RUBY.replace("9.9.9", "6.6.6"));
    await Deno.utime(ruby, info.atime ?? new Date(), info.mtime ?? new Date());
    assertEquals((await fastlaneToolchainStatus(opts)).state, "cached");
    const tampered = await fastlaneToolchainStatus({ ...opts, verify: true });
    assertEquals([tampered.state, tampered.ok], ["invalid", false]);
    const windows = await fastlaneToolchainStatus({ ...opts, target: "windows-aarch64" });
    assertEquals([windows.state, windows.ok, windows.path], ["unsupported", true, null]);
    const path = await fastlaneToolchainStatus({
      ...opts,
      env: (k) => (k === FASTLANE_ENV ? join(f.root, "absent") : undefined),
    });
    assertEquals([path.mode, path.ok], ["path", false]);
    assertStringIncludes(path.detail, "NOT FOUND");
  } finally {
    await f.close();
  }
});

Deno.test("compilerProblem on Linux: cc (or gcc) and make on PATH", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-cc-" });
  try {
    const env = (k: string) => (k === "PATH" ? dir : undefined);
    const none = await compilerProblem("linux", env);
    assertEquals(none?.missing, "C compiler (cc) or make");
    assertStringIncludes(none?.fix ?? "", "build-essential");
    for (const name of ["gcc", "make"]) {
      await Deno.writeTextFile(join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
      await Deno.chmod(join(dir, name), 0o755);
    }
    assertEquals(await compilerProblem("linux", env), null);
    await Deno.remove(join(dir, "make"));
    assertEquals((await compilerProblem("linux", env))?.missing, "make");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pluginfileGems: the plugins fastlane/Pluginfile lists", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-plugins-" });
  try {
    assertEquals(await pluginfileGems(dir), []);
    await Deno.mkdir(join(dir, "fastlane"));
    await Deno.writeTextFile(
      join(dir, "fastlane", "Pluginfile"),
      "# Autogenerated by fastlane\n\ngem 'fastlane-plugin-firebase_app_distribution'\n" +
        '  gem "fastlane-plugin-versioning", "~> 0.5"\n# gem "commented-out"\n',
    );
    assertEquals(await pluginfileGems(dir), [
      "fastlane-plugin-firebase_app_distribution",
      "fastlane-plugin-versioning",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runFastlane: the arguments verbatim, the child's exit code, a plugin warning", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-run-" });
  try {
    const lines: string[] = [];
    const spawned: { args: string[]; cwd: string }[] = [];
    const invocation = {
      command: "/r/ruby",
      args: ["-S", "bundle", "exec", "fastlane"],
      env: {},
      version: "2.999.0",
    };
    const code = await runFastlane(["ios", "beta", "flavor:staging", "--verbose"], dir, {
      resolve: () => Promise.resolve(invocation),
      spawn: (inv, args, cwd) => {
        assertEquals(inv, invocation);
        spawned.push({ args, cwd });
        return Promise.resolve(3);
      },
      log: (l) => lines.push(l),
    });
    assertEquals(code, 3);
    assertEquals(spawned, [{ args: ["ios", "beta", "flavor:staging", "--verbose"], cwd: dir }]);
    assertEquals(lines, []);
    await Deno.mkdir(join(dir, "fastlane"));
    await Deno.writeTextFile(join(dir, "fastlane", "Pluginfile"), 'gem "fastlane-plugin-x"\n');
    await runFastlane([], dir, {
      resolve: () => Promise.resolve(invocation),
      spawn: () => Promise.resolve(0),
      log: (l) => lines.push(l),
    });
    assertStringIncludes(lines.join("\n"), "fastlane/Pluginfile lists fastlane-plugin-x");
    // A user's own fastlane (DENEXT_FASTLANE) loads its plugins: no warning, just its own.
    lines.length = 0;
    await runFastlane([], dir, {
      resolve: () =>
        Promise.resolve({
          command: "/x/fastlane",
          args: [],
          env: {},
          version: "path",
          warning: "W",
        }),
      spawn: () => Promise.resolve(0),
      log: (l) => lines.push(l),
    });
    assertEquals(lines, ["W"]);
    // No fastlane to be had: the reason, exit 1, nothing spawned.
    lines.length = 0;
    const failed = await runFastlane(["ios"], dir, {
      resolve: () => Promise.reject(new FastlaneUnsupportedError("denext: not here")),
      spawn: () => Promise.reject(new Error("must not spawn")),
      log: (l) => lines.push(l),
    });
    assertEquals([failed, lines], [1, ["denext: not here"]]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "runFastlane spawns with exactly the invocation's environment and returns its exit code",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-spawn-" });
    try {
      const out = join(dir, "out.txt");
      const code = await runFastlane(["ios", "--verbose"], dir, {
        resolve: () =>
          Promise.resolve({
            command: "/bin/sh",
            args: [
              "-c",
              'printf "%s|%s|%s|%s" "$*" "$PWD" "$ONLY" "${GEM_HOME-unset}" > out.txt; exit 7',
              "sh",
            ],
            env: { ONLY: "1", PATH: "/usr/bin:/bin" },
            version: "2.999.0",
          }),
        log: quiet,
      });
      assertEquals(code, 7);
      const [args, cwd, only, gem] = (await Deno.readTextFile(out)).split("|");
      assertEquals(args, "ios --verbose");
      assertEquals(await Deno.realPath(cwd), await Deno.realPath(dir));
      assertEquals([only, gem], ["1", "unset"], "nothing else is inherited");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "denext fastlane: the CLI hands fastlane's arguments over verbatim, in --cwd",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-cli-" });
    try {
      const exe = join(dir, "fake-fastlane");
      await Deno.writeTextFile(exe, '#!/bin/sh\nprintf "%s\\n" "$*" "$PWD"\nexit 4\n');
      await Deno.chmod(exe, 0o755);
      const cli = new URL("../cli.ts", import.meta.url).pathname;
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", cli, "--cwd", dir, "fastlane", "--version", "--verbose", "env"],
        env: { DENEXT_FASTLANE: exe, DENEXT_DENO: "stock", NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 4);
      const [args, cwd] = new TextDecoder().decode(out.stdout).trim().split("\n");
      assertEquals(args, "--version --verbose env");
      assertEquals(await Deno.realPath(cwd), await Deno.realPath(dir));
      assertStringIncludes(
        new TextDecoder().decode(out.stderr),
        "not downloaded, pinned or verified",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** Two local sources: `/primary` and `/fallback`, each answering with its own handler. */
async function twoSources(
  primary: (req: Request) => Response,
  fallback: (req: Request) => Response,
) {
  const seen: string[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const path = new URL(req.url).pathname;
    seen.push(`${path} ${req.headers.get("authorization") ?? "-"}`);
    return path === "/primary" ? primary(req) : fallback(req);
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  const dir = await Deno.makeTempDir({ prefix: "denext-fallback-" });
  return {
    seen,
    dest: join(dir, "file"),
    artifact: (sha256: string, size: number) => ({
      file: "ruby.tar.gz",
      url: `${base}/primary`,
      sha256,
      size,
      format: "tar.gz" as const,
      fallbacks: [{ url: `${base}/fallback`, headers: { Authorization: "Bearer QQ==" } }],
    }),
    close: async () => {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("downloadPinned: the mirror first; on failure the fallback, checked against the same hash", async () => {
  const good = new TextEncoder().encode("the pinned bytes");
  const sha = await sha256Hex(good);
  const ok = () => new Response(good);
  const cases: [string, (req: Request) => Response][] = [
    ["an HTTP error", () => new Response("gone", { status: 404 })],
    ["a tampered copy", () => new Response(new TextEncoder().encode("the pinned byteZ"))],
    ["a truncated copy", () => new Response(good.subarray(0, 4))],
  ];
  for (const [label, primary] of cases) {
    const t = await twoSources(primary, ok);
    try {
      const lines: string[] = [];
      await downloadPinned(
        { artifact: t.artifact(sha, good.byteLength), what: "fastlane Ruby" },
        t.dest,
        fetch,
        (l) => lines.push(l),
      );
      assertEquals(await Deno.readTextFile(t.dest), "the pinned bytes", label);
      // The mirror is asked without the registry's token; the fallback with it.
      assertEquals(t.seen, ["/primary -", "/fallback Bearer QQ=="], label);
      assertEquals(lines.length, 1, label);
      assertStringIncludes(lines[0], "trying 127.0.0.1", label);
    } finally {
      await t.close();
    }
  }
  // The mirror works: the fallback is never asked.
  const t = await twoSources(ok, () => {
    throw new Error("must not be asked");
  });
  try {
    await downloadPinned(
      { artifact: t.artifact(sha, good.byteLength), what: "x" },
      t.dest,
      fetch,
      quiet,
    );
    assertEquals(t.seen, ["/primary -"]);
  } finally {
    await t.close();
  }
});

Deno.test("downloadPinned: every source failing — a hash refusal wins, else all the errors; nothing left", async () => {
  const good = new TextEncoder().encode("the pinned bytes");
  const sha = await sha256Hex(good);
  const tampered = () => new Response(new TextEncoder().encode("the pinned byteZ"));
  const down = () => new Response("no", { status: 503 });
  const a = await twoSources(down, tampered);
  try {
    const err = await assertRejects(
      () =>
        downloadPinned(
          { artifact: a.artifact(sha, good.byteLength), what: "fastlane Ruby" },
          a.dest,
          fetch,
          quiet,
        ),
      DenoToolchainHashError,
    );
    assertStringIncludes(err.message, "REFUSING denext's fastlane Ruby");
    assertEquals(await Deno.stat(a.dest).catch(() => null), null);
  } finally {
    await a.close();
  }
  const b = await twoSources(down, down);
  try {
    const err = await assertRejects(
      () =>
        downloadPinned(
          { artifact: b.artifact(sha, good.byteLength), what: "fastlane Ruby" },
          b.dest,
          fetch,
          quiet,
        ),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "/primary → 503");
    assertStringIncludes(err.message, "also tried http://127.0.0.1");
    assertStringIncludes(err.message, "/fallback → 503");
    assertEquals(await Deno.stat(b.dest).catch(() => null), null);
  } finally {
    await b.close();
  }
});

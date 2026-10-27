// src/build/linux-libc.ts: denext's Linux binaries (the toolchain, the Deno Desktop runtime) need
// glibc 2.35 or later and do not run on musl. The host is probed before either is downloaded, and
// an unsupported one stops with the supported distributions named; `denext doctor` reports it.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  assertLinuxLibc,
  DEFAULT_MIN_GLIBC,
  type LibcCommandRunner,
  linuxLibcProblem,
  minGlibcFor,
  probeLinuxLibc,
} from "../src/build/linux-libc.ts";
import { ensureDenoToolchain } from "../src/build/deno-toolchain.ts";
import { ensureDesktopRuntime } from "../src/build/desktop-runtime.ts";
import { linuxLibcCheck } from "../src/cli/commands/doctor.ts";

/** A runner answering each command from a table (`null`: the command is missing). */
function runner(
  answers: Record<string, { success: boolean; output: string } | null>,
): LibcCommandRunner {
  return (cmd) => Promise.resolve(answers[cmd] ?? null);
}

const none = () => Promise.resolve([] as string[]);

Deno.test("probeLinuxLibc: getconf's glibc version", async () => {
  const libc = await probeLinuxLibc({
    run: runner({ getconf: { success: true, output: "glibc 2.35\n" } }),
    list: none,
  });
  assertEquals(libc, { kind: "glibc", version: "2.35" });
});

Deno.test("probeLinuxLibc: ldd names musl, or glibc's version, when getconf can't answer", async () => {
  const musl = await probeLinuxLibc({
    run: runner({
      getconf: { success: false, output: "getconf: GNU_LIBC_VERSION: unknown variable" },
      ldd: { success: false, output: "musl libc (x86_64)\nVersion 1.2.5\n" },
    }),
    list: none,
  });
  assertEquals(musl, { kind: "musl" });
  const old = await probeLinuxLibc({
    run: runner({ ldd: { success: true, output: "ldd (Ubuntu GLIBC 2.31-0ubuntu9.16) 2.31\n" } }),
    list: none,
  });
  assertEquals(old, { kind: "glibc", version: "2.31" });
});

Deno.test("probeLinuxLibc: musl's loader in /lib, else unknown", async () => {
  const loader = await probeLinuxLibc({
    run: runner({}),
    list: () => Promise.resolve(["ld-musl-aarch64.so.1", "libc.musl-aarch64.so.1"]),
  });
  assertEquals(loader, { kind: "musl" });
  assertEquals(await probeLinuxLibc({ run: runner({}), list: none }), { kind: "unknown" });
});

Deno.test("linuxLibcProblem / minGlibcFor: musl and an older glibc fail; unknown passes", () => {
  assertEquals(DEFAULT_MIN_GLIBC, "2.35");
  assertEquals(minGlibcFor({}), "2.35");
  assertEquals(minGlibcFor({ minGlibc: "2.28" }), "2.28");
  assertEquals(minGlibcFor({ minGlibc: "nope" }), "2.35");
  assertStringIncludes(linuxLibcProblem({ kind: "musl" }, "2.35")!, "musl");
  assertStringIncludes(
    linuxLibcProblem({ kind: "glibc", version: "2.34" }, "2.35")!,
    "glibc 2.34",
  );
  assertEquals(linuxLibcProblem({ kind: "glibc", version: "2.35" }, "2.35"), null);
  assertEquals(linuxLibcProblem({ kind: "glibc", version: "2.40" }, "2.35"), null);
  assertEquals(linuxLibcProblem({ kind: "glibc", version: "3.0" }, "2.35"), null);
  assertEquals(linuxLibcProblem({ kind: "unknown" }, "2.35"), null);
});

Deno.test("assertLinuxLibc: names the distributions; a no-op off Linux", async () => {
  const err = await assertRejects(
    () => assertLinuxLibc("the thing", "2.35", { os: "linux", libc: { kind: "musl" } }),
    Error,
  );
  assertStringIncludes(err.message, "denext: can't install the thing");
  assertStringIncludes(err.message, "Ubuntu 22.04");
  assertStringIncludes(err.message, "Alpine");
  await assertLinuxLibc("the thing", "2.35", { os: "darwin", libc: { kind: "musl" } });
});

/** A fetch that fails the test if anything is downloaded. */
function noDownload(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: () => {
      calls++;
      return Promise.reject(new Error("downloaded"));
    },
    calls: () => calls,
  };
}

Deno.test("ensureDenoToolchain stops on musl before downloading the Linux toolchain", async () => {
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-libc-toolchain-" });
  const net = noDownload();
  try {
    const err = await assertRejects(
      () =>
        ensureDenoToolchain({
          target: "linux-x86_64",
          os: "linux",
          cacheRoot,
          fetch: net.fetch,
          log: () => {},
          host: { os: "linux", libc: { kind: "musl" } },
        }),
      Error,
    );
    assertStringIncludes(err.message, "musl");
    assertEquals(net.calls(), 0);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

Deno.test("ensureDesktopRuntime stops on an older glibc before downloading the Linux runtime", async () => {
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-libc-runtime-" });
  const net = noDownload();
  try {
    const err = await assertRejects(
      () =>
        ensureDesktopRuntime({
          target: "x86_64-unknown-linux-gnu",
          backend: "webview",
          cacheRoot,
          fetch: net.fetch,
          log: () => {},
          host: { os: "linux", libc: { kind: "glibc", version: "2.34" } },
        }),
      Error,
    );
    assertStringIncludes(err.message, "glibc 2.34");
    assertEquals(net.calls(), 0);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

Deno.test("denext doctor: the linux libc check (Linux only)", async () => {
  assertEquals(await linuxLibcCheck({ os: "darwin" }), null);
  const ok = await linuxLibcCheck({ os: "linux", libc: { kind: "glibc", version: "2.39" } });
  assert(ok?.ok, ok?.detail);
  assertStringIncludes(ok!.detail, "glibc 2.39");
  const bad = await linuxLibcCheck({ os: "linux", libc: { kind: "musl" } });
  assertEquals([bad?.name, bad?.ok, bad?.critical], ["linux libc", false, false]);
  assertStringIncludes(bad!.detail, "Debian 12+");
});

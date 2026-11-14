// tests/helpers/heap-flags.ts: a child that must hit a small heap limit drops the heap sizes
// DENO_V8_FLAGS would hand it, and keeps the rest. And src/build/heap-flags.ts, since a heap size in
// V8's flags raises denext's heap caps to its own: finding the flags in `DENO_V8_FLAGS` and a
// `deno run` command line's `--v8-flags`, and the startup warning `denext start` (cap in force)
// and `denext dev` (production only) print.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { withoutHeapSize } from "./helpers/heap-flags.ts";
import {
  findHeapFlags,
  heapFlagWarning,
  heapSizeFlags,
  memoryCap,
} from "../src/build/heap-flags.ts";
import { heapFlagNotice, parseRunCommandLine } from "../src/cli/self-exec.ts";

Deno.test("withoutHeapSize: the heap sizes go, other flags and variables stay", () => {
  // The Windows test pass's own value: nothing left, so the variable goes (an empty one is a flag
  // V8 refuses).
  assertEquals(withoutHeapSize({ DENO_V8_FLAGS: "--max-old-space-size=6144", A: "1" }), { A: "1" });
  assertEquals(
    withoutHeapSize({
      DENO_V8_FLAGS: "--stack-size=2000, --max_old_space_size=8192,--max-heap-size=64,--expose-gc",
    }),
    { DENO_V8_FLAGS: "--stack-size=2000,--expose-gc" },
  );
  // A look-alike flag is not a heap size; no variable, nothing to do.
  assertEquals(withoutHeapSize({ DENO_V8_FLAGS: "--max-old-space-size-x=1" }), {
    DENO_V8_FLAGS: "--max-old-space-size-x=1",
  });
  assertEquals(withoutHeapSize({ PATH: "/bin" }), { PATH: "/bin" });
  // The input is left as it was.
  const env = { DENO_V8_FLAGS: "--max-old-space-size=1" };
  withoutHeapSize(env);
  assertEquals(env, { DENO_V8_FLAGS: "--max-old-space-size=1" });
});

Deno.test("heapSizeFlags: both spellings, comma- or space-separated, other flags left out", () => {
  assertEquals(
    heapSizeFlags("--stack-size=900, --max_old_space_size=4096 --max-heap-size=512"),
    ["--max_old_space_size=4096", "--max-heap-size=512"],
  );
  assertEquals(heapSizeFlags(["--max-old-space-size=64,--expose-gc"]), ["--max-old-space-size=64"]);
  assertEquals(heapSizeFlags("--max-semi-space-size=64 --max-old-space"), []);
  assertEquals(heapSizeFlags(undefined), []);
});

Deno.test("parseRunCommandLine: --v8-flags=<list> and --v8-flags <list>, before the script only", () => {
  const line = parseRunCommandLine([
    "deno",
    "run",
    "--v8-flags=--max-old-space-size=4096,--expose-gc",
    "--v8-flags",
    "--max-heap-size=512",
    "-A",
    "cli.ts",
    "--v8-flags=--max-heap-size=1",
  ]);
  assertEquals(line.v8Flags, ["--max-old-space-size=4096,--expose-gc", "--max-heap-size=512"]);
  assertEquals(line.script, "cli.ts");
  assertEquals(parseRunCommandLine(["deno", "run", "cli.ts"]).v8Flags, []);
});

Deno.test("findHeapFlags: DENO_V8_FLAGS first, then --v8-flags, each named", () => {
  assertEquals(findHeapFlags("--max-old-space-size=4096", ["--max-heap-size=512"]), [
    { flag: "--max-old-space-size=4096", source: "DENO_V8_FLAGS" },
    { flag: "--max-heap-size=512", source: "--v8-flags" },
  ]);
  assertEquals(findHeapFlags(undefined), []);
});

Deno.test("heapFlagWarning: names the flag, the cap and the fix; nothing without either", () => {
  const found = findHeapFlags("--max-old-space-size=4096");
  const caps = memoryCap(["--max-memory=384m", "--max-time=60"]);
  assertEquals(caps, ["start.limits.memory (--max-memory=384m)"]);
  const now = heapFlagWarning(found, caps, "now") ?? "";
  assertStringIncludes(
    now,
    "--max-old-space-size=4096 (DENO_V8_FLAGS) overrides start.limits.memory (--max-memory=384m)",
  );
  assertStringIncludes(now, "Drop the flag and rely on the cap");
  assertStringIncludes(
    heapFlagWarning(found, caps, "production") ?? "",
    "will override in production",
  );
  const both = findHeapFlags("--max-heap-size=1", ["--max-old-space-size=2"]);
  assertStringIncludes(heapFlagWarning(both, caps, "now") ?? "", "(--v8-flags) override start");
  assertEquals(heapFlagWarning([], caps, "now"), null);
  assertEquals(heapFlagWarning(found, [], "now"), null);
  assertEquals(memoryCap(["--max-cpu-time=10"]), []);
});

Deno.test("heapFlagNotice: this process's env and own --v8-flags, read only with a cap", async () => {
  const caps = memoryCap(["--max-memory=256m"]);
  let reads = 0;
  const argv = (...words: string[]) => () => {
    reads++;
    return Promise.resolve(["deno", "run", ...words, "cli.ts", "start"]);
  };
  const env = (value?: string) => (name: string) => name === "DENO_V8_FLAGS" ? value : undefined;
  const fromEnv = await heapFlagNotice(caps, "now", argv(), env("--max-heap-size=900"));
  assertStringIncludes(fromEnv ?? "", "--max-heap-size=900 (DENO_V8_FLAGS) overrides");
  const fromArgv = await heapFlagNotice(
    caps,
    "production",
    argv("--v8-flags=--max_old_space_size=8192"),
    env(),
  );
  assertStringIncludes(fromArgv ?? "", "--max_old_space_size=8192 (--v8-flags) will override");
  assertEquals(await heapFlagNotice(caps, "now", argv("-A"), env("--expose-gc")), null);
  assertEquals(await heapFlagNotice(caps, "now", () => Promise.resolve(null), env()), null);
  reads = 0;
  assertEquals(await heapFlagNotice([], "now", argv(), env("--max-heap-size=900")), null);
  assertEquals(reads, 0); // no cap: the command line is never read
});

// The per-file coverage floor (scripts/coverage-floor.ts) that `deno task test:coverage` runs
// after the aggregate threshold: lcov parsing, which files are floored, and the verdicts — a file
// under the floor on any metric, or one no test ever loaded, fails the gate.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  canonicalPath,
  checkFloor,
  FLOORED_FULL,
  flooredFiles,
  main,
  parseLcov,
  pct,
} from "../scripts/coverage-floor.ts";

/** The fixture project root, absolute on this OS (`D:\\p` on Windows). */
const ROOT = resolve("/p");
/** An lcov `SF:` path as \`deno coverage\` writes it: absolute, with this OS's separators. */
const sf = (rel: string) => resolve(ROOT, rel);

const LCOV = `TN:
SF:${sf("src/desktop/a.ts")}
FN:1,f
FN:5,g
FNDA:3,f
FNDA:0,g
FNF:2
FNH:1
BRDA:2,0,0,1
BRDA:2,0,1,0
BRDA:3,1,0,-
DA:1,3
DA:2,3
DA:3,0
DA:5,0
end_of_record
SF:${sf("src/desktop/caps/b.ts")}
DA:1,1
end_of_record
`;

Deno.test("parseLcov: counts lines, branches (`-` = not taken) and functions per file", () => {
  const m = parseLcov(LCOV.replaceAll("\n", "\r\n"));
  assertEquals(m.get(sf("src/desktop/a.ts")), {
    lines: [2, 4],
    branches: [1, 3],
    functions: [1, 2],
  });
  assertEquals(m.get(sf("src/desktop/caps/b.ts")), {
    lines: [1, 1],
    branches: [0, 0],
    functions: [0, 0],
  });
  // Lines outside a record are ignored.
  assertEquals(parseLcov("DA:1,1\nend_of_record\n").size, 0);
});

Deno.test("pct: a metric with nothing to cover is 100%", () => {
  assertEquals(pct([0, 0]), 100);
  assertEquals(pct([1, 4]), 25);
});

Deno.test("checkFloor: each metric is held to the floor; an unloaded file fails", () => {
  const lcov = parseLcov(LCOV);
  const files = ["src/desktop/a.ts", "src/desktop/caps/b.ts", "src/desktop/never.ts"];
  const results = checkFloor(files, lcov, ROOT, 85);
  assertEquals(results.map((r) => [r.file, r.failures]), [
    ["src/desktop/a.ts", ["lines 50.0%", "branches 33.3%", "functions 50.0%"]],
    ["src/desktop/caps/b.ts", []],
    ["src/desktop/never.ts", ["never loaded by a test"]],
  ]);
  assertEquals(checkFloor(["src/desktop/a.ts"], lcov, ROOT, 30)[0].failures, []);
});

Deno.test("flooredFiles: src/desktop recursively, plus the named desktop files elsewhere", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const f of [
        "src/desktop/a.ts",
        "src/desktop/caps/b.ts",
        "src/desktop/notes.md",
        "src/build/desktop.ts",
        "src/build/desktop-runtime.ts",
        "src/build/desktop-runtime-pin.json",
        "src/build/export.ts",
        "src/build/nested/desktop-x.ts",
        "src/build/app-update.ts",
        "src/build/safe-extract.ts",
        "src/build/file-lock.ts",
        "src/build/project-locks.ts",
        "src/build/app-update-extra.ts",
        "src/cli/commands/desktop.ts",
        "src/cli/commands/desktop-add.ts",
        "src/cli/commands/dev.ts",
        "src/mobile/desktop-queue.ts",
        "src/mobile/open-file.ts",
        "src/mobile/notification-trigger.ts",
        "src/mobile/haptics.ts",
        "src/react-native/desktop.ts",
        "src/react-native/web.ts",
      ]
    ) {
      await Deno.mkdir(join(root, f, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, f), "");
    }
    assertEquals(await flooredFiles(root), [
      "src/build/app-update.ts",
      "src/build/desktop-runtime.ts",
      "src/build/desktop.ts",
      "src/build/file-lock.ts",
      "src/build/project-locks.ts",
      "src/build/safe-extract.ts",
      "src/cli/commands/desktop-add.ts",
      "src/cli/commands/desktop.ts",
      "src/desktop/a.ts",
      "src/desktop/caps/b.ts",
      "src/mobile/desktop-queue.ts",
      "src/mobile/notification-trigger.ts",
      "src/mobile/open-file.ts",
      "src/react-native/desktop.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main: exit 1 naming the files under the floor, 0 when all pass, --report always 0", async () => {
  const root = await Deno.makeTempDir();
  const errs: string[] = [];
  const logs: string[] = [];
  const prev = [console.error, console.log] as const;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    await Deno.mkdir(join(root, "src/desktop"), { recursive: true });
    await Deno.mkdir(join(root, "src/build"), { recursive: true });
    await Deno.writeTextFile(join(root, "src/desktop/a.ts"), "");
    const file = join(root, "lcov.info");
    const abs = resolve(root, "src/desktop/a.ts");
    await Deno.writeTextFile(file, `SF:${abs}\nDA:1,1\nDA:2,0\nend_of_record\n`);
    assertEquals(await main([file], root), 1);
    assertStringIncludes(errs.join("\n"), "1 file(s) below 85%");
    assertStringIncludes(errs.join("\n"), "src/desktop/a.ts   <- lines 50.0%");
    assertEquals(await main([file, "--floor", "50"], root), 0);
    assertStringIncludes(logs.join("\n"), "1 files at or above 50% each");
    assertEquals(await main([file, "--report"], root), 0);
    assertStringIncludes(logs.join("\n"), "  50.0  100.0  100.0  src/desktop/a.ts");
    assertEquals(await main([], root), 2);
    assertStringIncludes(errs.join("\n"), "usage: coverage-floor.ts");
  } finally {
    [console.error, console.log] = prev;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("flooredFiles --full: the whole-suite floor adds the 4.x files raised past 50% lines", async () => {
  assertEquals(FLOORED_FULL.map((f) => f.dir), ["src/cli", "packages/tanstack-start/src"]);
  const root = await Deno.makeTempDir();
  try {
    for (
      const f of [
        "src/desktop/a.ts",
        "src/cli/cli-cache.ts",
        "src/cli/run-verb.ts",
        "packages/tanstack-start/src/use-server.ts",
        "packages/tanstack-start/src/toolchain.ts",
      ]
    ) {
      await Deno.mkdir(join(root, f, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, f), "");
    }
    // The desktop run (coverage:desktop) loads only the desktop suites: it keeps its own set.
    assertEquals(await flooredFiles(root), ["src/desktop/a.ts"]);
    assertEquals(await flooredFiles(root, true), [
      "packages/tanstack-start/src/use-server.ts",
      "src/cli/cli-cache.ts",
      "src/desktop/a.ts",
    ]);
    // `--full` holds them to the floor: one no test loaded fails the run.
    const file = join(root, "lcov.info");
    const abs = (f: string) => resolve(root, f);
    await Deno.writeTextFile(
      file,
      ["src/desktop/a.ts", "src/cli/cli-cache.ts"].map((f) =>
        `SF:${abs(f)}\nDA:1,1\nend_of_record\n`
      )
        .join(""),
    );
    const errs: string[] = [];
    const prev = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      assertEquals(await main([file], root), 0);
      assertEquals(await main([file, "--full"], root), 1);
    } finally {
      console.error = prev;
    }
    assertStringIncludes(errs.join("\n"), "packages/tanstack-start/src/use-server.ts");
    assertStringIncludes(errs.join("\n"), "never loaded by a test");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("canonicalPath: symlinks resolved; a missing tail kept on its deepest existing ancestor", () => {
  // `/var` → `/private/var`, as on macOS; nothing else resolves past the root.
  const links: Record<string, string> = { "/": "/", "/var": "/private/var" };
  const realPath = (p: string) => {
    for (const [from, to] of Object.entries(links)) {
      if (p === from) return to;
      if (from !== "/" && p.startsWith(`${from}/`)) {
        if (p === "/var/t/repo" || p === "/var/t") return `${to}${p.slice(from.length)}`;
      }
    }
    throw new Deno.errors.NotFound(p);
  };
  assertEquals(canonicalPath("/var/t/repo", realPath), "/private/var/t/repo");
  // The file is gone (or never existed here): its existing ancestor is resolved.
  assertEquals(canonicalPath("/var/t/repo/src/a.ts", realPath), "/private/var/t/repo/src/a.ts");
  // A path with nothing resolvable but the root comes back as written.
  assertEquals(canonicalPath("/home/runner/src/a.ts", realPath), "/home/runner/src/a.ts");
});

Deno.test("parseLcov: records of one file under two spellings merge, a point covered once", () => {
  const lcov = `SF:/var/r/src/desktop/a.ts
FNDA:1,f
FNDA:0,g
DA:1,1
DA:2,0
BRDA:2,0,0,1
BRDA:2,0,1,0
end_of_record
SF:/private/var/r/src/desktop/a.ts
FNDA:0,f
FNDA:2,g
DA:1,0
DA:2,4
BRDA:2,0,0,0
BRDA:2,0,1,-
end_of_record
`;
  const canonical = (p: string) => p.replace(/^\/var\//, "/private/var/");
  assertEquals([...parseLcov(lcov, canonical)], [[
    "/private/var/r/src/desktop/a.ts",
    { lines: [2, 2], branches: [1, 2], functions: [2, 2] },
  ]]);
  // Without a canonical form the two spellings stay two files.
  assertEquals(parseLcov(lcov).size, 2);
});

Deno.test({
  name: "main: a root reached through a symlink and a report mixing both spellings agree",
  // Creating a symlink on Windows needs a privilege CI's account may not hold.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const parent = await Deno.realPath(await Deno.makeTempDir());
    const real = join(parent, "the-real-checkout");
    const link = join(parent, "l");
    const errs: string[] = [];
    const prev = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      await Deno.mkdir(join(real, "src/desktop"), { recursive: true });
      await Deno.writeTextFile(join(real, "src/desktop/a.ts"), "");
      await Deno.writeTextFile(join(real, "src/desktop/b.ts"), "");
      await Deno.symlink(real, link);
      const file = join(parent, "lcov.info");
      await Deno.writeTextFile(
        file,
        `SF:${join(link, "src/desktop/a.ts")}\nDA:1,1\nDA:2,0\nend_of_record\n` +
          `SF:${join(real, "src/desktop/a.ts")}\nDA:1,0\nDA:2,1\nend_of_record\n` +
          `SF:${join(real, "src/desktop/b.ts")}\nDA:1,1\nend_of_record\n`,
      );
      // Read from the link: b.ts is found under the real spelling, a.ts's two records merge.
      assertEquals(await main([file], link), 0, errs.join("\n"));
    } finally {
      console.error = prev;
      await Deno.remove(parent, { recursive: true });
    }
  },
});

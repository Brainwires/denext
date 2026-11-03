// The stock-Deno deprecation notice (src/build/stock-deprecation.ts): what it says, once per
// process tree, the opt-out, and the paths that call it (the CLI gate's in tests/cli-toolchain,
// the desktop runtime's in tests/desktop-pinned-runtime).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  NO_DEPRECATION_WARNINGS_ENV,
  STOCK_DEPRECATION_SHOWN_ENV,
  type StockDenoPath,
  stockDeprecationNotice,
  warnIfStockDeno,
  warnStockDeprecation,
} from "../src/build/stock-deprecation.ts";
import { resolveDenoToolchain } from "../src/build/deno-toolchain.ts";
import { forwardedDeno } from "../src/cli/deno-path.ts";
import { stockPathOf } from "../src/cli/self-exec.ts";
import { noteStockEsbuild } from "../src/build/esbuild/binary.ts";

const MODULE = new URL("../src/build/stock-deprecation.ts", import.meta.url);

/** A recording environment: its variables, what was set, and what was printed. */
function world(vars: Record<string, string> = {}) {
  const warned: string[] = [];
  return {
    vars,
    warned,
    deps: {
      env: (k: string) => vars[k],
      setEnv: (k: string, v: string) => void (vars[k] = v),
      warn: (m: string) => void warned.push(m),
    },
  };
}

Deno.test("the notice names the cause, 5.0, the fix and the opt-out, on every stock path", () => {
  const paths: Record<StockDenoPath, [string, string]> = {
    "deno-env": ["DENEXT_DENO=stock", "unset DENEXT_DENO"],
    "deno-path": ["DENEXT_DENO points at a stock Deno binary", "unset DENEXT_DENO, or point it"],
    "desktop-env": ["DENEXT_DESKTOP_RUNTIME=stock", "unset DENEXT_DESKTOP_RUNTIME"],
    "desktop-mismatch": ["stock Deno Desktop runtime", "`denext toolchain install`"],
    "esbuild": ["npm esbuild", "`denext toolchain install`"],
    "stock-process": ["plain `deno task`", "run it with `denext task <name>`"],
  };
  for (const [path, [cause, fix]] of Object.entries(paths) as [StockDenoPath, string[]][]) {
    const text = stockDeprecationNotice(path);
    assert(text.startsWith("denext: deprecated: "), text);
    assertStringIncludes(text, cause);
    assertStringIncludes(text, "denext 5.0 drops stock Deno support.");
    assertStringIncludes(text, `Fix: ${fix}`);
    assertStringIncludes(text, `${NO_DEPRECATION_WARNINGS_ENV}=1 hides this notice.`);
  }
});

Deno.test("warnStockDeprecation: once per process tree, through the inherited marker", () => {
  const parent = world();
  assert(warnStockDeprecation("deno-env", parent.deps));
  assertEquals(parent.vars[STOCK_DEPRECATION_SHOWN_ENV], "1");
  // A second stock path in the same command: still the one notice.
  assertEquals(warnStockDeprecation("esbuild", parent.deps), false);
  assertEquals(parent.warned, [stockDeprecationNotice("deno-env")]);
  // A child inherits the environment: it stays quiet.
  const child = world({ ...parent.vars });
  assertEquals(warnStockDeprecation("stock-process", child.deps), false);
  assertEquals(child.warned, []);
});

Deno.test("warnStockDeprecation: DENEXT_NO_DEPRECATION_WARNINGS hides it; 0 / false / empty do not", () => {
  for (const value of ["1", "true", "TRUE", " 1 "]) {
    const w = world({ [NO_DEPRECATION_WARNINGS_ENV]: value });
    assertEquals(warnStockDeprecation("deno-env", w.deps), false, value);
    assertEquals([w.warned, w.vars[STOCK_DEPRECATION_SHOWN_ENV]], [[], undefined]);
  }
  for (const value of ["0", "false", ""]) {
    const w = world({ [NO_DEPRECATION_WARNINGS_ENV]: value });
    assert(warnStockDeprecation("deno-env", w.deps), value);
  }
});

Deno.test("warnStockDeprecation: an injected env without setEnv marks nothing", () => {
  const vars: Record<string, string> = {};
  const warned: string[] = [];
  const deps = { env: (k: string) => vars[k], warn: (m: string) => void warned.push(m) };
  assert(warnStockDeprecation("desktop-env", deps));
  assert(warnStockDeprecation("desktop-env", deps));
  assertEquals([warned.length, vars], [2, {}]);
});

Deno.test("warnIfStockDeno: silent on denext's Deno, the notice on stock Deno", () => {
  const onToolchain = world();
  assertEquals(
    warnIfStockDeno({ deno: "3.0.0-rc.5", denext: "3.0.0-rc.5" }, onToolchain.deps),
    false,
  );
  // An old-scheme toolchain build (before the identity marker) is denext's Deno too.
  assertEquals(warnIfStockDeno({ deno: "2.9.7-denext.15" }, onToolchain.deps), false);
  assertEquals(onToolchain.warned, []);
  const stock = world();
  assert(warnIfStockDeno({ deno: "2.9.8" }, stock.deps));
  assertEquals(stock.warned, [stockDeprecationNotice("stock-process")]);
});

Deno.test("noteStockEsbuild: only the npm esbuild (the stock fallback) is deprecated", () => {
  for (const source of ["toolchain", "env"] as const) {
    const w = world();
    assertEquals(noteStockEsbuild({ source }, w.deps), false, source);
    assertEquals(w.warned, []);
  }
  const npm = world();
  assert(noteStockEsbuild({ source: "npm" }, npm.deps));
  assertEquals(npm.warned, [stockDeprecationNotice("esbuild")]);
});

/** Run `script` in a `deno eval` child with the notice's variables cleared (plus `env`). */
async function evalChild(script: string, env: Record<string, string> = {}) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-config", script],
    env: { [STOCK_DEPRECATION_SHOWN_ENV]: "", [NO_DEPRECATION_WARNINGS_ENV]: "", ...env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return { code: out.code, stdout: d.decode(out.stdout), stderr: d.decode(out.stderr) };
}

const NOTICE = "denext 5.0 drops stock Deno support";

Deno.test("a real process tree: one notice for the parent's paths and its child's", async () => {
  // The parent hits three stock paths, then starts a child that hits another: one notice in all.
  const script = `
import { warnStockDeprecation } from ${JSON.stringify(MODULE.href)};
warnStockDeprecation("deno-env");
warnStockDeprecation("esbuild");
warnStockDeprecation("desktop-env");
const child = await new Deno.Command(Deno.execPath(), {
  args: ["eval", "--no-config", ${
    JSON.stringify(
      `import { warnStockDeprecation } from ${
        JSON.stringify(MODULE.href)
      }; console.log(warnStockDeprecation("stock-process"));`,
    )
  }],
  stdin: "null",
  stdout: "piped",
  stderr: "inherit",
}).output();
console.log("child printed it:", new TextDecoder().decode(child.stdout).trim());
`;
  const run = await evalChild(script);
  assertEquals(run.code, 0, run.stderr);
  assertEquals(run.stderr.split(NOTICE).length, 2, run.stderr);
  assertStringIncludes(run.stderr, "DENEXT_DENO=stock");
  assertStringIncludes(run.stdout, "child printed it: false");
  // The opt-out quiets the whole tree.
  const hushed = await evalChild(script, { [NO_DEPRECATION_WARNINGS_ENV]: "1" });
  assertEquals(hushed.code, 0, hushed.stderr);
  assert(!hushed.stderr.includes(NOTICE), hushed.stderr);
});

/** A stand-in `deno` file (never run: the `versionOutput` seam answers for it). */
async function fakeDeno(run: (bin: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "denext-stock-path-" });
  try {
    const bin = `${dir}/deno`;
    await Deno.writeTextFile(bin, "#!/bin/sh\n");
    await run(bin);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const STOCK_VERSION =
  "deno 2.9.8 (stable, release, x86_64-apple-darwin)\nv8 14.0\ntypescript 5.9\n";
const DENEXT_VERSION = "deno 3.0.0-denext.2 (stable, release, x86_64-apple-darwin)\n" +
  "denext 3.0.0-denext.2 (Brainwires)\nv8 14.0\n";

Deno.test("DENEXT_DENO=<path>: a stock binary is flagged by the identity marker, denext's is not", async () => {
  await fakeDeno(async (bin) => {
    const resolve = (output: string | null) =>
      resolveDenoToolchain({
        env: (k) => k === "DENEXT_DENO" ? bin : undefined,
        versionOutput: () => Promise.resolve(output),
      });
    const stock = await resolve(STOCK_VERSION);
    assert(stock.kind === "toolchain" && stock.stock === true, JSON.stringify(stock));
    assertEquals(stockPathOf(stock), "deno-path");
    // Stock Deno of the number denext's own Deno has (3.0.0): the marker decides, not the number.
    const upstream3 = await resolve("deno 3.0.0 (stable, release, x86_64-apple-darwin)\n");
    assert(upstream3.kind === "toolchain" && upstream3.stock === true);
    // denext's Deno: no flag, no notice.
    const own = await resolve(DENEXT_VERSION);
    assert(own.kind === "toolchain" && own.stock === undefined, JSON.stringify(own));
    assertEquals(stockPathOf(own), null);
    // A binary that can't be asked: unknown, so quiet.
    const unknown = await resolve(null);
    assert(unknown.kind === "toolchain" && unknown.stock === undefined);
    assertEquals(stockPathOf(unknown), null);
  });
});

Deno.test({
  name: "forwardedDeno: DENEXT_DENO=<path> at a stock Deno says so once; the opt-out hides it",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await fakeDeno(async (bin) => {
      const saved = new Map(
        ["DENEXT_DENO", STOCK_DEPRECATION_SHOWN_ENV, NO_DEPRECATION_WARNINGS_ENV].map((
          k,
        ) => [k, Deno.env.get(k)]),
      );
      const consoleError = console.error;
      const printed: string[] = [];
      console.error = (m: unknown) => void printed.push(String(m));
      try {
        // A stand-in that answers `--version` like stock Deno.
        await Deno.writeTextFile(bin, `#!/bin/sh\nprintf '%s' '${STOCK_VERSION}'\n`);
        await Deno.chmod(bin, 0o755);
        Deno.env.set("DENEXT_DENO", bin);
        Deno.env.delete(STOCK_DEPRECATION_SHOWN_ENV);
        Deno.env.delete(NO_DEPRECATION_WARNINGS_ENV);
        await forwardedDeno();
        await forwardedDeno(); // the second sees the marker: still one notice
        const notices = printed.filter((m) => m.includes(NOTICE));
        assertEquals(notices.length, 1, printed.join("\n"));
        assertStringIncludes(notices[0], "DENEXT_DENO points at a stock Deno binary");
        // The opt-out.
        printed.length = 0;
        Deno.env.delete(STOCK_DEPRECATION_SHOWN_ENV);
        Deno.env.set(NO_DEPRECATION_WARNINGS_ENV, "1");
        await forwardedDeno();
        assertEquals(printed.filter((m) => m.includes(NOTICE)), []);
        // denext's own Deno at that path: no notice.
        Deno.env.delete(NO_DEPRECATION_WARNINGS_ENV);
        Deno.env.delete(STOCK_DEPRECATION_SHOWN_ENV);
        await Deno.writeTextFile(bin, `#!/bin/sh\nprintf '%s' '${DENEXT_VERSION}'\n`);
        await forwardedDeno();
        assertEquals(printed.filter((m) => m.includes(NOTICE)), []);
      } finally {
        console.error = consoleError;
        for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      }
    });
  },
});

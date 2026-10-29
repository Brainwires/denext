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

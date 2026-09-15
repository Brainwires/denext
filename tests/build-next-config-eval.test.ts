// The shared bounded `next.config.*` evaluator (`src/build/next-config-eval.ts`) that
// `denext migrate` and `denext ui`'s `/config/next` panel both drive with their own program.

import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  evalNextConfigProgram,
  LOAD_NEXT_CONFIG,
  type NextConfigEvalResult,
} from "../src/build/next-config-eval.ts";

const MARKER = "__TEST_NEXT_CONFIG__";

/** Build a program: the shared loader, then `body`, which prints the result. */
function program(body: string): string {
  return `${LOAD_NEXT_CONFIG}\n${body}\n`;
}

/** The plainest translation: echo the unwrapped config behind the marker, exit with `code`. */
function echo(code = 0): string {
  return program(
    `console.log(${JSON.stringify(MARKER)} + JSON.stringify(cfg));\nDeno.exit(${code});`,
  );
}

/** Run `fn` against a temp dir holding one config file (removed afterwards). */
async function withConfig(
  file: string,
  source: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext-next-eval-" });
  try {
    await Deno.writeTextFile(join(dir, file), source);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Evaluate `file` in `dir` with `prog` (default: {@link echo}). */
function evalIn(
  dir: string,
  file: string,
  prog = echo(),
  timeoutMs?: number,
): Promise<NextConfigEvalResult> {
  return evalNextConfigProgram({ dir, file, program: prog, marker: MARKER, timeoutMs });
}

/** The value of a successful evaluation (fails the test with the reason otherwise). */
function valueOf(result: NextConfigEvalResult): unknown {
  assert(result.ok, result.ok ? "" : `expected ok, got: ${result.reason}`);
  return result.value;
}

/** The reason of a failed evaluation (fails the test on success). */
function reasonOf(result: NextConfigEvalResult): string {
  assert(!result.ok, "expected the evaluation to fail");
  return result.reason;
}

/** A config that never finishes evaluating; it names its pid on stderr first. */
const HANGING = 'console.error("pid=" + Deno.pid);\nwhile (true) {}\nexport default {};\n';

Deno.test("evaluates an ESM next.config.mjs object export", async () => {
  await withConfig(
    "next.config.mjs",
    'export default { basePath: "/docs", trailingSlash: true };\n',
    async (dir) => {
      assertEquals(valueOf(await evalIn(dir, "next.config.mjs")), {
        basePath: "/docs",
        trailingSlash: true,
      });
    },
  );
});

Deno.test("evaluates a CommonJS next.config.cjs module.exports", async () => {
  await withConfig(
    "next.config.cjs",
    'module.exports = { basePath: "/cjs", images: { unoptimized: true } };\n',
    async (dir) => {
      assertEquals(valueOf(await evalIn(dir, "next.config.cjs")), {
        basePath: "/cjs",
        images: { unoptimized: true },
      });
    },
  );
});

Deno.test("unwraps a factory-function config (and accepts an absolute file path)", async () => {
  const src = 'export default async () => ({ assetPrefix: "/cdn", i18n: { locales: ["en"] } });\n';
  await withConfig("next.config.mjs", src, async (dir) => {
    assertEquals(valueOf(await evalIn(dir, join(dir, "next.config.mjs"))), {
      assetPrefix: "/cdn",
      i18n: { locales: ["en"] },
    });
  });
});

Deno.test("a program that never prints the marker is a failure with a reason", async () => {
  await withConfig("next.config.mjs", "export default {};\n", async (dir) => {
    const reason = reasonOf(await evalIn(dir, "next.config.mjs", program('console.log("nope");')));
    assertStringIncludes(reason, "no result line");
    assertStringIncludes(reason, "exit code 0");
  });
});

Deno.test("stdout noise before the marker line is ignored", async () => {
  const src = 'console.log("compiling next.config…");\nexport default { basePath: "/n" };\n';
  const prog = program(
    `console.log("warn: " + ${JSON.stringify(MARKER)});\n` +
      `console.log(${JSON.stringify(MARKER)} + JSON.stringify(cfg));\nDeno.exit(0);`,
  );
  await withConfig("next.config.mjs", src, async (dir) => {
    assertEquals(valueOf(await evalIn(dir, "next.config.mjs", prog)), { basePath: "/n" });
  });
});

Deno.test("a non-zero exit after the marker still yields the parsed value", async () => {
  await withConfig("next.config.mjs", "export default { trailingSlash: false };\n", async (dir) => {
    assertEquals(valueOf(await evalIn(dir, "next.config.mjs", echo(3))), { trailingSlash: false });
  });
});

Deno.test("a config that fails to load reports why, and an unparseable result is a failure", async () => {
  await withConfig(
    "next.config.mjs",
    'import "npm:definitely-not-installed-xyz";\n',
    async (dir) => {
      const reason = reasonOf(await evalIn(dir, "next.config.mjs"));
      assertMatch(reason, /no result line \(exit code [1-9]\d*\): ./);
    },
  );
  await withConfig("next.config.mjs", "export default {};\n", async (dir) => {
    const bad = program(`console.log(${JSON.stringify(MARKER)} + "{not json");\nDeno.exit(0);`);
    assertFalse((await evalIn(dir, "next.config.mjs", bad)).ok);
  });
});

Deno.test("a hanging config times out and the child is killed", async () => {
  await withConfig("next.config.mjs", HANGING, async (dir) => {
    const started = performance.now();
    const reason = reasonOf(await evalIn(dir, "next.config.mjs", echo(), 3_000));
    assertStringIncludes(reason, "timed out after 3000 ms");
    assert(performance.now() - started < 30_000, "the call returned long after the deadline");
    const pid = Number(/pid=(\d+)/.exec(reason)?.[1]);
    if (pid > 0 && Deno.build.os !== "windows") {
      let alive = true;
      try {
        Deno.kill(pid, "SIGCONT");
      } catch {
        alive = false;
      }
      assertFalse(alive, `evaluator child ${pid} outlived the call`);
    }
  });
});

Deno.test("the child can read its project but not write, reach the network, or read outside", async () => {
  const probe = `
const outcome = async (f) => { try { await f(); return "allowed"; } catch (e) { return e.name; } };
const wrote = await outcome(() => Deno.writeTextFile(new URL("./pwned.txt", import.meta.url), "x"));
const fetched = await outcome(() => fetch("http://127.0.0.1:9/"));
const readOutside = await outcome(() => Deno.readTextFile(${JSON.stringify(Deno.execPath())}));
const readInside = await outcome(() => Deno.readTextFile(new URL("./next.config.mjs", import.meta.url)));
export default { wrote, fetched, readOutside, readInside };
`;
  await withConfig("next.config.mjs", probe, async (dir) => {
    const value = valueOf(await evalIn(dir, "next.config.mjs")) as Record<string, string>;
    assertEquals(value.readInside, "allowed");
    for (const key of ["wrote", "fetched", "readOutside"]) {
      assert(value[key] !== "allowed", `${key} escaped the sandbox`);
    }
    assertFalse(await Deno.stat(join(dir, "pwned.txt")).then(() => true, () => false));
  });
  // An uncaught write attempt fails the evaluation outright — still without writing.
  const loud =
    'await Deno.writeTextFile(new URL("./pwned.txt", import.meta.url), "x");\nexport default {};\n';
  await withConfig("next.config.mjs", loud, async (dir) => {
    reasonOf(await evalIn(dir, "next.config.mjs"));
    assertFalse(await Deno.stat(join(dir, "pwned.txt")).then(() => true, () => false));
  });
});

Deno.test("DENEXT_NEXT_EVAL_TIMEOUT_MS sets the default deadline; an explicit timeoutMs wins", async () => {
  const prior = Deno.env.get("DENEXT_NEXT_EVAL_TIMEOUT_MS");
  try {
    await withConfig("next.config.mjs", HANGING, async (dir) => {
      Deno.env.set("DENEXT_NEXT_EVAL_TIMEOUT_MS", "400");
      assertStringIncludes(
        reasonOf(await evalIn(dir, "next.config.mjs")),
        "timed out after 400 ms",
      );
      Deno.env.set("DENEXT_NEXT_EVAL_TIMEOUT_MS", "600000");
      const explicit = reasonOf(await evalIn(dir, "next.config.mjs", echo(), 300));
      assertStringIncludes(explicit, "timed out after 300 ms");
    });
  } finally {
    if (prior === undefined) Deno.env.delete("DENEXT_NEXT_EVAL_TIMEOUT_MS");
    else Deno.env.set("DENEXT_NEXT_EVAL_TIMEOUT_MS", prior);
  }
});

Deno.test("a config that prints its own marker line can't forge the result (per-run nonce)", async () => {
  // The config runs before the caller's program and prints a line behind the caller's marker,
  // hoping to plant keys (or code) in what the caller writes. The real marker carries a
  // per-run nonce the config never sees, so only the program's own line is read.
  const forged = JSON.stringify({ planted: "(globalThis.PWNED = Deno.cwd())" });
  const src = `console.log(${JSON.stringify(MARKER)} + ${JSON.stringify(forged)});\n` +
    'export default { basePath: "/real" };\n';
  await withConfig("next.config.mjs", src, async (dir) => {
    assertEquals(valueOf(await evalIn(dir, "next.config.mjs")), { basePath: "/real" });
  });
});

Deno.test("evaluates a CommonJS next.config.js (module.exports, no package.json type)", async () => {
  const src = 'module.exports = { basePath: "/cjs-js", trailingSlash: true };\n';
  await withConfig("next.config.js", src, async (dir) => {
    assertEquals(valueOf(await evalIn(dir, "next.config.js")), {
      basePath: "/cjs-js",
      trailingSlash: true,
    });
  });
});

Deno.test("calls a function-form config the way Next.js does: (phase, { defaultConfig })", async () => {
  const src = "export default (phase, { defaultConfig }) => " +
    '({ basePath: typeof defaultConfig === "object" ? "/" + phase : "/missing" });\n';
  await withConfig("next.config.mjs", src, async (dir) => {
    assertEquals(valueOf(await evalIn(dir, "next.config.mjs")), {
      basePath: "/phase-production-build",
    });
  });
});

Deno.test("a config that imports a remote module is refused, not fetched (--no-remote)", async () => {
  // deno.land is on Deno's default import allow-list, so only --no-remote stops this fetch
  // (an arbitrary host is already refused by the import permission).
  const src = 'import x from "https://deno.land/std@0.224.0/fmt/colors.ts";\n' +
    "export default { basePath: String(x) };\n";
  await withConfig("next.config.mjs", src, async (dir) => {
    assertMatch(reasonOf(await evalIn(dir, "next.config.mjs")), /remote|no-remote/i);
  });
});

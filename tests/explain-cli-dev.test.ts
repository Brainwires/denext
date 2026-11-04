// Where explained diagnostics show up: `denext check` / `denext lint` (explained by default,
// `--raw` / DENEXT_RAW_DIAGNOSTICS=1 for Deno's output unchanged), driven through the real CLI
// with a `deno` stand-in that prints a captured diagnostic; and the dev server's terminal,
// overlay payload and 500 page.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { FIXTURE_APP_DIR } from "../scripts/capture-explain-fixtures.ts";
import {
  explainForOverlay,
  explainForTerminal,
  pushError,
} from "../src/build/dev-server/reload.ts";
import { devErrorPage } from "../src/build/dev-server/error-page.ts";
import { DevEventLog } from "../src/build/dev-events.ts";
import type { DevState } from "../src/build/dev-server/state.ts";
import { boundedOutput } from "./helpers/bounded-command.ts";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));
const ROOT = fromFileUrl(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "tests/fixtures/explain");
const posix = Deno.build.os !== "windows";

/** A project dir with the fixture's source, its captured output rewritten to that dir. */
async function project(fixture: string, file: string): Promise<{ dir: string; raw: string }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-explain-cli-" }));
  await Deno.writeTextFile(join(dir, file), Deno.readTextFileSync(join(FIXTURES, `${file}.txt`)));
  const raw = Deno.readTextFileSync(join(FIXTURES, `${fixture}.raw.txt`))
    .replaceAll(FIXTURE_APP_DIR, dir);
  return { dir, raw };
}

/** A `deno` stand-in: records its argv, prints `raw` to stderr and exits 1. */
async function fakeDeno(dir: string, raw: string): Promise<{ path: string; log: string }> {
  const out = join(dir, "diagnostics.txt");
  await Deno.writeTextFile(out, raw);
  const path = join(dir, "fake-deno");
  const log = join(dir, "argv.log");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\ncat '${out}' >&2\nexit 1\n`,
  );
  await Deno.chmod(path, 0o755);
  return { path, log };
}

/** Run the CLI from source in `cwd` with `env` added. */
async function cli(args: string[], cwd: string, env: Record<string, string>) {
  const coverage = Deno.env.get("DENEXT_CHILD_COVERAGE");
  const out = await boundedOutput(Deno.execPath(), {
    args: [
      "run",
      "-A",
      ...(coverage ? [`--coverage=${join(ROOT, coverage)}`] : []),
      "--config",
      join(ROOT, "deno.json"),
      CLI,
      ...args,
    ],
    cwd,
    env: { DENEXT_TOOLCHAIN_ACTIVE: "1", DENEXT_DENO: "stock", NO_COLOR: "1", ...env },
  });
  const d = new TextDecoder();
  return { code: out.code, stderr: d.decode(out.stderr) };
}

Deno.test({
  name: "denext check explains each type error; --raw and DENEXT_RAW_DIAGNOSTICS=1 don't",
  ignore: !posix,
  fn: async () => {
    const { dir, raw } = await project("possibly-undefined", "possibly-undefined.ts");
    try {
      const deno = await fakeDeno(dir, raw);
      const env = { DENO_BIN: deno.path };

      const explained = await cli(["check", "possibly-undefined.ts"], dir, env);
      assertEquals(explained.code, 1, explained.stderr);
      assertStringIncludes(explained.stderr, "TS18048: `user` may be `undefined`");
      assertStringIncludes(explained.stderr, "Fix: Narrow it first:");
      assertStringIncludes(explained.stderr, ">  9 |   return user.name;");
      // The original is kept, under the explanation.
      assertStringIncludes(explained.stderr, "Original (deno check):");
      assertStringIncludes(explained.stderr, "│ TS18048 [ERROR]: 'user' is possibly 'undefined'.");
      assertStringIncludes(explained.stderr, "error: Type checking failed.");

      const rawRun = await cli(["check", "--raw", "possibly-undefined.ts"], dir, env);
      assertEquals(rawRun.code, 1);
      assertStringIncludes(rawRun.stderr, raw.trim());
      assert(!rawRun.stderr.includes("Fix:"), rawRun.stderr);
      const argv = (await Deno.readTextFile(deno.log)).trim().split("\n");
      assertEquals(argv, ["check", "possibly-undefined.ts"], "--raw is denext's, not forwarded");

      const envRaw = await cli(["check", "possibly-undefined.ts"], dir, {
        ...env,
        DENEXT_RAW_DIAGNOSTICS: "1",
      });
      assert(!envRaw.stderr.includes("Fix:"), envRaw.stderr);
      assertStringIncludes(envRaw.stderr, "TS18048 [ERROR]");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "denext lint explains a denext rule report; --json output is left alone",
  ignore: !posix,
  fn: async () => {
    const { dir, raw } = await project("lint-rules-of-hooks", "lint-rules-of-hooks.tsx");
    try {
      const deno = await fakeDeno(dir, raw);
      const env = { DENO_BIN: deno.path };
      const run = await cli(["lint", "lint-rules-of-hooks.tsx"], dir, env);
      assertEquals(run.code, 1);
      assertStringIncludes(
        run.stderr,
        "denext/rules-of-hooks: `useEffect` is called conditionally",
      );
      assertStringIncludes(run.stderr, "Original (deno lint):");
      const json = await cli(["lint", "--json", "lint-rules-of-hooks.tsx"], dir, env);
      assert(!json.stderr.includes("Fix:"), json.stderr);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** The slice of {@linkcode DevState} the explain hooks read. */
function devState(projectDir: string): DevState {
  return {
    paths: { projectDir },
    devEvents: new DevEventLog(),
    reloadClients: new Set(),
  } as unknown as DevState;
}

Deno.test("dev: a failed type-check is explained for the terminal, the overlay and the 500 page", async () => {
  const { dir, raw } = await project("possibly-null", "possibly-null.ts");
  try {
    const st = devState(dir);
    const terminal = explainForTerminal(st, raw);
    assertStringIncludes(terminal, "TS18047: `heading` may be `null`");
    assertStringIncludes(terminal, "│ TS18047 [ERROR]: 'heading' is possibly 'null'.");

    const { explained } = explainForOverlay(st, raw);
    assert(explained, "the overlay gets an explanation");
    assertStringIncludes(explained, "querySelector");
    assert(!explained.includes("[ERROR]"), "the original is shown apart, not inside it");

    pushError(st, { title: "Type error", message: raw, stack: "", explained });
    const [event] = st.devEvents.snapshot({ kind: "error" });
    assertEquals(event.explained, explained, "recorded for the MCP dev logs and the 500 page");
    const page = devErrorPage(event, "/_denext/reload.js")!;
    assertStringIncludes(page, "<h2>Explained</h2>");
    assertStringIncludes(page, "<details><summary>Original diagnostic</summary>");

    assertEquals(explainForOverlay(st, "TypeError: boom\n    at x (file:///a.ts:1:1)"), {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

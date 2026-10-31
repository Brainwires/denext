// Opt-in crash reports (src/build/crash-report.ts, runtime 3.0.0-denext.5): the URL rules the
// runtime applies, the application name denext's CLI hops hand down, the `denext doctor` check and
// `denext crash-report test` — with a fake self-test child, and once against the real runtime
// when this process runs on it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  compareDenoVersions,
  currentDenoIdentity,
  FIRST_CRASH_REPORT_RUNTIME,
  supportsCrashReports,
} from "../src/build/deno-version.ts";
import {
  CRASH_REPORT_APP_ENV,
  CRASH_REPORT_SELFTEST_ENV,
  CRASH_REPORT_URL_ENV,
  crashReportAppEnv,
  crashReportCheck,
  crashReportTest,
  crashReportUrlProblem,
} from "../src/build/crash-report.ts";
import { crashReportAction, crashReportCommand } from "../src/cli/commands/crash-report.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";
import { VERSION } from "../src/version.ts";

/** An environment reader over `vars`. */
const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

const TOKEN_URL = "https://ingest.example.com/r?token=s3cret";

Deno.test("crash reports arrive with runtime 3.0.0-denext.5", () => {
  assertEquals(FIRST_CRASH_REPORT_RUNTIME, "3.0.0-denext.5");
  assert(supportsCrashReports("3.0.0-denext.5"));
  assert(supportsCrashReports("3.0.0-denext.12"));
  assert(!supportsCrashReports("3.0.0-denext.3"));
  assert(!supportsCrashReports("3.0.0-rc.7"));
  assert(!supportsCrashReports("2.9.7-denext.22"));
  assert(!supportsCrashReports("not a version"));
});

Deno.test("the URL rules: https and a host-less file are accepted, the rest refused", () => {
  assertEquals(crashReportUrlProblem("https://example.com/ingest"), null);
  assertEquals(crashReportUrlProblem("file:///var/log/crash.jsonl"), null);
  assertStringIncludes(crashReportUrlProblem("http://example.com")!, "http://");
  assertStringIncludes(crashReportUrlProblem("file://server/share/x.jsonl")!, "host");
  assertStringIncludes(crashReportUrlProblem("not a url")!, "not a URL");
  assertStringIncludes(crashReportUrlProblem("ftp://example.com/x")!, "ftp:");
  // The answer never repeats the value (it may hold a token).
  assert(!crashReportUrlProblem("http://h/?token=s3cret")!.includes("s3cret"));
});

Deno.test("a CLI hop names denext as the application, on a runtime that reads it", () => {
  const app = { [CRASH_REPORT_APP_ENV]: `denext@${VERSION}` };
  const env = envOf({});
  assertEquals(crashReportAppEnv({ runtime: "3.0.0-denext.5", env, version: VERSION }), app);
  // A DENEXT_DENO=<path> build: its version is unknown, and the variable is harmless unread.
  assertEquals(crashReportAppEnv({ runtime: "path", env, version: VERSION }), app);
  // Stock Deno, or denext's Deno before crash reports: nothing.
  assertEquals(crashReportAppEnv({ runtime: undefined, env, version: VERSION }), {});
  assertEquals(crashReportAppEnv({ runtime: "3.0.0-denext.3", env, version: VERSION }), {});
  // The operator's own name stands.
  const own = envOf({ [CRASH_REPORT_APP_ENV]: "myapp@1" });
  assertEquals(crashReportAppEnv({ runtime: "3.0.0-denext.5", env: own, version: VERSION }), {});
  // A version the runtime would not accept is not sent.
  assertEquals(
    crashReportAppEnv({ runtime: "3.0.0-denext.5", env, version: "1 2".repeat(40) }),
    {},
  );
});

Deno.test("doctor: off while unset; http and stock Deno are flagged; a valid URL is on", () => {
  assertEquals(crashReportCheck(envOf({}), "3.0.0-denext.5"), null);
  assertEquals(crashReportCheck(envOf({ [CRASH_REPORT_URL_ENV]: "" }), "3.0.0-denext.5"), null);

  const http = crashReportCheck(envOf({ [CRASH_REPORT_URL_ENV]: "http://h/x" }), "3.0.0-denext.5")!;
  assertEquals([http.name, http.ok, http.critical], ["crash reports", false, false]);
  assertStringIncludes(http.detail, "http://");

  const set = envOf({ [CRASH_REPORT_URL_ENV]: TOKEN_URL });
  const stock = crashReportCheck(set, undefined)!;
  assertEquals(stock.ok, false);
  assertStringIncludes(stock.detail, "set but unsupported: stock Deno");
  const old = crashReportCheck(set, "3.0.0-denext.3")!;
  assertEquals(old.ok, false);
  assertStringIncludes(old.detail, "3.0.0-denext.3 sends none");

  const on = crashReportCheck(set, "3.0.0-denext.5")!;
  assertEquals(on.ok, true);
  assertStringIncludes(on.detail, "ingest.example.com");
  assert(!on.detail.includes("s3cret"), on.detail);
  const file = crashReportCheck(
    envOf({ [CRASH_REPORT_URL_ENV]: "file:///var/log/c.jsonl" }),
    "3.0.0-denext.5",
  )!;
  assertStringIncludes(file.detail, "/var/log/c.jsonl");
});

/** A fake self-test child that appends `line` to the file URL it is handed, and exits `code`. */
function fakeChild(line: string | null, code = 1) {
  const calls: Record<string, string>[] = [];
  const run = async (_deno: string, env: Record<string, string>) => {
    calls.push(env);
    const url = new URL(env[CRASH_REPORT_URL_ENV]);
    if (line !== null && url.protocol === "file:") {
      await Deno.writeTextFile(url, line + "\n", { append: true });
    }
    return { code, stderr: "Deno has panicked." };
  };
  return { run, calls };
}

Deno.test("crash-report test: a file URL shows the self-test line the child appended", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "crash.jsonl");
    await Deno.writeTextFile(path, '{"kind":"panic"}\n'); // an earlier report is not shown
    const url = toFileUrl(path).href;
    const report = JSON.stringify({ schema: 2, kind: "selftest", app: `denext@${VERSION}` });
    const child = fakeChild(report);
    const result = await crashReportTest({
      env: envOf({ [CRASH_REPORT_URL_ENV]: url }),
      deno: "deno",
      runtime: "3.0.0-denext.5",
      version: VERSION,
      run: child.run,
    });
    assertEquals(result.ok, true);
    assertEquals(result.lines.at(-1), report);
    assertEquals(child.calls, [{
      [CRASH_REPORT_URL_ENV]: url,
      [CRASH_REPORT_SELFTEST_ENV]: "1",
      [CRASH_REPORT_APP_ENV]: `denext@${VERSION}`,
    }]);

    // The child panicked but wrote nothing: a failure naming the file.
    const none = await crashReportTest({
      env: envOf({ [CRASH_REPORT_URL_ENV]: toFileUrl(join(dir, "new.jsonl")).href }),
      deno: "deno",
      runtime: "3.0.0-denext.5",
      version: VERSION,
      run: fakeChild(null).run,
    });
    assertEquals(none.ok, false);
    assertStringIncludes(none.lines.at(-1)!, "no self-test report was appended");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("crash-report test: an https endpoint is posted to, its value never printed", async () => {
  const result = await crashReportTest({
    env: envOf({ [CRASH_REPORT_URL_ENV]: TOKEN_URL }),
    deno: "deno",
    runtime: "3.0.0-denext.5",
    version: VERSION,
    run: fakeChild(null).run,
  });
  assertEquals(result.ok, true);
  assertStringIncludes(result.lines.join("\n"), "ingest.example.com");
  assert(!result.lines.join("\n").includes("s3cret"));
});

Deno.test("crash-report test: refusals and a child that did not panic", async () => {
  const run = async (env: Record<string, string>, runtime: string | undefined, code = 1) =>
    await crashReportTest({
      env: envOf(env),
      deno: "deno",
      runtime,
      version: VERSION,
      run: () => Promise.resolve({ code, stderr: "warning: DENEXT_CRASH_REPORT_URL is ignored" }),
    });
  const unset = await run({}, "3.0.0-denext.5");
  assertEquals(unset.ok, false);
  assertStringIncludes(unset.lines[0], "is not set");
  const http = await run({ [CRASH_REPORT_URL_ENV]: "http://h/" }, "3.0.0-denext.5");
  assertStringIncludes(http.lines[0], "http://");
  const stock = await run({ [CRASH_REPORT_URL_ENV]: TOKEN_URL }, undefined);
  assertStringIncludes(stock.lines[0], "stock Deno sends no crash reports");
  const old = await run({ [CRASH_REPORT_URL_ENV]: TOKEN_URL }, "3.0.0-denext.3");
  assertStringIncludes(old.lines[0], "3.0.0-denext.3 sends no crash reports");
  const calm = await run({ [CRASH_REPORT_URL_ENV]: TOKEN_URL }, "3.0.0-denext.5", 0);
  assertEquals(calm.ok, false);
  assertStringIncludes(calm.lines[0], "did not panic");
  assertStringIncludes(calm.lines[0], "is ignored");
});

Deno.test("denext crash-report: the action, its exit code and output", async () => {
  const out: [string, boolean][] = [];
  const deps = {
    binary: () => Promise.resolve({ deno: "deno", marker: "3.0.0-denext.5" }),
    env: envOf({ [CRASH_REPORT_URL_ENV]: TOKEN_URL }),
    print: (line: string, error: boolean) => out.push([line, error]),
    run: fakeChild(null).run,
  };
  assertEquals(await crashReportAction("bogus", deps), 1);
  assertStringIncludes(out[0][0], 'unknown crash-report action "bogus"');
  assertEquals(await crashReportAction(undefined, deps), 1);
  out.length = 0;
  assertEquals(await crashReportAction("test", deps), 0);
  assert(out.every(([, error]) => !error));
  out.length = 0;
  const stock = { ...deps, binary: () => Promise.resolve({ deno: "deno", marker: "" }) };
  assertEquals(await crashReportAction("test", stock), 1);
  assert(out.every(([, error]) => error));
});

Deno.test("denext crash-report <unknown>: exits 1 before resolving the toolchain", async () => {
  const out = capture();
  const exit = stubExit();
  try {
    let thrown = "";
    await Promise.resolve(crashReportCommand.run(makeCtx({ positionals: ["bogus"] }))).catch(
      (e: Error) => {
        thrown = e.message;
      },
    );
    assertEquals([thrown, exit.calls], ["__exit__1", [1]]);
    assertStringIncludes(out.errs.join("\n"), 'unknown crash-report action "bogus"');
  } finally {
    exit.restore();
    out.restore();
  }
});

// End to end on the real runtime, when this process is denext's Deno with crash reports: the
// self-test panics and appends one schema-2 report naming denext.
const runtime = currentDenoIdentity().denext;
Deno.test({
  name: "crash-report test against the running denext Deno writes one self-test report",
  ignore: runtime === undefined || compareDenoVersions(runtime, FIRST_CRASH_REPORT_RUNTIME) < 0,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "crash.jsonl");
      const result = await crashReportTest({
        env: envOf({ [CRASH_REPORT_URL_ENV]: toFileUrl(path).href }),
        deno: Deno.execPath(),
        runtime,
        version: VERSION,
      });
      assert(result.ok, result.lines.join("\n"));
      const lines = (await Deno.readTextFile(path)).trim().split("\n");
      assertEquals(lines.length, 1);
      const report = JSON.parse(lines[0]);
      assertEquals([report.schema, report.kind, report.app], [2, "selftest", `denext@${VERSION}`]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

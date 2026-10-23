// Coverage for `src/cli/commands/doctor.ts`: the `info` command (JSON + text) against a
// temp project, the `doctor` happy path against a real conforming example app, and
// doctor's config-load-failure branch (which reports a failed critical check and exits).

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { doctorCommand, infoCommand } from "../src/cli/commands/doctor.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** A conforming, all-static example app (used by the conformance suite). */
const DOCS = fromFileUrl(new URL("../site", import.meta.url));

async function tempApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  return dir;
}

Deno.test("info prints project facts as text", async () => {
  const dir = await tempApp();
  const cap = capture();
  try {
    await infoCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "denext");
  assertStringIncludes(out, "app dir");
  assertStringIncludes(out, dir);
});

Deno.test("info prints project facts as JSON with --json", async () => {
  const dir = await tempApp();
  const cap = capture();
  try {
    await infoCommand.run(makeCtx({ positionals: [dir], global: { json: true } }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const facts = JSON.parse(cap.logs.join("\n"));
  assert(typeof facts.denext === "string");
  assert(typeof facts.deno === "string");
  assert(facts.appDir.endsWith("app"));
  assert(facts.mode === "app-router");
});

Deno.test("doctor reports all checks passing for a conforming app", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await doctorCommand.run(makeCtx({ positionals: [DOCS] }));
  } finally {
    exit.restore();
    cap.restore();
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "denext doctor");
  assertStringIncludes(out, "Deno version");
  assertStringIncludes(out, "app directory");
  assertStringIncludes(out, "route conformance");
  assertStringIncludes(out, "All checks passed.");
  // A conforming app never triggers the failure exit.
  assert(exit.calls.length === 0, "no exit on a clean doctor run");
});

Deno.test("doctor --report prints a markdown health report with every section", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await doctorCommand.run(makeCtx({ positionals: [DOCS], flags: { report: true } }));
  } finally {
    exit.restore();
    cap.restore();
  }
  const md = cap.logs.join("\n");
  assertStringIncludes(md, "# denext doctor — ");
  assertStringIncludes(md, "**Verdict:** all checks passed");
  assertStringIncludes(md, "## Checks");
  assertStringIncludes(md, "**route conformance**");
  assertStringIncludes(md, "## Routes");
  assertStringIncludes(md, "| Route | Path | Status | Kind | Result |");
  assertStringIncludes(md, "static (0 KB JS)");
  assertStringIncludes(md, "## Client bundle");
  // The docs app has no `.denext/client` build output here → the degrade line, not a build.
  assert(
    md.includes("_Not built — run `denext build`") || md.includes("### Chunks"),
    "bundle section is either the not-built hint or the chunk table",
  );
  assertStringIncludes(md, "denext profile");
  assert(exit.calls.length === 0, "a clean report never exits non-zero");
});

Deno.test("doctor --report --json emits the structured report; --json alone emits the checks", async () => {
  const full = capture();
  try {
    await doctorCommand.run(
      makeCtx({ positionals: [DOCS], flags: { report: true }, global: { json: true } }),
    );
  } finally {
    full.restore();
  }
  const report = JSON.parse(full.logs.join("\n"));
  assert(Array.isArray(report.checks), "checks array");
  assert(report.checks.some((c: { name: string }) => c.name === "route conformance"));
  assert(typeof report.routes.total === "number", "the full per-route report is included");
  assert(Array.isArray(report.routes.routes));
  assert("bundle" in report, "bundle is present (null when not built)");
  assert(report.bundle === null || Array.isArray(report.bundle));

  const checksOnly = capture();
  try {
    await doctorCommand.run(makeCtx({ positionals: [DOCS], global: { json: true } }));
  } finally {
    checksOnly.restore();
  }
  const checks = JSON.parse(checksOnly.logs.join("\n"));
  assert(Array.isArray(checks) && checks.length > 0, "--json without --report is the check list");
  assert("critical" in checks[0]);
});

Deno.test("doctor --report on a project with no app dir explains the un-probed sections and exits 1", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_noapp_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  const cap = capture();
  const exit = stubExit();
  try {
    await doctorCommand.run(makeCtx({ positionals: [dir], flags: { report: true } }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const md = cap.logs.join("\n");
  assertStringIncludes(md, "**Verdict:** problems found");
  assertStringIncludes(md, "✖ **app directory**");
  assertStringIncludes(md, "_Not probed — SPA mode, a missing app directory");
  assertStringIncludes(md, "_Not built — run `denext build`");
  assert(exit.calls.includes(1), "a failing critical check still exits non-zero under --report");
});

/** `doctor --json` over a project with no `app/` and `config` as its `denext.config.ts`. */
async function doctorWithoutAppDir(
  config: string,
  files: Record<string, string> = {},
): Promise<{ app: { ok: boolean; detail: string } | undefined; exitCalls: number[] }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_plugin_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  const cap = capture();
  const exit = stubExit();
  try {
    await doctorCommand.run(makeCtx({ positionals: [dir], global: { json: true } }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const checks = JSON.parse(cap.logs.join("\n")) as Array<
    { name: string; ok: boolean; detail: string }
  >;
  return { app: checks.find((c) => c.name === "app directory"), exitCalls: exit.calls };
}

Deno.test("doctor counts the app directory as not needed when a plugin serves the pages", async () => {
  // A Pages Router / TanStack Start shape: no `app/`, the pages come from a plugin that declares
  // `ctx.servesRoutes()`. A plugin that only adds a request handler is not named.
  const { app, exitCalls } = await doctorWithoutAppDir(
    `export default {\n` +
      `  plugins: [{\n` +
      `    name: "fixture-router",\n` +
      `    setup(ctx) { ctx.addRequestHandler(() => new Response("routed")); ctx.servesRoutes(); },\n` +
      `  }, {\n` +
      `    name: "fixture-api",\n` +
      `    setup(ctx) { ctx.addRequestHandler(() => null); ctx.addRouteSynthesizer(() => {}); },\n` +
      `  }, { name: "fixture-inert", setup() {} }],\n` +
      `};\n`,
  );
  assert(app?.ok, `app directory passes: ${JSON.stringify(app)}`);
  assertStringIncludes(app.detail, "not needed: routes come from fixture-router");
  assert(!app.detail.includes("fixture-api"), "an endpoint-only plugin is not named");
  assert(!app.detail.includes("fixture-inert"), "a plugin that serves nothing is not named");
  assert(!exitCalls.includes(1), "no critical failure for a plugin-routed app");
});

Deno.test("doctor at a monorepo's root names the apps to run it on", async () => {
  const { app, exitCalls } = await doctorWithoutAppDir("export default {};\n", {
    "deno.json": JSON.stringify({ workspace: ["./apps/web"] }),
    "apps/web/app/page.tsx": "export default function Home() { return null; }\n",
  });
  assert(app && !app.ok, JSON.stringify(app));
  assertStringIncludes(app.detail, "its denext app is apps/web");
  assert(exitCalls.includes(1), "still a critical failure: the root is not an app");
});

Deno.test("doctor passes a Pages Router app (no app/) through @denext/pages-router", async () => {
  const pagesRouter = new URL("../packages/pages-router/mod.ts", import.meta.url).href;
  const { app, exitCalls } = await doctorWithoutAppDir(
    `import { pagesRouter } from ${JSON.stringify(pagesRouter)};\n` +
      `export default { plugins: [pagesRouter()] };\n`,
    { "pages/index.ts": `export default function Home() { return null; }\n` },
  );
  assert(app?.ok, `app directory passes: ${JSON.stringify(app)}`);
  assertStringIncludes(app.detail, "@denext/pages-router");
  assert(!exitCalls.includes(1));
});

Deno.test("doctor fails a missing app directory when the only plugin is OpenAPI's", async () => {
  // @denext/openapi registers a request handler (its docs) and a route synthesizer, but serves no
  // pages: it must not stand in for `app/`.
  const openapi = new URL("../packages/openapi/mod.ts", import.meta.url).href;
  const { app, exitCalls } = await doctorWithoutAppDir(
    `import { openapi } from ${JSON.stringify(openapi)};\n` +
      `export default { plugins: [openapi()] };\n`,
  );
  assert(app?.ok === false, `app directory fails: ${JSON.stringify(app)}`);
  assert(exitCalls.includes(1), "an OpenAPI-only project with no app/ is a critical failure");
});

Deno.test("doctor fails a missing app directory with no plugins", async () => {
  const { app, exitCalls } = await doctorWithoutAppDir(`export default {};\n`);
  assert(app?.ok === false, `app directory fails: ${JSON.stringify(app)}`);
  assert(exitCalls.includes(1));
});

Deno.test("doctor still fails a missing app directory when a router plugin's setup fails", async () => {
  const { app, exitCalls } = await doctorWithoutAppDir(
    `export default {\n` +
      `  plugins: [{ name: "fixture-inert", setup() {} }, {\n` +
      `    name: "fixture-broken",\n` +
      `    setup(ctx) { ctx.servesRoutes(); throw new Error("setup failed"); },\n` +
      `  }],\n` +
      `};\n`,
  );
  assert(app?.ok === false, `app directory fails: ${JSON.stringify(app)}`);
  assert(exitCalls.includes(1), "a plugin whose setup fails does not stand in for app/");
});

Deno.test("doctor reports a config-load failure as a failed critical check", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_bad_" });
  // A denext.config.ts that throws on import → resolveProject rejects → doctor turns it
  // into a failed `config` check and exits non-zero.
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `throw new Error("boom from config");\nexport default {};\n`,
  );
  const cap = capture();
  const exit = stubExit();
  try {
    await doctorCommand.run(makeCtx({ positionals: [dir] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "Problems found.");
  assert(exit.calls.includes(1), "config failure exits non-zero");
});

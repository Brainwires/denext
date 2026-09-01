// Coverage for `src/cli/commands/doctor.ts`: the `info` command (JSON + text) against a
// temp project, the `doctor` happy path against a real conforming example app, and
// doctor's config-load-failure branch (which reports a failed critical check and exits).

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { doctorCommand, infoCommand } from "../src/cli/commands/doctor.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** A conforming, all-static example app (used by the conformance suite). */
const DOCS = new URL("../apps/web", import.meta.url).pathname;

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

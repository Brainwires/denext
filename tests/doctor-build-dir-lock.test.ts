// `denext doctor` under the build-directory lock the CLI takes for it (run-verb.ts): a project
// with plugins runs their prepare steps inside the route-conformance probe, which writes
// `.denext/` under the build-dir lock exclusive — so the verb must not hold that lock shared.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { doctorCommand, doctorLocks } from "../src/cli/commands/doctor.ts";
import { acquireProjectLocks } from "../src/build/project-locks.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** An App Router project whose one plugin has a prepare step that writes into `.denext/`. */
async function pluginApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_lock_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    "export default function Root({ children }: { children: unknown }) {\n" +
      '  return <html lang="en"><head><title>t</title></head><body>{children}</body></html>;\n' +
      "}\n",
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    "export default function Home() { return <main>home</main>; }\n",
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    "export default {\n" +
      "  plugins: [{\n" +
      '    name: "fixture-codegen",\n' +
      "    setup(ctx) {\n" +
      "      ctx.addPrepareStep(async (p) => {\n" +
      "        await Deno.mkdir(p.outDir, { recursive: true });\n" +
      '        await Deno.writeTextFile(`${p.outDir}/fixture-codegen.ts`, "export {};\\n");\n' +
      "      });\n" +
      "    },\n" +
      "  }],\n" +
      "};\n",
  );
  return dir;
}

/** Run `doctor --json` on `dir` the way the CLI does: under the locks the verb declares. */
async function doctorUnderItsLocks(
  dir: string,
): Promise<{ checks: Array<{ name: string; ok: boolean; detail: string }>; exits: number[] }> {
  const ctx = makeCtx({ positionals: [dir], global: { json: true } });
  const cap = capture();
  const exit = stubExit();
  try {
    const request = await doctorCommand.locks?.(ctx);
    using _locks = request ? await acquireProjectLocks(request) : undefined;
    await doctorCommand.run(ctx);
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  return { checks: JSON.parse(cap.logs.join("\n")), exits: exit.calls };
}

Deno.test("doctor probes a project whose plugin has a prepare step under its own build-dir lock", async () => {
  const dir = await pluginApp();
  try {
    const { checks, exits } = await doctorUnderItsLocks(dir);
    const conformance = checks.find((c) => c.name === "route conformance");
    assert(conformance, "the route-conformance check ran");
    assert(!conformance.detail.includes("not upgraded"), conformance.detail);
    assert(conformance.ok, `route conformance passes: ${conformance.detail}`);
    assert(!exits.includes(1), `no critical failure: ${JSON.stringify(checks)}`);
    // The prepare step ran (inside the verb's lock) and wrote its codegen.
    const written = await Deno.readTextFile(join(dir, ".denext", "fixture-codegen.ts"));
    assertEquals(written, "export {};\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor's build-dir lock: exclusive only when its probe runs plugin prepare steps", async () => {
  const dirs: string[] = [];
  // A fresh project per config (a config module, once imported, stays cached in this process).
  const mode = async (config: string | null) => {
    const dir = await Deno.makeTempDir({ prefix: "denext_doctor_lockmode_" });
    dirs.push(dir);
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    if (config !== null) await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
    return (await doctorLocks(makeCtx({ positionals: [dir] }))).buildDir;
  };
  try {
    assertEquals(await mode(null), "shared", "no config: a reader");
    assertEquals(await mode("export default { plugins: [] };\n"), "shared", "no plugins");
    assertEquals(
      await mode('export default { plugins: [{ name: "p", setup() {} }] };\n'),
      "exclusive",
      "a plugin: the probe runs its prepare steps",
    );
    assertEquals(
      await mode('export default { mode: "spa", plugins: [{ name: "p", setup() {} }] };\n'),
      "shared",
      "SPA mode: no probe runs",
    );
    assertEquals(await mode("export default {\n"), "shared", "a config that fails to load");
  } finally {
    for (const dir of dirs) await Deno.remove(dir, { recursive: true });
  }
});

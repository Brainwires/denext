// Coverage for `src/cli/commands/generate.ts`: the command's `run` (kind validation,
// name requirement, docker's optional name, the written/skipped output, and the
// "everything already existed" non-zero exit). The codegen engine itself is covered
// separately in cli-generate.test.ts — here we drive the CLI verb.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { generateCommand } from "../src/cli/commands/generate.ts";
import { GENERATE_KINDS, generateArtifact } from "../src/build/generate.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_gen_cli_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  return dir;
}

Deno.test("generate scaffolds a page and prints the written path", async () => {
  const dir = await project();
  const cap = capture();
  try {
    await generateCommand.run(makeCtx({ positionals: ["page", "dashboard", dir] }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "+ ");
    assertStringIncludes(out, "page.tsx");
    assert((await Deno.stat(join(dir, "app/dashboard/page.tsx"))).isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate docker needs no name", async () => {
  const dir = await project();
  const cap = capture();
  try {
    await generateCommand.run(makeCtx({ positionals: ["docker", "", dir] }));
  } finally {
    cap.restore();
  }
  try {
    assertStringIncludes(cap.logs.join("\n"), "Dockerfile");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate rejects an unknown kind", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(makeCtx({ positionals: ["widget", "Foo"] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "unknown kind");
});

Deno.test("generate requires a name for a named kind", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(makeCtx({ positionals: ["component"] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "missing name");
});

Deno.test("generate exits non-zero when every target already exists", async () => {
  const dir = await project();
  // First run writes the component; second run finds it and skips everything → exit 1.
  const cap0 = capture();
  try {
    await generateCommand.run(makeCtx({ positionals: ["component", "Card", dir] }));
  } finally {
    cap0.restore();
  }
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(makeCtx({ positionals: ["component", "Card", dir] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.logs.join("\n"), "exists, skipped");
});

// ── the engine's write policy: dryRun / force (added with the `denext ui` generate panel) ──

Deno.test("generateArtifact dryRun plans the files without touching disk", async () => {
  const dir = await project();
  try {
    const res = await generateArtifact(dir, "page", "dashboard", { dryRun: true });
    assertEquals(res.written, [join(dir, "app/dashboard/page.tsx")]);
    assertEquals(res.skipped, []);
    assertEquals(res.preview?.length, 1);
    assertEquals(res.preview?.[0].path, join(dir, "app/dashboard/page.tsx"));
    assertStringIncludes(res.preview?.[0].contents ?? "", "function DashboardPage(");
    await assertRejects(() => Deno.stat(join(dir, "app/dashboard/page.tsx")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateArtifact dryRun previews every docker file and reports existing ones", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(join(dir, "Dockerfile"), "# mine\n");
    const res = await generateArtifact(dir, "docker", "", { dryRun: true });
    assertEquals(res.preview?.map((f) => f.path), [
      join(dir, "Dockerfile"),
      join(dir, "docker-compose.yml"),
      join(dir, ".dockerignore"),
    ]);
    assertEquals(res.skipped, [join(dir, "Dockerfile")]);
    assertEquals(res.written.length, 2);
    // Nothing was written and the existing file is untouched.
    assertEquals(await Deno.readTextFile(join(dir, "Dockerfile")), "# mine\n");
    await assertRejects(() => Deno.stat(join(dir, "docker-compose.yml")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateArtifact never overwrites by default, and force does", async () => {
  const dir = await project();
  const target = join(dir, "components/Card.tsx");
  try {
    await generateArtifact(dir, "component", "Card");
    await Deno.writeTextFile(target, "// hand-edited\n");

    const kept = await generateArtifact(dir, "component", "Card");
    assertEquals(kept.written, []);
    assertEquals(kept.skipped, [target]);
    assertEquals(await Deno.readTextFile(target), "// hand-edited\n");

    const forced = await generateArtifact(dir, "component", "Card", { force: true });
    assertEquals(forced.written, [target]);
    assertEquals(forced.skipped, []);
    assertStringIncludes(await Deno.readTextFile(target), "export function Card()");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a forced dry run counts an existing file as written, and still writes nothing", async () => {
  const dir = await project();
  const target = join(dir, "components/Card.tsx");
  try {
    await generateArtifact(dir, "component", "Card");
    await Deno.writeTextFile(target, "// hand-edited\n");
    const res = await generateArtifact(dir, "component", "Card", { dryRun: true, force: true });
    assertEquals(res.written, [target]);
    assertEquals(res.skipped, []);
    assertEquals(await Deno.readTextFile(target), "// hand-edited\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GENERATE_KINDS is the CLI verb's kind list, in order", () => {
  const help = (generateCommand.positionals ?? []).find((p) => p.name === "kind")?.help ?? "";
  assertEquals(help, GENERATE_KINDS.join(" | "));
  assertEquals(GENERATE_KINDS.length, 13);
  assertEquals(GENERATE_KINDS[0], "page");
  assertEquals(GENERATE_KINDS[GENERATE_KINDS.length - 1], "docker");
});

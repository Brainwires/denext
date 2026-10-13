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
  assertEquals(GENERATE_KINDS.length, 17);
  assertEquals(GENERATE_KINDS[0], "page");
  assertEquals(GENERATE_KINDS[GENERATE_KINDS.length - 1], "ci");
});

// ---- docker flags ------------------------------------------------------------

/** Run `generate docker` with flags; return the output and any exit code. */
async function runDocker(
  dir: string,
  flags: Record<string, string | number | boolean>,
  kind = "docker",
): Promise<{ out: string; err: string; exit?: number }> {
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(
      makeCtx({ positionals: [kind, kind === "docker" ? "" : "x", dir], flags }),
    );
  } catch (e) {
    if (!String(e).includes("__exit__")) throw e;
  } finally {
    exit.restore();
    cap.restore();
  }
  return { out: cap.logs.join("\n"), err: cap.errs.join("\n"), exit: exit.calls[0] };
}

Deno.test("generate docker --postgres --storage --migrate --dev writes the stack and reports why", async () => {
  const dir = await project();
  try {
    const { out, exit } = await runDocker(dir, {
      postgres: true,
      storage: true,
      "no-migrate": true,
      dev: true,
      port: 8080,
      "deno-tag": "2.9.7",
    });
    assertEquals(exit, undefined);
    assertStringIncludes(out, "postgres  on   (--postgres)");
    assertStringIncludes(out, "migrate   off  (--no-migrate)");
    assertStringIncludes(out, "pgvector  off  (not detected)");
    assertStringIncludes(out, "cp .env.example .env");
    assertStringIncludes(out, ".gitignore does not ignore .env");
    const compose = await Deno.readTextFile(join(dir, "docker-compose.yml"));
    assertStringIncludes(compose, "minio-init:");
    assertStringIncludes(compose, `"8080:8080"`);
    assert(!compose.includes("  migrate:"), "--no-migrate");
    assertStringIncludes(await Deno.readTextFile(join(dir, "Dockerfile")), "deno:2.9.7");
    assert((await Deno.stat(join(dir, "compose.dev.yml"))).isFile);
    assert((await Deno.stat(join(dir, ".env.example"))).isFile);
    await assertRejects(() => Deno.stat(join(dir, ".env")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate docker --dry-run prints diffs and writes nothing; a re-run diffs, --force overwrites", async () => {
  const dir = await project();
  try {
    const dry = await runDocker(dir, { stack: true, "dry-run": true });
    assertStringIncludes(dry.out, "+++ docker-compose.yml");
    assertStringIncludes(dry.out, "would write");
    await assertRejects(() => Deno.stat(join(dir, "Dockerfile")), Deno.errors.NotFound);

    await runDocker(dir, {});
    const same = await runDocker(dir, {});
    assertEquals(same.exit, undefined, "an identical re-run is not a failure");
    assertStringIncludes(same.out, "exists, skipped");

    const port = await runDocker(dir, { port: 8080 });
    assertEquals(port.exit, 1, "nothing written, and the files on disk differ");
    assertStringIncludes(port.out, '+      - "8080:8080"');
    assertStringIncludes(port.out, "rerun with --force");

    // A new file (.env.example) is still written beside the skipped, differing ones.
    const differs = await runDocker(dir, { postgres: true });
    assertEquals(differs.exit, undefined);
    assertStringIncludes(differs.out, "+  db:");
    assertStringIncludes(differs.out, ".env.example");
    assert(!(await Deno.readTextFile(join(dir, "docker-compose.yml"))).includes("pg_isready"));

    const forced = await runDocker(dir, { postgres: true, force: true });
    assertEquals(forced.exit, undefined);
    assertStringIncludes(await Deno.readTextFile(join(dir, "docker-compose.yml")), "pg_isready");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate docker refuses contradictory or invalid flags, and docker flags on other kinds", async () => {
  const dir = await project();
  try {
    const both = await runDocker(dir, { postgres: true, "no-postgres": true });
    assertEquals(both.exit, 1);
    assertStringIncludes(both.err, "contradict");
    const port = await runDocker(dir, { port: 70000 });
    assertEquals(port.exit, 1);
    assertStringIncludes(port.err, "invalid --port");
    const tag = await runDocker(dir, { "deno-tag": "x;rm" });
    assertEquals(tag.exit, 1);
    assertStringIncludes(tag.err, "invalid --deno-tag");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default { mode: "spa" };\n`);
    const spa = await runDocker(dir, { postgres: true });
    assertEquals(spa.exit, 1);
    assertStringIncludes(spa.err, "static (SPA) image has no server");
    const other = await runDocker(dir, { postgres: true }, "page");
    assertEquals(other.exit, 1);
    assertStringIncludes(other.err, "only apply to `docker`");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate --dry-run and --force work for every kind", async () => {
  const dir = await project();
  try {
    const dry = await runDocker(dir, { "dry-run": true }, "page");
    assertStringIncludes(dry.out, "would write");
    await assertRejects(() => Deno.stat(join(dir, "app/x/page.tsx")), Deno.errors.NotFound);
    await runDocker(dir, {}, "page");
    await Deno.writeTextFile(join(dir, "app/x/page.tsx"), "mine");
    await runDocker(dir, { force: true }, "page");
    assert((await Deno.readTextFile(join(dir, "app/x/page.tsx"))) !== "mine");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

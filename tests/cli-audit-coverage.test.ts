// Coverage for `src/cli/commands/audit.ts`: the command's `run` in its text-report,
// JSON/SBOM, and strict-with-offenders (non-zero exit) forms. The audit engine itself is
// covered in cli-audit.test.ts — here we drive the CLI verb's output + exit behavior.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { auditCommand } from "../src/cli/commands/audit.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

async function fixture(
  files: Record<string, string>,
  imports: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_audit_cli_" });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  return dir;
}

Deno.test("audit prints a zero-npm text report", async () => {
  const dir = await fixture(
    { "app/page.tsx": `import "@std/assert";\nexport default () => null;` },
    { "@std/assert": "jsr:@std/assert@^1" },
  );
  const cap = capture();
  const exit = stubExit();
  try {
    await auditCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "denext audit");
  assertStringIncludes(out, "Dependencies");
  assertStringIncludes(out, "zero-npm runtime");
  assertStringIncludes(out, "Suggested baseline permissions");
  assert(exit.calls.length === 0, "a clean audit does not exit");
});

Deno.test("audit emits a CycloneDX SBOM with --json", async () => {
  const dir = await fixture(
    { "app/page.tsx": `export default () => null;` },
    { "@std/assert": "jsr:@std/assert@^1" },
  );
  const cap = capture();
  const exit = stubExit();
  try {
    await auditCommand.run(makeCtx({ positionals: [dir], global: { json: true } }));
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const doc = JSON.parse(cap.logs.join("\n"));
  assert(doc.bomFormat === "CycloneDX", "emits a CycloneDX document");
  assert(Array.isArray(doc.components));
});

Deno.test("audit --strict exits non-zero when runtime source imports npm", async () => {
  const dir = await fixture(
    { "app/page.tsx": `import "left-pad";\nexport default () => null;` },
    { "left-pad": "npm:left-pad@^1" },
  );
  const cap = capture();
  const exit = stubExit();
  try {
    await auditCommand.run(makeCtx({ positionals: [dir], flags: { strict: true } }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1), "an npm runtime offender under --strict exits 1");
  assertStringIncludes(cap.logs.join("\n"), "runtime npm import");
});

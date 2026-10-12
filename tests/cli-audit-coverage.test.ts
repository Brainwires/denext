// Coverage for `src/cli/commands/audit.ts`: the command's `run` in its text-report,
// JSON/SBOM, and strict-with-offenders (non-zero exit) forms. The audit engine itself is
// covered in cli-audit.test.ts — here we drive the CLI verb's output + exit behavior. Deno's half
// (`deno audit`) runs through a recorded stub, so the suite needs no network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { denoAuditArgs, makeAuditCommand } from "../src/cli/commands/audit.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** One recorded `deno audit` call. */
interface AuditCall {
  args: string[];
  cwd: string;
  toStderr: boolean;
}

/** An audit verb whose `deno audit` exits `code`, recording each call. */
function auditWith(code = 0): { command: ReturnType<typeof makeAuditCommand>; calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  const command = makeAuditCommand((args, cwd, toStderr) => {
    calls.push({ args, cwd, toStderr });
    return Promise.resolve(code);
  });
  return { command, calls };
}

const auditCommand = auditWith().command;

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

Deno.test("audit runs deno audit in the project and forwards Deno's audit flags", async () => {
  const dir = await fixture({ "app/page.tsx": `export default () => null;` }, {});
  const { command, calls } = auditWith();
  const cap = capture();
  const exit = stubExit();
  try {
    await command.run(makeCtx({
      positionals: [dir],
      flags: { level: "high", "ignore-unfixable": true, ignore: "CVE-1,CVE-2" },
      rest: ["--", "x"],
    }));
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(exit.calls, []);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].cwd, dir);
  assertEquals(calls[0].toStderr, false);
  assertEquals(calls[0].args, [
    "audit",
    "--level=high",
    "--ignore-unfixable",
    "--ignore=CVE-1,CVE-2",
    "--",
    "x",
  ]);
});

Deno.test("audit exits 1 when deno audit fails, even when denext's checks pass", async () => {
  const dir = await fixture({ "app/page.tsx": `export default () => null;` }, {});
  const { command } = auditWith(1);
  const cap = capture();
  const exit = stubExit();
  try {
    await command.run(makeCtx({ positionals: [dir] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(exit.calls, [1]);
});

Deno.test("audit --json keeps deno audit's output off stdout; --skip-deno-audit skips it", async () => {
  const dir = await fixture({ "app/page.tsx": `export default () => null;` }, {});
  const json = auditWith();
  const skipped = auditWith(1);
  const cap = capture();
  const exit = stubExit();
  try {
    await json.command.run(makeCtx({ positionals: [dir], global: { json: true, quiet: true } }));
    await skipped.command.run(makeCtx({ positionals: [dir], flags: { "skip-deno-audit": true } }));
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(json.calls[0].toStderr, true);
  assertEquals(json.calls[0].args, ["audit", "--quiet"]);
  assertEquals(skipped.calls, []);
  assertEquals(exit.calls, []);
});

Deno.test("denoAuditArgs forwards --config", () => {
  assertEquals(
    denoAuditArgs(makeCtx({ global: { config: "deno.jsonc" }, flags: { "no-lock": true } })),
    ["audit", "--no-lock", "--config", "deno.jsonc"],
  );
});

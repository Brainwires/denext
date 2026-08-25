// Unit tests for the audit engine behind `denext audit`: dependency classification,
// the zero-npm runtime proof (source imports resolving to npm via the import map),
// and the CycloneDX SBOM shape.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { auditProject, toCycloneDx } from "../src/build/audit.ts";

async function fixture(
  files: Record<string, string>,
  imports: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_audit_" });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  return dir;
}

Deno.test("classifies deps and proves a zero-npm runtime", async () => {
  const dir = await fixture(
    { "app/page.tsx": `import { thing } from "@std/assert";\nexport default () => null;` },
    { "@std/assert": "jsr:@std/assert@^1", "react": "./src/react.ts" },
  );
  try {
    const report = await auditProject(dir);
    assertEquals(report.deps.length, 2);
    assertEquals(report.npmDeps.length, 0);
    assertEquals(report.runtimeNpmOffenders.length, 0);
    const kinds = Object.fromEntries(report.deps.map((d) => [d.specifier, d.kind]));
    assertEquals(kinds["@std/assert"], "jsr");
    assertEquals(kinds["react"], "relative");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("flags an npm import in runtime source (direct and via alias)", async () => {
  const dir = await fixture(
    {
      "lib/db.ts": `import { drizzle } from "drizzle-orm";\nimport x from "npm:zod";`,
      "node_modules/pkg/index.ts": `import bad from "npm:ignored";`, // must be skipped
    },
    { "drizzle-orm": "npm:drizzle-orm@^0.3" },
  );
  try {
    const report = await auditProject(dir);
    assertEquals(report.npmDeps.length, 1);
    // Both the aliased bare import and the literal npm: import are caught; the
    // node_modules copy is skipped.
    assertEquals(report.runtimeNpmOffenders.length, 2);
    assert(report.runtimeNpmOffenders.every((o) => !o.includes("node_modules")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("emits a CycloneDX SBOM", async () => {
  const dir = await fixture(
    { "app/page.tsx": "export default () => null;" },
    { "@std/path": "jsr:@std/path@^1" },
  );
  try {
    const sbom = toCycloneDx(await auditProject(dir)) as {
      bomFormat: string;
      components: Array<{ name: string; purl: string }>;
    };
    assertEquals(sbom.bomFormat, "CycloneDX");
    assertEquals(sbom.components.length, 1);
    assertEquals(sbom.components[0].name, "@std/path");
    assert(sbom.components[0].purl.startsWith("pkg:jsr/"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

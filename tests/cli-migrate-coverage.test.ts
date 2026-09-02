// Coverage for `src/cli/commands/migrate.ts`: the `migrate` verb's report output on a
// real (temp) Next.js app — with and without `--codemod` — and the standalone
// `codemod` verb's non-interactive dry run. The migrate/codemod engines themselves are
// covered by the migrate.test.ts family; here we drive the CLI verbs' orchestration +
// their console reporting.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { codemodCommand, migrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

async function nextApp(withImports: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_cli_" });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: { react: "^18", "react-dom": "^18", next: "^15" },
    }),
  );
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  const page = withImports
    ? `import { useState } from "react";\nimport Link from "next/link";\n` +
      `export default function Page() {\n  const [n] = useState(0);\n` +
      `  return <Link href="/">{n}</Link>;\n}\n`
    : `export default function Page() {\n  return <div>hi</div>;\n}\n`;
  await Deno.writeTextFile(join(dir, "app/page.tsx"), page);
  return dir;
}

Deno.test("migrate writes a compat config and reports the alias summary", async () => {
  const dir = await nextApp(false);
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "denext migrate");
    assertStringIncludes(out, "aliased to denext");
    assertStringIncludes(out, "Source unchanged");
    assert((await Deno.stat(join(dir, "deno.json"))).isFile, "wrote deno.json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate --codemod prints the rewrite plan as a dry run (non-interactive)", async () => {
  const dir = await nextApp(true);
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({ positionals: [dir], flags: { codemod: true } }));
  } finally {
    cap.restore();
    // The page still imports react/next after a dry run.
    const page = await Deno.readTextFile(join(dir, "app/page.tsx"));
    assertStringIncludes(page, `from "react"`);
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "Rewriting source imports");
  assertStringIncludes(out, "import rewrite(s)");
  assertStringIncludes(out, "Dry run");
});

async function viteSpaApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_spa_" });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "spa",
      dependencies: { react: "^18", "react-dom": "^18" },
      devDependencies: { vite: "^5", "@vitejs/plugin-react": "^4" },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "vite.config.ts"),
    `import react from "@vitejs/plugin-react";\nexport default { plugins: [react()] };\n`,
  );
  await Deno.writeTextFile(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>My SPA</title></head><body>` +
      `<div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`,
  );
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "src/main.tsx"),
    `import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<div>hi</div>);\n`,
  );
  return dir;
}

Deno.test("migrate --from vite --desktop writes an SPA config and reports the SPA + desktop block", async () => {
  const dir = await viteSpaApp();
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({
      positionals: [dir],
      flags: { from: "vite", desktop: true, backend: "http://localhost:8080", proxy: "/api,/ws" },
    }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "denext migrate");
    assertStringIncludes(out, 'mode: "spa"');
    assertStringIncludes(out, "entry ");
    assertStringIncludes(out, "desktop:");
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(cfg, "spa");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codemod verb reports 'nothing to rewrite' when there are no next/react imports", async () => {
  const dir = await nextApp(false);
  const cap = capture();
  try {
    await codemodCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "denext codemod");
  assertStringIncludes(out, "No next/*+react imports to rewrite");
});

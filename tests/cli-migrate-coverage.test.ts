// Coverage for `src/cli/commands/migrate.ts`: the `migrate` verb's report output on a
// real (temp) Next.js app — with and without `--codemod` — and the standalone
// `codemod` verb's non-interactive dry run. The migrate/codemod engines themselves are
// covered by the migrate.test.ts family; here we drive the CLI verbs' orchestration +
// their console reporting.

import { assert, assertRejects, assertStringIncludes } from "@std/assert";
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

Deno.test("migrate --json prints the result as one JSON document (no banner)", async () => {
  const dir = await nextApp(false);
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({ positionals: [dir], global: { json: true } }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assert(!out.includes("denext migrate  ▸"), "no banner in --json mode");
    const result = JSON.parse(out);
    assertStringIncludes(result.target, dir.split("/").pop()!);
    assert(result.kind === "next", `kind: ${result.kind}`);
    assert(Array.isArray(result.aliased));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A Next app on Prisma whose datasource is `provider`, with a seed and a client module. */
async function prismaApp(provider: string): Promise<string> {
  const dir = await nextApp(false);
  const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
  pkg.dependencies["@prisma/client"] = "^5.22.0";
  pkg.prisma = { seed: "tsx prisma/seed.ts" };
  await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(pkg));
  await Deno.mkdir(join(dir, "prisma"));
  await Deno.writeTextFile(
    join(dir, "prisma/schema.prisma"),
    `datasource db {\n  provider = "${provider}"\n  url      = env("DATABASE_URL")\n}\n`,
  );
  const client =
    `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();\n`;
  await Deno.writeTextFile(join(dir, "prisma/seed.ts"), client);
  await Deno.writeTextFile(join(dir, "app/db.ts"), client);
  return dir;
}

for (
  const [provider, mode, adapter, setup] of [
    ["sqlite", "npm", "@prisma/adapter-better-sqlite3", "bundles the compat, installs"],
    ["postgresql", "npm", "@prisma/adapter-pg", "(installs, `prisma generate`"],
    ["sqlserver", "npm", null, "(installs, `prisma generate`"],
    ["sqlite", "deno-sql", "denext/prisma-adapter", "(installs, `prisma generate`"],
    ["postgresql", "deno-sql", "denext/prisma-adapter", "(installs, `prisma generate`"],
  ] as const
) {
  Deno.test(`migrate reports the Prisma wiring for a ${provider} datasource (${mode})`, async () => {
    const dir = await prismaApp(provider);
    const cap = capture();
    try {
      await migrateCommand.run(makeCtx({ positionals: [dir], flags: { "prisma-adapter": mode } }));
    } finally {
      cap.restore();
      await Deno.remove(dir, { recursive: true });
    }
    const out = cap.logs.join("\n");
    assertStringIncludes(out, `Prisma detected (${provider}) — wired to the ESM/Deno client`);
    if (adapter) assertStringIncludes(out, `+ ${adapter} driver adapter`);
    else assert(!out.includes("driver adapter (no"), "no adapter is claimed for an unwired one");
    assertStringIncludes(out, "seed + test tooling on the Deno client too");
    assertStringIncludes(out, "seed with `denext task prisma:seed`");
    assertStringIncludes(out, setup);
  });
}

Deno.test("migrate refuses an unknown --prisma-adapter", async () => {
  await assertRejects(
    async () =>
      await migrateCommand.run(makeCtx({ positionals: ["."], flags: { "prisma-adapter": "pg" } })),
    Error,
    "--prisma-adapter must be auto, deno-sql or npm",
  );
});

Deno.test("migrate on a Fresh app reports the generated tree, Tailwind and the findings", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_cli_fresh_" });
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({ imports: { fresh: "jsr:@fresh/core@^2.3.3" } }),
    "client.ts": `import "./assets/styles.css";\n`,
    "assets/styles.css": `@import "tailwindcss";\n`,
    "vite.config.ts": `import { fresh } from "@fresh/plugin-vite";\nimport x from "x";\n` +
      `export default { plugins: [fresh(), x()] };\n`,
    "routes/_app.tsx": `export default function App({ Component }) { return <Component />; }\n`,
    "routes/_layout.tsx": `export default function L({ Component }) { return <Component />; }\n`,
    "routes/index.tsx": `import { Partial } from "fresh/runtime";\n` +
      `export default function Home() { return <Partial name="p">home</Partial>; }\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "Fresh 2.x detected");
    assertStringIncludes(out, "tailwind: ./assets/styles.css → ./assets/styles.gen.css");
    assertStringIncludes(out, "won't migrate (1)");
    assertStringIncludes(out, "Fresh Partials");
    assertStringIncludes(out, "Fresh modules unchanged");
    // A root `_layout` runs inside the `_app` wrapper, both from app/layout.tsx.
    const root = await Deno.readTextFile(join(dir, "app/layout.tsx"));
    assertStringIncludes(root, "return await App({ children: await Layout({ children }) });");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate on a Preact app reports the tooling, the routers and the findings", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_cli_preact_" });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      dependencies: { preact: "^10.0.0", "preact-router": "^4.1.2" },
      devDependencies: { "@preact/preset-vite": "^2.10.6" },
    }),
    "vite.config.js":
      `import preact from "@preact/preset-vite";\nexport default { plugins: [preact()] };\n`,
    "index.html": `<div id="app"></div><script type="module" src="/src/index.jsx"></script>\n`,
    "src/index.jsx":
      `import { options, render } from "preact";\noptions.diffed = () => {};\nrender(<p />, document.body);\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(
      out,
      "Preact (vite) — SPA mode with Preact mapped to denext · routers: preact-router",
    );
    assertStringIncludes(out, "won't migrate (1)");
    assertStringIncludes(out, "preact options hooks");
    assertStringIncludes(out, "Source unchanged: `preact`");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

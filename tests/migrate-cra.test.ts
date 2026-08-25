// `denext migrate` for Create React App and generic React SPAs. CRA and generic
// apps are SPA-shaped, so they reuse the Vite SPA machinery (mode:"spa" +
// denext.config.ts + react→denext aliases) but read entry/env from their own
// conventions: CRA from public/index.html + process.env.REACT_APP_*, generic from a
// root index.html. Also covers the `--from` override.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";

async function write(dir: string, path: string, content: string): Promise<void> {
  const full = join(dir, path);
  await Deno.mkdir(join(full, ".."), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function craFixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_cra_" });
  await write(
    dir,
    "package.json",
    JSON.stringify({
      name: "cra-app",
      dependencies: { react: "^18", "react-dom": "^18", axios: "^1" },
      devDependencies: { "react-scripts": "5.0.1" },
    }),
  );
  await write(dir, "public/index.html", "<html><head><title>My CRA App</title></head></html>");
  await write(dir, "src/index.tsx", `import App from "./App";\n`);
  await write(
    dir,
    "src/App.tsx",
    `export default function App() {\n  return <div>{process.env.REACT_APP_API_URL}</div>;\n}\n`,
  );
  return dir;
}

Deno.test("migrate CRA: mode:spa config, entry, title, REACT_APP_ env, react aliases", async () => {
  const dir = await craFixture();
  try {
    const r = await migrateProject(dir);
    assertEquals(r.kind, "cra");
    assert(r.spa, "spa info present");
    assertEquals(r.spa!.entry, "./src/index.tsx");
    assertEquals(r.spa!.title, "My CRA App");
    assertEquals(r.spa!.envKeys, ["REACT_APP_API_URL"]);

    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(cfg.includes('mode: "spa"'), "config is SPA mode");
    assert(cfg.includes("REACT_APP_API_URL"), "env key threaded into config");

    const denoJson = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assert(String(denoJson.imports["react"]).includes("@denext/denext"), "react → denext");
    // react-scripts is not passed through as an npm dep (it's the CRA toolchain).
    assert(!("react-scripts" in denoJson.imports), "react-scripts not aliased/passed");
    // A real runtime dep is passed through (auto nodeModulesDir).
    assert(String(denoJson.imports["axios"]).startsWith("npm:"), "axios passthrough");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate generic React SPA (react + root index.html, no framework config)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_generic_" });
  try {
    await write(
      dir,
      "package.json",
      JSON.stringify({ name: "generic", dependencies: { react: "^18", "react-dom": "^18" } }),
    );
    await write(
      dir,
      "index.html",
      "<html><head><title>Generic</title></head><body>" +
        '<script type="module" src="/src/main.tsx"></script></body></html>',
    );
    await write(dir, "src/main.tsx", "console.log('app');\n");
    const r = await migrateProject(dir);
    assertEquals(r.kind, "generic");
    assertEquals(r.spa!.entry, "./src/main.tsx");
    assertEquals(r.spa!.title, "Generic");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--from next forces the Next path even for a CRA-shaped app", async () => {
  const dir = await craFixture();
  try {
    const r = await migrateProject(dir, { from: "next" });
    assertEquals(r.kind, "next");
    // Next path emits no spa info and a Next-style deno.json (jsxImportSource react).
    assertEquals(r.spa, undefined);
    const denoJson = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(denoJson.compilerOptions.jsxImportSource, "react");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--from cra forces the CRA path for an otherwise-ambiguous app", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_from_cra_" });
  try {
    // No react-scripts, no public/index.html — would be generic/Next by detection.
    await write(
      dir,
      "package.json",
      JSON.stringify({ name: "amb", dependencies: { react: "^18", "react-dom": "^18" } }),
    );
    await write(dir, "public/index.html", "<title>Forced</title>");
    await write(dir, "src/index.tsx", "");
    const r = await migrateProject(dir, { from: "cra" });
    assertEquals(r.kind, "cra");
    assertEquals(r.spa!.title, "Forced");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

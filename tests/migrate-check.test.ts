// `denext migrate --check`: the dry run of `denext migrate`.
//
// For every source `migrate` supports (Next App Router, Pages Router, Vite, CRA, a generic
// React SPA, Remix, React Router v7 framework mode, Expo, Fresh) these tests prove three things:
//   1. nothing is written: the project tree (paths, sizes, mtimes, contents) is identical
//      before and after the check;
//   2. the planned changes are exactly what the real migration does: the same fixture is
//      migrated for real in a second copy and its on-disk diff must equal the plan, file
//      contents included;
//   3. the report has the documented shape, including the `--json` CLI output, and a run with
//      read permission only succeeds.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import {
  checkMigration,
  type MigrateCheckReport,
  shellPathArg,
} from "../src/build/migrate-check.ts";
import { dryRunMigration, mfs, type PlannedChange } from "../src/build/migrate-io.ts";
import { migrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";
import { boundedOutput } from "./helpers/bounded-command.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));
const REMIX_FIXTURE = fromFileUrl(new URL("./fixtures/remix-app", import.meta.url));

type Tree = Record<string, unknown>;

/** Write `files` (relative path → contents; objects are JSON) under `root`. */
async function writeTree(root: string, files: Tree): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
}

/** A fresh temp dir (real path, so the reported target matches). */
async function tempDir(): Promise<string> {
  return await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_check_" }));
}

/** Every entry under `root`: path → kind, size, mtime and (for files) contents. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const full = join(dir, e.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      const info = await Deno.lstat(full);
      if (e.isDirectory) {
        out.set(rel + "/", `dir ${info.mtime?.getTime()}`);
        await walk(full);
      } else {
        const text = await Deno.readTextFile(full).catch(() => "<binary>");
        out.set(rel, `file ${info.size} ${info.mtime?.getTime()}\n${text}`);
      }
    }
  };
  await walk(root);
  return out;
}

/** File contents only (no metadata), for diffing a real run against the original. */
async function contents(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [k, v] of await snapshot(root)) {
    if (!k.endsWith("/")) out.set(k, v.slice(v.indexOf("\n") + 1));
  }
  return out;
}

/** The changes a real run made, from a before/after content diff, in the plan's shape. */
function realChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [p, text] of after) {
    if (!before.has(p)) out.push(`create ${p}\n${text}`);
    else if (before.get(p) !== text) out.push(`modify ${p}\n${text}`);
  }
  for (const p of before.keys()) if (!after.has(p)) out.push(`delete ${p}`);
  return out.sort();
}

/** The planned changes in the same shape (a move is a delete of its source plus a create). */
function planned(changes: PlannedChange[], before: Map<string, string>): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (c.action === "move") {
      out.push(`delete ${c.from}`, `create ${c.path}\n${before.get(c.from!)}`);
    } else if (c.action === "delete") {
      out.push(`delete ${c.path}`);
    } else {
      out.push(`${c.action} ${c.path}\n${c.content}`);
    }
  }
  return out.sort();
}

/**
 * Check the app (a fixture tree, or a directory to copy), proving no write happened and that the
 * plan equals a real migration of a second copy. Returns the report.
 */
async function checkAndCompare(
  app: Tree | string,
  options: Parameters<typeof migrateProject>[1] = {},
): Promise<MigrateCheckReport> {
  const a = await tempDir();
  const b = await tempDir();
  try {
    for (const dir of [a, b]) {
      if (typeof app === "string") await copy(app, dir, { overwrite: true });
      else await writeTree(dir, app);
    }
    const before = await snapshot(a);
    const report = await checkMigration(a, options);
    assertEquals(await snapshot(a), before, "migrate --check must not write anything");

    const { changes } = await dryRunMigration(a, () => migrateProject(a, options));
    assertEquals(await snapshot(a), before, "the dry run must not write anything");
    const original = await contents(b);
    await migrateProject(b, options);
    assertEquals(planned(changes, original), realChanges(original, await contents(b)));
    assertEquals(
      report.changes,
      changes.map(({ content: _c, ...rest }) => rest),
      "the report lists the dry run's changes",
    );
    return report;
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
}

const NEXT_APP: Tree = {
  "package.json": {
    name: "next-app",
    dependencies: {
      next: "15.3.0",
      react: "19.1.0",
      "react-dom": "19.1.0",
      zod: "3.24.0",
      canvas: "2.11.2",
    },
    devDependencies: { "@types/react": "19.1.0", tailwindcss: "4.1.0" },
  },
  "tsconfig.json": { compilerOptions: { paths: { "@/*": ["./*"] } } },
  "next.config.js":
    `module.exports = { basePath: "/docs", reactStrictMode: true, env: { A: "1" } };\n`,
  "app/globals.css": `@import "tailwindcss";\n`,
  "app/layout.tsx": `export default function L({ children }) { return children; }\n`,
  "app/page.tsx": `export default function P() { return process.env.NEXT_PUBLIC_X ?? null; }\n`,
  ".gitignore": "node_modules/\n",
};

Deno.test("migrate --check: Next App Router — plan equals the real run, nothing written", async () => {
  const r = await checkAndCompare(NEXT_APP);
  assertEquals(r.source, "next-app-router");
  assertEquals(r.verdict, "review");
  const actions = Object.fromEntries(r.changes.map((c) => [c.path, c.action]));
  assertEquals(actions["deno.json"], "create");
  assertEquals(actions["denext.config.ts"], "create");
  assertEquals(actions[".gitignore"], "modify");
  assert(r.dependencies!.flagged.some((f) => f.startsWith("canvas@")));
  assert(r.wontMigrate.some((f) => f.item.startsWith("canvas@")));
  // Keys with a denext equivalent are listed with it; inert keys are review notes.
  assert(r.wontMigrate.some((f) => f.item === "next.config.js: env"));
  assert(
    r.review.some((f) => f.item === "next.config.js: reactStrictMode") ||
      r.wontMigrate.some((f) => f.item === "next.config.js: reactStrictMode"),
  );
  assertEquals(r.command, "denext migrate");
});

Deno.test("migrate --check: Next App Router + Prisma — source rewrites are planned too", async () => {
  const r = await checkAndCompare({
    "package.json": {
      name: "prisma-app",
      dependencies: { next: "15.3.0", react: "19.1.0", "@prisma/client": "5.22.0" },
      devDependencies: { prisma: "5.22.0" },
    },
    "prisma/schema.prisma":
      `datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n\n` +
      `generator client {\n  provider = "prisma-client-js"\n}\n`,
    "app/db.server.ts":
      `import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();\n`,
    "app/page.tsx": `export default function P() { return null; }\n`,
  }, { denextLocalPath: REPO_ROOT });
  const paths = r.changes.map((c) => `${c.action} ${c.path}`);
  assert(paths.includes("modify prisma/schema.prisma"), paths.join("\n"));
  assert(paths.includes("modify app/db.server.ts"), paths.join("\n"));
  assert(paths.includes("modify package.json"), paths.join("\n"));
  assert(r.review.some((f) => f.item === "prisma"));
});

Deno.test("migrate --check: Next Pages Router", async () => {
  const r = await checkAndCompare({
    "package.json": { dependencies: { next: "14.2.0", react: "18.3.1", effect: "3.10.0" } },
    "pages/index.tsx": `export default function Home() { return null; }\n`,
  });
  assertEquals(r.source, "next-pages-router");
  assert(r.changes.some((c) => c.path === "denext.config.ts" && c.action === "create"));
});

Deno.test("migrate --check: a hand-authored deno.json and config are reported, not touched", async () => {
  const r = await checkAndCompare({
    "package.json": { dependencies: { next: "14.2.0", react: "18.3.1" } },
    "pages/index.tsx": `export default function Home() { return null; }\n`,
    "deno.json": { imports: {} },
    "denext.config.ts": `export default {};\n`,
  });
  assertEquals(r.verdict, "review");
  assert(!r.changes.some((c) => c.path === "deno.json" || c.path === "denext.config.ts"));
  assert(r.wontMigrate.some((f) => f.item === "deno.json"));
  const cfg = r.wontMigrate.find((f) => f.item === "denext.config.ts");
  assertStringIncludes(cfg!.reason, "pagesRouter()");
});

Deno.test("migrate --check: Vite SPA (with --desktop)", async () => {
  const r = await checkAndCompare({
    "package.json": {
      dependencies: { react: "19.1.0", "react-dom": "19.1.0" },
      devDependencies: { vite: "6.0.0", "@vitejs/plugin-react": "4.3.0" },
    },
    "vite.config.ts":
      `export default { server: { proxy: { "/api": "http://localhost:3000" } } };\n`,
    "index.html":
      `<!doctype html><html><head><title>Vite App</title></head><body><div id="root"></div>` +
      `<script type="module" src="/src/main.tsx"></script></body></html>\n`,
    "src/main.tsx": `document.getElementById("root"); console.log(import.meta.env.VITE_API);\n`,
  }, { desktop: true, backend: "http://127.0.0.1:3773" });
  assertEquals(r.source, "vite");
  assertEquals(r.verdict, "ready");
  assert(r.changes.some((c) => c.path === "desktop.ts" && c.action === "create"));
  assertEquals(r.command, "denext migrate --desktop --backend http://127.0.0.1:3773");
});

Deno.test("migrate --check: a Vite proxy built in code is a review item, not a silent /api", async () => {
  // T3 Code's shape: the proxy map is computed from a shared prefix list, so migrate can't
  // read its keys and falls back to `/api`. The check must say so (verdict review), else the
  // desktop app ships without `/ws` and never connects.
  const r = await checkAndCompare({
    "package.json": {
      dependencies: { react: "19.1.0", "react-dom": "19.1.0" },
      devDependencies: { vite: "6.0.0", "@vitejs/plugin-react": "4.3.0" },
    },
    "vite.config.ts": `const PREFIXES = ["/api", "/ws"];\n` +
      `export default { server: { proxy: Object.fromEntries(\n` +
      `  PREFIXES.map((p) => [p, { target: "http://localhost:3000", ws: true }]),\n` +
      `) } };\n`,
    "index.html":
      `<!doctype html><html><head><title>Vite App</title></head><body><div id="root"></div>` +
      `<script type="module" src="/src/main.tsx"></script></body></html>\n`,
    "src/main.tsx": `document.getElementById("root");\n`,
  }, { desktop: true, backend: "http://127.0.0.1:3773" });
  assertEquals(r.verdict, "review");
  const item = r.review.find((f) => f.item === "vite.config.ts: server.proxy");
  assert(item, `review lists the computed proxy: ${JSON.stringify(r.review)}`);
  assertStringIncludes(item.reason, "--proxy");
});

Deno.test("migrate --check: Create React App", async () => {
  const r = await checkAndCompare({
    "package.json": {
      dependencies: { react: "18.3.1", "react-dom": "18.3.1", "react-scripts": "5.0.1" },
    },
    "public/index.html": `<html><head><title>%PUBLIC_URL% CRA</title></head><body></body></html>\n`,
    "src/index.tsx": `console.log(process.env.REACT_APP_KEY);\n`,
  });
  assertEquals(r.source, "cra");
  assert(r.dependencies!.dropped.includes("react-scripts"));
});

Deno.test("migrate --check: a generic React SPA", async () => {
  const r = await checkAndCompare({
    "package.json": { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } },
    "index.html": `<html><head><title>Plain</title></head><body><div id="app"></div>` +
      `<script type="module" src="./src/main.tsx"></script></body></html>\n`,
    "src/main.tsx": `document.getElementById("app");\n`,
  });
  assertEquals(r.source, "generic-react");
});

Deno.test("migrate --check: Fresh — the generated app/, the moves and deletes are planned", async () => {
  const r = await checkAndCompare({
    "deno.json": {
      imports: { fresh: "jsr:@fresh/core@^2.3.3", preact: "npm:preact@^10.29.1" },
      compilerOptions: { jsx: "precompile", jsxImportSource: "preact" },
    },
    "vite.config.ts":
      `import { fresh } from "@fresh/plugin-vite";\nexport default { plugins: [fresh()] };\n`,
    "client.ts": `import "./assets/styles.css";\n`,
    "assets/styles.css": `body { margin: 0; }\n`,
    "routes/_app.tsx": `export default function App({ Component }) { return <Component />; }\n`,
    "routes/index.tsx": `export default function Home() { return <p>home</p>; }\n`,
    "routes/api/[name].ts": `export const handler = { GET: () => new Response("x") };\n`,
    "islands/Counter.tsx":
      `export default function Counter() { return <button type="button" />; }\n`,
    "static/logo.svg": "<svg/>\n",
  });
  assertEquals(r.source, "fresh");
  const actions = new Set(r.changes.map((c) => `${c.action} ${c.path}`));
  for (
    const change of [
      "create app/page.tsx",
      "create app/layout.tsx",
      "create app/api/[name]/route.ts",
      "create middleware.ts",
      "modify islands/Counter.tsx",
      "move public/logo.svg",
      "delete vite.config.ts",
      "delete client.ts",
      "modify deno.json",
    ]
  ) assert(actions.has(change), `${change}\n${JSON.stringify(r.changes, null, 2)}`);
});

Deno.test("migrate --check: Preact — the SPA config with the Preact aliases is planned", async () => {
  const r = await checkAndCompare({
    "package.json": {
      dependencies: { preact: "^11.0.0", "preact-iso": "^2.12.2" },
      devDependencies: { "@preact/preset-vite": "^2.10.6", vite: "^8.3.1" },
    },
    "vite.config.js":
      `import preact from "@preact/preset-vite";\nexport default { plugins: [preact()] };\n`,
    "index.html": `<div id="app"></div><script type="module" src="/src/index.jsx"></script>\n`,
    "src/index.jsx":
      `import { render } from "preact";\nrender(<p>hi</p>, document.getElementById("app"));\n`,
  });
  assertEquals(r.source, "preact");
  const actions = new Set(r.changes.map((c) => `${c.action} ${c.path}`));
  assert(actions.has("create denext.config.ts") && actions.has("create deno.json"));
});

Deno.test("migrate --check: Remix — the route-tree transform (creates, deletes) is planned", async () => {
  const r = await checkAndCompare(REMIX_FIXTURE);
  assertEquals(r.source, "remix");
  const actions = new Set(r.changes.map((c) => `${c.action} ${c.path}`));
  assert(actions.has("delete app/root.tsx"));
  assert(actions.has("create app/layout.tsx"));
  assert(actions.has("delete app/entry.server.tsx"));
  assert(r.review.some((f) => f.item === "remix route tree"));
});

Deno.test("migrate --check: Remix colocated modules are planned as moves", async () => {
  const r = await checkAndCompare({
    "package.json": {
      dependencies: { "@remix-run/react": "2.15.0", "@remix-run/node": "2.15.0", react: "18.3.1" },
    },
    "app/root.tsx": `export default function Root() { return null; }\n`,
    "app/routes/_index.tsx": `import { helper } from "./helper.server";\n` +
      `export async function loader() { return helper(); }\n` +
      `export default function Index() { return null; }\n`,
    "app/routes/helper.server.ts": `export const helper = () => 1;\n`,
  });
  assert(
    r.changes.some((c) =>
      c.action === "move" && c.path === "app/_routes/helper.server.ts" &&
      c.from === "app/routes/helper.server.ts"
    ),
    JSON.stringify(r.changes, null, 2),
  );
});

Deno.test("migrate --check --codemod: a Remix plan says it reads the pre-migration tree", async () => {
  const dir = await tempDir();
  try {
    await copy(REMIX_FIXTURE, dir, { overwrite: true });
    const out = capture();
    try {
      await migrateCommand.run(
        makeCtx({ positionals: [dir], flags: { check: true, codemod: true } }),
      );
    } finally {
      out.restore();
    }
    assertStringIncludes(
      out.logs.join("\n"),
      "the codemod plan lists files at their current paths",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate --check: the suggested command keeps --denext-local-path", async () => {
  const dir = await tempDir();
  try {
    await writeTree(dir, NEXT_APP);
    const r = await checkMigration(dir, { denextLocalPath: REPO_ROOT, from: "next" });
    assertStringIncludes(r.command, "--from next");
    assertStringIncludes(r.command, `--denext-local-path ${REPO_ROOT}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate --check: a project at a filesystem root gets clean relative paths", async () => {
  // `/` (or `C:\\`) already ends in the separator; appending another made every path absolute.
  const root = Deno.build.os === "windows" ? "C:\\" : "/";
  const target = join(root, `denext-root-check-${crypto.randomUUID()}.txt`);
  const { changes } = await dryRunMigration(root, () => mfs.writeTextFile(target, "x"));
  assertEquals(changes.map((c) => c.path), [target.slice(root.length)]);
});

Deno.test("migrate --check: React Router v7 framework mode", async () => {
  const r = await checkAndCompare({
    "package.json": {
      dependencies: { react: "19.1.0", "react-router": "7.1.0", "@react-router/node": "7.1.0" },
    },
    "react-router.config.ts": `export default { ssr: true };\n`,
    "app/routes.ts": `import { index } from "@react-router/dev/routes";\n` +
      `export default [index("routes/home.tsx")];\n`,
    "app/root.tsx": `export default function Root() { return null; }\n`,
    "app/routes/home.tsx": `export default function Home() { return null; }\n`,
  });
  assertEquals(r.source, "react-router");
  // Config routing runs on the plugin: the app's source is untouched.
  assert(r.changes.every((c) => !c.path.startsWith("app/")));
});

Deno.test("migrate --check: Expo — native-only packages and prebuild output are findings", async () => {
  const r = await checkAndCompare({
    "package.json": {
      name: "expo-app",
      dependencies: {
        expo: "~53.0.0",
        react: "19.0.0",
        "react-native": "0.79.0",
        "react-native-nitro-thing": "1.0.0",
      },
    },
    "node_modules/react-native-nitro-thing/package.json": {
      name: "react-native-nitro-thing",
      version: "1.0.0",
    },
    "node_modules/react-native-nitro-thing/nitro.json": "{}",
    "app.json": { expo: { name: "Expo App", slug: "expo-app" } },
    "App.tsx": `export default function App() { return null; }\n`,
    "ios/Podfile": "",
  });
  assertEquals(r.source, "expo");
  assert(r.changes.some((c) => c.path === "capacitor.config.ts" && c.action === "create"));
  assert(r.review.some((f) => f.item === "ios/"), JSON.stringify(r.review));
  assert(r.review.some((f) => f.item === "react-native-web"));
});

Deno.test("migrate --check: Expo — one native SDK recipe note per Firebase / IAP / Stripe package", async () => {
  const r = await checkAndCompare({
    "package.json": {
      name: "expo-app",
      dependencies: {
        expo: "~53.0.0",
        react: "19.0.0",
        "react-native": "0.79.0",
        "@react-native-firebase/app": "22.0.0",
        "@react-native-firebase/messaging": "22.0.0",
        "@stripe/stripe-react-native": "0.45.0",
        "react-native-iap": "14.0.0",
      },
    },
    // Installed and native-only (Nitro): listed once, with its recipe, not twice.
    "node_modules/react-native-iap/package.json": { name: "react-native-iap", version: "14.0.0" },
    "node_modules/react-native-iap/nitro.json": "{}",
    "app.json": { expo: { name: "Expo App", slug: "expo-app" } },
    "App.tsx": `export default function App() { return null; }\n`,
  });
  const url = "https://denext.dev/docs/native-sdk-recipes";
  const firebase = "native-only, with no alias in React Native mode; Firebase: push through " +
    "`denext mobile add push` and `sendPush`, the Firebase JS SDK for auth, Firestore and the " +
    `rest; see ${url}`;
  assertEquals(r.wontMigrate.filter((f) => !f.item.startsWith("app config")), [
    { item: "@react-native-firebase/app", reason: firebase },
    { item: "@react-native-firebase/messaging", reason: firebase },
    {
      item: "@stripe/stripe-react-native",
      reason: "native-only, with no alias in React Native mode; Stripe: Stripe.js and the " +
        `Payment Element in the WebView, or a Capacitor Stripe plugin; see ${url}`,
    },
    {
      item: "react-native-iap",
      reason: "native-only, with no alias in React Native mode; in-app purchases: " +
        "`denext mobile add purchases` (RevenueCat), or a Capacitor billing plugin; " +
        `see ${url}`,
    },
  ]);
});

Deno.test("migrate --check: a migration that would fail is reported as blocked", async () => {
  const dir = await tempDir();
  try {
    const empty = await checkMigration(dir);
    assertEquals(empty.verdict, "blocked");
    assertEquals(empty.source, null);
    assertStringIncludes(empty.error!, "no package.json");

    await writeTree(dir, {
      "package.json": { dependencies: { next: "15.0.0", react: "19.0.0" } },
      ".pnp.cjs": "",
    });
    const before = await snapshot(dir);
    const pnp = await checkMigration(dir);
    assertEquals(pnp.verdict, "blocked");
    assertStringIncludes(pnp.error!, "Plug'n'Play");
    assertEquals(await snapshot(dir), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The keys and value types of the `--json` report (the documented contract). */
function assertReportShape(json: Record<string, unknown>): void {
  assertEquals(
    Object.keys(json).sort(),
    [
      "changes",
      "command",
      "denext",
      "dependencies",
      "review",
      "schema",
      "source",
      "target",
      "verdict",
      "wontMigrate",
    ],
  );
  assertEquals(json.schema, "denext.migrate-check/1");
  assert(["ready", "review", "blocked"].includes(json.verdict as string));
  for (const c of json.changes as Array<Record<string, unknown>>) {
    assert(["create", "modify", "delete", "move"].includes(c.action as string));
    assertEquals(typeof c.path, "string");
    assert(!("content" in c), "the JSON report carries no file contents");
  }
  for (const list of [json.wontMigrate, json.review] as Array<Array<Record<string, unknown>>>) {
    for (const f of list) assertEquals(Object.keys(f).sort(), ["item", "reason"]);
  }
  const deps = json.dependencies as Record<string, unknown>;
  assertEquals(Object.keys(deps).sort(), ["aliased", "dropped", "flagged", "passthrough"]);
}

Deno.test("migrate --check --json: the CLI prints the report and writes nothing", async () => {
  const dir = await tempDir();
  try {
    await writeTree(dir, NEXT_APP);
    const before = await snapshot(dir);
    const out = capture();
    try {
      await migrateCommand.run(
        makeCtx({ positionals: [dir], flags: { check: true }, global: { json: true } }),
      );
    } finally {
      out.restore();
    }
    const json = JSON.parse(out.logs.join("\n"));
    assertReportShape(json);
    assertEquals(json.target, dir);
    assertEquals(json.source, "next-app-router");
    assertEquals(await snapshot(dir), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate --check: the human report, --codemod plan, and exit 1 when blocked", async () => {
  const dir = await tempDir();
  try {
    await writeTree(dir, {
      ...NEXT_APP,
      "app/page.tsx": `import { useState } from "react";\nexport default function P() {}\n`,
    });
    const before = await snapshot(dir);
    const out = capture();
    try {
      await migrateCommand.run(
        makeCtx({ positionals: [dir], flags: { check: true, codemod: true } }),
      );
    } finally {
      out.restore();
    }
    const text = out.logs.join("\n");
    assertStringIncludes(text, "source: next-app-router");
    assertStringIncludes(text, "create deno.json");
    assertStringIncludes(text, "won't migrate");
    assertStringIncludes(text, "Nothing was written. To migrate: denext migrate");
    assertStringIncludes(text, "react → denext");
    assertEquals(await snapshot(dir), before);

    const json = capture();
    try {
      await migrateCommand.run(
        makeCtx({
          positionals: [dir],
          flags: { check: true, codemod: true },
          global: { json: true },
        }),
      );
    } finally {
      json.restore();
    }
    assert("codemod" in JSON.parse(json.logs.join("\n")));
    assertEquals(await snapshot(dir), before);

    await Deno.remove(join(dir, "package.json"));
    const exit = stubExit();
    const blocked = capture();
    try {
      await Promise.resolve(
        migrateCommand.run(makeCtx({ positionals: [dir], flags: { check: true } })),
      )
        .catch((e: Error) => assertStringIncludes(e.message, "__exit__1"));
    } finally {
      blocked.restore();
      exit.restore();
    }
    assertEquals(exit.calls, [1]);
    assertStringIncludes(blocked.logs.join("\n"), "blocked: no package.json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "migrate --check: runs with read permission only (no --allow-write)",
  async fn() {
    const dir = await tempDir();
    try {
      await writeTree(dir, NEXT_APP);
      const before = await snapshot(dir);
      const out = await boundedOutput(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          "--allow-read",
          "--allow-env",
          join(REPO_ROOT, "cli.ts"),
          "migrate",
          "--check",
          "--json",
          dir,
        ],
      });
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      const json = JSON.parse(new TextDecoder().decode(out.stdout));
      assertReportShape(json);
      assertEquals(json.source, "next-app-router");
      // Without --allow-run the next.config can't be evaluated; the report says that, and does
      // not claim its keys (basePath here) won't migrate.
      const item = (f: { item: string }) => f.item.startsWith("next.config.js");
      assertEquals(json.wontMigrate.filter(item), []);
      const cfg = json.review.find(item);
      assertStringIncludes(cfg.reason, "couldn't evaluate next.config (needs --allow-run)");
      assertEquals(await snapshot(dir), before);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "migrate --check: with --allow-run the next.config is evaluated (basePath carries)",
  async fn() {
    const dir = await tempDir();
    try {
      await writeTree(dir, NEXT_APP);
      const before = await snapshot(dir);
      const out = await boundedOutput(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          "--allow-read",
          "--allow-env",
          "--allow-run",
          join(REPO_ROOT, "cli.ts"),
          "migrate",
          "--check",
          "--json",
          dir,
        ],
      });
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      const json = JSON.parse(new TextDecoder().decode(out.stdout));
      const items = [...json.wontMigrate, ...json.review].map((f: { item: string }) => f.item);
      assert(!items.includes("next.config.js"), `next.config.js was not evaluated: ${items}`);
      assert(!items.includes("next.config.js: basePath"), "basePath is carried over");
      assertEquals(await snapshot(dir), before);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("shellPathArg: a path as the user's shell reads it back", () => {
  // Windows: backslashes stay single (cmd and PowerShell read them literally).
  assertEquals(shellPathArg("C:\\Users\\me\\denext\\", "windows"), "C:\\Users\\me\\denext\\");
  assertEquals(shellPathArg("C:\\My Code\\denext", "windows"), '"C:\\My Code\\denext"');
  // POSIX: single quotes when anything is special, a quote closed and reopened.
  assertEquals(shellPathArg("/home/me/denext/", "linux"), "/home/me/denext/");
  assertEquals(shellPathArg("/home/me/my code", "darwin"), "'/home/me/my code'");
  assertEquals(shellPathArg("/tmp/it's", "linux"), "'/tmp/it'\\''s'");
  assertEquals(shellPathArg("/tmp/a\\b$c", "linux"), "'/tmp/a\\b$c'");
});

Deno.test("migrate: a next.config rule that reads a machine path is left out, never inlined", async () => {
  const dir = await tempDir();
  try {
    await writeTree(dir, {
      "package.json": { name: "paths", dependencies: { next: "15.3.0", react: "19.1.0" } },
      "next.config.mjs": `export default {
  async redirects() {
    return [
      { source: "/cache", destination: "/files" + (process.env.HOME ?? "") + "/x", permanent: false },
      { source: "/old", destination: "/new", permanent: true },
    ];
  },
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "x-tmp", value: String(Deno.env.get("TMPDIR")) }] }];
  },
};
`,
      "app/layout.tsx": `export default function L({ children }) { return children; }\n`,
      "app/page.tsx": `export default function P() { return null; }\n`,
    });
    await migrateProject(dir, {});
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    // The plain rule is inlined; the one reading HOME is not, and neither is this machine's path.
    assertStringIncludes(config, '"source":"/old"');
    assert(!config.includes('"source":"/cache"'), config);
    assert(!config.includes("__denext_machine_env_"), config);
    const home = Deno.env.get("HOME");
    if (home) assert(!config.includes(home), config);
    assertStringIncludes(config, "// redirects: a rule or value reads HOME");
    assertStringIncludes(config, "// headers: a rule or value reads TMPDIR");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

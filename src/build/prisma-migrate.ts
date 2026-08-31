// Prisma wiring for `denext migrate`. Prisma's default client ships a native Rust query
// engine that does not bundle under Deno, so an unmodified `@prisma/client` app can't run
// on denext as-is. denext's supported path (see examples/prisma) is Prisma 6's ESM,
// Deno-runtime client (`generator client { provider = "prisma-client"; runtime = "deno" }`)
// talking to Deno's built-in `node:sqlite` through the `@prisma/adapter-better-sqlite3`
// driver adapter, with the adapter's native `better-sqlite3` dependency substituted for a
// bundled copy of denext's compat via deno.json `links`.
//
// This module makes `denext migrate` emit that whole path automatically: it (1) contributes
// the deno.json wiring (manual node_modules + links + the adapter/client npm pins), (2)
// rewrites the app's `prisma/schema.prisma` generator to the Deno client, (3) rewrites every
// `@prisma/client` import to the generated client and injects the driver adapter at each
// `new PrismaClient()` site, (4) drops the superseded `@prisma/client`/`prisma` entries from
// package.json (they'd otherwise pin the native v5 client into node_modules and clash with
// the v6 adapter), and (5) writes the `links` patch package + a one-shot `prisma:setup` task
// (bundle the compat → install → `prisma generate` → `prisma db push`). After setup the app
// runs on real Prisma with zero hand edits — no stub.

import { dirname, join, relative } from "@std/path";

/** Prisma 6 line: the first release with the ESM/Deno `prisma-client` generator + GA driver adapters. */
const PRISMA_VERSION = "6.7.0";
/** The `better-sqlite3` version the patch package advertises (matches examples/prisma). */
const BETTER_SQLITE3_VERSION = "11.10.0";
/** Where the Deno client is generated (relative to the app root); the schema's `output` is `../generated/client`. */
const GENERATED_CLIENT = "generated/client/client.ts";
/** The `links` patch package directory (relative to the app root). */
const PATCH_DIR = "patch/better-sqlite3";
const SETUP_SCRIPT = "scripts/denext-prisma-setup.ts";
const SETUP_TASK = "prisma:setup";

/** Summary of what the Prisma transform did (for the CLI report). */
export interface PrismaMigrateInfo {
  /** The `prisma/schema.prisma` (relative) whose generator was rewritten to the Deno client. */
  schemaPath: string;
  /** Modules (relative) where a `new PrismaClient()` was rewired to the driver adapter. */
  clientModules: string[];
  /** Files (relative) whose `@prisma/client` import was repointed at the generated client. */
  refsRewritten: string[];
  /** `@prisma/client`/`prisma` were removed from package.json (superseded by the deno.json pins). */
  packageJsonEdited: boolean;
  /** The task the user must run once before build/start. */
  setupTask: string;
  /** `new PrismaClient()` sites (or refs) the transform could not rewrite automatically. */
  warnings: string[];
}

/** deno.json fragments + a deferred source transform contributed by Prisma wiring. */
export interface PrismaWiring {
  /** import-map entries to add (the adapter + the `@prisma/client` runtime pin). */
  importsToAdd: Record<string, string>;
  /** import-map keys to remove — `better-sqlite3` resolves via `links`, not the `.ts` alias
   * (an npm-internal require of the compat's `.ts` fails with "Loading unprepared module"). */
  importsToDelete: string[];
  /** deno.json `links` entries. */
  links: string[];
  /** extra deno.json tasks (`prisma:setup`). */
  tasks: Record<string, string>;
  /** Prisma needs Deno to resolve the generated client + adapter from a real node_modules. */
  nodeModulesDir: "manual";
  /** Reported names (for the migrate summary's passthrough list). */
  handledDeps: string[];
  /** Run AFTER deno.json (and any route transform) is written: rewrites schema + source,
   * emits the patch package + setup script, edits package.json. Returns the report. */
  finalize: () => Promise<PrismaMigrateInfo>;
}

/** True for a dependency this module supersedes (pinned/handled here, not passed through raw). */
export function isPrismaDep(name: string): boolean {
  return name === "prisma" || name.startsWith("@prisma/");
}

/**
 * Detect a Prisma app and, when found, return the wiring it needs. Prisma is present when the
 * app depends on `@prisma/client` or carries a `prisma/schema.prisma`. `compatSpecifier` is the
 * specifier the generated setup script bundles denext's `better-sqlite3` compat from (a
 * `jsr:@denext/denext@…/better-sqlite3` on the published path, a `file://` in local-path mode).
 */
export async function detectPrismaWiring(
  dir: string,
  deps: Record<string, string>,
  compatSpecifier: string,
): Promise<PrismaWiring | null> {
  const schemaAbs = join(dir, "prisma", "schema.prisma");
  const hasSchema = await fileExists(schemaAbs);
  if (!("@prisma/client" in deps) && !hasSchema) return null;

  return {
    importsToAdd: {
      "@prisma/client": `npm:@prisma/client@${PRISMA_VERSION}`,
      "@prisma/adapter-better-sqlite3": `npm:@prisma/adapter-better-sqlite3@${PRISMA_VERSION}`,
    },
    importsToDelete: ["better-sqlite3"],
    links: [`./${PATCH_DIR}`],
    tasks: { [SETUP_TASK]: `deno run -A ${SETUP_SCRIPT}` },
    nodeModulesDir: "manual",
    handledDeps: Object.keys(deps).filter(isPrismaDep),
    finalize: () => transformPrismaApp(dir, compatSpecifier, schemaAbs, hasSchema),
  };
}

/** The actual filesystem transform (deferred so it runs after deno.json is written). */
async function transformPrismaApp(
  dir: string,
  compatSpecifier: string,
  schemaAbs: string,
  hasSchema: boolean,
): Promise<PrismaMigrateInfo> {
  const warnings: string[] = [];
  const clientModules: string[] = [];
  const refsRewritten: string[] = [];

  // 1. Rewrite the schema generator to the ESM/Deno client (the query-compiler client with
  //    no Rust engine binary). Leave the datasource block untouched.
  let schemaPath = relative(dir, schemaAbs);
  if (hasSchema) {
    await rewriteSchema(schemaAbs, warnings);
  } else {
    schemaPath = "prisma/schema.prisma";
    warnings.push(
      'no prisma/schema.prisma found — add a `generator client { provider = "prisma-client"; ' +
        'runtime = "deno"; moduleFormat = "esm"; output = "../generated/client" }` block by hand.',
    );
  }

  // 2 & 3. Rewrite `@prisma/client` imports across the app to the generated Deno client, and
  //         inject the driver adapter at each construction site.
  for (const file of await collectSourceFiles(dir)) {
    const original = await Deno.readTextFile(file);
    if (!original.includes("@prisma/client") && !original.includes("new PrismaClient")) {
      continue;
    }
    let text = original;
    const rel = relToGenerated(dir, file);

    if (/["']@prisma\/client["']/.test(text)) {
      text = text.replace(/(["'])@prisma\/client\1/g, `"${rel}"`);
      refsRewritten.push(relative(dir, file));
    }

    if (/new\s+PrismaClient\s*\(/.test(text)) {
      const injected = injectAdapter(text, rel, warnings, relative(dir, file));
      text = injected;
      clientModules.push(relative(dir, file));
    }

    if (text !== original) await Deno.writeTextFile(file, text);
  }

  // 4. Drop the superseded prisma deps from package.json so `deno install` materializes the
  //    v6 client/adapter (pinned in deno.json) rather than the native v5 client.
  const packageJsonEdited = await stripPrismaFromPackageJson(join(dir, "package.json"));

  // 5. The `links` patch package (its index.mjs is bundled by the setup script) + the setup
  //    script + gitignore for the generated + bundled artifacts.
  await writePatchPackage(dir);
  await writeSetupScript(dir, compatSpecifier);
  await appendGitignore(dir, ["generated/", `${PATCH_DIR}/index.mjs`]);

  return {
    schemaPath,
    clientModules,
    refsRewritten,
    packageJsonEdited,
    setupTask: SETUP_TASK,
    warnings,
  };
}

/** Replace the `generator client { … }` block with the ESM/Deno client generator. */
async function rewriteSchema(schemaAbs: string, warnings: string[]): Promise<void> {
  const src = await Deno.readTextFile(schemaAbs);
  // `queryCompiler` + `driverAdapters`: the Rust-free query compiler (no native engine
  // binary) driven through the better-sqlite3 driver adapter. Without them, the generator
  // emits the library engine — which needs a native `.node` binary AND rejects `{ adapter }`
  // ("driverAdapters preview feature not enabled") under Deno.
  const denoBlock = `generator client {
  provider        = "prisma-client"
  output          = "../generated/client"
  runtime         = "deno"
  moduleFormat    = "esm"
  previewFeatures = ["queryCompiler", "driverAdapters"]
}`;
  if (/runtime\s*=\s*"deno"/.test(src) && /queryCompiler/.test(src)) {
    return; // already the Rust-free Deno client (idempotent re-run)
  }
  const block = /generator\s+client\s*\{[\s\S]*?\n\}/;
  if (block.test(src)) {
    await Deno.writeTextFile(schemaAbs, src.replace(block, denoBlock));
  } else {
    // No `generator client` block — append one (a schema can omit it and rely on defaults).
    await Deno.writeTextFile(schemaAbs, `${src.trimEnd()}\n\n${denoBlock}\n`);
    warnings.push("prisma/schema.prisma had no `generator client` block — appended the Deno one.");
  }
}

/**
 * Inject the driver adapter into a module that constructs `PrismaClient`: add the adapter
 * import + a render-once adapter factory right after the (already-repointed) client import,
 * and thread `adapter` into every `new PrismaClient(...)`. A construction whose argument is
 * neither empty nor an object literal is left as-is with a warning.
 */
function injectAdapter(
  text: string,
  generatedRel: string,
  warnings: string[],
  relFile: string,
): string {
  const helper =
    `import { PrismaBetterSQLite3 as __PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
// Prisma resolves a sqlite \`file:\` path relative to the schema dir (prisma/); the runtime
// adapter resolves it relative to CWD — so normalize to a prisma/-prefixed, CWD-relative path.
const __denextDbUrl = (() => {
  const p = (Deno.env.get("DATABASE_URL") ?? "file:./prisma/data.db").replace(/^file:/, "").replace(/\\?.*$/, "");
  return \`file:\${p.startsWith("/") || /(^|\\/)prisma\\//.test(p) ? p : "./prisma/" + p.replace(/^\\.?\\//, "")}\`;
})();
const __denextPrismaAdapter = () => new __PrismaBetterSQLite3({ url: __denextDbUrl });`;

  // Place the helper right after the import that pulls in PrismaClient (now repointed at the
  // generated client), so the factory's import is in scope; fall back to the top of the file.
  const importLine = new RegExp(
    `^.*import[^\\n]*PrismaClient[^\\n]*from\\s*["']${escapeRe(generatedRel)}["'];?[^\\n]*$`,
    "m",
  );
  if (importLine.test(text)) {
    text = text.replace(importLine, (m) => `${m}\n${helper}`);
  } else {
    text = `${helper}\n${text}`;
  }

  // Thread `adapter` into each construction in ONE pass (an empty `()` becomes an object;
  // an existing `({ … })` gets the adapter merged in) — a two-pass replace would double it.
  text = text.replace(
    /new\s+PrismaClient\s*\(\s*(\)|\{)/g,
    (_m, brace: string) =>
      brace === ")"
        ? "new PrismaClient({ adapter: __denextPrismaAdapter() })"
        : "new PrismaClient({ adapter: __denextPrismaAdapter(),",
  );
  // Any remaining construction takes a non-object arg (a spread/variable) we can't safely merge.
  if (/new\s+PrismaClient\s*\(\s*[^){\s]/.test(text)) {
    warnings.push(
      `${relFile}: a \`new PrismaClient(<arg>)\` call takes a non-object argument — add ` +
        "`adapter: new PrismaBetterSQLite3({ url })` to it by hand.",
    );
  }
  return text;
}

/** Remove `@prisma/client` and `prisma` from package.json deps/devDeps. Returns whether it changed. */
async function stripPrismaFromPackageJson(pkgPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(pkgPath);
  } catch {
    return false;
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return false;
  }
  let changed = false;
  for (const field of ["dependencies", "devDependencies"]) {
    const block = pkg[field] as Record<string, string> | undefined;
    if (!block) continue;
    for (const name of Object.keys(block)) {
      if (name === "@prisma/client" || name === "prisma") {
        delete block[name];
        changed = true;
      }
    }
  }
  if (changed) {
    // Preserve the file's indentation style where obvious (2-space default).
    await Deno.remove(pkgPath).catch(() => {}); // unlink a possible symlink (cloned repos)
    await Deno.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  return changed;
}

/** Write the `links` patch package.json (its index.mjs is produced by the setup bundle step). */
async function writePatchPackage(dir: string): Promise<void> {
  const pkgDir = join(dir, PATCH_DIR);
  await Deno.mkdir(pkgDir, { recursive: true });
  await Deno.writeTextFile(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "better-sqlite3",
        version: BETTER_SQLITE3_VERSION,
        type: "module",
        main: "index.mjs",
      },
      null,
      2,
    ) + "\n",
  );
}

/** Write the one-shot setup script (bundle compat → install → generate → db push). */
async function writeSetupScript(dir: string, compatSpecifier: string): Promise<void> {
  const script =
    `// generated by \`denext migrate\` — safe to edit; re-running migrate may overwrite.
// One-time Prisma setup for denext: substitute denext's node:sqlite compat for the adapter's
// native \`better-sqlite3\` (bundled into the \`links\` package), install, then generate the
// ESM/Deno Prisma client and create the database schema. Run: \`deno task ${SETUP_TASK}\`.

const DENO = Deno.execPath();
const COMPAT_SRC = ${JSON.stringify(compatSpecifier)};
const SHIM_OUT = ${JSON.stringify(`${PATCH_DIR}/index.mjs`)};
const DATABASE_URL = Deno.env.get("DATABASE_URL") ?? "file:./data.db";

async function run(step: string, args: string[], env?: Record<string, string>): Promise<void> {
  console.log(\`\\n▸ \${step}\`);
  const { success } = await new Deno.Command(DENO, { args, env, stdout: "inherit", stderr: "inherit" })
    .output();
  if (!success) {
    console.error(\`\\n✗ setup failed at: \${step}\`);
    Deno.exit(1);
  }
}

// 1. Bundle the node:sqlite-backed compat into the links package (node:sqlite stays external —
//    it's a Deno builtin). \`--no-config\` avoids the app's manual node_modules (not installed yet).
await run("bundle the better-sqlite3 compat", [
  "bundle", "--no-config", "--format", "esm", "--external", "node:sqlite", "-o", SHIM_OUT, COMPAT_SRC,
]);
// 2. Install deps + apply the link (materializes the compat as \`better-sqlite3\`).
await run("install deps + apply the link", ["install"]);
// 3. Generate the ESM/Deno Prisma client + create the schema. Both run the prisma CLI with
//    \`--no-config\` so Deno resolves it from the global cache and ignores this app's deno.json
//    (its \`links\` field would otherwise force npm linking on every \`deno run\`, and the CLI
//    isn't in the manual node_modules). The generated client + adapter still use the app config.
await run("prisma generate", ["run", "-A", "--no-config", "npm:prisma@${PRISMA_VERSION}", "generate"], {
  DATABASE_URL,
});
await run("prisma db push", [
  "run", "-A", "--no-config", "npm:prisma@${PRISMA_VERSION}", "db", "push", "--skip-generate", "--accept-data-loss",
], { DATABASE_URL });

console.log("\\n✓ Prisma setup complete — run \`deno task build\` (or dev).");
`;
  await Deno.mkdir(join(dir, "scripts"), { recursive: true });
  await Deno.writeTextFile(join(dir, SETUP_SCRIPT), script);
}

/** Append entries to .gitignore under the denext marker (idempotent; symlink-safe). */
async function appendGitignore(dir: string, entries: string[]): Promise<void> {
  const path = join(dir, ".gitignore");
  let current = "";
  try {
    current = await Deno.readTextFile(path);
  } catch { /* none yet */ }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length === 0) return;
  const marker = "# denext generated build artifacts";
  const block = (have.has(marker) ? "" : `${marker}\n`) + missing.join("\n") + "\n";
  const lead = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await Deno.remove(path).catch(() => {});
  await Deno.writeTextFile(path, current + lead + block);
}

/** The relative specifier from `file`'s directory to the generated client entry. */
function relToGenerated(dir: string, file: string): string {
  let rel = relative(dirname(file), join(dir, GENERATED_CLIENT)).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/**
 * App RUNTIME source roots — the code denext actually bundles/serves. Deliberately excludes
 * `prisma/` (the Node seed script), plus `cypress/`, `test/`, `mocks/`, `scripts/` (test + tooling),
 * and the like: those legitimately use the native `@prisma/client` under the app's own Node
 * toolchain, which denext doesn't run, so rewriting them to the Deno client would corrupt them.
 */
const RUNTIME_ROOTS = ["app", "src", "lib", "components", "pages", "server", "routes"];

/** Collect runtime source files under {@link RUNTIME_ROOTS} (skips node_modules/dist/.denext/generated/out). */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (root: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(root)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        if (["node_modules", "dist", ".denext", "generated", ".git", "out"].includes(e.name)) {
          continue;
        }
        await walk(join(root, e.name));
      } else if (/\.(tsx?|jsx?|mts|mjs)$/.test(e.name)) {
        out.push(join(root, e.name));
      }
    }
  };
  for (const sub of RUNTIME_ROOTS) await walk(join(dir, sub));
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

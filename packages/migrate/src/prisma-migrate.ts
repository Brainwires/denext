// Prisma wiring for `denext migrate`. Prisma's default client ships a native Rust query
// engine that does not bundle under Deno, so an unmodified `@prisma/client` app can't run
// on denext as-is. denext's supported path (see examples/prisma) is Prisma 6's ESM,
// Deno-runtime client (`generator client { provider = "prisma-client"; runtime = "deno" }`)
// talking to Deno's built-in `node:sqlite` through the `@prisma/adapter-better-sqlite3`
// driver adapter, with the adapter's native `better-sqlite3` dependency substituted for a
// bundled copy of denext's compat via deno.json `links`.
//
// A Postgres or MySQL datasource takes the same path with that database's driver adapter
// instead: `@prisma/adapter-pg` (over the npm `pg` driver) or `@prisma/adapter-mariadb` (over
// the npm `mariadb` driver, which speaks MySQL too), and a SQL Server one `@prisma/adapter-mssql`
// (over the npm `mssql` driver). Those are pure-JS drivers on Deno's Node compat, so they need no
// `links` substitution and no bundled compat.
//
// On denext's Deno runtime 3.0.0-rc.1 and later, whose `Deno.SQL` reports each result
// column's type, a SQLite or Postgres datasource is wired to `denext/prisma-adapter` instead:
// Prisma's driver adapter over `Deno.SQL`, with no npm database driver, no `links` shim and no
// bundled compat (`MigrateOptions.prismaAdapter` / `--prisma-adapter` chooses explicitly).
//
// This module makes `denext migrate` emit that whole path automatically: it (1) contributes
// the deno.json wiring (manual node_modules + links + the adapter/client npm pins), (2)
// rewrites the app's `prisma/schema.prisma` generator to the Deno client, (3) rewrites every
// `@prisma/client` import to the generated client and injects the driver adapter at each
// `new PrismaClient()` site — in the runtime source AND the seed and test tooling, which then run
// on Deno too (the seed as `deno task prisma:seed` / `prisma db seed`, tests under
// `denext test`) — (4) drops the superseded `@prisma/client`/`prisma` entries from
// package.json (they'd otherwise pin the native v5 client into node_modules and clash with
// the v6 adapter), and (5) writes the `links` patch package + a one-shot `prisma:setup` task
// (bundle the compat → install → `prisma generate` → `prisma migrate deploy`/`db push`). After setup the app
// runs on real Prisma with zero hand edits — no stub.

import { dirname, join, relative } from "@std/path";
import { appendGitignore, mfs } from "@denext/denext/internal/migrate-host";

/** Prisma 6 line: the first release with the ESM/Deno `prisma-client` generator + GA driver adapters. */
const PRISMA_VERSION = "6.19.3";
/** The `better-sqlite3` version the patch package advertises (matches examples/prisma). */
const BETTER_SQLITE3_VERSION = "11.10.0";
/** Where the Deno client is generated (relative to the app root); the schema's `output` is `../generated/client`. */
const GENERATED_CLIENT = "generated/client/client.ts";
/** The `links` patch package directory (relative to the app root). */
const PATCH_DIR = "patch/better-sqlite3";
const SETUP_SCRIPT = "scripts/denext-prisma-setup.ts";
const SETUP_TASK = "prisma:setup";
const SEED_TASK = "prisma:seed";

/** The datasource providers denext wires a driver adapter for. */
export type PrismaProvider = "sqlite" | "postgresql" | "mysql" | "sqlserver";

/** The specifier the generated code imports `denext/prisma-adapter` by. */
const DENO_SQL_ADAPTER = "denext/prisma-adapter";

/** One datasource provider's driver adapter, as the transform injects it. */
interface DriverAdapter {
  provider: PrismaProvider;
  /** The package the injected code imports (npm, or {@link DENO_SQL_ADAPTER}). */
  pkg: string;
  /** Its import-map target (`npm:<pkg>@<PRISMA_VERSION>`, or denext's subpath). */
  target: string;
  /** The adapter factory class the package exports. */
  className: string;
  /** The injected factory (`__denextPrismaAdapter`), reading the URL from `envVar`. */
  helper(envVar: string): string;
}

/** The SQLite URL the runtime opens: Prisma's schema-relative `file:` path, CWD-relative. */
const SQLITE_URL =
  `// Prisma resolves a sqlite \`file:\` path relative to the schema dir (prisma/); the runtime
// adapter resolves it relative to CWD — so normalize to a prisma/-prefixed, CWD-relative path.
const __denextDbUrl = (() => {
  const p = (Deno.env.get("DATABASE_URL") ?? "file:./prisma/data.db").replace(/^file:/, "").replace(/\\?.*$/, "");
  return \`file:\${p.startsWith("/") || /(^|\\/)prisma\\//.test(p) ? p : "./prisma/" + p.replace(/^\\.?\\//, "")}\`;
})();`;

const SQLITE_ADAPTER: DriverAdapter = {
  provider: "sqlite",
  pkg: "@prisma/adapter-better-sqlite3",
  target: `npm:@prisma/adapter-better-sqlite3@${PRISMA_VERSION}`,
  className: "PrismaBetterSQLite3",
  helper: () =>
    `import { PrismaBetterSQLite3 as __PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
${SQLITE_URL}
const __denextPrismaAdapter = () => new __PrismaBetterSQLite3({ url: __denextDbUrl });`,
};

/** Postgres: Prisma's own adapter over the npm `pg` driver (pure JS on Deno's Node compat). */
const PG_ADAPTER: DriverAdapter = {
  provider: "postgresql",
  pkg: "@prisma/adapter-pg",
  target: `npm:@prisma/adapter-pg@${PRISMA_VERSION}`,
  className: "PrismaPg",
  helper: (envVar) =>
    `import { PrismaPg as __PrismaPg } from "@prisma/adapter-pg";
// The datasource URL (\`${envVar}\`, as schema.prisma names it); a pool per client.
const __denextPrismaAdapter = () =>
  new __PrismaPg({ connectionString: Deno.env.get(${JSON.stringify(envVar)}) });`,
};

/** MySQL / MariaDB: Prisma's adapter over the npm `mariadb` driver (it takes `mysql://`). */
const MYSQL_ADAPTER: DriverAdapter = {
  provider: "mysql",
  pkg: "@prisma/adapter-mariadb",
  target: `npm:@prisma/adapter-mariadb@${PRISMA_VERSION}`,
  className: "PrismaMariaDb",
  helper: (envVar) =>
    `import { PrismaMariaDb as __PrismaMariaDb } from "@prisma/adapter-mariadb";
// The datasource URL (\`${envVar}\`, as schema.prisma names it; \`mysql://\` or \`mariadb://\`).
const __denextPrismaAdapter = () =>
  new __PrismaMariaDb(Deno.env.get(${JSON.stringify(envVar)}) ?? "");`,
};

/**
 * SQL Server: Prisma's adapter over the npm `mssql` driver. It takes Prisma's own
 * `sqlserver://host:port;database=…;user=…;password=…` URL (and its `schema=`) as is.
 */
const MSSQL_ADAPTER: DriverAdapter = {
  provider: "sqlserver",
  pkg: "@prisma/adapter-mssql",
  target: `npm:@prisma/adapter-mssql@${PRISMA_VERSION}`,
  className: "PrismaMssql",
  helper: (envVar) =>
    `import { PrismaMssql as __PrismaMssql } from "@prisma/adapter-mssql";
// The datasource URL (\`${envVar}\`, as schema.prisma names it; Prisma's \`sqlserver://\` form).
const __denextPrismaAdapter = () =>
  new __PrismaMssql(Deno.env.get(${JSON.stringify(envVar)}) ?? "");`,
};

const ADAPTERS: Record<PrismaProvider, DriverAdapter> = {
  sqlite: SQLITE_ADAPTER,
  postgresql: PG_ADAPTER,
  mysql: MYSQL_ADAPTER,
  sqlserver: MSSQL_ADAPTER,
};

/**
 * `denext/prisma-adapter` (Prisma over `Deno.SQL`) for a SQLite or Postgres datasource, imported
 * from `target` (denext's `prisma-adapter` subpath).
 */
function denoSqlAdapter(provider: "sqlite" | "postgresql", target: string): DriverAdapter {
  const factory = `import { PrismaDenoSql as __PrismaDenoSql } from "${DENO_SQL_ADAPTER}";`;
  return {
    provider,
    pkg: DENO_SQL_ADAPTER,
    target,
    className: "PrismaDenoSql",
    helper: (envVar) =>
      provider === "sqlite"
        ? `${factory}
${SQLITE_URL}
const __denextPrismaAdapter = () => new __PrismaDenoSql(__denextDbUrl);`
        : `${factory}
// The datasource URL (\`${envVar}\`, as schema.prisma names it), on the runtime's Deno.SQL.
const __denextPrismaAdapter = () => new __PrismaDenoSql(Deno.env.get(${
          JSON.stringify(envVar)
        }) ?? "");`,
  };
}

/**
 * The adapter for a datasource: `denext/prisma-adapter` for SQLite and Postgres when
 * `denoSqlTarget` is given (CockroachDB stays on `@prisma/adapter-pg`), else the npm adapter
 * of the provider; null for a provider with none.
 */
function adapterFor(provider: string | null, denoSqlTarget: string | null): DriverAdapter | null {
  const wired = wiredProvider(provider);
  if (denoSqlTarget && wired === "sqlite") return denoSqlAdapter("sqlite", denoSqlTarget);
  if (denoSqlTarget && wired === "postgresql" && provider !== "cockroachdb") {
    return denoSqlAdapter("postgresql", denoSqlTarget);
  }
  return wired ? ADAPTERS[wired] : null;
}

/** What `schema.prisma`'s `datasource` block declares. */
export interface PrismaDatasource {
  /** `provider = "…"` as written (`postgresql`, `sqlite`, …), or null when unreadable. */
  provider: string | null;
  /** The variable `url = env("…")` reads, or null for a literal / missing URL. */
  envVar: string | null;
}

/** Read the `datasource` block of a Prisma schema (its provider and URL variable). */
export function readDatasource(schema: string): PrismaDatasource {
  const block = /datasource\s+\w+\s*\{([\s\S]*?)\n\s*\}/.exec(schema)?.[1] ?? "";
  const provider = /^\s*provider\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? null;
  const envVar = /^\s*url\s*=\s*env\(\s*"([^"]+)"\s*\)/m.exec(block)?.[1] ?? null;
  return { provider, envVar };
}

/**
 * The provider denext wires for a datasource `provider` (`postgres` is Prisma's alias of
 * `postgresql`; `cockroachdb` speaks the Postgres wire protocol, and Prisma takes the Postgres
 * adapter for it), or null for one it has no adapter path for (`mongodb`: Prisma 6 has no
 * driver adapter for it). A schema without a readable provider is treated as SQLite, as before.
 */
export function wiredProvider(provider: string | null): PrismaProvider | null {
  if (provider === null || provider === "sqlite") return "sqlite";
  if (provider === "postgresql" || provider === "postgres" || provider === "cockroachdb") {
    return "postgresql";
  }
  if (provider === "mysql") return "mysql";
  if (provider === "sqlserver") return "sqlserver";
  return null;
}

/** Summary of what the Prisma transform did (for the CLI report). */
export interface PrismaMigrateInfo {
  /** The datasource provider as the schema declares it (`postgresql`, `sqlite`, …). */
  provider: string;
  /** The driver adapter package injected, or null when the provider has none denext wires. */
  adapter: string | null;
  /** The `prisma/schema.prisma` (relative) whose generator was rewritten to the Deno client. */
  schemaPath: string;
  /** Modules (relative) where a `new PrismaClient()` was rewired to the driver adapter. */
  clientModules: string[];
  /** Files (relative) whose `@prisma/client` import was repointed at the generated client. */
  refsRewritten: string[];
  /**
   * Seed and test tooling (relative: `prisma/seed.ts`, `tests/…`, `scripts/…`) rewritten the
   * same way, so it runs on Deno against the same client as the app.
   */
  toolingRewritten: string[];
  /** The task that runs the seed on Deno (`prisma:seed`), when the app has a seed script. */
  seedTask?: string;
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
 * `denoSqlTarget`, when given, is where `denext/prisma-adapter` resolves: a SQLite or Postgres
 * datasource is then wired to it instead of an npm driver adapter.
 */
export async function detectPrismaWiring(
  dir: string,
  deps: Record<string, string>,
  compatSpecifier: string,
  denoSqlTarget: string | null = null,
): Promise<PrismaWiring | null> {
  const schemaAbs = join(dir, "prisma", "schema.prisma");
  const hasSchema = await fileExists(schemaAbs);
  if (!("@prisma/client" in deps) && !hasSchema) return null;
  const seed = await findSeedScript(dir);
  const datasource = hasSchema
    ? readDatasource(await mfs.readTextFile(schemaAbs))
    : { provider: null, envVar: null };
  const adapter = adapterFor(datasource.provider, denoSqlTarget);
  const sqlite = adapter === SQLITE_ADAPTER; // the better-sqlite3 path: links + bundled compat
  const plan: TransformPlan = {
    dir,
    compatSpecifier,
    schemaAbs,
    hasSchema,
    seed,
    provider: datasource.provider ?? "sqlite",
    adapter,
    envVar: datasource.envVar ?? "DATABASE_URL",
  };

  return {
    importsToAdd: {
      "@prisma/client": `npm:@prisma/client@${PRISMA_VERSION}`,
      ...(adapter ? { [adapter.pkg]: adapter.target } : {}),
    },
    importsToDelete: sqlite ? ["better-sqlite3"] : [],
    links: sqlite ? [`./${PATCH_DIR}`] : [],
    tasks: {
      [SETUP_TASK]: `deno run -A ${SETUP_SCRIPT}`,
      ...(seed ? { [SEED_TASK]: seedCommand(seed) } : {}),
    },
    nodeModulesDir: "manual",
    handledDeps: Object.keys(deps).filter(isPrismaDep),
    finalize: () => transformPrismaApp(plan),
  };
}

/** Everything the deferred transform needs (see {@link detectPrismaWiring}). */
interface TransformPlan {
  dir: string;
  compatSpecifier: string;
  schemaAbs: string;
  hasSchema: boolean;
  seed: string | null;
  /** The datasource provider as written. */
  provider: string;
  /** Its driver adapter, or null when denext wires none for it. */
  adapter: DriverAdapter | null;
  /** The variable the datasource URL comes from. */
  envVar: string;
}

/** The actual filesystem transform (deferred so it runs after deno.json is written). */
async function transformPrismaApp(plan: TransformPlan): Promise<PrismaMigrateInfo> {
  const { dir, schemaAbs, hasSchema, seed, adapter } = plan;
  const warnings: string[] = [];
  if (!adapter) {
    warnings.push(
      `the datasource provider "${plan.provider}" has no driver adapter denext wires (SQLite, ` +
        "Postgres, CockroachDB, MySQL and SQL Server do) — `new PrismaClient()` was left as is; " +
        "pass the provider's driver adapter by hand (MongoDB has none in Prisma 6).",
    );
  }

  // 1. Rewrite the schema generator to the ESM/Deno client (the query-compiler client with
  //    no Rust engine binary). Leave the datasource block untouched.
  let schemaPath = relative(dir, schemaAbs).replace(/\\/g, "/"); // reported `/`-separated
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
  //         inject the driver adapter at each construction site — then the same for the seed
  //         and test tooling (the native client they used is gone from package.json below).
  const inject = adapter ? { adapter, envVar: plan.envVar } : null;
  const runtime = await rewritePrismaSources(dir, await collectSourceFiles(dir), inject, warnings);
  const tooling = await rewritePrismaSources(
    dir,
    await collectToolingFiles(dir, seed),
    inject,
    warnings,
  );

  // 4. Drop the superseded prisma deps from package.json so `deno install` materializes the
  //    v6 client/adapter (pinned in deno.json) rather than the native v5 client, and point
  //    Prisma's seed command (package.json / prisma.config.ts) at Deno.
  const packageJsonEdited = await stripPrismaFromPackageJson(join(dir, "package.json"), seed);
  if (seed) await rewriteSeedInPrismaConfig(dir, seed);

  // 5. The `links` patch package (better-sqlite3 only), the setup script, and the gitignore.
  await writeSetupFiles(plan);

  return {
    provider: plan.provider,
    adapter: adapter?.pkg ?? null,
    schemaPath,
    clientModules: runtime.clientModules,
    refsRewritten: runtime.refsRewritten,
    toolingRewritten: [...new Set([...tooling.refsRewritten, ...tooling.clientModules])].sort(),
    ...(seed ? { seedTask: SEED_TASK } : {}),
    packageJsonEdited,
    setupTask: SETUP_TASK,
    warnings,
  };
}

/**
 * Step 5 of the transform: SQLite on better-sqlite3 gets the `links` patch package (its
 * index.mjs is bundled by the setup script); every app gets the setup script and a gitignore
 * for the generated (+ bundled) artifacts.
 */
async function writeSetupFiles(plan: TransformPlan): Promise<void> {
  const { dir, adapter } = plan;
  const shim = adapter === SQLITE_ADAPTER;
  if (shim) await writePatchPackage(dir);
  await writeSetupScript(dir, {
    compat: shim ? plan.compatSpecifier : null,
    envVar: adapter?.provider === "sqlite" ? null : plan.envVar,
  });
  await appendGitignore(dir, ["generated/", ...(shim ? [`${PATCH_DIR}/index.mjs`] : [])]);
}

/** The adapter to inject at each construction site and the variable its URL comes from. */
interface Injection {
  adapter: DriverAdapter;
  envVar: string;
}

/**
 * Rewrite every module of `files` that references Prisma: repoint `@prisma/client` at the
 * generated Deno client and inject the driver adapter at each `new PrismaClient(...)`.
 * Idempotent: a module already carrying the injected factory is fully transformed (its import
 * repointed and the adapter threaded), so a second migrate is a no-op (commit-parity), not a
 * double injection. Returns the modules that construct a client and those whose import moved.
 */
async function rewritePrismaSources(
  dir: string,
  files: readonly string[],
  inject: Injection | null,
  warnings: string[],
): Promise<{ clientModules: string[]; refsRewritten: string[] }> {
  const clientModules: string[] = [];
  const refsRewritten: string[] = [];
  for (const file of files) {
    const original = await mfs.readTextFile(file);
    if (!original.includes("@prisma/client") && !original.includes("new PrismaClient")) continue;
    if (original.includes("__denextPrismaAdapter")) continue;
    const relFile = relative(dir, file).replace(/\\/g, "/"); // reported `/`-separated
    const rel = relToGenerated(dir, file);
    let text = original;
    if (/["']@prisma\/client["']/.test(text)) {
      text = text.replace(/(["'])@prisma\/client\1/g, `"${rel}"`);
      refsRewritten.push(relFile);
    }
    if (inject && /new\s+PrismaClient\s*\(/.test(text)) {
      text = injectAdapter(text, rel, inject, warnings, relFile);
      clientModules.push(relFile);
    }
    if (text !== original) await mfs.writeTextFile(file, text);
  }
  return { clientModules, refsRewritten };
}

/** Replace the `generator client { … }` block with the ESM/Deno client generator. */
async function rewriteSchema(schemaAbs: string, warnings: string[]): Promise<void> {
  const src = await mfs.readTextFile(schemaAbs);
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
    await mfs.writeTextFile(schemaAbs, src.replace(block, denoBlock));
  } else {
    // No `generator client` block — append one (a schema can omit it and rely on defaults).
    await mfs.writeTextFile(schemaAbs, `${src.trimEnd()}\n\n${denoBlock}\n`);
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
  inject: Injection,
  warnings: string[],
  relFile: string,
): string {
  const helper = inject.adapter.helper(inject.envVar);

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
        `\`adapter: new ${inject.adapter.className}(…)\` to it by hand.`,
    );
  }
  return text;
}

/**
 * Remove `@prisma/client` and `prisma` from package.json deps/devDeps, and point a
 * `prisma.seed` command at Deno (`prisma db seed` / `migrate reset` then seed through the
 * rewritten script). Returns whether the Prisma deps were removed.
 */
async function stripPrismaFromPackageJson(pkgPath: string, seed: string | null): Promise<boolean> {
  const pkg = await readPackageJson(pkgPath);
  if (!pkg) return false;
  const seedChanged = seed !== null && pointSeedAtDeno(pkg, seed);
  const depsDropped = dropPrismaDeps(pkg);
  if (seedChanged || depsDropped) {
    // Preserve the file's indentation style where obvious (2-space default).
    await mfs.remove(pkgPath).catch(() => {}); // unlink a possible symlink (cloned repos)
    await mfs.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  return depsDropped;
}

/** package.json as an object, or null when it is missing or not JSON. */
async function readPackageJson(pkgPath: string): Promise<Record<string, unknown> | null> {
  try {
    const pkg = JSON.parse(await mfs.readTextFile(pkgPath));
    return pkg && typeof pkg === "object" ? pkg : null;
  } catch {
    return null;
  }
}

/** Point `prisma.seed` at the seed on Deno; whether it changed. */
function pointSeedAtDeno(pkg: Record<string, unknown>, seed: string): boolean {
  const block = pkg.prisma as Record<string, unknown> | undefined;
  if (typeof block?.seed !== "string" || block.seed === seedCommand(seed)) return false;
  block.seed = seedCommand(seed);
  return true;
}

/** Delete `@prisma/client` and `prisma` from deps/devDeps; whether any was there. */
function dropPrismaDeps(pkg: Record<string, unknown>): boolean {
  let changed = false;
  for (const field of ["dependencies", "devDependencies"]) {
    const block = pkg[field] as Record<string, string> | undefined;
    for (const name of ["@prisma/client", "prisma"]) {
      if (block && name in block) {
        delete block[name];
        changed = true;
      }
    }
  }
  return changed;
}

/** Write the `links` patch package.json (its index.mjs is produced by the setup bundle step). */
async function writePatchPackage(dir: string): Promise<void> {
  const pkgDir = join(dir, PATCH_DIR);
  await mfs.mkdir(pkgDir, { recursive: true });
  await mfs.writeTextFile(
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

/** What the setup script prepares: the compat to bundle, and the server database's URL. */
interface SetupPlan {
  /** The compat to bundle into the `links` package (better-sqlite3 path only), else null. */
  compat: string | null;
  /**
   * The server database's URL variable (Postgres / MySQL), which the script checks is set
   * before it runs the Prisma CLI against it; null for SQLite.
   */
  envVar: string | null;
}

/** The setup script's header comment. */
function setupIntro({ compat, envVar }: SetupPlan): string {
  if (compat !== null) {
    return `// One-time Prisma setup for denext: substitute denext's node:sqlite compat for the adapter's
// native \`better-sqlite3\` (bundled into the \`links\` package), install, then generate the
// ESM/Deno Prisma client and create the database schema. Run: \`deno task ${SETUP_TASK}\`.`;
  }
  if (envVar === null) {
    return `// One-time Prisma setup for denext: install the Prisma client, then generate the ESM/Deno
// client and create the SQLite schema. The app reaches SQLite through
// denext/prisma-adapter (Deno.SQL), no npm driver. Run: \`deno task ${SETUP_TASK}\`.`;
  }
  return `// One-time Prisma setup for denext: install (the Prisma client and its driver adapter), then
// generate the ESM/Deno Prisma client and create the database schema in the server ${envVar}
// names. Run: \`deno task ${SETUP_TASK}\` with ${envVar} set (or in .env).`;
}

/**
 * Write the one-shot setup script: (better-sqlite3) bundle the compat → install → generate →
 * migrate deploy / db push.
 */
async function writeSetupScript(dir: string, plan: SetupPlan): Promise<void> {
  const { compat: compatSpecifier, envVar } = plan;
  const intro = setupIntro(plan);
  const urlSetup = envVar === null
    ? `const DATABASE_URL = Deno.env.get("DATABASE_URL") ?? "file:./data.db";
const PRISMA_ENV: Record<string, string> = { DATABASE_URL };`
    : `const URL_VAR = ${JSON.stringify(envVar)};
// The Prisma CLI reads .env itself; the check only fails fast when neither has the URL.
const HAS_URL = Deno.env.get(URL_VAR) !== undefined ||
  (await Deno.readTextFile(".env").catch(() => "")).split("\\n").some((l) =>
    l.trimStart().startsWith(URL_VAR + "=")
  );
if (!HAS_URL) {
  console.error(\`✗ set \${URL_VAR} (the datasource URL in prisma/schema.prisma) first.\`);
  Deno.exit(1);
}
const PRISMA_ENV: Record<string, string> = {};`;
  const bundle = compatSpecifier !== null
    ? `
const COMPAT_SRC = ${JSON.stringify(compatSpecifier)};
const SHIM_OUT = ${JSON.stringify(`${PATCH_DIR}/index.mjs`)};
// 1. Bundle the node:sqlite-backed compat into the links package (node:sqlite stays external —
//    it's a Deno builtin). \`--no-config\` avoids the app's manual node_modules (not installed yet).
await run("bundle the better-sqlite3 compat", [
  "bundle", "--no-config", "--format", "esm", "--external", "node:sqlite", "-o", SHIM_OUT, COMPAT_SRC,
]);
// 2. Install deps + apply the link (materializes the compat as \`better-sqlite3\`).
await run("install deps + apply the link", ["install"]);`
    : `
// 1–2. Install deps (the generated client's runtime${
      envVar === null ? "" : ", the driver adapter"
    }).
await run("install deps", ["install"]);`;
  const script =
    `// generated by \`denext migrate\` — safe to edit; re-running migrate may overwrite.
${intro}

const DENO = Deno.execPath();
${urlSetup}

async function run(step: string, args: string[], env?: Record<string, string>): Promise<void> {
  console.log(\`\\n▸ \${step}\`);
  const { success } = await new Deno.Command(DENO, { args, env, stdout: "inherit", stderr: "inherit" })
    .output();
  if (!success) {
    console.error(\`\\n✗ setup failed at: \${step}\`);
    Deno.exit(1);
  }
}
${bundle}
// 3. Generate the ESM/Deno Prisma client + create the schema. Both run the prisma CLI with
//    \`--no-config\` so Deno resolves it from the global cache and ignores this app's deno.json
//    (its \`links\` field would otherwise force npm linking on every \`deno run\`, and the CLI
//    isn't in the manual node_modules). The generated client + adapter still use the app config.
await run("prisma generate", ["run", "-A", "--no-config", "npm:prisma@${PRISMA_VERSION}", "generate"], PRISMA_ENV);
// An app with SQL migrations (\`prisma/migrations/\`) gets them APPLIED — they often carry
// seed rows (the Epic Stack's roles/permissions) that \`db push\` (schema only) would skip.
const HAS_MIGRATIONS = await Deno.stat("prisma/migrations").then(() => true, () => false);
await run(HAS_MIGRATIONS ? "prisma migrate deploy" : "prisma db push", [
  "run", "-A", "--no-config", "npm:prisma@${PRISMA_VERSION}",
  ...(HAS_MIGRATIONS ? ["migrate", "deploy"] : ["db", "push", "--skip-generate", "--accept-data-loss"]),
], PRISMA_ENV);

console.log("\\n✓ Prisma setup complete — run \`denext task build\` (or dev).");
`;
  await mfs.mkdir(join(dir, "scripts"), { recursive: true });
  await mfs.writeTextFile(join(dir, SETUP_SCRIPT), script);
}

/** A seed script's run command on Deno. */
function seedCommand(seed: string): string {
  return `deno run -A ${seed}`;
}

/** A script path inside a seed command (`tsx prisma/seed.ts`, `node --loader ts-node/esm x.mts`). */
const SEED_PATH = /(?:^|\s)((?:\.\/)?[\w./-]+\.(?:[cm]?[jt]s))(?=\s|$)/;

/**
 * The app's seed script (relative, `/`-separated): the script `prisma.seed` in package.json (or
 * `migrations.seed` in `prisma.config.ts`) runs, else `prisma/seed.{ts,mts,js,mjs}`; null when
 * there is none.
 */
async function findSeedScript(dir: string): Promise<string | null> {
  for (const command of await seedCommands(dir)) {
    const path = SEED_PATH.exec(command)?.[1]?.replace(/^\.\//, "");
    if (path && await fileExists(join(dir, path))) return path;
  }
  for (const ext of ["ts", "mts", "js", "mjs"]) {
    if (await fileExists(join(dir, "prisma", `seed.${ext}`))) return `prisma/seed.${ext}`;
  }
  return null;
}

/** The seed commands the app declares (package.json `prisma.seed`, `prisma.config.ts`). */
async function seedCommands(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const pkg = JSON.parse(await mfs.readTextFile(join(dir, "package.json")));
    if (typeof pkg?.prisma?.seed === "string") out.push(pkg.prisma.seed);
  } catch { /* no package.json */ }
  const config = await mfs.readTextFile(join(dir, "prisma.config.ts")).catch(() => "");
  const m = /\bseed\s*:\s*(["'`])([^"'`]+)\1/.exec(config);
  if (m) out.push(m[2]);
  return out;
}

/** Point `prisma.config.ts`'s `migrations.seed` command at Deno. */
async function rewriteSeedInPrismaConfig(dir: string, seed: string): Promise<void> {
  const path = join(dir, "prisma.config.ts");
  const config = await mfs.readTextFile(path).catch(() => null);
  if (config === null) return;
  const next = config.replace(
    /(\bseed\s*:\s*)(["'`])[^"'`]+\2/,
    (_m, key: string, q: string) => `${key}${q}${seedCommand(seed)}${q}`,
  );
  if (next !== config) await mfs.writeTextFile(path, next);
}

/** The relative specifier from `file`'s directory to the generated client entry. */
function relToGenerated(dir: string, file: string): string {
  let rel = relative(dirname(file), join(dir, GENERATED_CLIENT)).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/** App RUNTIME source roots — the code denext actually bundles/serves. */
const RUNTIME_ROOTS = ["app", "src", "lib", "components", "pages", "server", "routes"];

/**
 * Seed and test tooling roots: the seed and its helpers (`prisma/`), test suites and their
 * fixtures and mocks, and project scripts. migrate drops the native client from package.json,
 * so these move to the generated Deno client too and run on Deno (`denext test`,
 * `deno task prisma:seed`).
 */
const TOOLING_ROOTS = [
  "prisma",
  "tests",
  "test",
  "__tests__",
  "e2e",
  "mocks",
  "__mocks__",
  "cypress",
  "playwright",
  "scripts",
];

/** Root-level test setup and seed files (`vitest.setup.ts`, `jest.setup.js`, `seed.ts`, …). */
const ROOT_TOOLING_FILE =
  /^(?:(?:vitest|jest|playwright)[.-][\w.-]*|[\w.-]*setup[\w.-]*|seed)\.[cm]?[jt]sx?$/i;

/** Collect runtime source files under {@link RUNTIME_ROOTS} (skips node_modules/dist/.denext/generated/out). */
function collectSourceFiles(dir: string): Promise<string[]> {
  return collectUnder(dir, RUNTIME_ROOTS);
}

/** Collect the seed and test tooling files (see {@link TOOLING_ROOTS}), the seed script included. */
async function collectToolingFiles(dir: string, seed: string | null): Promise<string[]> {
  const files = new Set(await collectUnder(dir, TOOLING_ROOTS));
  for await (const e of mfs.readDir(dir)) {
    if (e.isFile && ROOT_TOOLING_FILE.test(e.name)) files.add(join(dir, e.name));
  }
  if (seed) files.add(join(dir, seed));
  const runtime = new Set(await collectSourceFiles(dir));
  return [...files].filter((f) => !runtime.has(f)).sort();
}

/** Source files under `roots` of `dir` (skips node_modules/dist/.denext/generated/out). */
async function collectUnder(dir: string, roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (root: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of mfs.readDir(root)) entries.push(e);
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
  for (const sub of roots) await walk(join(dir, sub));
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await mfs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Prisma wiring for `denext migrate`. Prisma's default client ships a native Rust query
// engine that does not bundle under Deno, so an unmodified `@prisma/client` app can't run
// on denext as-is. denext's supported path (see examples/prisma) is Prisma 7's ESM,
// Deno-runtime client (`generator client { provider = "prisma-client"; runtime = "deno" }`)
// talking to Deno's built-in `node:sqlite` through the `@prisma/adapter-better-sqlite3`
// driver adapter, with the adapter's native `better-sqlite3` dependency substituted for a
// bundled copy of denext's compat via deno.json `links`.
//
// Every app comes out on Prisma 7, whichever major it started on: every Prisma 6 release's
// `@prisma/config` pins `deepmerge-ts` 7.1.5 (GHSA-ggr8-5vv4-36mx), so no Prisma 6 tree is free
// of that advisory, and migrate already moves the client to a new generator. A Prisma 6 schema's
// datasource URL (`url`, `directUrl`, `shadowDatabaseUrl`, which Prisma 7 rejects in the schema)
// moves to `prisma.config.ts`; a Prisma 7 app's own `prisma.config.ts` datasource is kept.
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
// rewrites the app's `prisma/schema.prisma` generator to the Deno client and its datasource URL
// into `prisma.config.ts`, (3) rewrites every
// `@prisma/client` import to the generated client and injects the driver adapter at each
// `new PrismaClient()` site — in the runtime source AND the seed and test tooling, which then run
// on Deno too (the seed as `deno task prisma:seed` / `prisma db seed`, tests under
// `denext test`) — (4) drops the superseded `@prisma/client`/`prisma` entries from
// package.json (they'd otherwise pin an older client into node_modules and clash with
// the v7 adapter), and (5) writes the `links` patch package + a one-shot `prisma:setup` task
// (bundle the compat → install → `prisma generate` → `prisma migrate deploy`/`db push`). After setup the app
// runs on real Prisma with zero hand edits — no stub.

import { dirname, isAbsolute, join, normalize, relative } from "@std/path";
import { appendGitignore } from "./gitignore.ts";
import { mfs } from "./migrate-io.ts";

/**
 * Prisma 7 line (the CLI, `@prisma/client` and every `@prisma/adapter-*`): its `@prisma/config`
 * takes `deepmerge-ts` 8, past GHSA-ggr8-5vv4-36mx, which every Prisma 6 release pins.
 */
const PRISMA_VERSION = "7.10.1";
/**
 * The `better-sqlite3` version the patch package advertises (matches examples/prisma): within
 * the 7.x `@prisma/adapter-better-sqlite3`'s `^12.6.0`. An app that requires `better-sqlite3`
 * itself is pinned to it too: Deno takes a link only for a range its version satisfies.
 */
const BETTER_SQLITE3_VERSION = "12.6.2";
/**
 * Where the Deno client is generated (relative to the app root) unless the app's own
 * `prisma-client` generator names another `output`; the schema's `output` is then
 * `../generated/client`.
 */
const GENERATED_DIR = "generated/client";
/** The Prisma 7 CLI configuration (relative to the app root). */
const PRISMA_CONFIG = "prisma.config.ts";
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
  /**
   * The injected factory (`__denextPrismaAdapter`), reading the URL from `envVar`; a SQLite one
   * falls back to `sqlite.fallback` and rebases a relative path onto `prisma/` when `rebase`.
   */
  helper(envVar: string, sqlite: SqliteUrl): string;
}

/** How the runtime finds a SQLite datasource's file (see {@link sqliteUrlHelper}). */
interface SqliteUrl {
  /** The `file:` URL used when the variable is unset. */
  fallback: string;
  /** Rebase a relative path onto `prisma/` (the URL is a Prisma 6, schema-relative one). */
  rebase: boolean;
}

/**
 * The expression that rebases a Prisma 6 SQLite `file:` path (relative to the schema's
 * directory, `prisma/`) onto the app root, where the runtime adapter and Prisma 7's CLI resolve
 * it: an absolute path, or one already under a `prisma/` segment, is kept.
 */
function rebaseSqliteUrl(source: string): string {
  return `(() => {
${rebaseSqliteBody(source)}
})()`;
}

/** The statements of {@link rebaseSqliteUrl} (they `return` the rebased `file:` URL). */
function rebaseSqliteBody(source: string): string {
  return `  const p = (${source}).replace(/^file:/, "").replace(/\\?.*$/, "");
  return \`file:\${p.startsWith("/") || /(^|\\/)prisma\\//.test(p) ? p : "./prisma/" + p.replace(/^\\.?\\//, "")}\`;`;
}

/** The SQLite URL the runtime opens, CWD-relative (`__denextDbUrl`). */
function sqliteUrlHelper(envVar: string, { fallback, rebase }: SqliteUrl): string {
  const source = `Deno.env.get(${JSON.stringify(envVar)}) ?? ${JSON.stringify(fallback)}`;
  if (!rebase) {
    return `// The SQLite datasource (\`${envVar}\`), resolved from the working directory as Prisma 7 does.
const __denextDbUrl = ${source};`;
  }
  return `// Prisma 6 resolved a sqlite \`file:\` path relative to the schema dir (prisma/); the runtime
// adapter (and Prisma 7's CLI) resolve it relative to CWD — so normalize to a prisma/-prefixed,
// CWD-relative path.
const __denextDbUrl = ${rebaseSqliteUrl(source)};`;
}

const SQLITE_ADAPTER: DriverAdapter = {
  provider: "sqlite",
  pkg: "@prisma/adapter-better-sqlite3",
  target: `npm:@prisma/adapter-better-sqlite3@${PRISMA_VERSION}`,
  className: "PrismaBetterSqlite3",
  helper: (envVar, sqlite) =>
    `import { PrismaBetterSqlite3 as __PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
${sqliteUrlHelper(envVar, sqlite)}
const __denextPrismaAdapter = () => new __PrismaBetterSqlite3({ url: __denextDbUrl });`,
};

/** Postgres: Prisma's own adapter over the npm `pg` driver (pure JS on Deno's Node compat). */
const PG_ADAPTER: DriverAdapter = {
  provider: "postgresql",
  pkg: "@prisma/adapter-pg",
  target: `npm:@prisma/adapter-pg@${PRISMA_VERSION}`,
  className: "PrismaPg",
  helper: (envVar) =>
    `import { PrismaPg as __PrismaPg } from "@prisma/adapter-pg";
// The datasource URL (\`${envVar}\`, as the datasource names it); a pool per client.
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
// The datasource URL (\`${envVar}\`, as the datasource names it; \`mysql://\` or \`mariadb://\`).
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
// The datasource URL (\`${envVar}\`, as the datasource names it; Prisma's \`sqlserver://\` form).
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
    helper: (envVar, sqlite) =>
      provider === "sqlite"
        ? `${factory}
${sqliteUrlHelper(envVar, sqlite)}
const __denextPrismaAdapter = () => new __PrismaDenoSql(__denextDbUrl);`
        : `${factory}
// The datasource URL (\`${envVar}\`, as the datasource names it), on the runtime's Deno.SQL.
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

/** What a Prisma app's datasource declares: the schema's provider, and its URL's source. */
export interface PrismaDatasource {
  /** `provider = "…"` as written (`postgresql`, `sqlite`, …), or null when unreadable. */
  provider: string | null;
  /** The variable the datasource URL reads, or null for a literal / missing URL. */
  envVar: string | null;
  /**
   * Where the URL is declared: Prisma 7's `prisma.config.ts` (`datasource.url`), the schema's
   * `datasource` block (a Prisma 6 app), or nowhere.
   */
  urlIn: "config" | "schema" | null;
}

/** The variable a URL expression reads: `env("X")`, `process.env.X` / `["X"]`, `Deno.env.get("X")`. */
const ENV_READ =
  /\benv\(\s*["'`]([^"'`]+)["'`]\s*\)|\bprocess\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])|\bDeno\.env\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/;

/** The variable an expression reads (see {@link ENV_READ}), or null. */
function envVarIn(expr: string): string | null {
  const m = ENV_READ.exec(expr);
  return m ? m[1] ?? m[2] ?? m[3] ?? m[4] : null;
}

/** The `datasource` block's body of a Prisma schema ("" when there is none). */
function datasourceBlock(schema: string): string {
  return /datasource\s+\w+\s*\{([\s\S]*?)\n\s*\}/.exec(schema)?.[1] ?? "";
}

/** The right-hand side of `key = …` in a schema block, or null. */
function schemaField(block: string, key: string): string | null {
  return new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(block)?.[1] ?? null;
}

/**
 * The `datasource: { url: … }` expression of a `prisma.config.ts` (the text after `url:` up to
 * the next `,`, `}` or line end), or null when the config declares no datasource URL.
 */
function configDatasourceUrl(config: string): string | null {
  const block = /\bdatasource\s*:\s*\{([^}]*)\}/.exec(config)?.[1];
  if (block === undefined) return null;
  return /(?:^|[\s,{])url\s*:\s*([^,\n}]+)/.exec(block)?.[1]?.trim() ?? null;
}

/**
 * Read a Prisma app's datasource: the provider from the schema's `datasource` block, and the URL
 * from `prisma.config.ts` (`config`, Prisma 7) when it declares one, else from the schema's
 * `url = env("…")` (a Prisma 6 app). The caller falls back to `DATABASE_URL` when neither names
 * a variable.
 */
export function readDatasource(schema: string, config: string | null = null): PrismaDatasource {
  const block = datasourceBlock(schema);
  const provider = /^\s*provider\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? null;
  const fromConfig = config === null ? null : configDatasourceUrl(config);
  if (fromConfig !== null) return { provider, envVar: envVarIn(fromConfig), urlIn: "config" };
  const url = schemaField(block, "url");
  if (url === null) return { provider, envVar: null, urlIn: null };
  const envVar = /^env\(\s*"([^"]+)"\s*\)/.exec(url)?.[1] ?? null;
  return { provider, envVar, urlIn: "schema" };
}

/**
 * The provider denext wires for a datasource `provider` (`postgres` is Prisma's alias of
 * `postgresql`; `cockroachdb` speaks the Postgres wire protocol, and Prisma takes the Postgres
 * adapter for it), or null for one it has no adapter path for (`mongodb`: Prisma 7 has no
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
  const schema = hasSchema ? await mfs.readTextFile(schemaAbs) : "";
  const config = await mfs.readTextFile(join(dir, PRISMA_CONFIG)).catch(() => null);
  const datasource = readDatasource(schema, config);
  const adapter = adapterFor(datasource.provider, denoSqlTarget);
  // The `links` shim (denext's node:sqlite compat as `better-sqlite3`, bundled by the setup
  // script): Prisma's better-sqlite3 adapter needs it — injected here, or the app's own (a
  // Prisma 7 app constructs its adapter itself) — and so does an app that imports
  // `better-sqlite3` itself (a cache database): its server bundle takes the package from
  // node_modules, where only the link swaps the native addon out, whatever adapter Prisma uses.
  const sqlite = adapter === SQLITE_ADAPTER || "better-sqlite3" in deps ||
    "@prisma/adapter-better-sqlite3" in deps;
  const urls = schemaUrls(schema);
  const envVar = datasource.envVar ?? "DATABASE_URL";
  const plan: TransformPlan = {
    dir,
    compatSpecifier,
    schemaAbs,
    hasSchema,
    seed,
    provider: datasource.provider ?? "sqlite",
    adapter,
    envVar,
    // The CLI migrates through `directUrl` when the schema has one (the Prisma 7 upgrade guide
    // moves it to the config's `url`); the app keeps the pooled `url`.
    cliEnvVar: datasource.urlIn === "config" ? envVar : urls.directUrl?.env ?? envVar,
    sqlite: {
      fallback: datasource.urlIn === "schema" && urls.url?.literal?.startsWith("file:")
        ? urls.url.literal
        : SQLITE_FALLBACK,
      rebase: datasource.urlIn !== "config",
    },
    // Prisma 7 reads the URL from prisma.config.ts only: write it there unless it already is.
    configDatasource: datasource.urlIn === "config" ? null : urls,
    clientDir: generatedClientDir(schema),
    shim: sqlite,
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

/** One datasource URL of a Prisma 6 schema: the variable `env("…")` reads, or a literal. */
interface SchemaUrl {
  env?: string;
  literal?: string;
}

/** The URLs a Prisma 6 schema's `datasource` block declares (Prisma 7 takes them from the config). */
interface SchemaUrls {
  url?: SchemaUrl;
  directUrl?: SchemaUrl;
  shadowDatabaseUrl?: SchemaUrl;
}

/** The SQLite file a Prisma 6 app gets when its URL variable is unset (schema-relative). */
const SQLITE_FALLBACK = "file:./data.db";

/** Read `url` / `directUrl` / `shadowDatabaseUrl` from a schema's `datasource` block. */
function schemaUrls(schema: string): SchemaUrls {
  const block = datasourceBlock(schema);
  const out: SchemaUrls = {};
  for (const key of ["url", "directUrl", "shadowDatabaseUrl"] as const) {
    const value = schemaField(block, key);
    if (value === null) continue;
    const env = /^env\(\s*"([^"]+)"\s*\)/.exec(value)?.[1];
    const literal = /^"([^"]*)"/.exec(value)?.[1];
    if (env !== undefined) out[key] = { env };
    else if (literal !== undefined) out[key] = { literal };
  }
  return out;
}

/**
 * Where the Deno client is generated (relative to the app root, `/`-separated): the `output` of
 * the app's own `prisma-client` generator (its imports already point there), else
 * {@link GENERATED_DIR}. The older `prisma-client-js` generator's output is not kept: its
 * imports are `@prisma/client`, which migrate repoints.
 */
function generatedClientDir(schema: string): string {
  const output = prismaClientOutput(schema);
  if (output === null) return GENERATED_DIR;
  const rel = normalize(join("prisma", output)).replace(/\\/g, "/").replace(/\/$/, "");
  // Outside the app (or the app root itself): keep denext's own directory.
  return /^\.\.?(\/|$)/.test(rel) ? GENERATED_DIR : rel;
}

/** The relative `output` of a `prisma-client` generator, or null (another generator, none). */
function prismaClientOutput(schema: string): string | null {
  const block = /generator\s+client\s*\{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
  if (schemaField(block, "provider") !== '"prisma-client"') return null;
  const output = /^"([^"]+)"/.exec(schemaField(block, "output") ?? "")?.[1] ?? null;
  return output === null || isAbsolute(output) ? null : output;
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
  /** The variable the app's datasource URL comes from (the injected adapter reads it). */
  envVar: string;
  /** The variable the Prisma CLI's URL comes from (the setup script checks it is set). */
  cliEnvVar: string;
  /** How the injected SQLite adapter finds its file. */
  sqlite: SqliteUrl;
  /** The schema's URLs to move into `prisma.config.ts`, or null when it already has one. */
  configDatasource: SchemaUrls | null;
  /** Where the client is generated (relative to the app root). */
  clientDir: string;
  /** Whether `better-sqlite3` is linked to denext's compat (see {@link detectPrismaWiring}). */
  shim: boolean;
}

/** The actual filesystem transform (deferred so it runs after deno.json is written). */
async function transformPrismaApp(plan: TransformPlan): Promise<PrismaMigrateInfo> {
  const { dir, schemaAbs, hasSchema, seed, adapter } = plan;
  const warnings: string[] = [];
  if (!adapter) {
    warnings.push(
      `the datasource provider "${plan.provider}" has no driver adapter denext wires (SQLite, ` +
        "Postgres, CockroachDB, MySQL and SQL Server do) — `new PrismaClient()` was left as is; " +
        "pass the provider's driver adapter by hand (Prisma 7 does not support MongoDB yet).",
    );
  }

  // 1. Rewrite the schema generator to the ESM/Deno client (the query-compiler client with
  //    no Rust engine binary), and move a Prisma 6 datasource URL into prisma.config.ts.
  let schemaPath = relative(dir, schemaAbs).replace(/\\/g, "/"); // reported `/`-separated
  if (hasSchema) {
    await rewriteSchema(schemaAbs, plan.clientDir, warnings);
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
  const inject = adapter ? { adapter, envVar: plan.envVar, sqlite: plan.sqlite } : null;
  const generated = join(dir, plan.clientDir, "client.ts");
  const runtime = await rewritePrismaSources(
    dir,
    await collectSourceFiles(dir),
    generated,
    inject,
    warnings,
  );
  const tooling = await rewritePrismaSources(
    dir,
    await collectToolingFiles(dir, seed),
    generated,
    inject,
    warnings,
  );

  // 4. Drop the superseded prisma deps from package.json so `deno install` materializes the
  //    v7 client/adapter (pinned in deno.json) rather than an older client, and point
  //    Prisma's seed command (prisma.config.ts, and package.json's for older tools) at Deno.
  const packageJsonEdited = await stripPrismaFromPackageJson(
    join(dir, "package.json"),
    seed,
    plan.shim,
  );
  await writePrismaConfig(plan, warnings);

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
 * Step 5 of the transform: the better-sqlite3 shim gets the `links` patch package (its
 * index.mjs is bundled by the setup script); every app gets the setup script and a gitignore
 * for the generated (+ bundled) artifacts.
 */
async function writeSetupFiles(plan: TransformPlan): Promise<void> {
  const { dir, adapter, shim } = plan;
  if (shim) await writePatchPackage(dir);
  await writeSetupScript(dir, {
    compat: shim ? plan.compatSpecifier : null,
    envVar: adapter?.provider === "sqlite" ? null : plan.cliEnvVar,
  });
  const generated = plan.clientDir === GENERATED_DIR ? "generated/" : `${plan.clientDir}/`;
  await appendGitignore(dir, [generated, ...(shim ? [`${PATCH_DIR}/index.mjs`] : [])]);
}

/** The adapter to inject at each construction site and the variable its URL comes from. */
interface Injection {
  adapter: DriverAdapter;
  envVar: string;
  sqlite: SqliteUrl;
}

/**
 * Rewrite every module of `files` that references Prisma: repoint `@prisma/client` at the
 * generated Deno client and inject the driver adapter at each `new PrismaClient(...)`.
 * Idempotent: a module already carrying the injected factory is fully transformed (its import
 * repointed and the adapter threaded), so a second migrate is a no-op (commit-parity), not a
 * double injection. A construction that already passes an `adapter` (a Prisma 7 app's own) is
 * left as is. `generated` is the generated client's entry (`<clientDir>/client.ts`). Returns the
 * modules where an adapter was injected and those whose import moved.
 */
async function rewritePrismaSources(
  dir: string,
  files: readonly string[],
  generated: string,
  inject: Injection | null,
  warnings: string[],
): Promise<{ clientModules: string[]; refsRewritten: string[] }> {
  const clientModules: string[] = [];
  const refsRewritten: string[] = [];
  for (const file of files) {
    const original = await mfs.readTextFile(file);
    if (!original.includes("@prisma/client") && !original.includes("new PrismaClient")) continue;
    const relFile = relative(dir, file).replace(/\\/g, "/"); // reported `/`-separated
    const out = original.includes("__denextPrismaAdapter")
      ? { text: upgradeInjected(original), ref: false, client: false }
      : rewritePrismaSource(original, relToGenerated(file, generated), inject, warnings, relFile);
    if (out.ref) refsRewritten.push(relFile);
    if (out.client) clientModules.push(relFile);
    if (out.text !== original) await mfs.writeTextFile(file, out.text);
  }
  return { clientModules, refsRewritten };
}

/** An already-migrated module: rename the class an earlier (Prisma 6) migrate injected. */
function upgradeInjected(text: string): string {
  return text.replace(/\b(__)?PrismaBetterSQLite3\b/g, "$1PrismaBetterSqlite3");
}

/**
 * One module's rewrite (see {@link rewritePrismaSources}): `@prisma/client` repointed at `rel`,
 * the adapter injected; whether the import moved (`ref`) and an adapter went in (`client`).
 */
function rewritePrismaSource(
  original: string,
  rel: string,
  inject: Injection | null,
  warnings: string[],
  relFile: string,
): { text: string; ref: boolean; client: boolean } {
  const ref = /["']@prisma\/client["']/.test(original);
  let text = ref ? original.replace(/(["'])@prisma\/client\1/g, `"${rel}"`) : original;
  const before = text;
  if (inject && /new\s+PrismaClient\s*\(/.test(text)) {
    text = injectAdapter(text, rel, inject, warnings, relFile);
  }
  return { text, ref, client: text !== before };
}

/**
 * The preview features Prisma 7 made the default (the Rust-free query compiler driven through a
 * driver adapter): Prisma 6 needed them for the Deno client, Prisma 7 drops them from the schema.
 */
const DEFAULT_IN_7 = new Set(["queryCompiler", "driverAdapters"]);

/**
 * Rewrite the schema for Prisma 7: replace the `generator client { … }` block with the ESM/Deno
 * client generator (output in `clientDir`, the app's other preview features kept), and drop the
 * datasource's `url` / `directUrl` / `shadowDatabaseUrl`, which Prisma 7 rejects in the schema
 * (they move to `prisma.config.ts`, see {@link writePrismaConfig}). A schema already in that
 * shape is left byte for byte (an idempotent re-run).
 */
async function rewriteSchema(
  schemaAbs: string,
  clientDir: string,
  warnings: string[],
): Promise<void> {
  const src = await mfs.readTextFile(schemaAbs);
  const block = /generator\s+client\s*\{([\s\S]*?)\n\}/;
  const features = (schemaField(block.exec(src)?.[1] ?? "", "previewFeatures") ?? "")
    .match(/"[^"]+"/g)?.filter((f) => !DEFAULT_IN_7.has(f.slice(1, -1))) ?? [];
  const output = relative("prisma", clientDir).replace(/\\/g, "/");
  const denoBlock = `generator client {
  provider     = "prisma-client"
  output       = "${output}"
  runtime      = "deno"
  moduleFormat = "esm"${features.length ? `\n  previewFeatures = [${features.join(", ")}]` : ""}
}`;
  let next = src;
  if (block.test(src)) {
    next = src.replace(block, denoBlock);
  } else {
    // No `generator client` block — append one (a schema can omit it and rely on defaults).
    next = `${src.trimEnd()}\n\n${denoBlock}\n`;
    warnings.push("prisma/schema.prisma had no `generator client` block — appended the Deno one.");
  }
  next = next.replace(
    /(datasource\s+\w+\s*\{)([\s\S]*?\n\s*\})/,
    (_m, head: string, body: string) =>
      head + body.replace(/^[ \t]*(?:url|directUrl|shadowDatabaseUrl)[ \t]*=.*(?:\r?\n|$)/gm, ""),
  );
  if (next !== src) await mfs.writeTextFile(schemaAbs, next);
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
  // A construction whose options already pass an `adapter` (a Prisma 7 app constructs its own)
  // keeps it; only the others get denext's.
  const sites = [...text.matchAll(/new\s+PrismaClient\s*\(\s*(\)|\{)/g)];
  const bare = new Set(
    sites.filter((m) => m[1] === ")" || !passesAdapter(text, m.index + m[0].length - 1))
      .map((m) => m.index),
  );
  if (bare.size === 0) return text;
  const helper = inject.adapter.helper(inject.envVar, inject.sqlite);

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
  let i = 0;
  text = text.replace(
    /new\s+PrismaClient\s*\(\s*(\)|\{)/g,
    (m, brace: string) => {
      // The helper holds no construction, so the n-th match is still site n.
      const site = sites[i++]?.index ?? -1;
      if (!bare.has(site)) return m;
      return brace === ")"
        ? "new PrismaClient({ adapter: __denextPrismaAdapter() })"
        : "new PrismaClient({ adapter: __denextPrismaAdapter(),";
    },
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

/** Whether the object literal whose `{` is at `open` already has an `adapter` property. */
function passesAdapter(text: string, open: number): boolean {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      return /(?:^|[\s{,])adapter\s*(?::|,|$)/.test(text.slice(open + 1, i));
    }
  }
  return false;
}

/**
 * Remove `@prisma/client` and `prisma` from package.json deps/devDeps, pin the app's own
 * `@prisma/adapter-*` to the client's version (a 6.x adapter can't drive the 7.x client) and,
 * with the `links` shim (`shim`), its own `better-sqlite3` to the version the link advertises,
 * and point a `prisma.seed` command at Deno (for tools that still read it; Prisma 7 reads the seed
 * from `prisma.config.ts`). Returns whether the Prisma deps were removed.
 */
async function stripPrismaFromPackageJson(
  pkgPath: string,
  seed: string | null,
  shim: boolean,
): Promise<boolean> {
  const pkg = await readPackageJson(pkgPath);
  if (!pkg) return false;
  const seedChanged = seed !== null && pointSeedAtDeno(pkg, seed);
  const depsDropped = dropPrismaDeps(pkg);
  const adaptersPinned = pinPrismaAdapters(pkg);
  const linkPinned = shim &&
    pinDeps(pkg, (name) => name === "better-sqlite3", BETTER_SQLITE3_VERSION);
  if (seedChanged || depsDropped || adaptersPinned || linkPinned) {
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

/** Pin every `@prisma/adapter-*` in deps/devDeps to {@link PRISMA_VERSION}; whether any moved. */
function pinPrismaAdapters(pkg: Record<string, unknown>): boolean {
  return pinDeps(pkg, (name) => name.startsWith("@prisma/adapter-"), PRISMA_VERSION);
}

/** Pin every dep/devDep `which` names to `version`; whether any moved. */
function pinDeps(
  pkg: Record<string, unknown>,
  which: (name: string) => boolean,
  version: string,
): boolean {
  let changed = false;
  for (const field of ["dependencies", "devDependencies"]) {
    const block = pkg[field] as Record<string, string> | undefined;
    for (const name of Object.keys(block ?? {})) {
      if (which(name) && block![name] !== version) {
        block![name] = version;
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
    return `// One-time Prisma setup for denext: substitute denext's node:sqlite compat for the native
// \`better-sqlite3\` (bundled into the \`links\` package), install, then generate the
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
  const urlSetup = envVar === null ? "" : `
const URL_VAR = ${JSON.stringify(envVar)};
// The CLI gets .env through --env-file; the check only fails fast when neither has the URL.
const HAS_URL = Deno.env.get(URL_VAR) !== undefined ||
  (await Deno.readTextFile(".env").catch(() => "")).split("\\n").some((l) =>
    l.trimStart().startsWith(URL_VAR + "=")
  );
if (!HAS_URL) {
  console.error(\`✗ set \${URL_VAR} (the datasource URL prisma.config.ts reads) first.\`);
  Deno.exit(1);
}`;
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
const PRISMA = "npm:prisma@${PRISMA_VERSION}";
// Prisma 7's CLI loads no .env file itself: hand it the app's, when there is one.
const ENV_FILE = await Deno.stat(".env").then(() => ["--env-file=.env"], () => []);
${urlSetup}
async function run(step: string, args: string[]): Promise<void> {
  console.log(\`\\n▸ \${step}\`);
  const { success } = await new Deno.Command(DENO, { args, stdout: "inherit", stderr: "inherit" })
    .output();
  if (!success) {
    console.error(\`\\n✗ setup failed at: \${step}\`);
    Deno.exit(1);
  }
}
${bundle}
// 3. Generate the ESM/Deno Prisma client, then create the schema (Prisma 7's \`db push\` and
//    \`migrate deploy\` no longer generate). Both run the prisma CLI with \`--no-config\` so Deno
//    resolves it from the global cache and ignores this app's deno.json (its \`links\` field
//    would otherwise force npm linking on every \`deno run\`, and the CLI isn't in the manual
//    node_modules); the CLI reads the datasource URL from prisma.config.ts. The generated client
//    + adapter still use the app config.
const prisma = (...args: string[]) => ["run", "-A", "--no-config", ...ENV_FILE, PRISMA, ...args];
await run("prisma generate", prisma("generate"));
// An app with SQL migrations (\`prisma/migrations/\`) gets them APPLIED — they often carry
// seed rows (the Epic Stack's roles/permissions) that \`db push\` (schema only) would skip.
// A schema change that would drop data stops at Prisma's warning (no data-loss override).
const HAS_MIGRATIONS = await Deno.stat("prisma/migrations").then(() => true, () => false);
await run(
  HAS_MIGRATIONS ? "prisma migrate deploy" : "prisma db push",
  HAS_MIGRATIONS ? prisma("migrate", "deploy") : prisma("db", "push"),
);

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

/** `process.env.X` (or `process.env["X"]` for a name that is not an identifier). */
function processEnv(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name)
    ? `process.env.${name}`
    : `process.env[${JSON.stringify(name)}]`;
}

/** The config expression for one Prisma 6 schema URL (its variable, else its literal). */
function urlExpr(url: SchemaUrl | undefined, fallbackVar: string): string {
  if (url?.env !== undefined) return processEnv(url.env);
  if (url?.literal !== undefined) return JSON.stringify(url.literal);
  return processEnv(fallbackVar);
}

/** The helper a SQLite config rebases its Prisma 6, schema-relative `file:` path with. */
const CONFIG_SQLITE_HELPER = "denextSqliteUrl";

/**
 * The `datasource: { … }` property (and any helper it needs, declared before the config) that
 * carries a Prisma 6 schema's URLs into `prisma.config.ts`. The URL is read with `process.env`
 * rather than `prisma/config`'s `env()`, which throws while the variable is unset, so
 * `prisma generate` keeps working without a database URL, as it did on Prisma 6. A SQLite path
 * is rebased as the injected adapter rebases it (see {@link sqliteUrlHelper}): Prisma 6 resolved
 * it against `prisma/`, Prisma 7 against the working directory. A server database migrates
 * through `directUrl` when the schema has one (the Prisma 7 upgrade guide's mapping).
 */
function configDatasource(plan: TransformPlan, urls: SchemaUrls): { helper: string; prop: string } {
  if (wiredProvider(plan.provider) === "sqlite") {
    const source = `${processEnv(plan.envVar)} ?? ${JSON.stringify(plan.sqlite.fallback)}`;
    return {
      helper:
        `// Prisma 6 resolved a relative SQLite \`file:\` path against prisma/, Prisma 7 resolves it
// against this directory: keep pointing at the same file (the app's adapter does the same).
const ${CONFIG_SQLITE_HELPER} = (url: string): string => {
${rebaseSqliteBody("url")}
};
`,
      prop: `datasource: { url: ${CONFIG_SQLITE_HELPER}(${source}) }`,
    };
  }
  const url = urlExpr(urls.directUrl ?? urls.url, plan.envVar);
  const shadow = urls.shadowDatabaseUrl
    ? `, shadowDatabaseUrl: ${urlExpr(urls.shadowDatabaseUrl, plan.envVar)}`
    : "";
  return { helper: "", prop: `datasource: { url: ${url}${shadow} }` };
}

/**
 * Prisma 7's CLI reads the datasource URL and the seed from `prisma.config.ts` only. Write the
 * file when the app has none; otherwise add what it lacks (the datasource a Prisma 6 schema
 * declared, the seed) and point its seed at Deno. A config that already declares a datasource
 * (a Prisma 7 app's, or one an earlier migrate wrote) keeps it.
 */
async function writePrismaConfig(plan: TransformPlan, warnings: string[]): Promise<void> {
  const path = join(plan.dir, PRISMA_CONFIG);
  const config = await mfs.readTextFile(path).catch(() => null);
  const seed = plan.seed ? seedCommand(plan.seed) : null;
  const ds = plan.configDatasource ? configDatasource(plan, plan.configDatasource) : null;
  if (config === null) {
    if (ds) await mfs.writeTextFile(path, newPrismaConfig(ds, seed));
    return;
  }
  const next = amendPrismaConfig(seed ? withDenoSeed(config, seed) : config, ds, seed, warnings);
  if (next !== config) await mfs.writeTextFile(path, next);
}

/** A new `prisma.config.ts` for an app that had none (see {@link writePrismaConfig}). */
function newPrismaConfig(ds: { helper: string; prop: string }, seed: string | null): string {
  const what = seed
    ? "the schema, the seed and the datasource URL"
    : "the schema and the datasource URL";
  const migrations = seed ? `\n  migrations: { seed: ${JSON.stringify(seed)} },` : "";
  return `// Prisma 7's CLI configuration, written by \`denext migrate\`: ${what}
// the CLI migrates (Prisma 7 reads it here, not from schema.prisma). The app opens its database
// through the driver adapter injected where it constructs PrismaClient.
import { defineConfig } from "prisma/config";
${ds.helper ? `\n${ds.helper}` : ""}
export default defineConfig({
  schema: "prisma/schema.prisma",${migrations}
  ${ds.prop},
});
`;
}

/** Point an existing `migrations.seed` at Deno, or add the seed to an existing `migrations`. */
function withDenoSeed(config: string, seed: string): string {
  if (/\bseed\s*:/.test(config)) {
    return config.replace(
      /(\bseed\s*:\s*)(["'`])[^"'`]+\2/,
      (_m, key: string, q: string) => `${key}${q}${seed}${q}`,
    );
  }
  return config.replace(/\bmigrations\s*:\s*\{/, (m) => `${m} seed: ${JSON.stringify(seed)},`);
}

/**
 * Add the datasource (and a seed when the config has no `migrations`) to an existing
 * `prisma.config.ts`, right inside its `defineConfig({` / `export default {`; a config of another
 * shape gets a warning instead.
 */
function amendPrismaConfig(
  config: string,
  ds: { helper: string; prop: string } | null,
  seed: string | null,
  warnings: string[],
): string {
  const props = missingConfigProps(config, ds, seed);
  if (!props.length) return config;
  const open = /\bdefineConfig\s*\(\s*\{|\bexport\s+default\s*\{/.exec(config);
  if (!open) {
    warnings.push(
      `${PRISMA_CONFIG}: no \`defineConfig({ … })\` / \`export default { … }\` found — add ` +
        `\`${props.join(", ")}\` to it by hand (Prisma 7 reads the datasource URL there).`,
    );
    return config;
  }
  const at = open.index + open[0].length;
  const next = config.slice(0, at) + props.map((prop) => `\n  ${prop},`).join("") +
    config.slice(at);
  if (!ds?.helper) return next;
  const exp = /^export\s+default\b/m.exec(next)?.index ?? open.index;
  return next.slice(0, exp) + ds.helper + "\n" + next.slice(exp);
}

/** The properties a config lacks: the seed (no `seed` key at all) and the datasource. */
function missingConfigProps(
  config: string,
  ds: { prop: string } | null,
  seed: string | null,
): string[] {
  const props = ds ? [ds.prop] : [];
  if (seed && !/\bseed\s*:/.test(config)) {
    props.unshift(`migrations: { seed: ${JSON.stringify(seed)} }`);
  }
  return props;
}

/** The relative specifier from `file`'s directory to the generated client entry `generated`. */
function relToGenerated(file: string, generated: string): string {
  let rel = relative(dirname(file), generated).replace(/\\/g, "/");
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

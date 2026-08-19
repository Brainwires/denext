// One-time setup for the Prisma example. Prisma's better-sqlite3 driver adapter
// hard-depends on the native `better-sqlite3`, so we substitute denext's node:sqlite
// compat for it with Deno's `links` field (see deno.json) — but the linked package
// must be self-contained JS (an npm-internal import of the compat's .ts fails with
// "Loading unprepared module"), so we first bundle the compat into it.
//
// Steps: bundle the compat → the links package → install (applies the link) →
// `prisma generate` (the ESM/Deno client) → `prisma db push` (create the schema).
//
// Run from the example dir: `deno task setup`.

const DENO = Deno.execPath();

// The compat source to bundle into the links package. In this monorepo it's the
// framework's own file; a published app would bundle "jsr:@denext/denext/better-sqlite3".
const COMPAT_SRC = "../../src/compat/better-sqlite3.ts";
const SHIM_OUT = "patch/better-sqlite3/index.mjs";

async function run(step: string, args: string[]): Promise<void> {
  console.log(`\n▸ ${step}`);
  const { success } = await new Deno.Command(DENO, { args, stdout: "inherit", stderr: "inherit" })
    .output();
  if (!success) {
    console.error(`\n✗ setup failed at: ${step}`);
    Deno.exit(1);
  }
}

// 1. Bundle the node:sqlite-backed compat into the links package (node:sqlite stays
//    external — it's a Deno builtin). `--no-config` avoids the app's manual
//    node_modules (not installed yet at this point).
await run("bundle the better-sqlite3 compat", [
  "bundle",
  "--no-config",
  "--format",
  "esm",
  "--external",
  "node:sqlite",
  "-o",
  SHIM_OUT,
  COMPAT_SRC,
]);

// 2. Install deps and apply the link (materializes the compat as `better-sqlite3`).
await run("install deps + apply the link", ["install"]);

// 3. Generate the Prisma client (ESM, Deno runtime — no Rust engine).
await run("prisma generate", ["run", "-A", "npm:prisma@^6.7.0", "generate"]);

// 4. Create the database schema.
await run("prisma db push", [
  "run",
  "-A",
  "npm:prisma@^6.7.0",
  "db",
  "push",
  "--skip-generate",
  "--accept-data-loss",
]);

console.log("\n✓ setup complete — run `deno task dev` (or build && start).");

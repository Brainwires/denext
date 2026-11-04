// `cargo audit` over every Rust-built wasm package's lockfile (packages/*/Cargo.lock):
//
//   deno task audit:cargo
//
// Each package is audited from its own directory, so its `.cargo/audit.toml` ignores apply (each
// ignore there says why the advisory cannot reach the shipped wasm). A vulnerability or an
// `unsound` advisory fails; `unmaintained` ones are printed and pass. The advisory database is
// fetched fresh on every run, so a new advisory against an unchanged lockfile fails too.
//
// The binary is `$CARGO_AUDIT`, else `cargo-audit` on PATH (`cargo install cargo-audit --locked`).
// ci.yml's `cargo-audit` job runs this, and `deno task precheck` runs it when a package's
// Cargo.lock, Cargo.toml or .cargo/audit.toml changed.

import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The advisory kinds that fail the audit on top of vulnerabilities (`cargo audit --deny`). */
export const DENY: readonly string[] = ["unsound"];

/** Whether `path` (repository-relative) is an input of the cargo audit. */
export function isCargoAuditInput(path: string): boolean {
  return /^packages\/[^/]+\/(Cargo\.(lock|toml)|\.cargo\/audit\.toml)$/.test(path);
}

/** The `cargo-audit` arguments for one package directory. */
export function auditArgs(): string[] {
  return ["audit", ...DENY.flatMap((kind) => ["--deny", kind])];
}

/** The repository-relative package directories that have a Cargo.lock, sorted. */
export async function cargoPackages(root: string = ROOT): Promise<string[]> {
  const dirs: string[] = [];
  for await (const entry of Deno.readDir(`${root}packages`)) {
    if (!entry.isDirectory) continue;
    try {
      if ((await Deno.stat(`${root}packages/${entry.name}/Cargo.lock`)).isFile) {
        dirs.push(`packages/${entry.name}`);
      }
    } catch { /* no Rust in this package */ }
  }
  return dirs.sort();
}

/** The cargo-audit binary to run: `$CARGO_AUDIT`, else `cargo-audit` on PATH. */
export function cargoAuditBinary(env: Pick<typeof Deno.env, "get"> = Deno.env): string {
  return env.get("CARGO_AUDIT") || "cargo-audit";
}

/** Whether the cargo-audit binary can be started. */
export async function cargoAuditAvailable(binary: string = cargoAuditBinary()): Promise<boolean> {
  try {
    const { success } = await new Deno.Command(binary, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

/** Audit every package; returns the directories that failed. */
export async function auditAll(
  root: string = ROOT,
  binary: string = cargoAuditBinary(),
): Promise<string[]> {
  const failed: string[] = [];
  for (const dir of await cargoPackages(root)) {
    console.log(`\ncargo audit: ${dir}`);
    const { code } = await new Deno.Command(binary, {
      args: auditArgs(),
      cwd: `${root}${dir}`,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (code !== 0) failed.push(dir);
  }
  return failed;
}

if (import.meta.main) {
  const binary = cargoAuditBinary();
  if (!await cargoAuditAvailable(binary)) {
    console.error(
      `cargo audit: \`${binary}\` not found. Install it (\`cargo install cargo-audit --locked\`) ` +
        "or point $CARGO_AUDIT at the binary.",
    );
    Deno.exit(2);
  }
  const failed = await auditAll(ROOT, binary);
  if (failed.length) {
    console.error(
      `\ncargo audit: ${failed.join(", ")} failed. Update the dependency (\`cargo update -p ` +
        "<crate>` or the parent crate), or, when the code provably cannot reach the wasm, add an " +
        "ignore with the reason to that package's .cargo/audit.toml.",
    );
    Deno.exit(1);
  }
  console.log("\ncargo audit: ok");
}

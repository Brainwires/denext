// `deno task audit:cargo` (scripts/cargo-audit.ts): `cargo audit` over every wasm package's
// Cargo.lock, each from its own directory so its `.cargo/audit.toml` ignores apply. ci.yml's
// `cargo-audit` job and `deno task precheck` run it.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  auditAll,
  auditArgs,
  cargoAuditAvailable,
  cargoAuditBinary,
  cargoPackages,
  isCargoAuditInput,
} from "../scripts/cargo-audit.ts";

const ROOT = new URL("../", import.meta.url);

Deno.test("cargo audit: every Rust-built wasm package is audited", async () => {
  assertEquals(await cargoPackages(), ["packages/lightningcss", "packages/photon", "packages/swc"]);
});

Deno.test("cargo audit: vulnerabilities and unsound advisories fail", () => {
  assertEquals(auditArgs(), ["audit", "--deny", "unsound"]);
});

Deno.test("cargo audit: the precheck inputs are the lockfile, manifest and ignore list", () => {
  assert(isCargoAuditInput("packages/swc/Cargo.lock"));
  assert(isCargoAuditInput("packages/lightningcss/Cargo.toml"));
  assert(isCargoAuditInput("packages/photon/.cargo/audit.toml"));
  assertFalse(isCargoAuditInput("packages/swc/.cargo/config.toml"));
  assertFalse(isCargoAuditInput("packages/swc/src/lib.rs"));
  assertFalse(isCargoAuditInput("Cargo.lock"));
});

Deno.test("cargo audit: the binary is $CARGO_AUDIT, else cargo-audit on PATH", async () => {
  assertEquals(cargoAuditBinary({ get: () => undefined }), "cargo-audit");
  assertEquals(cargoAuditBinary({ get: () => "/opt/ca" }), "/opt/ca");
  assertFalse(await cargoAuditAvailable("/nonexistent/cargo-audit-binary"));
});

Deno.test("cargo audit: every ignore is a RUSTSEC id with its reason beside it", async () => {
  for (const dir of await cargoPackages()) {
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(`${dir}/.cargo/audit.toml`, ROOT));
    } catch {
      continue; // nothing ignored
    }
    // The `ignore = [ … ]` list's quoted entries (comments aside).
    const list = text.slice(text.indexOf("ignore = ["));
    const ignore = [...list.slice(0, list.indexOf("]")).matchAll(/^\s*"([^"]+)"/gm)].map((m) =>
      m[1]
    );
    assert(ignore.length > 0, `${dir}: .cargo/audit.toml ignores nothing; delete it`);
    for (const id of ignore) {
      assert(/^RUSTSEC-\d{4}-\d{4}$/.test(id), `${dir}: ${id} is not a RUSTSEC id`);
      const block = text.slice(0, text.indexOf(`"${id}"`));
      assert(block.includes(`# ${id}`), `${dir}: ${id} has no comment giving its reason`);
    }
  }
});

Deno.test("cargo audit: lightningcss builds without the sourcemap feature (no rkyv)", async () => {
  const lock = await Deno.readTextFile(new URL("packages/lightningcss/Cargo.lock", ROOT));
  // RUSTSEC-2026-0235: rkyv 0.7 came only through parcel_sourcemap (lightningcss `sourcemap`).
  assertFalse(lock.includes('name = "rkyv"'));
  assertFalse(lock.includes('name = "parcel_sourcemap"'));
});

Deno.test("cargo audit: ci.yml runs it, and a release needs it green", async () => {
  const ci = parseYaml(
    await Deno.readTextFile(new URL(".github/workflows/ci.yml", ROOT)),
  ) as { jobs: Record<string, { steps: { run?: string }[] }> };
  const job = ci.jobs["cargo-audit"];
  assert(job, "ci.yml has no cargo-audit job");
  assert(job.steps.some((s) => s.run?.includes("deno task audit:cargo")));
  const { RELEASE_CI_JOBS } = await import("../scripts/release-ci.ts");
  assert(RELEASE_CI_JOBS.includes("cargo-audit"));
});

Deno.test({
  name: "cargo audit: each package runs from its own directory; a failing one is reported",
  ignore: Deno.build.os === "windows", // the fake binary is a shell script
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      for (const p of ["a", "b", "c"]) {
        await Deno.mkdir(join(root, "packages", p), { recursive: true });
      }
      await Deno.writeTextFile(join(root, "packages", "a", "Cargo.lock"), "");
      await Deno.writeTextFile(join(root, "packages", "b", "Cargo.lock"), "");
      // c has no Rust: not audited.
      const log = join(root, "calls.log");
      const fake = join(root, "fake-cargo-audit");
      await Deno.writeTextFile(
        fake,
        `#!/bin/sh\necho "$(basename "$PWD") $*" >> "${log}"\n[ "$(basename "$PWD")" != b ]\n`,
      );
      await Deno.chmod(fake, 0o755);
      const failed = await auditAll(`${root}/`, fake);
      assertEquals(failed, ["packages/b"]);
      assertEquals(
        (await Deno.readTextFile(log)).trim().split("\n"),
        ["a audit --deny unsound", "b audit --deny unsound"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

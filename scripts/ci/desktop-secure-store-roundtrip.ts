/**
 * CI-only: exercise the REAL `secureStore` backend against the running OS credential store — WinRT
 * `PasswordVault` on Windows (`powershell.exe`), libsecret `secret-tool` on Linux, the Keychain on
 * macOS. The unit tests use a fake runner; this proves the actual round-trip on a Windows / Linux
 * runner (the platforms the maintainer's Mac can't verify). set → get → delete → get(absent).
 *
 * Run: `deno run -A scripts/ci/desktop-secure-store-roundtrip.ts` — exits non-zero on any mismatch.
 * Driven by `.github/workflows/desktop-ci.yml`. NOT part of the unit suite (it touches the OS store).
 *
 * @module
 */

import { secureStoreCapability } from "../../src/desktop/caps/secure-store.ts";

const cap = secureStoreCapability({ service: `dev.denext.ci.${crypto.randomUUID()}` });
const ctx = {
  emit() {},
  appSupportDir: "",
  os: Deno.build.os as "darwin" | "windows" | "linux",
  signal: AbortSignal.timeout(30_000),
};

/** Invoke a capability method with a minimal ctx. */
function call(method: string, args: unknown): Promise<unknown> {
  const m = cap.methods[method];
  if (!m) throw new Error(`no method ${method}`);
  return Promise.resolve(m.handler(args, ctx));
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(
      `FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    Deno.exit(1);
  }
  console.log(`ok   ${label}`);
}

const key = "ci-token";
// A value with a newline, quote and non-ASCII byte — the base64 wrapping must survive them.
const secret = 'line1\nline2 🔒 "q"';

try {
  await call("set", { key, value: secret });
  assertEq(await call("get", { key }), secret, "get returns the stored secret");
  assertEq(await call("get", { key: "absent" }), null, "get(absent) is null");
  await call("delete", { key });
  assertEq(await call("get", { key }), null, "get after delete is null");
  console.log(`\n✓ secureStore round-trip passed on ${ctx.os}`);
} catch (err) {
  console.error(
    `\n✗ secureStore round-trip threw on ${ctx.os}:`,
    err instanceof Error ? err.message : err,
  );
  // Best-effort cleanup, then fail.
  await call("delete", { key }).catch(() => {});
  Deno.exit(1);
}

// The e2e harness's process-state hygiene (tests/e2e/harness.ts, tests/e2e/clerk-keys.ts). deno
// test runs every e2e file in one process, so a variable one file leaves in `Deno.env` is read by
// the next: e2e run 40657805948's keyless Clerk test failed its `deno install` (killed at 600 s)
// before restoring its placeholder keys, and the keyed Clerk test then took them for a real
// instance and got Clerk's 401. And a child killed at its deadline must say what it was doing.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  clerkTestKeys,
  KEYLESS_FAPI,
  KEYLESS_PUBLISHABLE_KEY,
  KEYLESS_SECRET_KEY,
} from "./e2e/clerk-keys.ts";
import { describeTimeout, runDeno, setEnv, withEnv } from "./e2e/harness.ts";

const CLERK_NAMES = [
  "CLERK_TEST_PUBLISHABLE_KEY",
  "CLERK_TEST_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
];

/** Run `fn` with every Clerk key name unset (and an example dir with no .env), then restore. */
async function withoutClerkKeys(fn: (dir: string) => Promise<void>): Promise<void> {
  const prior = Object.fromEntries(CLERK_NAMES.map((k) => [k, Deno.env.get(k)]));
  for (const k of CLERK_NAMES) Deno.env.delete(k);
  const dir = await Deno.makeTempDir({ prefix: "denext-clerk-keys-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("e2e clerk keys: the keyless test's placeholders are never taken for an instance", async () => {
  await withoutClerkKeys(async (dir) => {
    // Exactly what the keyless test sets.
    await withEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: KEYLESS_PUBLISHABLE_KEY,
      CLERK_SECRET_KEY: KEYLESS_SECRET_KEY,
    }, async () => assertEquals(await clerkTestKeys(dir), null));
    // Either half alone is enough to refuse: the made-up instance with any secret, or the
    // placeholder secret with any instance.
    await withEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa(`${KEYLESS_FAPI}$`),
      CLERK_SECRET_KEY: "sk_test_something_else",
    }, async () => assertEquals(await clerkTestKeys(dir), null));
    const real = "pk_test_" + btoa("example-dev-1.clerk.accounts.dev$");
    await withEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: real,
      CLERK_SECRET_KEY: KEYLESS_SECRET_KEY,
    }, async () => assertEquals(await clerkTestKeys(dir), null));
    // A real development instance's keys still pass.
    await withEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: real,
      CLERK_SECRET_KEY: "sk_test_real",
    }, async () => {
      assertEquals(await clerkTestKeys(dir), { publishableKey: real, secretKey: "sk_test_real" });
    });
  });
});

Deno.test("e2e harness: withEnv restores the environment when its body throws", async () => {
  const name = "DENEXT_E2E_HARNESS_ENV_PROBE";
  const kept = "DENEXT_E2E_HARNESS_ENV_KEPT";
  Deno.env.delete(name);
  Deno.env.set(kept, "before");
  try {
    await assertRejects(
      () =>
        withEnv({ [name]: "leaked?", [kept]: "during" }, () => {
          assertEquals(Deno.env.get(name), "leaked?");
          return Promise.reject(new Error("deno install failed"));
        }),
      Error,
      "deno install failed",
    );
    assertEquals(Deno.env.get(name), undefined, "a name that was unset is unset again");
    assertEquals(Deno.env.get(kept), "before", "a name that was set gets its old value back");
    const restore = setEnv({ [name]: "x" });
    assertEquals(Deno.env.get(name), "x");
    restore();
    assertEquals(Deno.env.get(name), undefined);
  } finally {
    Deno.env.delete(name);
    Deno.env.delete(kept);
  }
});

Deno.test("e2e harness: a child killed at its deadline reports its silence and last lines", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-run-deno-" });
  try {
    // Prints like a stalled `deno install`, then hangs (an interval keeps it alive).
    const script = [
      "console.error('Download https://registry.npmjs.org/a');",
      "console.log('stdout line');",
      "console.error('Download https://registry.npmjs.org/stalled');",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const res = await runDeno(["eval", script], dir, 3_000);
    assertEquals(res.ok, false);
    assertStringIncludes(res.out, "did not finish within 3000ms and was killed");
    assertStringIncludes(res.out, "printed nothing for the last");
    assertStringIncludes(res.out, "its last progress line started a download");
    assertStringIncludes(res.out, "https://registry.npmjs.org/stalled");
    assertStringIncludes(res.out, "  | stdout line");
    assertEquals(res.stdout.trim(), "stdout line", "stdout alone, as before");
    // A child that finishes is reported as before: no timeout report.
    const ok = await runDeno(["eval", "console.log('done')"], dir, 60_000);
    assert(ok.ok, ok.out);
    assertEquals(ok.stdout.trim(), "done");
    assert(!ok.out.includes("did not finish"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("e2e harness: the timeout report quotes at most the last 25 lines, or says it was silent", () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const report = describeTimeout(["install"], 600_000, 540_000, many);
  assertStringIncludes(report, "`deno install` did not finish within 600000ms");
  assertStringIncludes(report, "nothing for the last 540s");
  assertStringIncludes(report, "last 25 of 40 lines");
  assert(!report.includes("| line 14\n") && report.includes("| line 15"));
  assert(!report.includes("started a download"), "the last line is no download");
  assertStringIncludes(describeTimeout(["install"], 1000, 1000, ""), "It printed nothing at all.");
  // Coloured, as CI prints it (FORCE_COLOR): still read as a download.
  const esc = String.fromCharCode(27);
  const coloured = `${esc}[0m${esc}[32mDownload${esc}[0m https://registry.npmjs.org/next`;
  assertStringIncludes(
    describeTimeout(["install"], 1000, 1000, coloured),
    "started a download (https://registry.npmjs.org/next)",
  );
});

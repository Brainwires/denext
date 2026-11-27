// Tests never reach the live runtime channel or revoked-runtimes list: every pass scripts/test-run.ts
// runs, and every CI workflow that runs tests, carries the variables that turn both off, and under
// them neither loader reads a cache or fetches anything. Tests of the checks inject their own keys,
// documents and environment.

import { assert, assertEquals } from "@std/assert";
import { HERMETIC_ENV, passEnv } from "../scripts/test-run.ts";
import { loadRuntimeRevocations } from "../src/build/runtime-revocations.ts";
import { loadRuntimeChannel } from "../src/build/runtime-channel.ts";

Deno.test("hermetic env: every test pass turns off the live channel and revocation list", () => {
  const env = passEnv("/r");
  for (const [k, v] of Object.entries(HERMETIC_ENV)) assertEquals(env[k], v, k);
  assertEquals(HERMETIC_ENV.DENEXT_REVOCATION_CHECK, "0");
  assertEquals(HERMETIC_ENV.DENEXT_RUNTIME_CHANNEL, "0");
});

Deno.test("hermetic env: the CI workflows that run tests set it for every job", async () => {
  for (const name of ["ci", "desktop-ci", "e2e"]) {
    const text = await Deno.readTextFile(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
    );
    const top = /^env:\n((?: {2}.*\n)+)/m.exec(text)?.[1] ?? "";
    for (const [k, v] of Object.entries(HERMETIC_ENV)) {
      assert(top.includes(`  ${k}: "${v}"\n`), `${name}.yml sets ${k} at the top level`);
    }
  }
});

Deno.test("hermetic env: under it neither loader reads a cache or touches the network", async () => {
  const env = (k: string) => HERMETIC_ENV[k];
  const fetched: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    fetched.push(String(input));
    return Promise.reject(new Error("no network in tests"));
  }) as typeof globalThis.fetch;
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext_hermetic_" });
  try {
    const revocations = await loadRuntimeRevocations({ env, fetch, cacheRoot, mode: "force" });
    assertEquals(revocations.configured, false);
    const channel = await loadRuntimeChannel({ env, fetch, cacheRoot, mode: "force" });
    assertEquals(channel.channel, null);
    assertEquals(channel.absent, "off");
    assertEquals(fetched, []);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

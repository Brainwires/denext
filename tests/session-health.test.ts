// A session secret production refuses takes the instance out of rotation: `/_denext/health`'s
// readiness checks report `session: "down"` (the probe answers 503), so a load balancer or a
// HEALTHCHECK stops routing to an instance whose every page would 500. Up to 4.5.0 the probe kept
// answering `ok` while each request failed on the missing / short `SESSION_SECRET`.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import {
  checkSessionSecretAtBoot,
  getSession,
  resetSessionHealthForTesting,
} from "../src/server/session.ts";
import { runHealthChecks } from "../src/server/health.ts";

const FORCE_PRODUCTION = Symbol.for("denext.testing.forceProduction");
const flags = globalThis as Record<symbol, unknown>;

/** Run `fn` under the production signal with console.error captured. */
async function inProduction(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  flags[FORCE_PRODUCTION] = true;
  try {
    await fn();
  } finally {
    delete flags[FORCE_PRODUCTION];
    console.error = original;
    resetSessionHealthForTesting();
  }
  return logged;
}

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(createRequestContext(new Request("https://app.example/")), fn);
}

Deno.test("a refused session secret makes /_denext/health unhealthy in production", async () => {
  for (const secret of ["short", ""]) {
    const logged = await inProduction(async () => {
      assertEquals((await runHealthChecks()).ok, true, "healthy before");
      await assertRejects(() => inRequest(() => getSession({ secret })));
      assertEquals(await runHealthChecks(), { ok: false, checks: { session: "down" } });
    });
    assertEquals(logged.length, 1, logged.join("\n"));
    assert(logged[0].includes("/_denext/health"), logged[0]);
  }
  assertEquals((await runHealthChecks()).ok, true, "reset");
});

Deno.test("a short SESSION_SECRET is reported at boot, before any request", async () => {
  const logged = await inProduction(() => {
    checkSessionSecretAtBoot((name) => name === "SESSION_SECRET" ? "too-short" : undefined);
    return runHealthChecks().then((r) => assertEquals(r.checks, { session: "down" }));
  });
  assert(logged.some((l) => l.includes("SESSION_SECRET")), logged.join("\n"));
  // A strong one, an unset one, or development: nothing to report.
  for (
    const [env, production] of [
      [{ SESSION_SECRET: "x".repeat(32) }, true],
      [{}, true],
      [{ SESSION_SECRET: "short" }, false],
    ] as const
  ) {
    if (production) flags[FORCE_PRODUCTION] = true;
    try {
      checkSessionSecretAtBoot((name) => (env as Record<string, string>)[name]);
      assertEquals((await runHealthChecks()).ok, true, JSON.stringify(env));
    } finally {
      delete flags[FORCE_PRODUCTION];
      resetSessionHealthForTesting();
    }
  }
});

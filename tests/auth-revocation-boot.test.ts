// DENEXT_BOOT_DDL=off: a `denextAuth` whose adapter keeps a revocation list checks that the list
// can be read before the server serves (packages/auth/src/mod.ts). A list whose table is missing
// (migration 0009 not applied out of band) fails the start as a BootSchemaError naming it, not as
// every stateless cookie session reading "signed out" once the first request looks its sid up.
// Serial: it sets and restores DENEXT_BOOT_DDL (listed in tests/serial-tests.ts).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { denextAuth } from "../packages/auth/src/mod.ts";
import { credentials } from "../packages/auth/src/providers.ts";
import { REVOCATIONS_MARKER } from "../packages/auth/src/sid-revocation.ts";
import type { AuthConfig } from "../packages/auth/src/types.ts";
import type { PluginContext } from "../src/plugin/mod.ts";
import { BOOT_DDL_ENV, BootSchemaError, verifyBootSchemas } from "../src/server/postgres-boot.ts";

/** Run `fn` with `DENEXT_BOOT_DDL` set to `value` (unset with `undefined`), restored after. */
async function withBootDdl<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = Deno.env.get(BOOT_DDL_ENV);
  if (value === undefined) Deno.env.delete(BOOT_DDL_ENV);
  else Deno.env.set(BOOT_DDL_ENV, value);
  try {
    return await fn();
  } finally {
    if (before === undefined) Deno.env.delete(BOOT_DDL_ENV);
    else Deno.env.set(BOOT_DDL_ENV, before);
  }
}

function config(adapter: AuthAdapter | undefined): AuthConfig {
  return {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: "https://app.test",
    providers: [credentials({ authorize: () => null })],
    rateLimit: false,
    ...(adapter ? { adapter } : {}),
  };
}

/** A plugin context with the seams `denextAuth`'s setup uses. */
const ctx = {
  addRequestHandler: () => {},
  addTeardown: () => {},
  addCommand: () => {},
} as unknown as PluginContext;

/** An adapter whose revocation list can't be read (its table is missing), counting the reads. */
function listless(): { adapter: AuthAdapter; reads: string[] } {
  const reads: string[] = [];
  const base = inMemoryAuthAdapter();
  const adapter: AuthAdapter = {
    ...base,
    isSidRevoked(sid) {
      reads.push(sid);
      throw new Error('relation "auth_revoked_sessions" does not exist');
    },
  };
  return { adapter, reads };
}

Deno.test("DENEXT_BOOT_DDL=off: a revocation list that can't be read refuses the start as a BootSchemaError", async () => {
  await withBootDdl("off", async () => {
    await verifyBootSchemas().catch(() => {}); // nothing left over from another test
    const { adapter, reads } = listless();
    await denextAuth(config(adapter)).setup(ctx);
    const error = await assertRejects(() => verifyBootSchemas(), BootSchemaError);
    assertStringIncludes(error.message, "revocation list can't be read with DENEXT_BOOT_DDL=off");
    assertStringIncludes(error.message, "0009_auth_sso_cookie_sessions");
    assertStringIncludes(error.message, "auth_revoked_sessions");
    assertEquals(reads, [REVOCATIONS_MARKER], "one marker lookup, nothing written");
    // An adapter's own BootSchemaError (the Postgres adapter's migration check) passes through.
    const schema = new BootSchemaError("postgresAuthAdapter: not migrated", [
      "auth_migrations:0009",
    ]);
    await denextAuth(config({
      ...inMemoryAuthAdapter(),
      isSidRevoked: () => {
        throw schema;
      },
    })).setup(ctx);
    assert(await assertRejects(() => verifyBootSchemas(), BootSchemaError) === schema);
  });
});

Deno.test("DENEXT_BOOT_DDL=off: a readable list, or an adapter without one, starts", async () => {
  await withBootDdl("off", async () => {
    await verifyBootSchemas().catch(() => {});
    await denextAuth(config(inMemoryAuthAdapter())).setup(ctx);
    await verifyBootSchemas();
    const { revokeSids: _r, isSidRevoked: _i, ...noList } = inMemoryAuthAdapter();
    await denextAuth(config(noList)).setup(ctx);
    await denextAuth(config(undefined)).setup(ctx);
    await verifyBootSchemas();
  });
});

Deno.test("with boot DDL on (the default) no check is registered: the list is created on first use", async () => {
  await withBootDdl(undefined, async () => {
    const { adapter, reads } = listless();
    await denextAuth(config(adapter)).setup(ctx);
    await verifyBootSchemas();
    assertEquals(reads, []);
  });
});

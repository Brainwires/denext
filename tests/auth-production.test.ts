// The production fail-closed guards: under the deploy signal (`DENEXT_ENV=production`)
// `denextAuth()` refuses to boot without a `canonicalOrigin` or with a brute-forceable
// secret, and an emailed link (password reset, magic link) is never built on the request's
// attacker-controllable Host header — with `canonicalOrigin` the link is on it whatever
// the Host says; without it the request is an error and nothing is mailed.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { isProductionEnv } from "../src/server/session.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { credentials, magicLink } from "../src/server/auth/providers.ts";
import { accountRoutes } from "../src/server/auth/routes-account.ts";
import { emailCallbacks } from "../src/server/auth/routes-email.ts";
import type { AuthRouteContext } from "../src/server/auth/routes-shared.ts";
import type {
  AuthConfig,
  EmailProvider,
  VerificationRequestParams,
} from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const EVIL = "evil.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

/** Run `fn` under the production signal, restoring the environment however it ends. */
async function inProduction(fn: () => void | Promise<void>): Promise<void> {
  const flags = globalThis as Record<symbol, unknown>;
  // Per isolate, unlike DENEXT_ENV (shared by every --parallel test module).
  flags[Symbol.for("denext.testing.forceProduction")] = true;
  try {
    assert(isProductionEnv());
    await fn();
  } finally {
    delete flags[Symbol.for("denext.testing.forceProduction")];
  }
  assert(!isProductionEnv(), "signal restored");
}

/** A config over an in-memory adapter with a recording mailer and a silent error log. */
function setup(
  extra: Partial<AuthConfig> = {},
): { config: AuthConfig; sent: VerificationRequestParams[]; errors: string[] } {
  const sent: VerificationRequestParams[] = [];
  const errors: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [credentials({ authorize: () => Promise.resolve(null) })],
    adapter: inMemoryAuthAdapter(),
    sendVerificationRequest: (params) => void sent.push(params),
    logger: { error: (message) => void errors.push(message) },
    ...extra,
  };
  return { config, sent, errors };
}

let userCount = 0;

/** Create an adapter user with a fresh address (the send budget is keyed per address). */
async function makeUser(config: AuthConfig): Promise<string> {
  const email = `prod-${++userCount}@x.test`;
  await config.adapter!.createUser({ email });
  return email;
}

/**
 * A same-origin JSON POST whose `Host` header says `evil.test`. The `Origin` header
 * matches what the same-origin check compares against (the canonical origin when set,
 * else the Host), so the request reaches the link builder either way.
 */
function forgedHostRequest(config: AuthConfig, path: string, body: Record<string, string>) {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, {
    method: "POST",
    headers: {
      host: EVIL,
      origin: config.canonicalOrigin ?? `https://${EVIL}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  setRemoteAddr(request, { transport: "tcp", hostname: "203.0.113.9", port: 443 });
  const route: AuthRouteContext = {
    request,
    config,
    options: resolveAuthOptions(config),
    url,
    method: "POST",
    params: {},
  };
  return { request, route };
}

/** `POST /auth/reset` for `email`, driven the way the dispatcher would, mail flushed. */
async function postReset(config: AuthConfig, email: string): Promise<Response | null> {
  const row = accountRoutes.find((r) => r.method === "POST" && r.pattern === "/reset")!;
  const { request, route } = forgedHostRequest(config, "/auth/reset", { email });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => row.handler(route));
  await runDeferred(ctx);
  return res;
}

/** `POST /auth/callback/<magic link>` for `email`, mail flushed. */
async function postMagicLink(
  config: AuthConfig,
  provider: EmailProvider,
  email: string,
): Promise<Response> {
  const { request, route } = forgedHostRequest(config, `/auth/callback/${provider.id}`, {
    email,
  });
  const ctx = createRequestContext(request);
  const res = await runWithContext(
    ctx,
    () => emailCallbacks.POST({ ...route, params: { provider: provider.id } }, provider),
  );
  await runDeferred(ctx);
  return res;
}

// ---- denextAuth() boot guards -------------------------------------------------

Deno.test("production: denextAuth() without canonicalOrigin throws (a warning only in dev)", async () => {
  const { config } = setup({ canonicalOrigin: undefined });
  // Outside production the same config boots (the Host fallback is a dev convenience).
  denextAuth(config);
  await inProduction(() => {
    assertThrows(() => denextAuth(config), Error, "`canonicalOrigin` is required in production");
    // With it set, the same config boots in production.
    denextAuth({ ...config, canonicalOrigin: ORIGIN });
  });
});

Deno.test("production: denextAuth() with a secret under 32 chars throws", async () => {
  const short = "only-sixteen-chr";
  assertEquals(short.length, 16);
  // Dev tolerates the weak secret (getSession warns once); production refuses to boot.
  denextAuth(setup({ secret: short }).config);
  await inProduction(() => {
    assertThrows(
      () => denextAuth(setup({ secret: short }).config),
      Error,
      "shorter than 32 chars",
    );
    assertThrows(
      () => denextAuth(setup({ secret: [SECRET, short] }).config),
      Error,
      "shorter than 32 chars",
      "every rotated secret must be strong",
    );
    denextAuth(setup().config);
  });
});

// ---- emailed links never derive their origin from Host in production ------------

Deno.test("production: a reset link is built on canonicalOrigin, whatever the Host header says", async () => {
  const { config, sent } = setup();
  const email = await makeUser(config);
  await inProduction(async () => {
    const res = await postReset(config, email);
    assertEquals(res?.status, 200);
    assertEquals(sent.length, 1, "one link mailed");
    assert(sent[0].url.startsWith(`${ORIGIN}/auth/reset?`), sent[0].url);
    assert(!sent[0].url.includes(EVIL), "the forged Host never reaches the link");
  });
});

Deno.test("production: without canonicalOrigin a reset request is an error and mails nothing", async () => {
  const { config, sent } = setup({ canonicalOrigin: undefined });
  const email = await makeUser(config);
  // Control: in dev the same forged request DOES mail a link on the Host header — which
  // is exactly what production must refuse.
  assertEquals((await postReset(config, email))?.status, 200);
  assertEquals(sent.length, 1);
  assert(sent[0].url.startsWith(`https://${EVIL}/auth/reset?`), sent[0].url);
  sent.length = 0;
  await inProduction(async () => {
    await assertRejects(
      () => postReset(config, email),
      Error,
      "emailed links need `canonicalOrigin`",
    );
    assertEquals(sent.length, 0, "the mailer was never invoked");
  });
});

Deno.test("production: a magic link is built on canonicalOrigin, whatever the Host header says", async () => {
  const provider = magicLink();
  const { config, sent } = setup({ providers: [provider] });
  const email = await makeUser(config);
  await inProduction(async () => {
    const res = await postMagicLink(config, provider, email);
    assertEquals(res.status, 200);
    assertEquals(sent.length, 1, "one link mailed");
    assert(sent[0].url.startsWith(`${ORIGIN}/auth/callback/${provider.id}?`), sent[0].url);
    assert(!sent[0].url.includes(EVIL), "the forged Host never reaches the link");
  });
});

Deno.test("production: without canonicalOrigin a magic-link request is an error and mails nothing", async () => {
  const provider = magicLink();
  const { config, sent } = setup({ providers: [provider], canonicalOrigin: undefined });
  const email = await makeUser(config);
  assertEquals((await postMagicLink(config, provider, email)).status, 200, "dev control");
  assertEquals(sent.length, 1);
  assert(sent[0].url.startsWith(`https://${EVIL}/`), sent[0].url);
  sent.length = 0;
  await inProduction(async () => {
    await assertRejects(
      () => postMagicLink(config, provider, email),
      Error,
      "emailed links need `canonicalOrigin`",
    );
    assertEquals(sent.length, 0, "the mailer was never invoked");
  });
});

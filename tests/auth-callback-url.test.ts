// `callbackUrl` normalization: where a completed sign-in lands. The value is
// request-supplied (query, form field, JSON body), so it must come back as a same-origin
// target however it is spelled — leading or embedded C0 controls, space and DEL are not
// allowed to change what the scheme check sees.

import { assert, assertEquals } from "@std/assert";
import type { PluginContext, PluginRequestHandler } from "../src/plugin/mod.ts";
import {
  type AuthConfig,
  credentials,
  denextAuth,
  hashPassword,
  inMemoryAuthAdapter,
} from "../src/server/mod.ts";
import { afterSignIn, sameOriginRedirect } from "../src/server/auth/routes-shared.ts";
import { safeRedirectLocation } from "../src/server/config.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@x.test";
const PASSWORD = "correct horse battery";
const FALLBACK = "/home";

/** Prefixes that the URL parser (or a browser) ignores in front of a URL. */
const PREFIXES = [" ", "\t", "\n", "\r", "\u0000", "\u001f", "\u007f"];

function config(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    providers: [credentials()],
    pages: { signIn: "/login", afterSignIn: FALLBACK },
    ...extra,
  };
}

/** Whether `location` resolves on `ORIGIN` (a path, or an absolute URL on it). */
function staysHome(location: string): boolean {
  return new URL(location, ORIGIN).origin === ORIGIN;
}

for (const withCanonical of [false, true]) {
  const label = withCanonical ? "with canonicalOrigin" : "without canonicalOrigin";
  const cfg = config(withCanonical ? { canonicalOrigin: ORIGIN } : {});

  Deno.test(`afterSignIn ${label}: a prefixed absolute URL falls back`, () => {
    for (const p of PREFIXES) {
      const out = afterSignIn(cfg, `${p}https://other.test/x`);
      assertEquals(out, FALLBACK, `prefix ${JSON.stringify(p)} gave ${out}`);
    }
  });

  Deno.test(`afterSignIn ${label}: controls inside the scheme fall back`, () => {
    for (
      const input of [
        "https:\t//other.test",
        "https:/\t/other.test",
        "ht\ntps://other.test/x",
        "HTTPS:\r\n//other.test",
        "\u0000\u0000https://other.test",
      ]
    ) {
      const out = afterSignIn(cfg, input);
      assertEquals(out, FALLBACK, `${JSON.stringify(input)} gave ${out}`);
    }
  });

  Deno.test(`afterSignIn ${label}: other schemes and protocol-relative stay home`, () => {
    for (
      const input of [
        "javascript:alert(1)",
        " javascript:alert(1)",
        "//other.test/x",
        "/\\other.test/x",
        "\\\\other.test/x",
        "/\t/other.test/x",
        " //other.test/x",
      ]
    ) {
      const out = afterSignIn(cfg, input);
      assert(staysHome(out), `${JSON.stringify(input)} left the origin: ${out}`);
      assert(!out.startsWith("//"), `${JSON.stringify(input)} gave ${out}`);
    }
  });

  Deno.test(`afterSignIn ${label}: relative paths are kept`, () => {
    assertEquals(afterSignIn(cfg, "/dashboard?t=1#top"), "/dashboard?t=1#top");
    assertEquals(afterSignIn(cfg, "/"), "/");
    assertEquals(afterSignIn(cfg, null), FALLBACK);
    assertEquals(afterSignIn(cfg, ""), FALLBACK);
  });
}

Deno.test("afterSignIn: an absolute URL on the canonical origin keeps its path", () => {
  const cfg = config({ canonicalOrigin: ORIGIN });
  assertEquals(afterSignIn(cfg, `${ORIGIN}/dashboard?t=1`), "/dashboard?t=1");
  assertEquals(afterSignIn(cfg, ` ${ORIGIN}/dashboard`), "/dashboard");
  assertEquals(afterSignIn(cfg, "https://other.test/dashboard"), FALLBACK);
});

Deno.test("afterSignIn: an absolute URL on the request's own origin keeps its path", () => {
  const cfg = config();
  assertEquals(afterSignIn(cfg, `${ORIGIN}/dashboard`, `${ORIGIN}/auth/x`), "/dashboard");
  assertEquals(afterSignIn(cfg, `${ORIGIN}/dashboard`), FALLBACK, "no origin to compare");
  assertEquals(afterSignIn(cfg, "https://other.test/d", `${ORIGIN}/auth/x`), FALLBACK);
});

Deno.test("sameOriginRedirect: a configured absolute fallback is still honoured", () => {
  const cfg = config();
  assertEquals(
    sameOriginRedirect(cfg, null, "https://accounts.example/home"),
    "https://accounts.example/home",
  );
});

Deno.test("safeRedirectLocation: a value that was not absolute stays relative", () => {
  for (const p of PREFIXES) {
    const out = safeRedirectLocation(`${p}https://other.test/x`);
    assert(staysHome(out), `prefix ${JSON.stringify(p)} gave ${out}`);
  }
  assert(staysHome(safeRedirectLocation("https:\t//other.test")));
  assertEquals(safeRedirectLocation("https://ok.example/x"), "https://ok.example/x");
  assertEquals(safeRedirectLocation("/a"), "/a");
  assertEquals(safeRedirectLocation("//a"), "/a");
});

// ---- the credentials form POST ---------------------------------------------------

async function mount(): Promise<PluginRequestHandler> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL, name: "Ada" });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const handlers: PluginRequestHandler[] = [];
  const ctx = {
    addRequestHandler: (handler: PluginRequestHandler) => void handlers.push(handler),
    addTeardown: () => {},
  } as unknown as PluginContext;
  await denextAuth(config({
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    adapter,
    logger: { warn: () => {} },
  })).setup(ctx);
  return handlers[0];
}

async function postForm(handle: PluginRequestHandler, callbackUrl: string): Promise<Response> {
  const body = new URLSearchParams({ email: EMAIL, password: PASSWORD, callbackUrl });
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  setRemoteAddr(request, { transport: "tcp", hostname: "203.0.113.7", port: 443 });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, async () => await handle(request));
  await runDeferred(ctx);
  assert(res, "the auth handler claimed the request");
  return res;
}

Deno.test("credentials form POST: a prefixed absolute callbackUrl lands on the fallback", async () => {
  const handle = await mount();
  for (
    const input of [" https://other.test/x", "https:\t//other.test", "\u0000https://other.test"]
  ) {
    const res = await postForm(handle, input);
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), FALLBACK, JSON.stringify(input));
  }
  const ok = await postForm(handle, "/dashboard");
  assertEquals(ok.headers.get("location"), "/dashboard");
});

// examples/clerk without keys (every CI run): the config denext validates (Clerk's CSP sources,
// the dev-server origins, the Deno Desktop origin / deep links / capabilities, passkey RP
// pinning), the preload installing the Clerk bridge synchronously, the key checks the app gates
// on, and the setup screen a fresh clone shows. The keyed flows are tests/e2e/clerk.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { render } from "../src/testing/render.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { clerkCsp, frontendApiHost } from "../examples/clerk/lib/clerk-csp.ts";
import { hasPublishableKey, hasServerKeys } from "../examples/clerk/lib/clerk-env.ts";
import { SetupScreen } from "../examples/clerk/app/setup-screen.tsx";

const EXAMPLE = fromFileUrl(new URL("../examples/clerk", import.meta.url));
/** A made-up development instance's publishable key (`pk_test_` + base64 of `<host>$`). */
const FAKE_PK = "pk_test_" + btoa("example-dev-1.clerk.accounts.dev$");
const ENV_NAMES = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "DENEXT_CLERK_DEV_HOST",
  "DENEXT_CLERK_PASSKEY_RP_IDS",
];

/** Run `fn` with `env` set (and the example's other variables cleared), then restore. */
async function withEnv(env: Record<string, string>, fn: () => Promise<void> | void) {
  const prior = Object.fromEntries(ENV_NAMES.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_NAMES) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

let loads = 0;
/** The example's config, evaluated now (a fresh module instance per call). */
async function loadConfig(): Promise<DenextConfig> {
  const url = toFileUrl(join(EXAMPLE, "denext.config.ts")).href + `?load=${++loads}`;
  return (await import(url)).default as DenextConfig;
}

Deno.test("clerk example: the config validates, with Clerk's CSP and the desktop shell", async () => {
  await withEnv({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: FAKE_PK }, async () => {
    const config = await loadConfig();
    validateDenextConfig(config); // throws on an invalid key or value
    assertEquals(config.compatibilityMode, true);
    const csp = config.csp as Record<string, string[]>;
    assert(csp.scriptSrc.includes("https://example-dev-1.clerk.accounts.dev"));
    assert(csp.scriptSrc.includes("https://challenges.cloudflare.com"));
    assert(csp.connectSrc.includes("https://example-dev-1.clerk.accounts.dev"));
    assertEquals(csp.styleSrc, ["'unsafe-inline'"]);
    assertEquals(csp.workerSrc, ["blob:"]);
    const desktop = config.desktop!;
    assertEquals(desktop.app?.origin, "denextclerk://app");
    assertEquals(desktop.app?.deepLinks, ["denextclerk"]);
    assertEquals(desktop.app?.identifier, "dev.denext.clerk-example");
    assertEquals(desktop.preload, "./desktop/preload.ts");
    const caps = desktop.capabilities as Record<string, unknown>;
    assertEquals(caps.secureStore, true);
    assertEquals(caps.authSession, true);
    // Passkeys pin their relying parties; none configured → [] (every native request is
    // refused and a sign-in continues in the browser), never `true`.
    assertEquals(caps.passkeys, { rpIds: [] });
    assertEquals(config.allowedDevOrigins, []);
    // The Capacitor shell's page origins call the API cross-origin with a bearer token.
    assertEquals(config.cors?.origins, ["capacitor://localhost", "https://localhost"]);
    assert(config.cors?.headers?.includes("authorization"));
    assertEquals(config.cors?.credentials, undefined); // bearer only, never cookies
  });
});

Deno.test("clerk example: the shell installs Clerk's mobile bridge before clerk-js loads", async () => {
  const src = await Deno.readTextFile(join(EXAMPLE, "instrumentation-client.ts"));
  assertStringIncludes(src, 'from "denext/mobile/clerk"');
  assertStringIncludes(
    src,
    'installClerkMobileBridge({ scheme: "denextclerk", nativeClerk: true })',
  );
  const capacitor = JSON.parse(await Deno.readTextFile(join(EXAMPLE, "capacitor.config.json")));
  assertEquals(capacitor.webDir, "out");
});

Deno.test("clerk example: tailnet host and passkey RPs come from the environment", async () => {
  await withEnv({
    DENEXT_CLERK_DEV_HOST: "mac.tail1234.ts.net",
    DENEXT_CLERK_PASSKEY_RP_IDS: "example.com, auth.example.com",
  }, async () => {
    const config = await loadConfig();
    validateDenextConfig(config);
    assertEquals(config.allowedDevOrigins, ["mac.tail1234.ts.net"]);
    assertEquals((config.desktop!.capabilities as Record<string, unknown>).passkeys, {
      rpIds: ["example.com", "auth.example.com"],
    });
    // No key: the wildcard development Frontend API only.
    const csp = config.csp as Record<string, string[]>;
    assertEquals(csp.scriptSrc.filter((s) => s.includes("clerk.accounts.dev")), [
      "https://*.clerk.accounts.dev",
    ]);
  });
});

Deno.test("clerk example: the Frontend API host a publishable key encodes", () => {
  assertEquals(frontendApiHost(FAKE_PK), "example-dev-1.clerk.accounts.dev");
  assertEquals(frontendApiHost("pk_live_" + btoa("clerk.example.com$")), "clerk.example.com");
  for (const bad of [undefined, "", "sk_test_x", "pk_test_!!!", "pk_test_" + btoa("no-dollar")]) {
    assertEquals(frontendApiHost(bad), null, String(bad));
  }
  // A host that is not a hostname never reaches the CSP.
  assertEquals(frontendApiHost("pk_test_" + btoa("evil.com; script-src *$")), null);
  assertEquals(clerkCsp(undefined).imgSrc, ["https://img.clerk.com"]);
});

Deno.test("clerk example: the key checks the app gates on", async () => {
  await withEnv({}, () => {
    assertEquals([hasPublishableKey(), hasServerKeys()], [false, false]);
  });
  await withEnv({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: FAKE_PK }, () => {
    // The page can load (desktop export), the server cannot verify sessions yet.
    assertEquals([hasPublishableKey(), hasServerKeys()], [true, false]);
  });
  await withEnv(
    { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: FAKE_PK, CLERK_SECRET_KEY: "sk_test_x" },
    () => {
      assertEquals([hasPublishableKey(), hasServerKeys()], [true, true]);
    },
  );
  await withEnv({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ placeholder" }, () => {
    assertEquals(hasPublishableKey(), false); // .env.example's blank / a typo: the setup screen
  });
});

Deno.test("clerk example: a fresh clone shows the setup screen", async () => {
  const screen = await render(h(SetupScreen, null));
  const text = screen.container.textContent ?? "";
  assertStringIncludes(text, "Set up Clerk");
  assertStringIncludes(text, ".env.local");
  assertStringIncludes(text, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  assertStringIncludes(text, "CLERK_SECRET_KEY");
  screen.unmount();
});

Deno.test("clerk example: the preload installs the Clerk bridge synchronously", async () => {
  const src = await Deno.readTextFile(join(EXAMPLE, "desktop/preload.ts"));
  const code = src.replace(/\/\/[^\n]*/g, "");
  const call = code.indexOf("installClerkDesktopBridge(");
  assert(call > 0, "the preload calls installClerkDesktopBridge");
  // Nothing may defer it: no top-level await or dynamic import before (or around) the call —
  // the bridge reads its per-launch preload key only while the preload runs.
  assert(!/\bawait\b/.test(code), "no await in the preload");
  assert(!/\bimport\s*\(/.test(code), "no dynamic import in the preload");
  assertStringIncludes(code.slice(call), "nativeClerk");
  assertStringIncludes(code.slice(call), "passkeys: true");
  // The middleware and the API route check the session themselves (no keys → pass-through).
  const mw = await Deno.readTextFile(join(EXAMPLE, "middleware.ts"));
  assertStringIncludes(mw, "clerkMiddleware(");
  assertStringIncludes(mw, "hasServerKeys()");
  const api = await Deno.readTextFile(join(EXAMPLE, "app/api/me/route.ts"));
  assertStringIncludes(api, "createApi().use(clerkSession)");
});

Deno.test("clerk example: the protected page exports and checks the session in the browser", async () => {
  // A static page (no force-dynamic, no server-only Clerk helper), so `denext export` writes it
  // for the Capacitor shell and the Deno Desktop window; the middleware still guards it on the web.
  const page = await Deno.readTextFile(join(EXAMPLE, "app/protected/page.tsx"));
  assert(!page.includes("force-dynamic"));
  assert(!page.includes("@clerk/nextjs/server"));
  assertStringIncludes(page, "<ProtectedContent />");
  const mw = await Deno.readTextFile(join(EXAMPLE, "middleware.ts"));
  assertStringIncludes(mw, '"/protected(.*)"');
  // Signed out: Clerk's sign-in modal (never a navigation a native shell would open outside the
  // app). Signed in: the server verifies the bearer token through GET /api/me.
  const panel = await Deno.readTextFile(join(EXAMPLE, "app/account-panel.tsx"));
  const content = panel.slice(panel.indexOf("export function ProtectedContent"));
  assertStringIncludes(content, '<SignInButton mode="modal" />');
  assertStringIncludes(content, 'apiUrl("/api/me")');
  assertStringIncludes(content, "authorization: `Bearer ${token}`");
  assertStringIncludes(content, 'id="protected-me"');
  // The header links to it with a plain anchor (the shell serves the exported page).
  const header = await Deno.readTextFile(join(EXAMPLE, "app/header.tsx"));
  assertStringIncludes(header, "<Nav />");
  assertStringIncludes(panel, '<a href="/protected">');
});

Deno.test("clerk example: keys are never committed", async () => {
  // .env.example ships empty values; .env / .env.local are git-ignored.
  const example = await Deno.readTextFile(join(EXAMPLE, ".env.example"));
  assert(!/(pk|sk)_(test|live)_[A-Za-z0-9]{8,}/.test(example));
  const ignore = await Deno.readTextFile(join(EXAMPLE, "../../.gitignore"));
  assertStringIncludes(ignore, "examples/*/.env");
  assertStringIncludes(ignore, "examples/*/.env.local");
});

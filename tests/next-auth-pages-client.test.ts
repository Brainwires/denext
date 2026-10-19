// The next-auth shim's built-in pages and the browser state its client modules share: every
// branch of the sign-in form (credentials with and without fields, labels, types and
// placeholders; email; OAuth; WebAuthn left out), the escaping, the error codes and statuses, and
// `client-state.ts` — the provider refetch, the same-origin rule for a `callbackUrl` (on and off
// a page) and navigation.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clientState,
  currentHref,
  DEFAULT_BASE_PATH,
  navigate,
  refetchers,
  refreshProviders,
  sameOrigin,
} from "../src/compat/next-auth/client-state.ts";
import {
  errorPage,
  signInPage,
  signOutPage,
  verifyRequestPage,
} from "../src/compat/next-auth/pages.ts";
import Credentials from "../src/compat/next-auth/providers/credentials.ts";
import GitHub from "../src/compat/next-auth/providers/github.ts";
import Passkey from "../src/compat/next-auth/providers/passkey.ts";
import Resend from "../src/compat/next-auth/providers/resend.ts";
import type { ProviderDescriptor } from "../src/compat/next-auth/providers/shared.ts";

const query = (init: Record<string, string> = {}) => new URLSearchParams(init);

Deno.test("pages: the sign-in page has a form per provider, WebAuthn left out", async () => {
  const providers = [
    Credentials({
      credentials: {
        email: { label: "E-mail", type: "email", placeholder: "you@example.com" },
        password: { type: "password" },
        otp: {},
      },
    }),
    GitHub({ clientId: "id", clientSecret: "secret" }),
    Resend({ from: "auth@app.test" }),
    Passkey({}),
  ] as ProviderDescriptor[];
  const res = signInPage("/api/auth", providers, 'tok"<en>', query({ callbackUrl: "/x?a=1&b=2" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assertStringIncludes(html, '<form method="post" action="/api/auth/callback/credentials">');
  assertStringIncludes(
    html,
    '<label>E-mail <input name="email" type="email" placeholder="you@example.com"></label>',
  );
  assertStringIncludes(html, '<label>password <input name="password" type="password"></label>');
  assertStringIncludes(html, '<label>otp <input name="otp" type="text"></label>');
  assertStringIncludes(html, 'action="/api/auth/signin/github"');
  assertStringIncludes(html, '<input name="email" type="email" required>');
  assert(!html.includes("/signin/passkey"), "a passkey signs in from script");
  // The hidden fields are escaped.
  assertStringIncludes(html, 'value="tok&quot;&lt;en&gt;"');
  assertStringIncludes(html, 'name="callbackUrl" value="/x?a=1&amp;b=2"');
  assert(!html.includes('role="alert"'), "no error, no message");
});

Deno.test("pages: a credentials provider without fields, and the default callbackUrl", async () => {
  const html = await signInPage(
    "/auth",
    [Credentials({ name: "Pass <phrase>" }) as ProviderDescriptor],
    "t",
    query(),
  ).text();
  assertStringIncludes(html, 'name="callbackUrl" value="/"');
  assertStringIncludes(html, "Sign in with Pass &lt;phrase&gt;</button>");
  assert(!html.includes("<label>"));
});

Deno.test("pages: error codes — known, unknown, prototype keys — and their statuses", async () => {
  const known = await signInPage("/a", [], "t", query({ error: "CredentialsSignin" })).text();
  assertStringIncludes(known, "Sign in failed. Check the details you provided are correct.");
  for (const code of ["Nope", "constructor", "__proto__"]) {
    const html = await signInPage("/a", [], "t", query({ error: code })).text();
    assertStringIncludes(html, '<p role="alert">Unable to sign in.</p>', code);
  }
  assertEquals(errorPage(query({ error: "Configuration" })).status, 500);
  assertEquals(errorPage(query({ error: "AccessDenied" })).status, 400);
  const fallback = errorPage(query());
  assertEquals(fallback.status, 400);
  assertStringIncludes(await fallback.text(), "Unable to sign in.");
});

Deno.test("pages: sign-out and check-your-email", async () => {
  const out = await signOutPage("/api/auth", "t", query({ callbackUrl: "/bye" })).text();
  assertStringIncludes(out, 'action="/api/auth/signout"');
  assertStringIncludes(out, 'name="callbackUrl" value="/bye"');
  assertStringIncludes(await signOutPage("/a", "t", query()).text(), 'value="/"');
  assertStringIncludes(await verifyRequestPage().text(), "Check your email");
});

/** Run `fn` with `globalThis.location` set to `href` (and a recording `reload`). */
function onPage(href: string, fn: (reloads: () => number) => void): void {
  let reloads = 0;
  const location = { href, reload: () => void reloads++ };
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  try {
    fn(() => reloads);
  } finally {
    delete (globalThis as { location?: unknown }).location;
  }
}

Deno.test("client state: the base path default and every mounted provider's refetch", async () => {
  assertEquals(clientState.basePath, DEFAULT_BASE_PATH);
  let calls = 0;
  const a = () => void calls++;
  const b = () => void (calls += 10);
  refetchers.add(a);
  refetchers.add(b);
  try {
    await refreshProviders();
    assertEquals(calls, 11);
  } finally {
    refetchers.delete(a);
    refetchers.delete(b);
  }
});

Deno.test("client state: off a page — `/`, and navigate does nothing", () => {
  assertEquals(currentHref(), "/");
  assertEquals(sameOrigin("/dashboard"), "http://localhost/dashboard");
  navigate("/anywhere"); // no location: no throw
});

Deno.test("client state: a callbackUrl is kept to this page's origin and http(s)", () => {
  onPage("https://app.test/login?x=1", () => {
    assertEquals(currentHref(), "https://app.test/login?x=1");
    assertEquals(sameOrigin("/dashboard"), "https://app.test/dashboard");
    assertEquals(sameOrigin("https://app.test/a#b"), "https://app.test/a#b");
    for (
      const hostile of ["https://evil.test/", "//evil.test/x", "javascript:alert(1)", "data:,x"]
    ) {
      assertEquals(sameOrigin(hostile), "https://app.test/login?x=1", hostile);
    }
    for (const empty of [undefined, null, 42, ""]) {
      assertEquals(sameOrigin(empty), "https://app.test/login?x=1");
    }
    // An unparseable URL falls back to this page.
    assertEquals(sameOrigin("http://[::1"), "https://app.test/login?x=1");
  });
});

Deno.test("client state: navigate follows a URL, reloading for a hash-only change", () => {
  onPage("https://app.test/", (reloads) => {
    navigate("https://app.test/next");
    assertEquals(globalThis.location.href, "https://app.test/next");
    assertEquals(reloads(), 0);
    navigate("https://app.test/next#top");
    assertEquals(globalThis.location.href, "https://app.test/next#top");
    assertEquals(reloads(), 1);
  });
});

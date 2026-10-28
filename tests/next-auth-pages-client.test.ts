// The next-auth shim's built-in pages and the browser state its client modules share: every
// branch of the sign-in form (credentials with and without fields, labels, types and
// placeholders; email; OAuth; WebAuthn as the passkey button and its script), the escaping, the error codes and statuses, and
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
} from "../packages/auth/next-auth/client-state.ts";
import {
  errorPage,
  PASSKEY_SCRIPT,
  PASSKEY_SCRIPT_HASH,
  signInPage,
  signOutPage,
  verifyRequestPage,
} from "../packages/auth/next-auth/pages.ts";
import Credentials from "../packages/auth/next-auth/providers/credentials.ts";
import GitHub from "../packages/auth/next-auth/providers/github.ts";
import Passkey from "../packages/auth/next-auth/providers/passkey.ts";
import Resend from "../packages/auth/next-auth/providers/resend.ts";
import type { ProviderDescriptor } from "../packages/auth/next-auth/providers/shared.ts";

const query = (init: Record<string, string> = {}) => new URLSearchParams(init);

Deno.test("pages: the sign-in page has a form per provider, WebAuthn as a passkey button", async () => {
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
  assertStringIncludes(
    html,
    '<button type="button" data-denext-passkey hidden data-base="/api/auth" ' +
      'data-callback="/x?a=1&amp;b=2">Sign in with Passkey</button>',
  );
  assertStringIncludes(html, `<script>${PASSKEY_SCRIPT}</script>`);
  // The page's own CSP runs that script, by its hash, and nothing else inline.
  assertEquals(
    res.headers.get("content-security-policy"),
    `script-src ${PASSKEY_SCRIPT_HASH}; object-src 'none'; base-uri 'none'`,
  );
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
  assert(!html.includes("<script"), "no WebAuthn provider, no script");
});

Deno.test("pages: PASSKEY_SCRIPT_HASH is the script's SHA-256", async () => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PASSKEY_SCRIPT)),
  );
  assertEquals(PASSKEY_SCRIPT_HASH, `'sha256-${btoa(String.fromCharCode(...digest))}'`);
});

/** A stand-in for the page the passkey script runs in: one button, its error line, the calls. */
function passkeyPage(get: () => Promise<unknown>, verify: Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const error = { hidden: true };
  let onClick: (() => void) | undefined;
  const attrs: Record<string, string> = { "data-base": "/api/auth", "data-callback": "/dash" };
  const button = {
    hidden: true,
    nextElementSibling: error,
    getAttribute: (name: string) => attrs[name] ?? null,
    addEventListener: (_type: string, fn: () => void) => void (onClick = fn),
  };
  const assigned: string[] = [];
  const globals = {
    window: { PublicKeyCredential: function PublicKeyCredential() {} },
    navigator: { credentials: { get } },
    document: { querySelectorAll: () => [button] },
    location: { assign: (url: string) => void assigned.push(url) },
    fetch: (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve(
        url.endsWith("/options")
          ? Response.json({
            challenge: "AQID",
            allowCredentials: [{ id: "BAU", type: "public-key" }],
            ceremonyId: "c1",
          })
          : verify,
      );
    },
  };
  new Function(...Object.keys(globals), PASSKEY_SCRIPT)(...Object.values(globals));
  const click = async () => {
    onClick!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { button, error, calls, assigned, click };
}

Deno.test("pages: the passkey script runs the sign-in ceremony and lands on the server's URL", async () => {
  const bytes = (...b: number[]) => new Uint8Array(b).buffer;
  let asked: { publicKey: { challenge: ArrayBuffer; allowCredentials: { id: ArrayBuffer }[] } };
  const page = passkeyPage(
    // deno-lint-ignore no-explicit-any
    (options?: any) => {
      asked = options;
      return Promise.resolve({
        id: "cred",
        rawId: bytes(250, 251),
        type: "public-key",
        response: {
          clientDataJSON: bytes(1),
          authenticatorData: bytes(2),
          signature: bytes(3),
          userHandle: bytes(4),
        },
      });
    },
    Response.json({ url: "/dash" }),
  );
  assertEquals(page.button.hidden, false, "WebAuthn found: the button shows");
  await page.click();
  assertEquals(page.calls.map((c) => c.url), [
    "/api/auth/passkey/authenticate/options",
    "/api/auth/passkey/authenticate",
  ]);
  assertEquals([...new Uint8Array(asked!.publicKey.challenge)], [1, 2, 3]);
  assertEquals([...new Uint8Array(asked!.publicKey.allowCredentials[0].id)], [4, 5]);
  assertEquals(page.calls[1].body, {
    credential: {
      id: "cred",
      rawId: "-vs",
      type: "public-key",
      response: {
        clientDataJSON: "AQ",
        authenticatorData: "Ag",
        signature: "Aw",
        userHandle: "BA",
      },
      clientExtensionResults: {},
    },
    ceremonyId: "c1",
    callbackUrl: "/dash",
  });
  assertEquals(page.assigned, ["/dash"]);
  assertEquals(page.error.hidden, true);
});

Deno.test("pages: the passkey script says nothing on a cancel and shows a refusal", async () => {
  const cancelled = passkeyPage(
    () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })),
    Response.json({}),
  );
  await cancelled.click();
  assertEquals([cancelled.calls.length, cancelled.error.hidden], [1, true], "a cancel is silent");
  const refused = passkeyPage(
    () =>
      Promise.resolve({
        id: "c",
        rawId: new ArrayBuffer(1),
        type: "public-key",
        toJSON: () => ({ id: "c" }),
      }),
    new Response("{}", { status: 400 }),
  );
  await refused.click();
  assertEquals(refused.calls[1].body.credential, { id: "c" }, "the browser's own toJSON()");
  assertEquals([refused.assigned, refused.error.hidden], [[], false], "the refusal shows");
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

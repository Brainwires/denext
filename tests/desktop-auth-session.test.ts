// denext/desktop OAuth sign-in: the token-gated loopback-redirect flow. Exercises the server
// half's validation (method, token, origin, content-type, body) failing closed, the single-session
// guard, a happy path driven by an injected `openBrowser` that simulates the system browser
// hitting the loopback listener, and the `injectDesktopGlobal` shell injection (incl. its CSP hash).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  browserLaunchArgs,
  handleDesktopAuthSession,
  resetDesktopAuthSessionForTesting,
} from "../src/desktop/auth-session-runtime.ts";
import { injectDesktopGlobal } from "../src/build/desktop.ts";

const TOKEN = "per-launch-token-abcdef";
const ENDPOINT = "http://127.0.0.1:8000/_denext/desktop/auth-session";
const VALID_AUTH_URL = "https://auth.example.com/authorize?client_id=x&state=s1&redirect_uri=" +
  encodeURIComponent("http://127.0.0.1/callback");

/** SHA-256 → base64, matching the CSP hash form the runtime emits. */
async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

interface ReqOpts {
  token?: string | null;
  origin?: string | null;
  contentType?: string | null;
  method?: string;
}

/** Build an auth-session request; pass `null` for a header to omit it. */
function req(body: unknown, opts: ReqOpts = {}): Request {
  const {
    token = TOKEN,
    origin = "http://127.0.0.1:8000",
    contentType = "application/json",
    method = "POST",
  } = opts;
  const headers = new Headers();
  if (token !== null) headers.set("x-denext-desktop-token", token);
  if (origin !== null) headers.set("origin", origin);
  if (contentType !== null) headers.set("content-type", contentType);
  return new Request(ENDPOINT, {
    method,
    headers,
    body: method === "GET" || method === "HEAD"
      ? undefined
      : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

const noopBrowser = () => {};

Deno.test("desktop auth-session: missing token → 403", async () => {
  resetDesktopAuthSessionForTesting();
  const res = await handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL }, { token: null }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(res.status, 403);
});

Deno.test("desktop auth-session: foreign token → 403", async () => {
  resetDesktopAuthSessionForTesting();
  const res = await handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL }, { token: "not-the-token-xxxxxx" }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(res.status, 403);
});

Deno.test("desktop auth-session: foreign Origin → 403", async () => {
  resetDesktopAuthSessionForTesting();
  const res = await handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL }, { origin: "https://evil.example.com" }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(res.status, 403);
});

Deno.test("desktop auth-session: a different loopback-port Origin → 403 (exact-origin)", async () => {
  resetDesktopAuthSessionForTesting();
  // Another local app's dev server (loopback, different port) must NOT reach the endpoint.
  const res = await handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL }, { origin: "http://127.0.0.1:9999" }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(res.status, 403);
});

Deno.test("browserLaunchArgs: an OAuth URL is one un-parsed argv entry on every OS (no cmd &-split)", () => {
  const url = "https://idp.example.com/authorize?client_id=x&redirect_uri=" +
    "http://127.0.0.1:5000/cb&state=s1&scope=openid+profile";
  // Windows: rundll32 FileProtocolHandler, NOT `cmd /c start` — the whole URL (every `&`) is a
  // single argv element, so cmd.exe never parses it as command separators.
  const [winCmd, winArgs] = browserLaunchArgs("windows", url);
  assertEquals(winCmd, "rundll32.exe");
  assertEquals(winArgs, ["url.dll,FileProtocolHandler", url]);
  assertEquals(winArgs.length, 2);
  assertEquals(winArgs[1], url);
  assertEquals(browserLaunchArgs("darwin", url), ["open", [url]]);
  assertEquals(browserLaunchArgs("linux", url), ["xdg-open", [url]]);
});

Deno.test("desktop auth-session: missing Origin → 403", async () => {
  resetDesktopAuthSessionForTesting();
  const res = await handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL }, { origin: null }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(res.status, 403);
});

Deno.test("desktop auth-session: GET → 405", async () => {
  resetDesktopAuthSessionForTesting();
  const res = await handleDesktopAuthSession(req(null, { method: "GET" }), TOKEN, noopBrowser);
  assertEquals(res.status, 405);
});

Deno.test("desktop auth-session: non-json content-type → 415", async () => {
  resetDesktopAuthSessionForTesting();
  const res = await handleDesktopAuthSession(
    req(JSON.stringify({ authUrl: VALID_AUTH_URL }), { contentType: "text/plain" }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(res.status, 415);
});

Deno.test("desktop auth-session: non-https authUrl → 400 invalid", async () => {
  resetDesktopAuthSessionForTesting();
  const authUrl = "http://auth.example.com/authorize?redirect_uri=" +
    encodeURIComponent("http://127.0.0.1/callback");
  const res = await handleDesktopAuthSession(req({ authUrl }), TOKEN, noopBrowser);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, "invalid");
});

Deno.test("desktop auth-session: non-loopback redirect_uri → 400 invalid", async () => {
  resetDesktopAuthSessionForTesting();
  const authUrl = "https://auth.example.com/authorize?redirect_uri=" +
    encodeURIComponent("http://evil.example.com/callback");
  const res = await handleDesktopAuthSession(req({ authUrl }), TOKEN, noopBrowser);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, "invalid");
});

Deno.test("desktop auth-session: fragment in redirect_uri → 400 invalid", async () => {
  resetDesktopAuthSessionForTesting();
  const authUrl = "https://auth.example.com/authorize?redirect_uri=" +
    encodeURIComponent("http://127.0.0.1/callback#frag");
  const res = await handleDesktopAuthSession(req({ authUrl }), TOKEN, noopBrowser);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, "invalid");
});

Deno.test("desktop auth-session: second concurrent call → 409 busy", async () => {
  resetDesktopAuthSessionForTesting();
  // First call: a no-op browser, so it stays pending until its short timeout.
  const first = handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL, timeoutMs: 300 }),
    TOKEN,
    noopBrowser,
  );
  // Let the first call get past body-parse and set the busy flag.
  await new Promise((r) => setTimeout(r, 60));
  const second = await handleDesktopAuthSession(
    req({ authUrl: VALID_AUTH_URL }),
    TOKEN,
    noopBrowser,
  );
  assertEquals(second.status, 409);
  assertEquals((await second.json()).code, "busy");
  // Drain the first (it times out, closes its listener, clears busy).
  const firstRes = await first;
  assertEquals(firstRes.status, 408);
  assertEquals((await firstRes.json()).code, "timeout");
});

Deno.test("desktop auth-session: happy path resolves 200 with the callback URL", async () => {
  resetDesktopAuthSessionForTesting();
  let browserFetch: Promise<string> | undefined;
  // Simulate the system browser: read the rewritten redirect_uri, append code/state, and hit it.
  const openBrowser = (authUrl: string) => {
    const redirect = new URL(new URL(authUrl).searchParams.get("redirect_uri")!);
    // The runtime rewrote the redirect_uri host+port to the loopback listener.
    assertEquals(redirect.hostname, "127.0.0.1");
    assertEquals(redirect.pathname, "/callback");
    redirect.searchParams.set("code", "the-auth-code");
    redirect.searchParams.set("state", "s1");
    browserFetch = fetch(redirect.href).then((r) => r.text());
  };
  const res = await handleDesktopAuthSession(req({ authUrl: VALID_AUTH_URL }), TOKEN, openBrowser);
  assertEquals(res.status, 200);
  const { url } = await res.json();
  assertStringIncludes(url, "code=the-auth-code");
  assertStringIncludes(url, "state=s1");
  // Drain the simulated browser fetch so no response body leaks.
  assertStringIncludes(await browserFetch!, "You can close this tab.");
});

Deno.test("injectDesktopGlobal: inserts the script with the token after <head>", async () => {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><div id="root"></div></body></html>';
  const out = await injectDesktopGlobal(html, "tok-123");
  assertStringIncludes(
    out,
    '<script>globalThis.__denext={"desktop":true,"token":"tok-123"}</script>',
  );
  // Injected immediately after the opening <head>, before the first meta.
  const scriptAt = out.indexOf("<script>globalThis.__denext");
  assert(scriptAt > out.indexOf("<head>"));
  assert(scriptAt < out.indexOf("<meta charset"));
});

Deno.test("injectDesktopGlobal: adds the script's sha256 to a strict CSP meta's script-src", async () => {
  const policy = "default-src 'self'; script-src 'self'; style-src 'self'";
  const html =
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}" />` +
    "<title>x</title></head><body></body></html>";
  const out = await injectDesktopGlobal(html, "tok-abc");
  const body = 'globalThis.__denext={"desktop":true,"token":"tok-abc"}';
  const hash = `'sha256-${await sha256Base64(body)}'`;
  // The injected script is present …
  assertStringIncludes(out, `<script>${body}</script>`);
  // … and the CSP meta's script-src now allows it by hash.
  const metaContent = out.match(/content="([^"]*)"/)![1];
  assertStringIncludes(metaContent, `script-src 'self' ${hash}`);
});

Deno.test("injectDesktopGlobal: no CSP meta ⇒ script injected, nothing to patch", async () => {
  const html = "<!doctype html><html><head></head><body></body></html>";
  const out = await injectDesktopGlobal(html, "t");
  assertStringIncludes(out, '<script>globalThis.__denext={"desktop":true,"token":"t"}</script>');
  assert(!out.includes("sha256-"));
});

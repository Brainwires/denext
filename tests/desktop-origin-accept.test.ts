// A Deno Desktop window at a custom app origin (`desktop.app.origin`, e.g. `myapp://app`) sends
// that value as its `Origin`. A denext backend accepts it — byte-exactly, and only the app's own
// configured origin (or an explicitly listed custom-scheme entry) — wherever it accepts
// same-origin: the Server Action / API-batch CSRF gate, the Live handshake, `denextAuth`'s POST
// gate and the dev origin gate. Nothing changes when `desktop.app.origin` is unset.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { customSchemeOrigin, sameOriginUpgrade, verifyOrigin } from "../src/server/origin-check.ts";
import { configuredDesktopAppOrigin, resolveServerOptions } from "../src/server/config.ts";
import { devOriginError, validateDenextConfig } from "../src/server/config-validate.ts";
import { devOriginAllowed } from "../src/build/dev-server.ts";
import { effectiveDevOrigins } from "../src/build/dev-server/lan.ts";
import { isSameOrigin } from "../src/server/auth/routes-shared.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { actionEndpoint, serverAction } from "../src/runtime/server-action.ts";
import { API_BATCH_HEADER, API_BATCH_PATH } from "../src/runtime/api-batch-protocol.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { batchApp } from "./helpers/batch-app.ts";

const APP = "myapp://app";

/** A POST to the backend at `api.example.com` carrying `headers`. */
function post(headers: Record<string, string>, path = "/_denext/action/x"): Request {
  return new Request(`http://api.example.com${path}`, {
    method: "POST",
    headers: { host: "api.example.com", ...headers },
  });
}

// ---- normalization ----------------------------------------------------------

Deno.test("desktop origin: the config's desktop.app.origin is normalized as the runtime does", () => {
  const cfg = (origin: unknown) => ({ desktop: { app: { origin } } }) as unknown as DenextConfig;
  assertEquals(configuredDesktopAppOrigin(cfg(" MyApp://App/ ")), "myapp://app");
  assertEquals(resolveServerOptions(cfg("myapp://app")).desktopAppOrigin, "myapp://app");
  // Unset or invalid → nothing is accepted.
  assertEquals(configuredDesktopAppOrigin(null), undefined);
  assertEquals(configuredDesktopAppOrigin({}), undefined);
  assertEquals(resolveServerOptions({}).desktopAppOrigin, undefined);
  assertEquals(configuredDesktopAppOrigin(cfg("https://app.example.com")), undefined);
  assertEquals(configuredDesktopAppOrigin(cfg("myapp://app:8080")), undefined);
  assertEquals(customSchemeOrigin("http://localhost:3000"), null);
  assertEquals(customSchemeOrigin("localhost:3000"), null);
});

// ---- Server Actions / API batch CSRF gate -----------------------------------

Deno.test("verifyOrigin: the exact desktop app origin is accepted", () => {
  assert(verifyOrigin(post({ origin: APP }), { desktopAppOrigin: APP }));
  // The configured value is normalized; the header must be the normalized form exactly.
  assert(verifyOrigin(post({ origin: APP }), { desktopAppOrigin: "MyApp://App/" }));
  assert(!verifyOrigin(post({ origin: "MyApp://App" }), { desktopAppOrigin: APP }));
  assert(!verifyOrigin(post({ origin: "myapp://app/" }), { desktopAppOrigin: APP }));
});

Deno.test("verifyOrigin: another scheme or host is refused", () => {
  for (
    const origin of [
      "other://app",
      "myapp://evil",
      "myapp://app.evil",
      "null",
      // A custom scheme on the backend's own host is not same-origin either.
      "myapp://api.example.com",
      "app://localhost",
    ]
  ) {
    assert(!verifyOrigin(post({ origin }), { desktopAppOrigin: APP }), origin);
  }
  // A Referer at the custom origin is not an Origin match.
  assert(!verifyOrigin(post({ referer: `${APP}/page` }), { desktopAppOrigin: APP }));
});

Deno.test("verifyOrigin: no effect when desktop.app.origin is unset", () => {
  assert(!verifyOrigin(post({ origin: APP }), {}));
  // Same-origin web requests behave as before.
  assert(verifyOrigin(post({ origin: "http://api.example.com" }), {}));
  assert(verifyOrigin(post({ origin: "http://api.example.com" }), { desktopAppOrigin: APP }));
});

Deno.test("verifyOrigin: a custom-scheme allowedOrigins entry matches exactly, never as 'null'", () => {
  const opts = { allowedOrigins: ["myapp://app"] };
  assert(verifyOrigin(post({ origin: APP }), opts));
  // `new URL("myapp://app").origin` is "null": the entry must not admit every opaque origin.
  assert(!verifyOrigin(post({ origin: "other://app" }), opts));
  assert(!verifyOrigin(post({ origin: "evil://x" }), opts));
  // A `host:port` entry is a bare host (it parses as a `host:` scheme).
  assert(
    verifyOrigin(post({ origin: "http://lan.local:3000" }), { allowedOrigins: ["lan.local:3000"] }),
  );
});

Deno.test("Server Action through createApp: the app's desktop origin is accepted, others refused", async () => {
  serverAction("desk_origin_ok", () => "ok");
  const send = (app: (r: Request) => Promise<Response>, origin: string) =>
    app(
      new Request(`http://localhost${actionEndpoint("desk_origin_ok")}`, {
        method: "POST",
        headers: {
          host: "localhost",
          origin,
          "content-type": "application/json",
          "x-denext-action": "1",
        },
        body: JSON.stringify({ args: [] }),
      }),
    );
  const desktop = batchApp({ desktopAppOrigin: APP });
  assertEquals((await send(desktop, APP)).status, 200);
  assertEquals((await send(desktop, "other://app")).status, 403);
  assertEquals((await send(desktop, "myapp://evil")).status, 403);
  assertEquals((await send(batchApp(), APP)).status, 403, "unset → refused");
});

Deno.test("API batch through createApp: the app's desktop origin is accepted, others refused", async () => {
  const send = (app: (r: Request) => Promise<Response>, origin: string) =>
    app(
      new Request(`http://localhost${API_BATCH_PATH}`, {
        method: "POST",
        headers: {
          origin,
          host: "localhost",
          "content-type": "application/json",
          [API_BATCH_HEADER]: "1",
        },
        body: JSON.stringify({ v: 1, items: [{ id: 0, m: "GET", p: "/api/hello" }] }),
      }),
    );
  assertEquals((await send(batchApp({ desktopAppOrigin: APP }), APP)).status, 200);
  assertEquals((await send(batchApp({ desktopAppOrigin: APP }), "other://app")).status, 403);
  assertEquals((await send(batchApp(), APP)).status, 403);
});

// ---- Live handshake ---------------------------------------------------------

Deno.test("Live upgrade: the exact desktop origin passes; other schemes and hosts do not", () => {
  const upgrade = (origin: string) =>
    new Request("http://api.example.com/_denext/live", {
      headers: { host: "api.example.com", origin, upgrade: "websocket" },
    });
  assert(sameOriginUpgrade(upgrade(APP), APP));
  assert(sameOriginUpgrade(upgrade("http://api.example.com"), APP));
  assert(!sameOriginUpgrade(upgrade("other://app"), APP));
  assert(!sameOriginUpgrade(upgrade("myapp://evil"), APP));
  assert(!sameOriginUpgrade(upgrade("myapp://api.example.com"), APP));
  assert(!sameOriginUpgrade(upgrade("http://evil.example"), APP));
  // Unset: only the web same-origin passes.
  assert(!sameOriginUpgrade(upgrade(APP)));
  assert(!sameOriginUpgrade(upgrade("myapp://api.example.com")));
  assert(sameOriginUpgrade(upgrade("http://api.example.com")));
});

// ---- denextAuth POST gate ----------------------------------------------------

Deno.test("denextAuth isSameOrigin: the app's desktop origin (from createApp's context) passes", () => {
  const config = {} as AuthConfig;
  const check = (origin: string, desktopAppOrigin?: string) => {
    const request = post({ origin }, "/auth/signout");
    const ctx = createRequestContext(request);
    ctx.desktopAppOrigin = desktopAppOrigin;
    return runWithContext(ctx, () => isSameOrigin(request, config));
  };
  assertEquals(check(APP, APP), true);
  assertEquals(check("other://app", APP), false);
  assertEquals(check("myapp://evil", APP), false);
  assertEquals(check("myapp://api.example.com", APP), false);
  assertEquals(check(APP), false, "unset → refused");
  assertEquals(check("http://api.example.com"), true);
  // canonicalOrigin pinned: the desktop origin still passes, an http downgrade still does not.
  const pinned = { canonicalOrigin: "https://api.example.com" } as AuthConfig;
  const request = post({ origin: APP }, "/auth/signout");
  const ctx = createRequestContext(request);
  ctx.desktopAppOrigin = APP;
  assertEquals(runWithContext(ctx, () => isSameOrigin(request, pinned)), true);
});

// ---- dev origin gate ----------------------------------------------------------

Deno.test("dev origin gate: a listed custom-scheme origin passes, even cross-site", () => {
  const target = new URL("http://127.0.0.1:3000/_denext/live");
  const req = (h: Record<string, string>) => new Request(target, { headers: h });
  const allowed = effectiveDevOrigins([undefined, undefined, [APP]], undefined);
  // The desktop window is cross-site to the dev server; its exact origin is admitted.
  assert(devOriginAllowed(req({ origin: APP, "sec-fetch-site": "cross-site" }), target, allowed));
  assert(devOriginAllowed(req({ origin: APP }), target, allowed));
  // Another scheme or host is not, even on the dev server's own host.
  assert(!devOriginAllowed(req({ origin: "other://app" }), target, allowed));
  assert(!devOriginAllowed(req({ origin: "myapp://evil" }), target, allowed));
  assert(!devOriginAllowed(req({ origin: "other://127.0.0.1:3000" }), target, allowed));
  assert(
    !devOriginAllowed(
      req({ origin: "other://app", "sec-fetch-site": "cross-site" }),
      target,
      allowed,
    ),
  );
  // Unset: the desktop origin is refused.
  assert(!devOriginAllowed(req({ origin: APP }), target, []));
  // An entry is normalized as desktop.app.origin is.
  assert(devOriginAllowed(req({ origin: APP }), target, ["MyApp://App/"]));
});

Deno.test("dev origin gate: a custom-scheme entry never admits a Host (DNS rebinding)", () => {
  // `myapp://app` must not turn into an allowed `Host: myapp` or `Host: app`.
  for (const host of ["myapp", "app"]) {
    const target = new URL(`http://${host}:3000/_denext/reload`);
    assert(!devOriginAllowed(new Request(target, { headers: { origin: APP } }), target, [APP]));
    assert(!devOriginAllowed(new Request(target), target, [APP]), host);
  }
});

// ---- allowedDevOrigins validation --------------------------------------------

Deno.test("allowedDevOrigins accepts custom-scheme origins validated as desktop.app.origin is", () => {
  for (const ok of ["myapp://app", "t3code://app", "com.acme.app://main", "MyApp://App/"]) {
    assertEquals(devOriginError(ok), null, ok);
  }
  validateDenextConfig({ allowedDevOrigins: ["192.168.1.5", "myapp://app"] });
  const bad: Array<[string, string]> = [
    ["myapp://app:3000", "port"],
    ["myapp://app/path", "path"],
    ["myapp://user@app", "userinfo"],
    ["ws://localhost", "reserved"],
    ["file://host", "reserved"],
    ["ftp://host", "http(s)"],
    ["1app://x", "letter"],
    ["myapp://", "host is empty"],
  ];
  for (const [entry, why] of bad) {
    const problem = devOriginError(entry);
    assert(problem !== null, `${entry} must be refused`);
    assertStringIncludes(problem, why);
  }
});

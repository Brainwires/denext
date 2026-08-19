// Server Action CSRF / dispatch edge cases at the handleAction layer. The happy
// paths (same-origin accept, cross-origin reject, 413/408, redirect payload, no-JS
// 303) live in server-action.test.ts; this file covers the scheme-downgrade guard
// through handleAction's own isKnownHttps, back-path safety, and refresh folding —
// paths the audit found untested despite superficially looking covered.

import { assert, assertEquals } from "@std/assert";
import { actionEndpoint, serverAction } from "../src/runtime/server-action.ts";
import { handleAction } from "../src/server/action-handler.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { refresh, updateTag } from "../src/server/cache.ts";

function actionRequest(
  id: string,
  init: { url?: string; headers?: Record<string, string>; json?: unknown; body?: BodyInit } = {},
): Request {
  const headers: Record<string, string> = { host: "app.example.com", ...init.headers };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const base = init.url ?? "http://app.example.com";
  return new Request(`${base}${actionEndpoint(id)}`, { method: "POST", headers, body });
}

function dispatch(request: Request, opts?: Parameters<typeof handleAction>[1]): Promise<Response> {
  return runWithContext(createRequestContext(request), () => handleAction(request, opts));
}

// ---- scheme-downgrade CSRF via isKnownHttps --------------------------------

Deno.test("trustForwardedHeaders: an http Origin with x-forwarded-proto:https is rejected", async () => {
  serverAction("ah_xfp", () => "ok");
  const res = await dispatch(
    actionRequest("ah_xfp", {
      headers: {
        origin: "http://app.example.com",
        "x-forwarded-proto": "https",
        "x-denext-action": "1",
      },
      json: { args: [] },
    }),
    { trustForwardedHeaders: true },
  );
  assertEquals(res.status, 403, "the proxy reports HTTPS → an http Origin is a downgrade");
});

Deno.test("without trustForwardedHeaders the same http Origin is allowed", async () => {
  serverAction("ah_xfp_off", () => "ok");
  const res = await dispatch(
    actionRequest("ah_xfp_off", {
      headers: {
        origin: "http://app.example.com",
        "x-forwarded-proto": "https",
        "x-denext-action": "1",
      },
      json: { args: [] },
    }),
    // flag off → x-forwarded-proto is ignored; internal request URL is http → no downgrade known
  );
  assertEquals(res.status, 200);
});

Deno.test("an https request URL rejects an http same-host Origin (downgrade)", async () => {
  serverAction("ah_httpsurl", () => "ok");
  const res = await dispatch(
    actionRequest("ah_httpsurl", {
      url: "https://app.example.com",
      headers: { origin: "http://app.example.com", "x-denext-action": "1" },
      json: { args: [] },
    }),
  );
  assertEquals(res.status, 403, "https site + http Origin for the same host is refused");
});

Deno.test("a full-origin allowedOrigins entry is scheme-strict (rejects http for an https entry)", async () => {
  serverAction("ah_full", () => "ok");
  const res = await dispatch(
    actionRequest("ah_full", {
      headers: { origin: "http://partner.example.com", "x-denext-action": "1" },
      json: { args: [] },
    }),
    { allowedOrigins: ["https://partner.example.com"] },
  );
  assertEquals(res.status, 403, "https:// allowlist entry must not admit an http:// origin");
});

// ---- no-JS back-path safety ------------------------------------------------

Deno.test("a no-JS post with a cross-host Referer redirects to / (not the foreign path)", async () => {
  serverAction("ah_backhost", () => "ok");
  const res = await dispatch(
    actionRequest("ah_backhost", {
      // Origin is same-host (passes CSRF); Referer points at a different host.
      headers: { origin: "http://app.example.com", referer: "http://evil.example/secret" },
      json: { args: [] },
    }),
  );
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/", "a cross-host Referer cannot steer the redirect");
});

Deno.test("a protocol-relative Referer path cannot produce an off-origin 303", async () => {
  serverAction("ah_protorel", () => "ok");
  // A Referer whose path begins with // would, unnormalized, become a
  // protocol-relative (off-origin) Location. safeRedirectLocation must neutralize it.
  const req = new Request(`http://app.example.com${actionEndpoint("ah_protorel")}`, {
    method: "POST",
    headers: {
      host: "app.example.com",
      origin: "http://app.example.com",
      referer: "http://app.example.com//evil.example/path",
    },
    body: new FormData(), // a real no-JS form post (empty fields)
  });
  const res = await dispatch(req);
  assertEquals(res.status, 303);
  const loc = res.headers.get("location") ?? "";
  assert(
    !loc.startsWith("//") && !loc.startsWith("/\\"),
    `Location must not be protocol-relative: ${loc}`,
  );
});

// ---- refresh directive folding ---------------------------------------------

Deno.test("an XHR action folds refresh()/updateTag() into its JSON response", async () => {
  serverAction("ah_refresh", async () => {
    refresh();
    await updateTag("posts");
    return "done";
  });
  const res = await dispatch(
    actionRequest("ah_refresh", {
      headers: { origin: "http://app.example.com", "x-denext-action": "1" },
      json: { args: [] },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result, "done");
  assertEquals(body.refresh, true, "refresh() surfaces as refresh:true");
  assertEquals(body.updatedTags, ["posts"], "updateTag() surfaces the tag");
});

// ---- header edge cases -----------------------------------------------------

Deno.test("a non-numeric content-length does not trip the 413 fast-path", async () => {
  serverAction("ah_cl", () => "ok");
  const res = await dispatch(
    actionRequest("ah_cl", {
      headers: {
        origin: "http://app.example.com",
        "x-denext-action": "1",
        "content-length": "abc", // Number("abc") is NaN → not > maxBody
      },
      json: { args: [] },
    }),
    { maxBodyBytes: 1024 },
  );
  // Falls through to the buffered read of the small body → succeeds, not a 413.
  assertEquals(res.status, 200);
});

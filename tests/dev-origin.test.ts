// The dev live-reload SSE endpoint refuses cross-origin subscribers so a page a
// developer visits cannot read dev signals (cf. CVE-2025-48068). This exercises
// the origin predicate directly; the endpoint returns 403 when it denies.

import { assertEquals } from "@std/assert";
import { devOriginAllowed } from "../src/build/dev-server.ts";

const target = new URL("http://localhost:3000/_denext/reload");
const req = (origin?: string) => new Request(target, origin ? { headers: { origin } } : undefined);
const reqHeaders = (h: Record<string, string>) => new Request(target, { headers: h });

Deno.test("dev origin: same-origin is allowed", () => {
  assertEquals(devOriginAllowed(req("http://localhost:3000"), target, []), true);
});

Deno.test("dev origin: a cross-origin page is refused", () => {
  assertEquals(devOriginAllowed(req("http://evil.example"), target, []), false);
  assertEquals(devOriginAllowed(req("http://localhost:4000"), target, []), false);
});

Deno.test("dev origin: a missing Origin (non-browser) is allowed", () => {
  assertEquals(devOriginAllowed(req(), target, []), true);
});

Deno.test("dev origin: allowedDevOrigins permits a listed host", () => {
  assertEquals(devOriginAllowed(req("http://192.168.1.5:3000"), target, ["192.168.1.5"]), true);
  assertEquals(
    devOriginAllowed(req("http://phone.local:3000"), target, ["phone.local:3000"]),
    true,
  );
  assertEquals(devOriginAllowed(req("http://phone.local:3000"), target, ["other.host"]), false);
});

Deno.test("dev origin: a malformed Origin is refused", () => {
  assertEquals(devOriginAllowed(req("not a url"), target, []), false);
});

Deno.test("dev origin: a cross-site Sec-Fetch-Site is refused even with NO Origin header", () => {
  // The bypass: a cross-origin subresource load (<img>/<script>) sends no Origin but
  // Sec-Fetch-Site: cross-site. It must be refused (this is what let a hostile page
  // reach the editor-launch endpoint). Also same-site/none are not same-origin → refused.
  assertEquals(devOriginAllowed(reqHeaders({ "sec-fetch-site": "cross-site" }), target, []), false);
  assertEquals(devOriginAllowed(reqHeaders({ "sec-fetch-site": "same-site" }), target, []), false);
  assertEquals(devOriginAllowed(reqHeaders({ "sec-fetch-site": "none" }), target, []), false);
});

Deno.test("dev origin: Sec-Fetch-Site same-origin is allowed and is authoritative", () => {
  // The legit overlay fetch / EventSource is same-origin.
  assertEquals(devOriginAllowed(reqHeaders({ "sec-fetch-site": "same-origin" }), target, []), true);
  // Present Sec-Fetch-Site wins even over a (spoofed) allowed-looking Origin.
  assertEquals(
    devOriginAllowed(
      reqHeaders({ "sec-fetch-site": "cross-site", origin: "http://localhost:3000" }),
      target,
      [],
    ),
    false,
  );
});

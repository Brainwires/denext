// `captureRequestContext()` (denext/plugin-kit): a plugin holding a long-lived connection re-enters
// a copy of the request it captured — the cookies, the client address and the app's proxy trust
// answer as they did — after the original request is gone.

import { assertEquals } from "@std/assert";
import {
  captureRequestContext,
  clientIp,
  cookies,
  createRequestContext,
  currentContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";

Deno.test("captureRequestContext: a later run sees the captured cookies and client address", async () => {
  const request = new Request("https://app.test/realtime/v1/websocket", {
    headers: {
      cookie: "session=abc",
      upgrade: "websocket",
      "sec-websocket-key": "x",
      "x-forwarded-for": "203.0.113.9",
    },
  });
  setRemoteAddr(request, { transport: "tcp", hostname: "198.51.100.7", port: 5000 });
  const run = runWithContext(
    createRequestContext(request, undefined, { trustForwardedHeaders: false }),
    () => captureRequestContext(),
  );
  // Later, outside the original request:
  assertEquals(currentContext(), undefined);
  const seen = await run(async () => ({
    cookie: (await cookies()).get("session")?.value,
    ip: clientIp(),
    upgrade: currentContext()!.request.headers.get("upgrade"),
    url: currentContext()!.request.url,
  }));
  assertEquals(seen, {
    cookie: "abc",
    ip: "198.51.100.7",
    upgrade: null, // the handshake's headers are not kept
    url: "https://app.test/realtime/v1/websocket",
  });
  // Each run is a fresh context.
  const ids = [run(() => currentContext()!.requestId), run(() => currentContext()!.requestId)];
  assertEquals(ids[0] === ids[1], false);
});

Deno.test("captureRequestContext: a trusted proxy's hop is kept; outside a request it just runs", () => {
  const request = new Request("https://app.test/", {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  setRemoteAddr(request, { transport: "tcp", hostname: "10.0.0.2", port: 5000 });
  const run = runWithContext(
    createRequestContext(request, undefined, { trustForwardedHeaders: true }),
    () => captureRequestContext(),
  );
  assertEquals(run(() => clientIp()), "203.0.113.9");
  const bare = captureRequestContext();
  assertEquals(bare(() => currentContext()), undefined);
});

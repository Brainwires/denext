// SPA reverse proxy: prefix matching + `spa.proxy` config validation (loopback guard).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { matchesProxyPrefix } from "../src/build/dev-proxy.ts";
import { validateDenextConfig } from "../src/build/paths.ts";
import type { DenextConfig } from "../src/server/config.ts";

Deno.test("matchesProxyPrefix: exact + sub-path, not a partial segment", () => {
  const prefixes = ["/api", "/ws", "/.well-known"];
  assert(matchesProxyPrefix("/api", prefixes));
  assert(matchesProxyPrefix("/api/users", prefixes));
  assert(matchesProxyPrefix("/ws", prefixes));
  assert(matchesProxyPrefix("/.well-known/openid", prefixes));
  // Not proxied.
  assertEquals(matchesProxyPrefix("/apix", prefixes), false); // partial segment
  assertEquals(matchesProxyPrefix("/", prefixes), false);
  assertEquals(matchesProxyPrefix("/assets/app.js", prefixes), false);
});

const spa = (
  proxy: unknown,
): DenextConfig => ({ mode: "spa", spa: { entry: "./src/main.tsx", proxy } } as DenextConfig);

Deno.test("validateDenextConfig: accepts a well-formed loopback proxy", () => {
  validateDenextConfig(spa({ prefixes: ["/api", "/ws"], target: "http://127.0.0.1:3773" }));
  validateDenextConfig(spa({ prefixes: ["/api"], target: "http://localhost:8080" }));
});

Deno.test("validateDenextConfig: rejects a non-loopback target unless allowNonLoopback", () => {
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: ["/api"], target: "https://api.example.com" })),
    Error,
    "loopback",
  );
  // Explicit opt-in is allowed.
  validateDenextConfig(
    spa({ prefixes: ["/api"], target: "https://api.example.com", allowNonLoopback: true }),
  );
});

Deno.test("validateDenextConfig: rejects bad prefixes and target", () => {
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: [], target: "http://127.0.0.1:3773" })),
    Error,
    "spa.proxy.prefixes",
  );
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: ["api"], target: "http://127.0.0.1:3773" })),
    Error,
    "spa.proxy.prefixes",
  );
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: ["/api"], target: "not a url" })),
    Error,
    "spa.proxy.target",
  );
});

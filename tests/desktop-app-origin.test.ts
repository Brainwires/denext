// desktop.app.origin / desktop.app.identifier, validated exactly as the denext-pinned Deno
// Desktop runtime does (cli/lib/standalone/app_origin.rs + app_id.rs: these cases mirror its
// unit tests), the config validator that surfaces them, and the trust decision
// (src/desktop/transport.ts) the gates are built on.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  DEFAULT_DESKTOP_APP_ORIGIN,
  desktopAppIdentifierError,
  desktopSchemeError,
  parseDesktopAppOrigin,
  RESERVED_DESKTOP_SCHEMES,
} from "../src/desktop/app-origin.ts";
import {
  isMemoryTransport,
  LOOPBACK_TRUST,
  memoryGate,
  resolveDesktopTrust,
} from "../src/desktop/transport.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

/** The normalized origin, or the error message. */
function origin(input: string): string {
  const r = parseDesktopAppOrigin(input);
  return r.ok ? r.value.origin : `ERR ${r.error}`;
}

Deno.test("app origin: the default and a custom origin parse into scheme + host", () => {
  const d = parseDesktopAppOrigin(DEFAULT_DESKTOP_APP_ORIGIN);
  assert(d.ok);
  assertEquals(d.value, { scheme: "app", host: "localhost", origin: "app://localhost" });
  const t = parseDesktopAppOrigin("t3code://app");
  assert(t.ok);
  assertEquals(t.value, { scheme: "t3code", host: "app", origin: "t3code://app" });
});

Deno.test("app origin: the URL-serializer form, whitespace and case are normalized", () => {
  assertEquals(origin("t3code://app/"), "t3code://app");
  assertEquals(origin("  t3code://app \n"), "t3code://app");
  assertEquals(origin("T3Code://App.Local"), "t3code://app.local");
  assertStringIncludes(origin("t3code://my app"), "host may only contain");
});

Deno.test("app origin: the scheme follows RFC 3986", () => {
  assertEquals(origin("my-app+v2.0://app"), "my-app+v2.0://app");
  assertEquals(origin("1app://app"), "ERR scheme must start with an ASCII letter");
  assertEquals(origin("-app://app"), "ERR scheme must start with an ASCII letter");
  assertStringIncludes(origin("my_app://app"), "scheme may only contain");
  assertStringIncludes(origin("my app://app"), "scheme may only contain");
  assertEquals(origin("://app"), "ERR scheme is empty");
});

Deno.test("app origin: every reserved scheme is refused, case-insensitively", () => {
  for (const scheme of RESERVED_DESKTOP_SCHEMES) {
    assertEquals(
      origin(`${scheme}://app`),
      `ERR scheme "${scheme}" is reserved by browsers and cannot be an app origin`,
    );
  }
  for (const s of ["http", "https", "file", "ws", "wss", "ftp", "blob", "data", "about"]) {
    assert(RESERVED_DESKTOP_SCHEMES.includes(s), s);
  }
  assertStringIncludes(origin("HTTPS://app"), '"https" is reserved');
  assertStringIncludes(origin("File://app"), '"file" is reserved');
});

Deno.test("app origin: requires the <scheme>://<host> shape", () => {
  assertEquals(origin(""), "ERR origin is empty");
  assertEquals(origin("   "), "ERR origin is empty");
  assertStringIncludes(origin("t3code"), "must be of the form");
  assertStringIncludes(origin("t3code:app"), "must be of the form");
  assertEquals(origin("t3code://"), "ERR host is empty");
  assertEquals(origin("t3code:///"), "ERR host is empty");
});

Deno.test("app origin: no port, userinfo, path, query or fragment", () => {
  assertStringIncludes(origin("t3code://app:8080"), "port");
  assertStringIncludes(origin("t3code://user@app"), "userinfo");
  assertStringIncludes(origin("t3code://app/index.html"), "path");
  assertStringIncludes(origin("t3code://app//"), "path");
  assertStringIncludes(origin("t3code://app?x=1"), "path");
  assertStringIncludes(origin("t3code://app#top"), "path");
  assertStringIncludes(origin("t3code://[::1]"), "port");
});

Deno.test("app origin: DNS-like host labels, and a length cap in UTF-8 bytes", () => {
  assertEquals(origin("t3code://app.example-1.local"), "t3code://app.example-1.local");
  for (const bad of ["t3code://.app", "t3code://app.", "t3code://a..b", "t3code://app_1"]) {
    assertStringIncludes(origin(bad), "host may only contain", bad);
  }
  assertStringIncludes(origin("t3code://äpp"), "host may only contain");
  assertEquals(origin(`t3code://${"a".repeat(255)}`), "ERR origin is longer than 255 characters");
  // 124 × "ä" is 248 bytes (257 with the scheme): over the cap in bytes, under it in UTF-16 units.
  assertEquals(origin(`t3code://${"ä".repeat(124)}`), "ERR origin is longer than 255 characters");
});

Deno.test("app identifier: the runtime's reverse-DNS rules and messages", () => {
  for (const id of ["com.acme.notes", "dev.t3.code", "com.deno.desktop.my-app", "com.3m.app"]) {
    assertEquals(desktopAppIdentifierError(id), null, id);
  }
  assertEquals(desktopAppIdentifierError(`com.${"a".repeat(151)}`), null);
  assertEquals(desktopAppIdentifierError(""), "bundle identifier is empty");
  assertStringIncludes(desktopAppIdentifierError("notes")!, "reverse-DNS form");
  assertStringIncludes(desktopAppIdentifierError(`com.${"a".repeat(155)}`)!, "longer than 155");
  for (const [id, c] of [["com.acme app", " "], ["com.acme_app", "_"], ["com.acme/app", "/"]]) {
    assertEquals(
      desktopAppIdentifierError(id),
      `bundle identifier ${JSON.stringify(id)} must match [A-Za-z0-9.-]+, but contains '${c}'`,
    );
  }
  assertStringIncludes(desktopAppIdentifierError("com.acme\napp")!, "contains '\\n'");
  for (const id of [".com.acme", "com..acme", "com.acme.", "."]) {
    assertStringIncludes(desktopAppIdentifierError(id)!, "empty segment", id);
  }
});

Deno.test("deep-link scheme: same RFC 3986 + reserved rules as the origin's scheme", () => {
  assertEquals(desktopSchemeError("myapp"), null);
  assertStringIncludes(desktopSchemeError("https")!, "reserved");
  assertStringIncludes(desktopSchemeError("my_app")!, "scheme may only contain");
  assertEquals(desktopSchemeError(""), "scheme is empty");
});

/** Validate a config with just a `desktop` block. */
function validateDesktop(desktop: unknown): void {
  validateDenextConfig({ desktop } as DenextConfig);
}

Deno.test("config: desktop.app.origin requires a valid identifier (runtime semantics)", () => {
  validateDesktop({ app: { origin: "t3code://app", identifier: "com.t3.code" } });
  const missing = assertThrows(() => validateDesktop({ app: { origin: "t3code://app" } }));
  assertStringIncludes(String(missing), "`desktop.app.identifier`");
  assertStringIncludes(String(missing), "requires desktop.app.identifier");
  const badId = assertThrows(() =>
    validateDesktop({ app: { origin: "t3code://app", identifier: "notes" } })
  );
  assertStringIncludes(String(badId), "reverse-DNS form");
  const badOrigin = assertThrows(() =>
    validateDesktop({ app: { origin: "https://app", identifier: "com.t3.code" } })
  );
  assertStringIncludes(String(badOrigin), "`desktop.app.origin` is invalid");
  // No origin: the identifier keeps its old, unvalidated meaning (existing apps keep loading).
  validateDesktop({ app: { identifier: "com.acme_app" } });
});

Deno.test("config: deepLinks, singleInstance, inspectable, preload and the window keys", () => {
  validateDesktop({
    app: { deepLinks: ["t3code", "t3code-dev"], singleInstance: true },
    inspectable: false,
    preload: "./preload.ts",
    window: { width: 1200, height: 800, title: "T3", resizable: true },
    titleBar: "hiddenInset",
    backdrop: "vibrancy",
    minSize: { width: 400, height: 300 },
    maxSize: { width: 4000, height: 3000 },
  });
  const cases: Array<[unknown, string]> = [
    [{ app: { deepLinks: "t3code" } }, "desktop.app.deepLinks"],
    [{ app: { deepLinks: ["https"] } }, "desktop.app.deepLinks[0]"],
    [{ app: { deepLinks: [1] } }, "desktop.app.deepLinks[0]"],
    [{ app: { singleInstance: "yes" } }, "desktop.app.singleInstance"],
    [{ app: [] }, "desktop.app"],
    [{ inspectable: 1 }, "desktop.inspectable"],
    [{ preload: "" }, "desktop.preload"],
    [{ window: { width: 0 } }, "desktop.window.width"],
    [{ window: { title: 1 } }, "desktop.window.title"],
    [{ window: { resizable: "no" } }, "desktop.window.resizable"],
    [{ titleBar: "inset" }, "desktop.titleBar"],
    [{ backdrop: "glass" }, "desktop.backdrop"],
    [{ minSize: { width: 10 } }, "desktop.minSize.height"],
    [
      { minSize: { width: 500, height: 500 }, maxSize: { width: 400, height: 900 } },
      "desktop.minSize",
    ],
  ];
  for (const [desktop, field] of cases) {
    const err = assertThrows(() => validateDesktop(desktop), Error, undefined, field);
    assertStringIncludes(String(err), `\`${field}`, field);
  }
});

Deno.test("trust: no published origin is the stock loopback world", () => {
  assertEquals(resolveDesktopTrust(undefined), { trust: LOOPBACK_TRUST });
  assertEquals(resolveDesktopTrust(""), { trust: LOOPBACK_TRUST });
  // A configured origin the runtime did not publish is not in effect: say so.
  const d = resolveDesktopTrust(undefined, "t3code://app");
  assertEquals(d.trust, LOOPBACK_TRUST);
  assertStringIncludes(d.warning!, "not in effect");
});

Deno.test("trust: a published origin is the memory world at THAT origin", () => {
  assertEquals(resolveDesktopTrust("t3code://app", "t3code://app"), {
    trust: { kind: "memory", origin: "t3code://app" },
  });
  assertEquals(resolveDesktopTrust("app://localhost").trust, {
    kind: "memory",
    origin: "app://localhost",
  });
  // A stale package: trust what the page really runs at, and warn.
  const stale = resolveDesktopTrust("old://app", "t3code://app");
  assertEquals(stale.trust, { kind: "memory", origin: "old://app" });
  assertStringIncludes(stale.warning!, "stale");
  // Garbage in the env fails closed.
  const bad = resolveDesktopTrust("http://127.0.0.1:1234");
  assertEquals(bad.trust.kind, "refuse");
});

Deno.test("isMemoryTransport: the serve info is required; the URL alone is not proof", () => {
  const mem = new Request("http+memory://app/x");
  const tcp = new Request("http://127.0.0.1:8000/x");
  assert(isMemoryTransport(mem, { remoteAddr: { transport: "memory" } }));
  // No serve info: fail closed (an absolute-form target over TCP can forge the URL).
  assert(!isMemoryTransport(mem));
  assert(!isMemoryTransport(mem, {}));
  assert(!isMemoryTransport(mem, { remoteAddr: { transport: "tcp" } }));
  assert(!isMemoryTransport(tcp));
  assert(!isMemoryTransport(tcp, { remoteAddr: { transport: "memory" } }));
});

Deno.test("memoryGate: transport first, then an absent-or-exact Origin", () => {
  const trust = { origin: "t3code://app" };
  const mem = { remoteAddr: { transport: "memory" } };
  const req = (url: string, origin?: string) =>
    new Request(url, { headers: origin === undefined ? {} : { origin } });
  assertEquals(memoryGate(trust, req("http+memory://app/x"), mem), null);
  assertEquals(memoryGate(trust, req("http+memory://app/x", "t3code://app"), mem), null);
  assertEquals(
    memoryGate(trust, req("http://127.0.0.1/x", "t3code://app"), mem),
    "transport",
  );
  for (const o of ["null", "https://app", "t3code://evil", "t3code://app/", "T3CODE://APP"]) {
    assertEquals(memoryGate(trust, req("http+memory://app/x", o), mem), "origin", o);
  }
  assertEquals(memoryGate(trust, req("http+memory://app/x"), mem, true), "origin");
  assertEquals(memoryGate(trust, req("http+memory://app/x"), undefined), "transport");
});

Deno.test("resolveDesktopCapabilities: surfaces the normalized origin and enforces the identifier", async () => {
  const { resolveDesktopCapabilities } = await import("../src/desktop/caps/mod.ts");
  const ok = await resolveDesktopCapabilities({
    desktop: { app: { origin: "T3Code://App", identifier: "com.t3.code" } },
  } as DenextConfig);
  assertEquals(ok.appOrigin, "t3code://app");
  assertEquals((await resolveDesktopCapabilities({} as DenextConfig)).appOrigin, undefined);
  // The desktop entry imports the config directly (no loader validation): the runtime's rules
  // are enforced here too, at launch.
  for (
    const [app, msg] of [
      [{ origin: "t3code://app" }, "requires desktop.app.identifier"],
      [{ origin: "https://app", identifier: "com.t3.code" }, "reserved"],
      [{ origin: "t3code://app", identifier: "t3" }, "reverse-DNS"],
    ] as const
  ) {
    let err = "";
    try {
      await resolveDesktopCapabilities({ desktop: { app } } as DenextConfig);
    } catch (e) {
      err = String(e);
    }
    assertStringIncludes(err, msg);
  }
});

// The `passkeys` capability (runtime side): the `@clerk/electron-passkeys` envelope passes through
// checked (anything else is `unknown`), the RP-ID pin refuses a foreign RP without reaching the OS,
// the window anchors the OS sheet, a runtime without passkeys answers `not_supported`, and
// `capabilities` mirrors @clerk/electron's `{ available, platformAuthenticator, securityKeys }`.

import { assertEquals, assertRejects } from "@std/assert";
import { passkeysCapability } from "../src/desktop/caps/passkeys.ts";
import { isPasskeyEnvelope } from "../src/desktop/passkey-envelope.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

const WINDOW = { id: 7 };
const ctx = (window?: unknown) => ({
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  os: "darwin" as const,
  window,
  signal: new AbortController().signal,
});

function fake(answer: string | Error = '{"ok":true,"credential":{"id":"c1"}}') {
  const calls: Array<{ kind: string; json: string; options: unknown }> = [];
  const api: DesktopAppApi = {
    passkeys: {
      capabilities: () => Promise.resolve({ platformAuthenticator: true, securityKeys: false }),
      create: (json, options) => {
        calls.push({ kind: "create", json, options });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      get: (json, options) => {
        calls.push({ kind: "get", json, options });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
  return { api, calls };
}

const getOptions = (rpId = "clerk.example.com") => ({
  optionsJson: JSON.stringify({ challenge: "abc", rpId, allowCredentials: [] }),
});
const createOptions = (id = "clerk.example.com") => ({
  optionsJson: JSON.stringify({ rp: { id, name: "x" }, challenge: "abc", user: { id: "u" } }),
});

Deno.test("passkeys: a ceremony forwards the JSON, anchors the window, returns the envelope", async () => {
  const { api, calls } = fake();
  const cap = passkeysCapability({ api });
  const out = await cap.methods.get.handler(getOptions(), ctx(WINDOW));
  assertEquals(out, { ok: true, credential: { id: "c1" } });
  assertEquals(calls[0].kind, "get");
  assertEquals(calls[0].json, getOptions().optionsJson);
  assertEquals(calls[0].options, { window: WINDOW });
  // No window → the runtime's default anchor.
  await cap.methods.create.handler(createOptions(), ctx(undefined));
  assertEquals(calls[1].options, undefined);
});

Deno.test("passkeys: the RP-ID pin refuses a foreign RP without reaching the OS", async () => {
  const { api, calls } = fake();
  const cap = passkeysCapability({ api, rpIds: ["Clerk.Example.com"] });
  assertEquals((await cap.methods.get.handler(getOptions("evil.example"), ctx())) as unknown, {
    ok: false,
    error: {
      code: "invalid_rp",
      message: 'the RP ID "evil.example" is not in desktop.capabilities.passkeys',
    },
  });
  const empty = await cap.methods.create.handler(createOptions(""), ctx()) as { ok: boolean };
  assertEquals(empty.ok, false);
  assertEquals(calls.length, 0);
  assertEquals(
    ((await cap.methods.get.handler(getOptions("clerk.example.com"), ctx())) as { ok: boolean }).ok,
    true,
  );
});

Deno.test("passkeys: a malformed native answer is `unknown`; a native throw too", async () => {
  for (const answer of ['{"ok":true}', '{"ok":false,"error":{"code":"weird"}}', "not json"]) {
    const cap = passkeysCapability({ api: fake(answer).api });
    const out = await cap.methods.get.handler(getOptions(), ctx()) as { error?: { code: string } };
    assertEquals(out.error?.code, "unknown", answer);
  }
  const cap = passkeysCapability({ api: fake(new Error("boom")).api });
  const out = await cap.methods.create.handler(createOptions(), ctx()) as {
    error?: { code: string };
  };
  assertEquals(out.error?.code, "unknown");
  // The OS's own failure envelopes pass through (Clerk maps invalid_rp, cancelled, …).
  const rp = passkeysCapability({
    api: fake('{"ok":false,"error":{"code":"invalid_rp","message":"no AASA"}}').api,
  });
  assertEquals(await rp.methods.get.handler(getOptions(), ctx()), {
    ok: false,
    error: { code: "invalid_rp", message: "no AASA" },
  });
});

Deno.test("passkeys: bad arguments are a validation error", async () => {
  const cap = passkeysCapability({ api: fake().api });
  for (
    const args of [{}, { optionsJson: 1 }, { optionsJson: "x".repeat(70_000) }, {
      optionsJson: "[",
    }, {
      optionsJson: "1",
    }]
  ) {
    await assertRejects(
      () => Promise.resolve(cap.methods.get.handler(args, ctx())),
      DesktopCapError,
    );
  }
});

Deno.test("passkeys: a runtime without passkeys → not_supported; capabilities report none", async () => {
  const cap = passkeysCapability({ api: {}, os: "darwin" });
  assertEquals(await cap.methods.get.handler(getOptions(), ctx()), {
    ok: false,
    error: { code: "not_supported", message: "this Deno Desktop runtime has no native passkeys" },
  });
  assertEquals(await cap.methods.capabilities.handler({}, ctx()), {
    available: false,
    platformAuthenticator: false,
    securityKeys: false,
  });
});

Deno.test("passkeys: capabilities mirror @clerk/electron (available on macOS/Windows, not Linux)", async () => {
  const { api } = fake();
  assertEquals(
    await passkeysCapability({ api, os: "darwin" }).methods.capabilities.handler({}, ctx()),
    {
      available: true,
      platformAuthenticator: true,
      securityKeys: false,
    },
  );
  const linux = await passkeysCapability({ api, os: "linux" }).methods.capabilities.handler(
    {},
    ctx(),
  ) as {
    available: boolean;
  };
  assertEquals(linux.available, false);
});

Deno.test("isPasskeyEnvelope: the @clerk/electron result shapes", () => {
  assertEquals(isPasskeyEnvelope({ ok: true, credential: {} }), true);
  assertEquals(isPasskeyEnvelope({ ok: true }), false);
  assertEquals(isPasskeyEnvelope({ ok: false, error: { code: "cancelled" } }), true);
  assertEquals(isPasskeyEnvelope({ ok: false, error: { code: "nope" } }), false);
  assertEquals(isPasskeyEnvelope(null), false);
});

Deno.test("resolveDesktopCapabilities: passkeys, deepLinks and one shared picked-path set", async () => {
  const { resolveDesktopCapabilities } = await import("../src/desktop/caps/mod.ts");
  const resolved = await resolveDesktopCapabilities({
    desktop: {
      app: { identifier: "com.a.b", deepLinks: ["MyApp", "other"] },
      capabilities: { passkeys: { rpIds: ["clerk.example.com"] } },
    },
  } as never);
  assertEquals(resolved.capabilities.map((c) => c.name), ["passkeys"]);
  assertEquals(resolved.deepLinks, ["myapp", "other"]);
  assertEquals(resolved.pickedPaths.size, 0);
  const none = await resolveDesktopCapabilities(undefined);
  assertEquals(none.deepLinks, []);
  await assertRejects(
    () => resolveDesktopCapabilities({ desktop: { app: { deepLinks: ["https"] } } } as never),
    Error,
    "deepLinks",
  );
});

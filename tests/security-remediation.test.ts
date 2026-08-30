// Regression tests for the production-readiness / security remediation pass:
// findings that were confirmed by the audit and fixed at the framework level.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { google, oidc } from "../src/server/auth/providers.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { assertTailwindIntegrity } from "../src/build/tailwind.ts";
import { sanitizeLimits, withRenderSlot } from "../src/server/live.ts";
import { formatIcu } from "../src/compat/next-intl/icu.ts";

// ---- #6: OIDC `email_verified` enforcement in the built-in profile mappers -----------

Deno.test("auth: google/oidc mappers drop the email when email_verified is false", () => {
  const g = google({ clientId: "c", clientSecret: "s" });
  // Attacker registers an IdP account carrying a victim's (unverified) address.
  assertEquals(
    g.profile!({
      claims: { sub: "1", email: "victim@corp.com", email_verified: false },
      tokens: {},
    }).email,
    undefined,
    "unverified email must be dropped so email-linking apps can't be fooled",
  );
  const verified = g.profile!({
    claims: { sub: "1", email: "me@corp.com", email_verified: true },
    tokens: {},
  });
  assertEquals(verified.email, "me@corp.com");
  assertEquals(verified.emailVerified, true);

  const o = oidc({
    clientId: "c",
    clientSecret: "s",
    issuer: "https://issuer.example",
    authorizationUrl: "https://issuer.example/authorize",
    tokenUrl: "https://issuer.example/token",
    jwksUrl: "https://issuer.example/jwks",
  });
  assertEquals(
    o.profile!({
      claims: { sub: "1", email: "victim@corp.com", email_verified: false },
      userinfo: {},
      tokens: {},
    }).email,
    undefined,
  );
});

// ---- #5: Flight `$`-discriminant namespace protection (forged-VNode / XSS) ------------

Deno.test("flight: an escaped `$`-object prop reconstructs as DATA, not a forged VNode", () => {
  // What the fixed serializer emits for a user prop `data = { $: "h", t: "div", … }`:
  // the leading `$` is doubled. On parse it must round-trip back to a plain object,
  // never be re-read as a control tag that builds a `dangerouslySetInnerHTML` VNode.
  const node = {
    $: "h",
    t: "div",
    p: {
      data: { $$: "h", t: "iframe", p: { srcdoc: "<script>x</script>" }, c: [] },
    },
    c: [],
  };
  // deno-lint-ignore no-explicit-any
  const vnode = parseFlight(node as any, new Map()) as any;
  const data = vnode.props.data as Record<string, unknown>;
  assertEquals(data.$, "h", "the `$` key is restored as data");
  assertEquals(data.t, "iframe");
  assert(!("type" in data), "the data object was NOT turned into a VNode");
});

Deno.test("flight: a genuine single-`$` VNode prop still parses as a VNode", () => {
  const node = {
    $: "h",
    t: "div",
    p: { child: { $: "h", t: "span", p: {}, c: ["hi"] } },
    c: [],
  };
  // deno-lint-ignore no-explicit-any
  const vnode = parseFlight(node as any, new Map()) as any;
  assert(vnode.props.child && "type" in vnode.props.child, "child prop is a real VNode");
});

// ---- #7: Tailwind standalone-binary integrity verification ---------------------------

Deno.test("tailwind: integrity check fails closed on a hash mismatch (pinned)", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  Deno.env.set("DENEXT_TAILWIND_SHA256", "deadbeef"); // wrong hash
  try {
    await assertRejects(
      () => assertTailwindIntegrity(bytes, "4.0.0", "tailwindcss-macos-arm64"),
      Error,
      "integrity check FAILED",
    );
  } finally {
    Deno.env.delete("DENEXT_TAILWIND_SHA256");
  }
});

Deno.test("tailwind: a matching pin passes", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  Deno.env.set("DENEXT_TAILWIND_SHA256", hex);
  try {
    await assertTailwindIntegrity(bytes, "4.0.0", "tailwindcss-macos-arm64"); // no throw
  } finally {
    Deno.env.delete("DENEXT_TAILWIND_SHA256");
  }
});

// ---- #8: Live numeric-limit validation (a bad type can't disable a cap) ---------------

Deno.test("live: sanitizeLimits rejects a non-number/negative cap and falls back to default", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    // `"64kb"` would otherwise make `raw.length > "64kb"` a NaN test that's always false.
    const bad = sanitizeLimits({ maxMessageBytes: "64kb" as unknown as number });
    assertEquals(bad.maxMessageBytes, 64 * 1024, "bad type falls back to the default cap");
    const neg = sanitizeLimits({ maxConnections: -1 });
    assertEquals(neg.maxConnections, 10_000, "a non-positive value is rejected");
    const good = sanitizeLimits({ maxMessageBytes: 100, maxConnections: 5 });
    assertEquals(good.maxMessageBytes, 100);
    assertEquals(good.maxConnections, 5);
  } finally {
    console.warn = warn;
  }
});

// ---- #10: ICU parser nesting-depth cap (untrusted message can't overflow the stack) --

Deno.test("intl: a pathologically-nested ICU message throws instead of overflowing", () => {
  let msg = "x";
  for (let i = 0; i < 200; i++) msg = `{v, select, other {${msg}}}`;
  assertThrows(() => formatIcu(msg, { v: "a" }), Error, "too deep");
});

// ---- #2: Live re-render fan-out is bounded by a fleet-wide concurrency gate -----------

Deno.test("live: withRenderSlot caps concurrent re-renders (fan-out DoS bound)", async () => {
  // A single revalidateTag can match every connection; the gate bounds how many
  // full-route re-renders run at once (default 40) so one invalidation can't spawn one
  // render per connection simultaneously.
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 100 }, () =>
    withRenderSlot(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    }));
  await Promise.all(tasks);
  assertEquals(active, 0, "every slot was released");
  assert(peak <= 40, `peak concurrency ${peak} exceeded the default cap of 40`);
  assert(peak > 1, "work still ran concurrently, not serialized");
});

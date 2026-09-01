// Regression tests for the production-readiness / security remediation pass:
// findings that were confirmed by the audit and fixed at the framework level.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { github, google, oidc } from "../src/server/auth/providers.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import {
  experimental_taintObjectReference,
  experimental_taintUniqueValue,
  taintMessageFor,
} from "../src/runtime/taint.ts";
import type { VNode } from "../src/jsx/types.ts";
import { assertTailwindIntegrity } from "../src/build/tailwind.ts";
import { sanitizeLimits, withDeadline, withRenderSlot } from "../src/server/live.ts";
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

// ---- GitHub OAuth: only a provider-verified email reaches the AuthUser ----------------

Deno.test("auth: github mapper exposes only a verified email (from /user/emails)", () => {
  const gh = github({ clientId: "c", clientSecret: "s" });
  // It configures the emails endpoint so the flow fetches the verified list.
  assertEquals(gh.userEmailsUrl, "https://api.github.com/user/emails");

  const userinfo = { id: 7, login: "octo", email: "public@x.com", avatar_url: "a" };

  // A verified primary email is exposed and marked verified.
  const verified = gh.profile!({
    tokens: {},
    userinfo,
    emails: [
      { email: "old@x.com", primary: false, verified: true },
      { email: "me@x.com", primary: true, verified: true },
    ],
  });
  assertEquals(verified.email, "me@x.com", "prefers the primary verified address");
  assertEquals(verified.emailVerified, true);
  assertEquals(verified.id, "7");

  // Only unverified addresses → no email at all (mirrors the google/oidc hardening).
  const unverified = gh.profile!({
    tokens: {},
    userinfo,
    emails: [{ email: "me@x.com", primary: true, verified: false }],
  });
  assertEquals(unverified.email, undefined, "an unverified email is never exposed");
  assertEquals(unverified.emailVerified, undefined);

  // No emails list (endpoint missing/failed) → no email, never the raw userinfo.email.
  const none = gh.profile!({ tokens: {}, userinfo });
  assertEquals(none.email, undefined, "never falls back to the unverified userinfo.email");
});

// ---- React `taint*`: a tainted value can't cross to a client component ----------------

function TaintWidget(): VNode {
  return h("span", null, "widget");
}
tagClientExports({ TaintWidget } as Record<string, unknown>, "taint_widget");

Deno.test("taint: taintMessageFor tracks object refs and unique values, not copies", () => {
  const secret = { key: "sk-1" };
  assertEquals(taintMessageFor(secret), undefined, "untainted at first");
  experimental_taintObjectReference("no leak: object", secret);
  assertEquals(taintMessageFor(secret), "no leak: object");
  assertEquals(taintMessageFor({ key: "sk-1" }), undefined, "a structural copy is a diff ref");

  const token = "unique-secret-token-abc";
  const lifetime = {};
  experimental_taintUniqueValue("no leak: token", lifetime, token);
  assertEquals(taintMessageFor(token), "no leak: token");
  assertEquals(taintMessageFor("some-other-string"), undefined);

  assertThrows(() => experimental_taintUniqueValue("x", {}, 123 as unknown as string), TypeError);
});

Deno.test("taint: the Flight serializer refuses a tainted prop bound for a client island", async () => {
  // An object reference marked as secret must not reach a client component's props.
  const secret = { apiKey: "sk-live-DO-NOT-LEAK" };
  experimental_taintObjectReference("secret object must not reach the client", secret);
  await assertRejects(
    () => renderToHtmlFlight(h(TaintWidget, { data: secret })),
    Error,
    "secret object must not reach the client",
  );

  // A unique secret string is blocked the same way.
  const token = "session-token-DO-NOT-LEAK-xyz";
  experimental_taintUniqueValue("secret token must not reach the client", {}, token);
  await assertRejects(
    () => renderToHtmlFlight(h(TaintWidget, { token })),
    Error,
    "secret token must not reach the client",
  );

  // An untainted prop serializes fine (no false positive).
  const { islands } = await renderToHtmlFlight(
    h("main", null, h(TaintWidget, { label: "ok", "client:load": true })),
  );
  assertEquals((islands[0].flight as { p: Record<string, unknown> }).p.label, "ok");
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

// ---- Live per-render deadline: a hung fetcher can't pin a render slot forever ---------

Deno.test("live: withDeadline rejects a hung render and aborts its signal", async () => {
  let seen: AbortSignal | undefined;
  const err = await withDeadline(20, (signal) => {
    seen = signal;
    return new Promise<never>(() => {}); // never settles on its own
  }).then(() => undefined, (e) => e);
  assert(err instanceof Error, "the deadline rejects the hung render");
  assert(seen?.aborted, "the fetcher's signal is aborted so cooperative code can bail");
});

Deno.test("live: withDeadline lets a fast render finish untouched", async () => {
  const value = await withDeadline(1000, () => Promise.resolve(42));
  assertEquals(value, 42);
});

Deno.test("live: renderTimeoutSeconds carries a positive default and is validated", () => {
  assert(sanitizeLimits().renderTimeoutSeconds > 0, "on by default");
  const warn = console.warn;
  console.warn = () => {};
  try {
    // An invalid value must fall back to the default, never disable the deadline.
    assertEquals(
      sanitizeLimits({ renderTimeoutSeconds: 0 }).renderTimeoutSeconds,
      sanitizeLimits().renderTimeoutSeconds,
    );
    assertEquals(sanitizeLimits({ renderTimeoutSeconds: 5 }).renderTimeoutSeconds, 5);
  } finally {
    console.warn = warn;
  }
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

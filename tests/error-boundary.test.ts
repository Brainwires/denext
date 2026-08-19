// Error-boundary primitives: the redaction + control-signal helpers behind
// `error.tsx`/`global-error.tsx`. These lock the guarantees that the renderers rely
// on — a caught render error must never leak internals to the client (prod), the
// digest must correlate with the server log, and control-flow signals
// (notFound/forbidden/unauthorized/redirect) must bubble THROUGH a boundary rather
// than be caught and redacted as if they were real errors.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  errorDigest,
  forbidden,
  isControlSignal,
  notFound,
  permanentRedirect,
  redirect,
  toClientError,
  toError,
  unauthorized,
} from "../src/runtime/error-boundary.ts";

/** Run `fn` with production mode (dev flag cleared), restoring the flag after. */
function inProd<T>(fn: () => T): T {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  delete g.__denextDev;
  try {
    return fn();
  } finally {
    if (prev !== undefined) g.__denextDev = prev;
    else delete g.__denextDev;
  }
}

/** Run `fn` with development mode on, restoring the flag after. */
function inDev<T>(fn: () => T): T {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = true;
  try {
    return fn();
  } finally {
    if (prev !== undefined) g.__denextDev = prev;
    else delete g.__denextDev;
  }
}

/** Swallow console.error while `fn` runs (toClientError logs the raw error in prod). */
function quietErrors<T>(fn: () => T): T {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

// ---- errorDigest ------------------------------------------------------------

Deno.test("errorDigest is deterministic: same error → same 16-hex digest", () => {
  const err = new Error("boom at db-prod:5432");
  const a = errorDigest(err);
  const b = errorDigest(err);
  assertEquals(a, b);
  assertEquals(a.length, 16);
  assert(/^[0-9a-f]{16}$/.test(a), `digest is 16 lowercase hex chars: ${a}`);
});

Deno.test("errorDigest distinguishes different errors", () => {
  assert(
    errorDigest(new Error("one")) !== errorDigest(new Error("two")),
    "different messages produce different digests",
  );
});

Deno.test("errorDigest of a non-Error value uses String() and stays 16 hex", () => {
  const d = errorDigest({ toString: () => "weird-object" });
  assertEquals(d.length, 16);
  assert(/^[0-9a-f]{16}$/.test(d), d);
  // A plain string throw digests the same as its String() form.
  assertEquals(errorDigest("plain string throw").length, 16);
});

// ---- toClientError (prod redaction / dev passthrough) ----------------------

Deno.test("toClientError redacts a real Error in production and attaches a digest", () => {
  const secret = "connect ECONNREFUSED db-prod:5432 password=hunter2";
  const raw = new Error(secret);
  const client = quietErrors(() => inProd(() => toClientError(raw)));
  assertEquals(client.message, "Internal Server Error");
  assert(!client.message.includes("hunter2"), "the secret must not reach the client message");
  assert(typeof client.digest === "string" && client.digest.length === 16, "carries a digest");
});

Deno.test("toClientError digest correlates with errorDigest(rawError)", () => {
  const raw = new Error("correlate me");
  const client = quietErrors(() => inProd(() => toClientError(raw)));
  assertEquals(client.digest, errorDigest(raw), "client digest === errorDigest(raw)");
});

Deno.test("toClientError logs the raw error server-side in production", () => {
  const secret = "internal path /srv/app/secret";
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void calls.push(a);
  try {
    inProd(() => toClientError(new Error(secret)));
  } finally {
    console.error = orig;
  }
  const flat = calls.flat();
  assert(
    flat.some((a) => typeof a === "string" && a.includes("digest")),
    "the log line references the digest for correlation",
  );
  assert(
    flat.some((a) => a instanceof Error && a.message === secret),
    "the real (unredacted) Error is handed to the server log",
  );
});

Deno.test("toClientError on a non-Error throw still redacts + digests in prod", () => {
  // The raw thrown value is a string — must not become `undefined.message`.
  const client = quietErrors(() => inProd(() => toClientError("just a string")));
  assertEquals(client.message, "Internal Server Error");
  assert(typeof client.digest === "string" && client.digest.length === 16, "still has a digest");
});

Deno.test("toClientError passes the real error through in development", () => {
  const raw = new Error("dev detail visible");
  const client = inDev(() => toClientError(raw));
  assertEquals(client, raw, "dev returns the exact same Error instance");
  assertEquals(client.digest, undefined, "no digest attached in dev");
});

Deno.test("toClientError wraps a non-Error dev throw into an Error", () => {
  const client = inDev(() => toClientError("boom"));
  assert(client instanceof Error);
  assertStringIncludes(client.message, "boom");
});

// ---- toError normalization -------------------------------------------------

Deno.test("toError returns Error instances unchanged and wraps other values", () => {
  const e = new Error("orig");
  assertEquals(toError(e), e, "an Error passes through by identity");

  const fromString = toError("a string");
  assert(fromString instanceof Error);
  assertEquals(fromString.message, "a string");

  const fromObject = toError({ code: 42 });
  assert(fromObject instanceof Error);
  assertEquals(fromObject.message, String({ code: 42 })); // "[object Object]"
});

// ---- isControlSignal matrix ------------------------------------------------

Deno.test("isControlSignal is true for every denext control-flow signal", () => {
  for (const raise of [notFound, forbidden, unauthorized]) {
    try {
      raise();
      throw new Error("expected the signal to throw");
    } catch (signal) {
      assert(isControlSignal(signal), `${raise.name}() must be a control signal`);
    }
  }
  try {
    redirect("/login");
  } catch (signal) {
    assert(isControlSignal(signal), "redirect() must be a control signal");
  }
  try {
    permanentRedirect("/moved");
  } catch (signal) {
    assert(isControlSignal(signal), "permanentRedirect() must be a control signal");
  }
});

Deno.test("isControlSignal is false for a plain error or non-error value", () => {
  assertEquals(isControlSignal(new Error("real failure")), false);
  assertEquals(isControlSignal("string"), false);
  assertEquals(isControlSignal(null), false);
  assertEquals(isControlSignal({ digest: "abc" }), false);
});

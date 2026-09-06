// ApiError — the typed API failure: status + code + data, its JSON envelope, and the fact
// that it is AUTHORED for the client (passes through production redaction unchanged).

import { assert, assertEquals } from "@std/assert";
import {
  ApiError,
  apiErrorResponse,
  ApiValidationError,
  isApiError,
} from "../src/server/api-error.ts";
import { toClientError } from "../src/runtime/error-boundary.ts";

Deno.test("ApiError carries status/code/data/fieldErrors/headers; message defaults to the code", () => {
  const bare = new ApiError(409, "conflict");
  assertEquals(bare.message, "conflict");
  assertEquals([bare.status, bare.code, bare.name], [409, "conflict", "ApiError"]);
  const full = new ApiError(429, "rate_limited", {
    message: "slow down",
    data: { retryIn: 3 },
    headers: { "retry-after": "3" },
  });
  assertEquals(full.data, { retryIn: 3 });
  assert(isApiError(full) && isApiError(bare));
  assert(!isApiError(new Error("conflict")));
  // Only the declared fields are enumerable — the brands are symbols set non-enumerable, so
  // a spread or JSON of the error never carries them.
  assertEquals(Object.keys(full).sort(), [
    "code",
    "data",
    "fieldErrors",
    "headers",
    "name",
    "status",
  ]);
});

Deno.test("ApiValidationError is a 400 `validation` with field errors and the offending source", () => {
  const err = new ApiValidationError("body", { title: "Title is required" });
  assertEquals([err.status, err.code, err.source], [400, "validation", "body"]);
  assertEquals(err.fieldErrors, { title: "Title is required" });
  assertEquals(err.data, { source: "body" });
  assert(isApiError(err));
});

Deno.test("apiErrorResponse builds the envelope, status, extra headers, request id, and digest", async () => {
  const err = new ApiError(429, "rate_limited", {
    message: "slow down",
    data: { retryIn: 3 },
    headers: { "retry-after": "3" },
  });
  const res = apiErrorResponse(err, "req-1");
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "3");
  assertEquals(res.headers.get("x-request-id"), "req-1");
  assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(await res.json(), {
    error: { code: "rate_limited", status: 429, message: "slow down", data: { retryIn: 3 } },
  });
  const redacted = await apiErrorResponse(new ApiError(500, "internal"), undefined, "abc").json();
  assertEquals(redacted.error.digest, "abc");
  assertEquals("data" in redacted.error, false);
});

Deno.test("an ApiError is authored for the client: production redaction passes it through", () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = false; // production
  try {
    const err = new ApiError(404, "not_found", { message: "no such order" });
    assert(toClientError(err) === err, "an ApiError must not be replaced by a generic error");
    const plain = toClientError(new Error("db password = hunter2"));
    assertEquals(plain.message, "Internal Server Error");
  } finally {
    g.__denextDev = prev;
  }
});

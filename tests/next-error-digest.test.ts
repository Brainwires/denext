// denext's control-flow signals and Next.js's own speak the same `digest`: a library built for
// Next (`@clerk/nextjs`'s middleware and `auth.protect()`) recognizes denext's `notFound()` /
// `forbidden()` / `unauthorized()` / `redirect()` by their digest, and denext recognizes the
// errors such a library throws itself (a plain Error with a Next digest) as the same signals.

import { assert, assertEquals } from "@std/assert";
import {
  forbidden,
  isForbidden,
  isNotFound,
  isRedirect,
  isUnauthorized,
  notFound,
  permanentRedirect,
  redirect,
  RedirectType,
  unauthorized,
} from "../src/runtime/error-boundary.ts";
// The server's recognizer for a library's Next-format errors (the request pipeline imports it).
import { parseNextRedirectDigest } from "../src/server/next-signals.ts";

function thrown(fn: () => never): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("did not throw");
}

/** A Next-format error, as `@clerk/nextjs` builds its own. */
function nextError(digest: string): Error {
  return Object.assign(new Error(digest.split(";")[0]), { digest });
}

Deno.test("denext's signals carry Next.js's digests", () => {
  assertEquals((thrown(notFound) as { digest: string }).digest, "NEXT_HTTP_ERROR_FALLBACK;404");
  assertEquals((thrown(forbidden) as { digest: string }).digest, "NEXT_HTTP_ERROR_FALLBACK;403");
  assertEquals((thrown(unauthorized) as { digest: string }).digest, "NEXT_HTTP_ERROR_FALLBACK;401");
  assertEquals(
    (thrown(() => redirect("/sign-in?x=1;y")) as { digest: string }).digest,
    "NEXT_REDIRECT;replace;/sign-in?x=1;y;307;",
  );
  assertEquals(
    (thrown(() => redirect("/a", RedirectType.push)) as { digest: string }).digest,
    "NEXT_REDIRECT;push;/a;307;",
  );
  assertEquals(
    (thrown(() => permanentRedirect("/b")) as { digest: string }).digest,
    "NEXT_REDIRECT;replace;/b;308;",
  );
});

Deno.test("a library's Next-format errors are denext's signals", () => {
  assert(isNotFound(nextError("NEXT_HTTP_ERROR_FALLBACK;404")));
  assert(isNotFound(nextError("NEXT_NOT_FOUND"))); // the legacy digest
  assert(isForbidden(nextError("NEXT_HTTP_ERROR_FALLBACK;403")));
  assert(isUnauthorized(nextError("NEXT_HTTP_ERROR_FALLBACK;401")));
  const r = nextError("NEXT_REDIRECT;replace;https://x.accounts.dev/sign-in?a=1;b=2;307;");
  assert(isRedirect(r));
  // Adopted: it now has what denext's redirect handling reads.
  assertEquals((r as unknown as { url: string }).url, "https://x.accounts.dev/sign-in?a=1;b=2");
  assertEquals((r as unknown as { status: number }).status, 307);
  assertEquals((r as unknown as { redirectType: string }).redirectType, "replace");
});

Deno.test("parseNextRedirectDigest: the URL may contain `;`, the status must be 3xx", () => {
  assertEquals(parseNextRedirectDigest("NEXT_REDIRECT;push;/a;b=1;308;"), {
    url: "/a;b=1",
    status: 308,
    type: "push",
  });
  assertEquals(parseNextRedirectDigest("NEXT_REDIRECT;replace;/x;200;"), undefined);
  assertEquals(parseNextRedirectDigest("NEXT_HTTP_ERROR_FALLBACK;404"), undefined);
});

Deno.test("other errors and malformed digests are not signals", () => {
  for (
    const e of [
      new Error("NEXT_NOT_FOUND"), // a message is not a digest
      nextError("NEXT_HTTP_ERROR_FALLBACK;500"),
      nextError("NEXT_REDIRECT;replace;/x;200;"),
      nextError("NEXT_REDIRECT;replace;;307;"),
      nextError("NEXT_REDIRECT;oops"),
      { digest: 42 },
      null,
      "NEXT_REDIRECT;replace;/x;307;",
    ]
  ) {
    assert(!isNotFound(e) && !isForbidden(e) && !isUnauthorized(e) && !isRedirect(e), String(e));
  }
  // The signals stay distinct.
  assert(!isNotFound(nextError("NEXT_HTTP_ERROR_FALLBACK;403")));
  assert(!isForbidden(thrown(notFound)));
});

// Public-env isolation — the single gate deciding which environment variables can
// reach the browser. A leak here ships a server secret to every client, so the
// prefix rule, the filter, and the server-side reader each get direct coverage.

import { assert, assertEquals } from "@std/assert";
import {
  documentPublicEnv,
  extractPublicEnvRefs,
  filterPublicEnv,
  isPublicEnvKey,
  PUBLIC_ENV_ID,
  PUBLIC_ENV_PREFIXES,
  publicEnv,
  restrictPublicEnv,
} from "../src/runtime/public-env.ts";

Deno.test("isPublicEnvKey admits only the recognized public prefixes", () => {
  assert(isPublicEnvKey("NEXT_PUBLIC_API_URL"));
  assert(isPublicEnvKey("DENEXT_PUBLIC_FLAG"));
  assert(!isPublicEnvKey("DATABASE_URL"), "an unprefixed secret is not public");
  assert(!isPublicEnvKey("SECRET_NEXT_PUBLIC_X"), "the prefix must be at the START of the name");
  assert(!isPublicEnvKey("NEXT_PUBLICX"), "a near-miss prefix is not public");
  assertEquals(PUBLIC_ENV_PREFIXES.includes("NEXT_PUBLIC_"), true);
});

Deno.test("filterPublicEnv drops every non-public key", () => {
  const filtered = filterPublicEnv({
    NEXT_PUBLIC_API_URL: "https://api.example",
    DENEXT_PUBLIC_MODE: "prod",
    DATABASE_URL: "postgres://user:pw@host/db",
    SESSION_SECRET: "super-secret",
    AWS_SECRET_ACCESS_KEY: "leakme",
  });
  assertEquals(filtered, {
    NEXT_PUBLIC_API_URL: "https://api.example",
    DENEXT_PUBLIC_MODE: "prod",
  });
  assert(!("DATABASE_URL" in filtered), "a secret must never survive the filter");
  assert(!("SESSION_SECRET" in filtered));
});

Deno.test("extractPublicEnvRefs finds only literal public-env references", () => {
  const src = `const a = publicEnv().NEXT_PUBLIC_A;
    const b = publicEnv()["DENEXT_PUBLIC_B"];
    const secret = process.env.DATABASE_URL;
    const dup = publicEnv().NEXT_PUBLIC_A;`;
  const refs = extractPublicEnvRefs(src).sort();
  assertEquals(refs, ["DENEXT_PUBLIC_B", "NEXT_PUBLIC_A"], "distinct, no secrets, no dupes");
});

Deno.test("restrictPublicEnv keeps only allowlisted keys (undefined = no restriction)", () => {
  const full = { NEXT_PUBLIC_A: "1", NEXT_PUBLIC_B: "2", DENEXT_PUBLIC_C: "3" };
  assertEquals(restrictPublicEnv(full, ["NEXT_PUBLIC_A"]), { NEXT_PUBLIC_A: "1" });
  assertEquals(restrictPublicEnv(full, undefined), full, "undefined keys ⇒ ship all");
  assertEquals(restrictPublicEnv(full, []), {}, "an empty allowlist ships nothing");
});

Deno.test("publicEnv() on the server returns only the public subset of the live env", () => {
  const pub = "DENEXT_PUBLIC_TEST_ONLY";
  const secret = "DENEXT_TEST_SECRET_ONLY";
  const prevPub = Deno.env.get(pub);
  const prevSecret = Deno.env.get(secret);
  try {
    Deno.env.set(pub, "visible");
    Deno.env.set(secret, "hidden");
    const env = publicEnv();
    assertEquals(env[pub], "visible", "the public var is present");
    assert(!(secret in env), "the non-public var is filtered out on the server too");
  } finally {
    if (prevPub !== undefined) Deno.env.set(pub, prevPub);
    else Deno.env.delete(pub);
    if (prevSecret !== undefined) Deno.env.set(secret, prevSecret);
    else Deno.env.delete(secret);
  }
});

Deno.test("PUBLIC_ENV_ID is the stable island id used for client hydration", () => {
  assertEquals(PUBLIC_ENV_ID, "__denext_public_env");
});

Deno.test("documentPublicEnv reads only the recorded names, live, without copying the env", () => {
  const pub = "DENEXT_PUBLIC_DOC_ENV_TEST";
  const other = "DENEXT_PUBLIC_DOC_ENV_OTHER";
  const secret = "DENEXT_DOC_ENV_SECRET";
  const toObject = Deno.env.toObject;
  let copies = 0;
  Deno.env.toObject = () => {
    copies++;
    return toObject.call(Deno.env);
  };
  try {
    Deno.env.set(pub, "one");
    Deno.env.set(other, "unlisted");
    Deno.env.set(secret, "hidden");
    // A secret name in the list (a hand-written `publicEnv` allowlist) is still never read out.
    assertEquals(documentPublicEnv([pub, secret, "NEXT_PUBLIC_UNSET_DOC_ENV"]), { [pub]: "one" });
    Deno.env.set(pub, "two");
    assertEquals(documentPublicEnv([pub]), { [pub]: "two" }, "the value is read per render");
    assertEquals(documentPublicEnv([]), {}, "an app that references none reads nothing");
    assertEquals(copies, 0, "a known name list never copies the whole environment");
    const all = documentPublicEnv(undefined);
    assertEquals([all[pub], all[other], secret in all], ["two", "unlisted", false]);
    assertEquals(copies, 1, "no list (dev): the public subset of the whole environment");
  } finally {
    Deno.env.toObject = toObject;
    for (const name of [pub, other, secret]) Deno.env.delete(name);
  }
});

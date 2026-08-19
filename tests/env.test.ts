import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  filterPublicEnv,
  isPublicEnvKey,
  loadEnv,
  parseEnv,
  publicEnv,
} from "../src/server/env.ts";
import { publicEnv as clientPublicEnv } from "../src/runtime/public-env.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

// Clean up any env keys a test set, so tests stay isolated.
function withEnv(keys: string[], run: () => void | Promise<void>): Promise<void> {
  const prev = new Map(keys.map((k) => [k, Deno.env.get(k)]));
  return (async () => {
    try {
      await run();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  })();
}

// ---- parseEnv --------------------------------------------------------------

Deno.test("parseEnv handles assignments, quotes, comments, and escapes", () => {
  const parsed = parseEnv(
    [
      "# a comment",
      "",
      "PLAIN=hello",
      "export EXPORTED=world",
      'DQUOTED="a b"',
      "SQUOTED='c d'",
      'ESCAPED="line1\\nline2"',
      "SINGLE_NOESC='x\\ny'",
      "INLINE=value # trailing",
      "HASH=no#comment",
      "SPACED =  trimmed  ",
      "=novalue",
      "1BAD=nope",
    ].join("\n"),
  );
  assertEquals(parsed.PLAIN, "hello");
  assertEquals(parsed.EXPORTED, "world");
  assertEquals(parsed.DQUOTED, "a b");
  assertEquals(parsed.SQUOTED, "c d");
  assertEquals(parsed.ESCAPED, "line1\nline2"); // double quotes interpret \n
  assertEquals(parsed.SINGLE_NOESC, "x\\ny"); // single quotes stay literal
  assertEquals(parsed.INLINE, "value"); // inline comment stripped
  assertEquals(parsed.HASH, "no#comment"); // no space before # -> not a comment
  assertEquals(parsed.SPACED, "trimmed");
  assert(!("" in parsed)); // "=novalue" skipped
  assert(!("1BAD" in parsed)); // invalid identifier skipped
});

// ---- public-env isolation --------------------------------------------------

Deno.test("isPublicEnvKey / filterPublicEnv gate on the recognized prefixes", () => {
  assert(isPublicEnvKey("NEXT_PUBLIC_API"));
  assert(isPublicEnvKey("DENEXT_PUBLIC_API"));
  assert(!isPublicEnvKey("SECRET"));
  assert(!isPublicEnvKey("PUBLIC_X")); // prefix must be exact

  assertEquals(
    filterPublicEnv({
      NEXT_PUBLIC_A: "1",
      DENEXT_PUBLIC_B: "2",
      SECRET: "shh",
      DATABASE_URL: "postgres://",
    }),
    { NEXT_PUBLIC_A: "1", DENEXT_PUBLIC_B: "2" },
  );
});

// ---- loadEnv ---------------------------------------------------------------

Deno.test("loadEnv merges .env then .env.local and respects existing env", async () => {
  const keys = ["DNTEST_A", "DNTEST_B", "DENEXT_PUBLIC_DNTEST", "DNTEST_SHELL"];
  await withEnv(keys, async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_env_" });
    try {
      await Deno.writeTextFile(
        join(dir, ".env"),
        "DNTEST_A=base\nDNTEST_B=base\nDENEXT_PUBLIC_DNTEST=pub\nDNTEST_SHELL=fromfile\n",
      );
      await Deno.writeTextFile(join(dir, ".env.local"), "DNTEST_B=local\n");

      // A real shell var must win over a committed .env value by default.
      Deno.env.set("DNTEST_SHELL", "fromshell");

      const merged = await loadEnv({ dir });
      // .env.local overrides .env in the returned merge.
      assertEquals(merged.DNTEST_B, "local");
      // Applied to Deno.env, but the pre-set shell var is not clobbered.
      assertEquals(Deno.env.get("DNTEST_A"), "base");
      assertEquals(Deno.env.get("DNTEST_B"), "local");
      assertEquals(Deno.env.get("DNTEST_SHELL"), "fromshell");

      // override:true clobbers the existing value.
      await loadEnv({ dir, override: true });
      assertEquals(Deno.env.get("DNTEST_SHELL"), "fromfile");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("publicEnv returns only public-prefixed process vars", async () => {
  await withEnv(["DENEXT_PUBLIC_ONE", "NEXT_PUBLIC_TWO", "DNTEST_SECRET"], () => {
    Deno.env.set("DENEXT_PUBLIC_ONE", "1");
    Deno.env.set("NEXT_PUBLIC_TWO", "2");
    Deno.env.set("DNTEST_SECRET", "hunter2");
    const pub = publicEnv();
    assertEquals(pub.DENEXT_PUBLIC_ONE, "1");
    assertEquals(pub.NEXT_PUBLIC_TWO, "2");
    assert(!("DNTEST_SECRET" in pub));
  });
});

// ---- client/server isolation end-to-end ------------------------------------

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("only public env reaches the page; secrets never do", async () => {
  await withEnv(["DENEXT_PUBLIC_SITE", "DNTEST_DB_SECRET"], async () => {
    Deno.env.set("DENEXT_PUBLIC_SITE", "https://pub.example");
    Deno.env.set("DNTEST_DB_SECRET", "sup3r-s3cret-value");

    const app = createApp({
      getManifest: manifest,
      load: () => Promise.resolve({ default: () => h("h1", null, "hi") }),
    });
    const html = await (await app(new Request("http://localhost/x"))).text();

    // The public var is embedded in the island; the secret is absent entirely.
    assertStringIncludes(html, `id="__denext_public_env"`);
    assertStringIncludes(html, "https://pub.example");
    assert(!html.includes("sup3r-s3cret-value"));
    assert(!html.includes("DNTEST_DB_SECRET"));
  });
});

Deno.test("client publicEnv reads the embedded island", () => {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = {
    getElementById: (id: string) =>
      id === "__denext_public_env"
        ? { textContent: JSON.stringify({ NEXT_PUBLIC_API: "https://api.x" }) }
        : null,
  };
  try {
    assertEquals(clientPublicEnv(), { NEXT_PUBLIC_API: "https://api.x" });
  } finally {
    if (prev === undefined) delete (g as Record<string, unknown>).document;
    else g.document = prev;
  }
});

// Public-env tree-shaking: the build scans client bundles for referenced public
// vars, and only those (∪ the `publicEnv` config) are embedded in the page.
Deno.test("extractPublicEnvRefs finds literally-referenced public vars", async () => {
  const { extractPublicEnvRefs } = await import("../src/runtime/public-env.ts");
  const src = `
    const a = publicEnv().NEXT_PUBLIC_API_URL;
    const b = publicEnv()["DENEXT_PUBLIC_FLAG"];
    const notPublic = Deno.env.get("SECRET_KEY");
  `;
  const refs = extractPublicEnvRefs(src).sort();
  assertEquals(refs, ["DENEXT_PUBLIC_FLAG", "NEXT_PUBLIC_API_URL"]);
});

Deno.test("restrictPublicEnv keeps only allowlisted keys (undefined ⇒ all)", async () => {
  const { restrictPublicEnv } = await import("../src/runtime/public-env.ts");
  const env = { NEXT_PUBLIC_A: "1", NEXT_PUBLIC_B: "2", DENEXT_PUBLIC_C: "3" };
  assertEquals(restrictPublicEnv(env, ["NEXT_PUBLIC_A", "DENEXT_PUBLIC_C"]), {
    NEXT_PUBLIC_A: "1",
    DENEXT_PUBLIC_C: "3",
  });
  assertEquals(restrictPublicEnv(env, undefined), env); // no restriction
  assertEquals(restrictPublicEnv(env, []), {}); // empty allowlist ships nothing
});

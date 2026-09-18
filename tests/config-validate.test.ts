// Unknown-key detection + "did you mean" for denext.config (the value-level
// `validateDenextConfig` throwing behavior is covered by tests/paths.test.ts).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  didYouMean,
  KNOWN_CONFIG_KEYS,
  validateDenextConfig,
  warnUnknownConfigKeys,
} from "../src/server/config-validate.ts";
import { CONFIG_KEYS, EXPERIMENTAL_KEYS } from "../src/server/config-keys.generated.ts";

/** Capture console.warn output produced while `fn` runs. */
function captureWarn(fn: () => void): string[] {
  const original = console.warn;
  const out: string[] = [];
  console.warn = (...args: unknown[]) => out.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return out;
}

Deno.test("KNOWN_CONFIG_KEYS is the generated, type-derived key list", () => {
  // One source of truth: the validator's list IS the generated one (which the loader in
  // paths.ts also iterates). Drift against the `DenextConfig` interface is caught by
  // tests/config-schema.test.ts, and exhaustiveness at compile time in paths.ts.
  assertEquals([...KNOWN_CONFIG_KEYS], [...CONFIG_KEYS]);
  assertEquals(new Set(KNOWN_CONFIG_KEYS).size, KNOWN_CONFIG_KEYS.length, "no duplicates");
  for (
    const key of [
      "basePath",
      "experimental",
      "cacheComponents",
      "reactCompiler",
      "asyncContext",
      "features",
      "plugins",
    ]
  ) {
    assert(KNOWN_CONFIG_KEYS.includes(key), `expected top-level key \`${key}\``);
  }
});

Deno.test("didYouMean suggests a close key and stays quiet on nonsense", () => {
  assertEquals(didYouMean("basepath"), "basePath"); // case-only
  assertEquals(didYouMean("basePathh"), "basePath"); // one extra char
  assertEquals(didYouMean("compatibility"), "compatibilityMode"); // prefix within range
  assertEquals(didYouMean("redirect"), "redirects"); // missing plural
  // Far-off garbage gets no suggestion rather than a misleading one.
  assertEquals(didYouMean("xyzzy"), undefined);
  assertEquals(didYouMean("somethingEntirelyUnrelated"), undefined);
  // Any candidate list works (the experimental sub-keys reuse it).
  assertEquals(didYouMean("asynccontext", EXPERIMENTAL_KEYS), "asyncContext");
  assertEquals(didYouMean("basePath", EXPERIMENTAL_KEYS), undefined);
});

Deno.test("warnUnknownConfigKeys warns per unknown key (with a suggestion), silent on known", () => {
  // A fully-known config is silent.
  assertEquals(
    captureWarn(() => warnUnknownConfigKeys({ basePath: "/x", trailingSlash: true })),
    [],
  );

  const warns = captureWarn(() =>
    warnUnknownConfigKeys({ basepath: "/x", notARealOption: 1 }, "denext.config.ts")
  );
  assertEquals(warns.length, 2);
  assert(warns[0].includes("`basepath`") && warns[0].includes("did you mean `basePath`"));
  assert(warns[0].includes("denext.config.ts"));
  // A far-off key still warns, just without a (misleading) suggestion.
  assert(warns[1].includes("`notARealOption`") && !warns[1].includes("did you mean"));
});

Deno.test("experimental.*: a typo gets a suggestion, an empty block is silent", () => {
  assertEquals(captureWarn(() => warnUnknownConfigKeys({ experimental: {} })), []);

  const warns = captureWarn(() =>
    warnUnknownConfigKeys({ experimental: { complier: true } }, "denext.config.ts")
  );
  assertEquals(warns, [
    "denext: denext.config.ts has an unknown option `experimental.complier`, which will be ignored — did you mean `compiler`?",
  ]);
  // Far-off: warns without a suggestion, and the top-level key list is NOT consulted.
  const far = captureWarn(() => warnUnknownConfigKeys({ experimental: { basePath: "/x" } }));
  assertEquals(far.length, 1);
  assert(far[0].includes("`experimental.basePath`") && !far[0].includes("did you mean"));
});

Deno.test("graduated experimental.* keys point at their top-level home (exact wording)", () => {
  const warns = captureWarn(() =>
    warnUnknownConfigKeys({
      experimental: { streaming: true, live: { allowAnonymous: true }, cacheComponents: true },
    })
  );
  assertEquals(warns, [
    "denext: denext.config sets `experimental.streaming`, which is no longer honored — set top-level `streaming` instead.",
    "denext: denext.config sets `experimental.live`, which is no longer honored — set top-level `live` instead.",
    "denext: denext.config sets `experimental.cacheComponents`, which is still honored for now but has moved — set top-level `cacheComponents` instead.",
  ]);
  // The removed aliases must not also be live `ExperimentalConfig` fields (else the
  // "no longer honored" message would be a lie — the generated list is the arbiter).
  for (const k of ["streaming", "live", "cacheComponents"]) {
    assert(!EXPERIMENTAL_KEYS.includes(k as never), `\`${k}\` is still in ExperimentalConfig`);
  }
});

Deno.test("every remaining experimental.* key is a graduated alias: honored, and warns once", () => {
  // The whole block is deprecated: each member stays an `ExperimentalConfig` field so a 2.x
  // config keeps type-checking, and setting one warns exactly once, naming its top-level twin.
  const warns = captureWarn(() =>
    warnUnknownConfigKeys(
      {
        experimental: {
          reactCompiler: true,
          compiler: true,
          asyncContext: true,
          features: { A: true },
          nodeResolve: false,
        },
      },
      "denext.config.ts",
    )
  );
  assertEquals(warns, [
    "denext: denext.config.ts sets `experimental.reactCompiler`, which is still honored for now but has moved — set top-level `reactCompiler` instead.",
    "denext: denext.config.ts sets `experimental.compiler`, which is still honored for now but has moved — set top-level `reactCompiler` instead.",
    "denext: denext.config.ts sets `experimental.asyncContext`, which is still honored for now but has moved — set top-level `asyncContext` instead.",
    "denext: denext.config.ts sets `experimental.features`, which is still honored for now but has moved — set top-level `features` instead.",
    "denext: denext.config.ts sets `experimental.nodeResolve`, which is still honored for now but has moved — set top-level `nodeResolve` instead.",
  ]);
  // Every generated sub-key is covered by a "moved" pointer — no member is left un-deprecated.
  for (const k of EXPERIMENTAL_KEYS) {
    const [line] = captureWarn(() => warnUnknownConfigKeys({ experimental: { [k]: true } }));
    assert(line?.includes(`\`experimental.${k}\`, which is still honored`), `\`${k}\` warns`);
  }
  // The top-level homes are silent, alone or beside the alias they supersede.
  assertEquals(
    captureWarn(() =>
      warnUnknownConfigKeys({ reactCompiler: true, asyncContext: true, features: { A: true } })
    ),
    [],
  );
});

Deno.test("a non-object `experimental` never crashes the key check", () => {
  for (const experimental of [true, false, null, undefined, "compiler", 42, ["compiler"]]) {
    assertEquals(captureWarn(() => warnUnknownConfigKeys({ experimental })), []);
  }
});

Deno.test("features is validated at both spellings, each error naming the field as written", () => {
  validateDenextConfig({ features: { A: true, B: false } });
  validateDenextConfig({ experimental: { features: { A: true } } });
  assertThrows(
    () => validateDenextConfig({ features: ["A"] as never }),
    Error,
    "`features` must be an object mapping flag names to booleans",
  );
  assertThrows(
    () => validateDenextConfig({ features: { A: "yes" } as never }),
    Error,
    "`features.A` must be a boolean",
  );
  assertThrows(
    () => validateDenextConfig({ experimental: { features: { A: 1 } } as never }),
    Error,
    "`experimental.features.A` must be a boolean",
  );
});

Deno.test("production-server keys: a bare origin, a boolean, whole numbers in range, a name list", () => {
  // Every value a deploy guide would set, accepted together.
  validateDenextConfig({
    canonicalOrigin: "https://example.com:8443",
    trustForwardedHeaders: true,
    requestTimeout: 0, // 0 = no deadline
    maxConcurrency: 100,
    slotBackstop: 60_000,
    actionMaxBodyBytes: 20 * 1024 * 1024,
    cacheKeyParams: ["page", "sort"],
  });
  // canonicalOrigin is exactly an origin: a path, a bare host or a non-http scheme would
  // make the Server Action origin check refuse every action (a silent 403).
  for (const bad of ["https://example.com/app", "example.com", "ftp://example.com", ""]) {
    assertThrows(
      () => validateDenextConfig({ canonicalOrigin: bad }),
      Error,
      "`canonicalOrigin` must be an origin",
    );
  }
  assertThrows(
    () => validateDenextConfig({ trustForwardedHeaders: "1" as never }),
    Error,
    "`trustForwardedHeaders` must be a boolean",
  );
  assertThrows(
    () => validateDenextConfig({ requestTimeout: -1 }),
    Error,
    "`requestTimeout` must be a finite integer >= 0",
  );
  assertThrows(
    () => validateDenextConfig({ requestTimeout: 1.5 }),
    Error,
    "`requestTimeout` must be a finite integer >= 0",
  );
  assertThrows(
    () => validateDenextConfig({ maxConcurrency: 0 }),
    Error,
    "`maxConcurrency` must be a finite integer >= 1",
  );
  assertThrows(
    () => validateDenextConfig({ slotBackstop: Infinity }),
    Error,
    "`slotBackstop` must be a finite integer >= 1",
  );
  assertThrows(
    () => validateDenextConfig({ actionMaxBodyBytes: 0 }),
    Error,
    "`actionMaxBodyBytes` must be a finite integer >= 1",
  );
  assertThrows(
    () => validateDenextConfig({ cacheKeyParams: "page" as never }),
    Error,
    "`cacheKeyParams` must be an array of query-parameter-name strings",
  );
  assertThrows(
    () => validateDenextConfig({ cacheKeyParams: [1] as never }),
    Error,
    "`cacheKeyParams` must be an array of query-parameter-name strings",
  );
  // They are known top-level keys — no unknown-key warning.
  for (
    const key of [
      "canonicalOrigin",
      "trustForwardedHeaders",
      "requestTimeout",
      "maxConcurrency",
      "slotBackstop",
      "actionMaxBodyBytes",
      "cacheKeyParams",
    ]
  ) {
    assert(KNOWN_CONFIG_KEYS.includes(key), `expected top-level key \`${key}\``);
  }
});

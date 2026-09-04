// Unknown-key detection + "did you mean" for denext.config (the value-level
// `validateDenextConfig` throwing behavior is covered by tests/paths.test.ts).

import { assert, assertEquals } from "@std/assert";
import {
  didYouMean,
  KNOWN_CONFIG_KEYS,
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
  for (const key of ["basePath", "experimental", "cacheComponents", "plugins"]) {
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

Deno.test("experimental.*: a typo gets a suggestion, the known sub-keys are silent", () => {
  const known = Object.fromEntries(EXPERIMENTAL_KEYS.map((k) => [k, true]));
  assertEquals(captureWarn(() => warnUnknownConfigKeys({ experimental: known })), []);
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
  // The graduated names must not also be live `ExperimentalConfig` fields (else the
  // "moved" message would be a lie — the generated list is the arbiter).
  for (const k of ["streaming", "live", "cacheComponents"]) {
    assert(!EXPERIMENTAL_KEYS.includes(k as never), `\`${k}\` is still in ExperimentalConfig`);
  }
});

Deno.test("a non-object `experimental` never crashes the key check", () => {
  for (const experimental of [true, false, null, undefined, "compiler", 42, ["compiler"]]) {
    assertEquals(captureWarn(() => warnUnknownConfigKeys({ experimental })), []);
  }
});

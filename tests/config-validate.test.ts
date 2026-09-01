// Unknown-key detection + "did you mean" for denext.config (the value-level
// `validateDenextConfig` throwing behavior is covered by tests/paths.test.ts).

import { assert, assertEquals } from "@std/assert";
import {
  didYouMean,
  KNOWN_CONFIG_KEYS,
  warnUnknownConfigKeys,
} from "../src/server/config-validate.ts";

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

Deno.test("KNOWN_CONFIG_KEYS matches the loader's field whitelist", () => {
  // The loader (paths.ts loadDenextConfig) reconstructs config from a fixed field list.
  // If a new DenextConfig key is added there but not here, unknown-key warnings would
  // false-positive on it — so these two lists must stay in lockstep.
  const expected = [
    "mode",
    "spa",
    "i18n",
    "basePath",
    "trailingSlash",
    "assetPrefix",
    "redirects",
    "rewrites",
    "headers",
    "images",
    "tailwind",
    "mdx",
    "cache",
    "streaming",
    "live",
    "experimental",
    "plugins",
    "csp",
    "hsts",
    "publicEnv",
    "compatibilityMode",
    "classComponents",
  ];
  assertEquals([...KNOWN_CONFIG_KEYS].sort(), [...expected].sort());
});

Deno.test("didYouMean suggests a close key and stays quiet on nonsense", () => {
  assertEquals(didYouMean("basepath"), "basePath"); // case-only
  assertEquals(didYouMean("basePathh"), "basePath"); // one extra char
  assertEquals(didYouMean("compatibility"), "compatibilityMode"); // prefix within range
  assertEquals(didYouMean("redirect"), "redirects"); // missing plural
  // Far-off garbage gets no suggestion rather than a misleading one.
  assertEquals(didYouMean("xyzzy"), undefined);
  assertEquals(didYouMean("somethingEntirelyUnrelated"), undefined);
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

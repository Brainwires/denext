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
  assertEquals(didYouMean("reactcompiler", EXPERIMENTAL_KEYS), "reactCompiler");
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
    warnUnknownConfigKeys({ experimental: { reactCompilr: true } }, "denext.config.ts")
  );
  assertEquals(warns, [
    "denext: denext.config.ts has an unknown option `experimental.reactCompilr`, which will be ignored — did you mean `reactCompiler`?",
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
  for (const k of ["streaming", "live"]) {
    assert(!EXPERIMENTAL_KEYS.includes(k as never), `\`${k}\` is still in ExperimentalConfig`);
  }
  // Next 16's spelling stays a typed, honored alias.
  assert(EXPERIMENTAL_KEYS.includes("cacheComponents" as never));
});

Deno.test("every remaining experimental.* key is Next's own spelling: honored, and warns once", () => {
  // Each member is a Next.js spelling kept as an obsolete alias for migrated Next apps, and
  // setting one warns exactly once, naming its top-level twin.
  const warns = captureWarn(() =>
    warnUnknownConfigKeys(
      { experimental: { reactCompiler: true, optimizePackageImports: ["x"] } },
      "denext.config.ts",
    )
  );
  assertEquals(warns, [
    "denext: denext.config.ts sets `experimental.reactCompiler`, which is still honored for now but has moved — set top-level `reactCompiler` instead.",
    "denext: denext.config.ts sets `experimental.optimizePackageImports`, which is still honored for now but has moved — set top-level `optimizePackageImports` instead.",
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

Deno.test("denext's own experimental.* aliases were removed in 3.0: a validation error, no warning", () => {
  const removed: [string, unknown, string][] = [
    ["compiler", true, "reactCompiler"],
    ["asyncContext", true, "asyncContext"],
    ["features", { A: true }, "features"],
    // Silently ignoring `false` here would flip the resolver back on — hence an error.
    ["nodeResolve", false, "nodeResolve"],
  ];
  for (const [key, value, to] of removed) {
    const config = { experimental: { [key]: value } } as never;
    assertThrows(
      () => validateDenextConfig(config, "denext.config.ts"),
      Error,
      `invalid denext.config.ts: \`experimental.${key}\` was removed in denext 3.0 — set top-level \`${to}\` instead`,
    );
    // The key check leaves it to the validator: no "unknown option" or "moved" line too.
    assertEquals(captureWarn(() => warnUnknownConfigKeys(config)), [], key);
    assert(!EXPERIMENTAL_KEYS.includes(key as never), `\`${key}\` is still in ExperimentalConfig`);
  }
});

Deno.test("a non-object `experimental` never crashes the key check", () => {
  for (const experimental of [true, false, null, undefined, "compiler", 42, ["compiler"]]) {
    assertEquals(captureWarn(() => warnUnknownConfigKeys({ experimental })), []);
  }
});

Deno.test("features is validated, each error naming the field as written", () => {
  validateDenextConfig({ features: { A: true, B: false } });
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
  // compress: a boolean, or { encodings } of "gzip" / "br".
  validateDenextConfig({ compress: false });
  validateDenextConfig({ compress: { encodings: ["br", "gzip"] } });
  validateDenextConfig({ compress: {} });
  assertThrows(
    () => validateDenextConfig({ compress: "gzip" as never }),
    Error,
    "`compress` must be a boolean or { encodings",
  );
  assertThrows(
    () => validateDenextConfig({ compress: { encodings: ["zstd"] } as never }),
    Error,
    '`compress.encodings` must be an array of "gzip" / "br"',
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

Deno.test("validateDenextConfig: spa.ota must be a boolean", () => {
  const spa = (ota: unknown) =>
    ({ mode: "spa", spa: { entry: "./src/main.tsx", ota } }) as Parameters<
      typeof validateDenextConfig
    >[0];
  validateDenextConfig(spa(true));
  validateDenextConfig(spa(false));
  validateDenextConfig(spa(undefined));
  assertThrows(() => validateDenextConfig(spa("yes")), Error, "`spa.ota` must be a boolean");
});

Deno.test("desktop.capabilities: valid shapes pass; bad shapes throw a field-scoped error", () => {
  // Valid: booleans, an fs options object, a shell options object, an extensions list, or absent.
  validateDenextConfig({
    desktop: {
      capabilities: {
        secureStore: true,
        fs: { read: ["$APPDATA"], write: ["$APPDATA"] },
        shell: { openExternal: ["https:"] },
        extensions: ["./desktop/extensions/scanner.ts"],
      },
    },
  });
  validateDenextConfig({ desktop: { capabilities: {} } });
  validateDenextConfig({ desktop: {} });
  validateDenextConfig({});

  // Invalid shapes.
  assertThrows(
    () => validateDenextConfig({ desktop: [] as unknown as Record<never, never> }),
    Error,
    "`desktop` must be an object",
  );
  assertThrows(
    () =>
      validateDenextConfig({ desktop: { capabilities: true } as unknown as Record<never, never> }),
    Error,
    "`desktop.capabilities`",
  );
  assertThrows(
    () =>
      validateDenextConfig(
        { desktop: { capabilities: { extensions: ["", 1] } } } as unknown as Record<never, never>,
      ),
    Error,
    "`desktop.capabilities.extensions`",
  );
  assertThrows(
    () =>
      validateDenextConfig(
        { desktop: { capabilities: { fs: 5 } } } as unknown as Record<never, never>,
      ),
    Error,
    "`desktop.capabilities.fs`",
  );
});

Deno.test("desktop.capabilities.shell.openPathAllowExtensions: bare extensions only", () => {
  const cfg = (allow: unknown) =>
    ({
      desktop: { capabilities: { shell: { openPath: true, openPathAllowExtensions: allow } } },
    }) as unknown as Record<never, never>;
  validateDenextConfig(cfg(["py", "SH"]));
  for (const bad of [".py", "a/b", "a\\b", "", 5, "py"]) {
    assertThrows(
      () => validateDenextConfig(cfg(bad === "py" ? "py" : [bad])),
      Error,
      "`desktop.capabilities.shell.openPathAllowExtensions`",
    );
  }
});

Deno.test("csp / spa.csp: opt-in values must be string arrays; unknown keys warn", () => {
  const all = {
    scriptSrc: ["https://js.stripe.com"],
    styleSrc: ["https://fonts.googleapis.com"],
    imgSrc: ["https://cdn.example"],
    connectSrc: ["https://api.stripe.com"],
    fontSrc: ["https://fonts.gstatic.com"],
    frameSrc: ["https://js.stripe.com", "https://hooks.stripe.com"],
    mediaSrc: ["https://media.example"],
    workerSrc: ["blob:"],
  };
  assertEquals(captureWarn(() => validateDenextConfig({ csp: all })), []);
  validateDenextConfig({ csp: "strict" });
  validateDenextConfig({ csp: "off" });
  assertThrows(
    () => validateDenextConfig({ csp: { frameSrc: "https://js.stripe.com" } as never }),
    Error,
    "`csp.frameSrc` must be an array of source strings",
  );
  assertThrows(
    () => validateDenextConfig({ csp: { mediaSrc: [1] } as never }),
    Error,
    "`csp.mediaSrc` must be an array of source strings",
  );
  assertThrows(
    () => validateDenextConfig({ csp: ["x"] as never }),
    Error,
    '`csp` must be "strict", "off", or an opt-in object',
  );
  assertThrows(
    () =>
      validateDenextConfig({
        mode: "spa",
        spa: { entry: "./src/main.tsx", csp: { workerSrc: "blob:" } as never },
      }),
    Error,
    "`spa.csp.workerSrc` must be an array of source strings",
  );
  const warns = captureWarn(() =>
    validateDenextConfig({ csp: { frameSource: ["https://x.io"] } as never })
  );
  assertEquals(warns.length, 1);
  assert(warns[0].includes("unknown option `frameSource`"), warns[0]);
  assert(warns[0].includes("did you mean `frameSrc`?"), warns[0]);
});

Deno.test("desktop.capabilities.passkeys: false or a required { rpIds: string[] } pin", () => {
  validateDenextConfig({
    desktop: { capabilities: { passkeys: { rpIds: ["clerk.example.com"] } } },
  });
  validateDenextConfig({ desktop: { capabilities: { passkeys: { rpIds: [] } } } });
  validateDenextConfig({ desktop: { capabilities: { passkeys: false } } });
  // Fail closed: no pin is an error, never "any RP ID".
  for (const passkeys of [true, {}]) {
    assertThrows(
      () =>
        validateDenextConfig(
          { desktop: { capabilities: { passkeys } } } as unknown as Record<never, never>,
        ),
      Error,
      "must pin its relying parties",
    );
  }
  for (const passkeys of [{ rpIds: "x" }, { rpIds: [""] }, { rpIds: [1] }, "yes"]) {
    assertThrows(
      () =>
        validateDenextConfig(
          { desktop: { capabilities: { passkeys } } } as unknown as Record<never, never>,
        ),
      Error,
      "desktop.capabilities.passkeys",
    );
  }
});

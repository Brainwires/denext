import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineConfig } from "../src/server/define-config.ts";

Deno.test("defineConfig returns the config unchanged (identity)", () => {
  const cfg = { basePath: "/app", trailingSlash: true };
  assertEquals(defineConfig(cfg), cfg);
});

Deno.test("defineConfig validates values at runtime (throws field-scoped)", () => {
  // A malformed value that TypeScript can't catch (a valid string, wrong shape) throws
  // at the config site with the offending field named.
  assertThrows(() => defineConfig({ basePath: "docs" }), Error, "basePath");
});

/** Capture console.warn output produced while `fn` runs. */
function captureWarn(fn: () => void): string[] {
  const original = console.warn;
  const warns: string[] = [];
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warns;
}

Deno.test("defineConfig warns on an unknown key with a suggestion", () => {
  // A stale/typo'd key on an object cast to the config type (e.g. copied from a
  // Next.js config). It's ignored, but no longer silently.
  const warns = captureWarn(() => defineConfig({ basePath: "/x", reactStrictMode: true } as never));
  assert(warns.some((w) => w.includes("`reactStrictMode`")));
});

Deno.test("defineConfig warns on a typo'd experimental.* key and on graduated aliases", () => {
  // Typo one level down → suggestion from the experimental sub-key list.
  const typo = captureWarn(() => defineConfig({ experimental: { complier: true } } as never));
  assertEquals(typo, [
    "denext: denext.config has an unknown option `experimental.complier`, which will be ignored — did you mean `compiler`?",
  ]);
  // Graduated keys → a "moved" pointer, not a generic unknown-key warning.
  const moved = captureWarn(() =>
    defineConfig(
      { experimental: { streaming: false, live: {}, cacheComponents: true } } as never,
    )
  );
  assertEquals(moved, [
    "denext: denext.config sets `experimental.streaming`, which is no longer honored — set top-level `streaming` instead.",
    "denext: denext.config sets `experimental.live`, which is no longer honored — set top-level `live` instead.",
    "denext: denext.config sets `experimental.cacheComponents`, which is still honored for now but has moved — set top-level `cacheComponents` instead.",
  ]);
  // A valid experimental block (and the new top-level home) is silent.
  assertEquals(
    captureWarn(() => defineConfig({ cacheComponents: true, experimental: { compiler: true } })),
    [],
  );
});

Deno.test("defineConfig type-checks the config (accepts valid, rejects unknown fields)", async () => {
  const mod = new URL("../src/server/define-config.ts", import.meta.url).pathname;
  const dir = await Deno.makeTempDir({ prefix: "denext-defineconfig-" });
  const check = async (body: string): Promise<number> => {
    await Deno.writeTextFile(`${dir}/t.ts`, body);
    const { code } = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/t.ts`],
      stderr: "null",
      stdout: "null",
    }).output();
    return code;
  };
  try {
    assertEquals(
      await check(
        `import { defineConfig } from "${mod}";\nexport default defineConfig({ basePath: "/x", cache: { store: "sqlite" } });`,
      ),
      0,
    );
    assertEquals(
      (await check(
        `import { defineConfig } from "${mod}";\nexport default defineConfig({ notAField: 1 });`,
      )) === 0,
      false,
      "an unknown config field must not typecheck",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

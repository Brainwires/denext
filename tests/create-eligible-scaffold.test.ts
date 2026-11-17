// `denext create`'s scaffold under Deno's dependency-age hold (src/cli/commands/create.ts): when
// this CLI's own release is too new for the hold, the files are written pinned to the newest
// version it lets in, and the held release is reported; past the hold nothing is rewritten. The
// registry and the clock are injected, so the result doesn't depend on when the test runs.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { scaffoldAndReport } from "../src/cli/commands/create.ts";
import { effectiveRule } from "../src/build/dep-age.ts";
import type { UpgradeLookups } from "../src/build/upgrade.ts";
import { VERSION } from "../src/version.ts";

const NOW = new Date("2026-10-20T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** A fake JSR holding @denext/denext's versions published `h` hours before NOW. */
function jsr(versions: Record<string, number>): UpgradeLookups {
  const published = Object.fromEntries(Object.entries(versions).map(([v, h]) => [v, hoursAgo(h)]));
  return {
    versions: (name: string) =>
      Promise.resolve(
        name === "@denext/denext"
          ? { latest: Object.keys(versions).at(-1)!, versions: Object.keys(versions), published }
          : null,
      ),
    denextRange: () => Promise.resolve(null),
  } as unknown as UpgradeLookups;
}

async function scaffold(versions: Record<string, number>) {
  const dir = await Deno.makeTempDir();
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const written = await scaffoldAndReport({ dir, name: "app" } as never, "create", false, {
      lookups: jsr(versions),
      rule: effectiveRule({ now: NOW }),
      now: NOW,
    });
    return { dir, written, logged, denoJson: await Deno.readTextFile(join(dir, "deno.json")) };
  } finally {
    console.log = log;
  }
}

Deno.test("create: a release inside the hold scaffolds the previous one and says so", async () => {
  const { dir, written, logged, denoJson } = await scaffold({ "4.0.0": 500, [VERSION]: 2 });
  try {
    assert(written.includes("deno.json"), written.join());
    assertStringIncludes(denoJson, "@denext/denext@^4.0.0");
    assert(!denoJson.includes(`@denext/denext@^${VERSION}`), "the held release was not pinned");
    assert(logged.some((l) => l.includes("   + deno.json")), logged.join("\n"));
    assert(logged.some((l) => l.includes(`denext ${VERSION} was published`)), logged.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("create: a release past the hold is scaffolded as is, with nothing held", async () => {
  const { dir, logged, denoJson } = await scaffold({ "4.0.0": 500, [VERSION]: 200 });
  try {
    assertStringIncludes(denoJson, `@denext/denext@^${VERSION}`);
    assertEquals(logged.filter((l) => l.includes("was published")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

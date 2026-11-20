// The Docker image and the project's runtime pin (src/build/docker-detect.ts dockerRuntime,
// src/build/docker-template.ts): a pinned project's image records the release as a label (the pin
// itself travels in with deno.json, so the build and the server resolve exactly it), and an
// unpinned project whose machine runs another release than the bundled one is warned with the fix.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dockerRuntime, resolveDocker } from "../src/build/docker-detect.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import type { RuntimeRelease } from "../src/build/runtime-select.ts";

const PIN = { version: "3.0.0-denext.31", integrity: `sha256-${"b".repeat(64)}` };

async function withProject(
  denoJson: unknown,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext-docker-runtime-" });
  try {
    if (denoJson !== undefined) {
      await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(denoJson));
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A selection of `source` (only the fields dockerRuntime reads matter). */
const selected =
  (source: string, version: string | null = "3.0.0-denext.30") =>
  () => ({ source, version } as unknown as RuntimeRelease);

Deno.test("dockerRuntime: a pinned project records its release, whatever runs here", async () => {
  await withProject({ denext: { runtime: PIN } }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(dockerRuntime(dir, warnings, selected("default")), { runtime: PIN.version });
    assertEquals(warnings, []);
    const resolved = await resolveDocker(dir);
    assertEquals(resolved.options.runtime, PIN.version);
  });
});

Deno.test("dockerRuntime: a malformed pin is a warning, not a crash", async () => {
  await withProject({ denext: { runtime: { version: "4.0.0" } } }, (dir) => {
    const warnings: string[] = [];
    assertEquals(dockerRuntime(dir, warnings), {});
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "malformed");
    return Promise.resolve();
  });
});

Deno.test("dockerRuntime: an unpinned project warns when this machine runs another release", async () => {
  await withProject({}, (dir) => {
    const fromDefault: string[] = [];
    assertEquals(dockerRuntime(dir, fromDefault, selected("default")), {});
    assertStringIncludes(fromDefault[0], "not 3.0.0-denext.30 (your default runtime here)");
    assertStringIncludes(fromDefault[0], "denext runtime use 3.0.0-denext.30 --project");
    const fromEnv: string[] = [];
    dockerRuntime(dir, fromEnv, selected("env"));
    assertStringIncludes(fromEnv[0], "(DENEXT_RUNTIME here)");
    // The bundled release is what the image runs too; no version or no answer: nothing to say.
    for (const quiet of [selected("bundled"), selected("default", null)]) {
      const w: string[] = [];
      assertEquals(dockerRuntime(dir, w, quiet), {});
      assertEquals(w, []);
    }
    const thrown: string[] = [];
    assertEquals(
      dockerRuntime(dir, thrown, () => {
        throw new Error("no runtime");
      }),
      {},
    );
    assertEquals(thrown, []);
    return Promise.resolve();
  });
});

Deno.test("renderDockerfile: the pinned release is the image's label, before the runtime link", () => {
  for (const mode of ["server", "static"] as const) {
    const pinned = renderDockerfile({ mode, runtime: PIN.version });
    const label = `LABEL dev.denext.runtime="${PIN.version}"`;
    assertStringIncludes(pinned, label);
    assert(pinned.indexOf(label) < pinned.indexOf("runtime path"), mode);
    assert(pinned.indexOf("deno task") < pinned.indexOf(label), `${mode}: after the build`);
    const plain = renderDockerfile({ mode });
    assert(!plain.includes("dev.denext.runtime"), mode);
    assertStringIncludes(plain, "runtime path)");
    assert(!plain.includes("toolchain path"), mode);
  }
});

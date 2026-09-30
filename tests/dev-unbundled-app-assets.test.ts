// Unbundled dev, compat mode: the app's OWN asset imports (a Vite `?url` / `?raw` query, a bare
// `./logo.png`) ride the dependency bundle by absolute path, so they resolve wherever the importer
// lives and export a URL that works from any page. They used to reach the bundle as the relative
// specifier, which it resolved against the project root and failed (T3 Code's `?url` sounds).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  createUnbundledState,
  depSlug,
  norm,
  NPM_PREFIX,
} from "../src/build/dev-unbundled/state.ts";
import { transform } from "../src/build/dev-unbundled/transform.ts";
import { ensureNpmBundle } from "../src/build/dev-unbundled/deps.ts";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({ imports: { "~/": "./src/" } }),
  "src/lib/sound.ts": [
    'import clickUrl from "../assets/click.mp3?url";',
    'import note from "~/assets/note.txt?raw";',
    'import logo from "../assets/logo.png";',
    "export const all = [clickUrl, note, logo];",
  ].join("\n"),
  "src/assets/click.mp3": "MP3",
  "src/assets/note.txt": "hello note",
  "src/assets/logo.png": "PNG",
};

Deno.test("compat dev: the app's ?url / ?raw / bare asset imports go through the dependency bundle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-app-assets-" });
  try {
    for (const [rel, text] of Object.entries(FILES)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    const st = createUnbundledState({
      projectDir: dir,
      appDir: join(dir, "src"),
      configPath: join(dir, "deno.json"),
      outDir: join(dir, "out"),
      compat: true,
    });
    const mp3 = norm(join(dir, "src/assets/click.mp3")) + "?url";
    const txt = norm(join(dir, "src/assets/note.txt")) + "?raw";
    const png = norm(join(dir, "src/assets/logo.png"));
    const out = (await transform(st, norm(join(dir, "src/lib/sound.ts")))).code;
    for (const spec of [mp3, txt, png]) {
      assertStringIncludes(out, `${NPM_PREFIX}${depSlug(spec)}.js`);
      assert(st.npmSpecs.has(spec), `noted by absolute path: ${spec}`);
    }
    assert(![...st.npmSpecs].some((s) => s.startsWith(".") || s.startsWith("~")));

    await ensureNpmBundle(st);
    const read = (spec: string) => Deno.readTextFileSync(join(st.npmDir, `${depSlug(spec)}.js`));
    // A file URL is absolute under the bundle's prefix (a relative one would resolve against the
    // page), and the file is there to serve.
    assert(new RegExp(`"${NPM_PREFIX}click-[\\w]+\\.mp3"`).test(read(mp3)), read(mp3));
    assert(new RegExp(`"${NPM_PREFIX}logo-[\\w]+\\.png"`).test(read(png)), read(png));
    assertStringIncludes(read(txt), "hello note");
    const emitted = [...Deno.readDirSync(st.npmDir)].map((e) => e.name);
    assert(emitted.some((n) => /^click-\w+\.mp3$/.test(n)), emitted.join(", "));
    assertEquals(emitted.filter((n) => /^logo-\w+\.png$/.test(n)).length, 1);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

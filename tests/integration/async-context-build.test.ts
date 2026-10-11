// `asyncContext: true` end to end, without a browser: the AsyncContext transform writes each
// instrumented client module into `.denext/asyncctx/`, so every module that copy imports must
// still resolve beside the ORIGINAL. A literal `import()` of an island used to resolve beside the
// copy instead (`Module not found .denext/asyncctx/island.tsx`) and failed the whole build. The
// app here (tests/e2e/fixtures/async-context, copied into a temp dir) reaches its modules through
// a literal and a template-literal `import()`, a stylesheet, JSON, a platform-file variant and a
// client island; it must build, export and serve. The browser half — the transition scope held
// inside the lazily imported module — is tests/e2e/async-context.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { copy } from "@std/fs";
import { runDeno, startCliServer } from "../e2e/harness.ts";

const FIXTURE = fromFileUrl(new URL("../e2e/fixtures/async-context", import.meta.url));
const abs = (p: string) => new URL(`../../${p}`, import.meta.url).href;
const CLI = fromFileUrl(abs("cli.ts"));

/**
 * Run a `denext` verb in `dir` through the real CLI: a client module that imports a stylesheet
 * is imported by the server too, which only the CLI's re-exec (its generated `--config`) can do.
 */
async function denext(dir: string, ...args: string[]): Promise<void> {
  const { ok, out } = await runDeno(["run", "-A", CLI, ...args], dir, 600_000);
  assert(ok, `denext ${args.join(" ")} failed:\n${out}`);
}

/** The fixture in a fresh temp dir, its `denext` imports made absolute (parallel-safe). */
async function fixtureCopy(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-asyncctx-" });
  await copy(join(FIXTURE, "app"), join(dir, "app"));
  await Deno.copyFile(join(FIXTURE, "denext.config.ts"), join(dir, "denext.config.ts"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  return dir;
}

/** Every `.js` file under `dir`, concatenated. */
async function allJs(dir: string): Promise<string> {
  let out = "";
  for await (const e of Deno.readDir(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) out += await allJs(path);
    else if (e.name.endsWith(".js")) out += await Deno.readTextFile(path);
  }
  return out;
}

/** The source of each instrumented copy the build wrote. */
async function asyncCopies(outDir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(outDir, "asyncctx"))) {
    if (e.isFile && e.name.startsWith("m_")) {
      out.push(await Deno.readTextFile(join(outDir, "asyncctx", e.name)));
    }
  }
  return out;
}

/** The instrumented copies re-root each relative specifier at the original module. */
function assertCopiesReRooted(copies: string[], appUrl: string): void {
  const loader = copies.find((c) => c.includes("loader.css"));
  assert(loader, "loader.tsx (it awaits) was instrumented");
  for (const spec of ["loader.css", "data.json", "tag.tsx", "lazy.tsx", "extra.ts"]) {
    assertStringIncludes(loader, JSON.stringify(`${appUrl}/${spec}`), `${spec} absolute`);
  }
  assert(!/["'`]\.\.?\//.test(loader), "no relative specifier is left in the copy");
  assertStringIncludes(loader, `with { type: "json" }`, "the import attribute is kept");
  const lazy = copies.find((c) => c.includes("__acStart"));
  assert(lazy, "the lazily imported lazy.tsx (it awaits) was instrumented");
  assertStringIncludes(lazy, "__asyncAwait(", "its `await gate` is bracketed");
}

Deno.test("asyncContext build: a dynamically imported island, CSS, JSON and a platform variant all resolve", async () => {
  const dir = await fixtureCopy();
  try {
    await denext(dir, "build", ".");
    const outDir = join(dir, ".denext");
    const appUrl = toFileUrl(await Deno.realPath(join(dir, "app"))).href;
    assertCopiesReRooted(await asyncCopies(outDir), appUrl);

    const js = await allJs(join(outDir, "client"));
    assertStringIncludes(js, "__acStart", "the lazy island's (instrumented) code is bundled");
    assertStringIncludes(js, "extra-ok", "the template-literal import() target is bundled");
    assertStringIncludes(js, "json-ok", "the JSON module is bundled");
    assert(!js.includes(`"plain"`), "the plain tag.tsx is replaced by its .web variant");

    const server = await startCliServer(dir, 120_000);
    try {
      const res = await fetch(server.origin + "/");
      const html = await res.text();
      assertEquals(res.status, 200);
      assertStringIncludes(html, "json-ok");
      assertStringIncludes(html, ">web</p>", "the server renders the .web variant too");
      assertStringIncludes(html, 'id="lazy-loading"', "the ssr:false island renders its loading");
      const css = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
      let styles = "";
      for (const href of css) styles += await (await fetch(new URL(href, server.origin))).text();
      assertStringIncludes(styles.replace(/\s/g, ""), "color:#010203", "loader.css is linked");
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("asyncContext export: the same module graph exports", async () => {
  const dir = await fixtureCopy();
  try {
    await denext(dir, "export", ".");
    const html = await Deno.readTextFile(join(dir, "out", "index.html"));
    assertStringIncludes(html, "json-ok");
    const js = await allJs(join(dir, "out"));
    assertStringIncludes(js, "__acStart", "the lazy island's code is exported");
    assertStringIncludes(js, "extra-ok", "the template-literal import() target is exported");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

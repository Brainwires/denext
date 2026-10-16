// The workspace packages @denext/denext pins at publish (scripts/lib/jsr-pins.ts), the
// `@denext/docs-corpus` version rules (scripts/lib/docs-corpus-package.ts) and the release
// script's refusal to tag while a pinned version is missing from JSR. JSR itself is faked.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  CORPUS_MODULE,
  CORPUS_PACKAGE,
  corpusVersion,
  moduleSourceHash,
  nextPatch,
  publishedSourceHash,
  releaseCorpusVersion,
  setCorpusVersion,
  versionAfterChange,
} from "../scripts/lib/docs-corpus-package.ts";
import { jsrHasVersion, memberPin, missingPins, RUNTIME_MEMBERS } from "../scripts/lib/jsr-pins.ts";
import { pinRefusal } from "../scripts/release.ts";
import { publishedFiles } from "./_published-files.ts";

/** A fake jsr.io: `versions` per package, `files` by URL path. */
function fakeJsr(
  versions: Record<string, string[]>,
  files: Record<string, string> = {},
): (url: string) => Promise<Response> {
  return (url) => {
    const path = new URL(url).pathname;
    const meta = /^\/(@[\w-]+\/[\w-]+)\/meta\.json$/.exec(path);
    if (meta) {
      const list = versions[meta[1]];
      if (!list) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(Response.json({
        versions: Object.fromEntries(list.map((v) => [v, {}])),
      }));
    }
    const body = files[path];
    return Promise.resolve(
      body === undefined ? new Response("", { status: 404 }) : new Response(body),
    );
  };
}

Deno.test("jsr pins: RUNTIME_MEMBERS are exactly the workspace members published code imports", async () => {
  const files = await publishedFiles();
  if (!files) return;
  const root = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const members = new Map<string, string>();
  for (const dir of root.workspace as string[]) {
    const json = JSON.parse(
      await Deno.readTextFile(new URL(`../${dir}/deno.json`, import.meta.url)),
    );
    members.set(json.name, dir.split("/").pop()!);
  }
  const imported = new Set<string>();
  const spec = /(?:from\s+|import\(\s*)["'](@denext\/[\w-]+)(?:\/[^"']*)?["']/g;
  for (const file of files.keys()) {
    if (!/\.(ts|tsx|js)$/.test(file)) continue;
    const text = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    for (const m of text.matchAll(spec)) {
      // A member the root import map pins explicitly (`jsr:@denext/swc@^76…`) resolves from JSR
      // already; only a workspace-resolved one takes its pin from the member's version.
      if (members.has(m[1]) && !(m[1] in root.imports)) imported.add(members.get(m[1])!);
    }
  }
  // Generated code text, not imports: migrate / codemod write these specifiers into an app.
  for (const textOnly of ["effect", "pages-router", "react-router"]) imported.delete(textOnly);
  assertEquals([...imported].sort(), [...RUNTIME_MEMBERS]);
});

Deno.test("jsr pins: a member's pin and tag come from its deno.json", async () => {
  const pin = await memberPin("docs-corpus");
  assertEquals(pin.name, CORPUS_PACKAGE);
  assertEquals(pin.version, await corpusVersion());
  assertEquals(pin.tag, `docs-corpus-v${pin.version}`);
});

Deno.test("jsr pins: jsrHasVersion reads meta.json; an unknown package has no versions", async () => {
  const jsr = fakeJsr({ "@denext/og": ["0.1.1", "0.1.2"] });
  assert(await jsrHasVersion("@denext/og", "0.1.2", jsr));
  assert(!await jsrHasVersion("@denext/og", "0.1.3", jsr));
  assert(!await jsrHasVersion("@denext/nope", "1.0.0", jsr));
  await assertRejects(
    () =>
      jsrHasVersion(
        "@denext/og",
        "0.1.2",
        () => Promise.resolve(new Response("", { status: 503 })),
      ),
    Error,
    "HTTP 503",
  );
});

Deno.test("jsr pins: missingPins lists each runtime member JSR lacks, with its tag", async () => {
  const pins = await Promise.all(RUNTIME_MEMBERS.map((dir) => memberPin(dir)));
  const all = Object.fromEntries(pins.map((p) => [p.name, [p.version]]));
  assertEquals(await missingPins(fakeJsr(all)), []);
  const { [CORPUS_PACKAGE]: _corpus, ...rest } = all;
  const missing = await missingPins(fakeJsr(rest));
  assertEquals(missing.map((p) => p.name), [CORPUS_PACKAGE]);
});

Deno.test("release: pinRefusal names every unpublished pin and its tag, or allows the tag", () => {
  assertEquals(pinRefusal([], "v9.0.0"), null);
  const refusal = pinRefusal(
    [{ name: CORPUS_PACKAGE, version: "0.1.4", tag: "docs-corpus-v0.1.4" }],
    "v9.0.0",
  )!;
  assertStringIncludes(refusal, "refusing to tag v9.0.0");
  assertStringIncludes(refusal, "@denext/docs-corpus@0.1.4 — push the tag docs-corpus-v0.1.4");
});

Deno.test("docs-corpus version: patch bumps, and a bump only once the version was released", () => {
  assertEquals(nextPatch("0.1.0"), "0.1.1");
  assertEquals(nextPatch("1.9.9-rc.2"), "1.9.10");
  assertEquals(versionAfterChange("0.1.3", ["v4.2.0", "docs-corpus-v0.1.2"]), null);
  assertEquals(versionAfterChange("0.1.3", ["docs-corpus-v0.1.3"]), "0.1.4");
});

Deno.test("docs-corpus version: the module's source hash, and setting the manifest's version", async () => {
  const text = await Deno.readTextFile(CORPUS_MODULE);
  assertEquals(moduleSourceHash(text)?.length, 64);
  assertEquals(moduleSourceHash('export const CORPUS_SOURCE_HASH = "abc123";'), "abc123");
  const dir = await Deno.makeTempDir();
  try {
    const manifest = `${dir}/deno.json`;
    await Deno.writeTextFile(
      manifest,
      '{\n  "name": "@denext/docs-corpus",\n  "version": "0.1.0"\n}\n',
    );
    await setCorpusVersion("0.1.1", manifest);
    assertEquals(
      await Deno.readTextFile(manifest),
      '{\n  "name": "@denext/docs-corpus",\n  "version": "0.1.1"\n}\n',
    );
    assertEquals(await corpusVersion(manifest), "0.1.1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docs-corpus version: the release bumps past a published version with other content", async () => {
  const version = await corpusVersion();
  const local = moduleSourceHash(await Deno.readTextFile(CORPUS_MODULE))!;
  const served = (hash: string) => `export const CORPUS_SOURCE_HASH: string = "${hash}";\n`;
  const path = `/${CORPUS_PACKAGE}/${version}/mod.ts`;
  // Not on JSR yet: this release publishes it.
  assertEquals(await releaseCorpusVersion(fakeJsr({})), null);
  assertEquals(await publishedSourceHash(version, fakeJsr({})), null);
  // On JSR with the same content: nothing to publish.
  const same = fakeJsr({ [CORPUS_PACKAGE]: [version] }, { [path]: served(local) });
  assertEquals(await publishedSourceHash(version, same), local);
  assertEquals(await releaseCorpusVersion(same), null);
  // On JSR with older content: the next patch JSR does not have.
  const next = nextPatch(version);
  const stale = fakeJsr({ [CORPUS_PACKAGE]: [version, next] }, { [path]: served("0".repeat(64)) });
  assertEquals(await releaseCorpusVersion(stale), nextPatch(next));
});

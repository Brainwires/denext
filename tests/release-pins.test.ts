// The workspace packages @denext/denext pins at publish (scripts/lib/jsr-pins.ts), the
// `@denext/docs-corpus` version rule (scripts/lib/docs-corpus-package.ts: denext X.Y.Z pins exactly
// @denext/docs-corpus X.Y.Z) and the release script's refusal to tag while a pinned version is
// missing from JSR. JSR itself is faked.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  CORPUS_MODULE,
  CORPUS_PACKAGE,
  corpusConflictMessage,
  corpusReleaseState,
  corpusVersion,
  moduleSourceHash,
  publishedSourceHash,
} from "../scripts/lib/docs-corpus-package.ts";
import {
  jsrHasVersion,
  memberPin,
  missingPins,
  RUNTIME_MEMBERS,
  SAME_VERSION_MEMBERS,
} from "../scripts/lib/jsr-pins.ts";
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
  const versions = new Map<string, string>();
  for (const dir of root.workspace as string[]) {
    const json = JSON.parse(
      await Deno.readTextFile(new URL(`../${dir}/deno.json`, import.meta.url)),
    );
    members.set(json.name, dir.split("/").pop()!);
    versions.set(json.name, json.version);
  }
  // A member the root import map pins explicitly (`jsr:@denext/swc@^76…`) resolves from JSR
  // already; one pinned to exactly its own version (`jsr:@denext/docs-corpus@<version>`) is
  // satisfied by the workspace member, so it is still released with denext.
  const workspaceResolved = (name: string) =>
    !(name in root.imports) || root.imports[name] === `jsr:${name}@${versions.get(name)}`;
  const imported = new Set<string>();
  const spec = /(?:from\s+|import\(\s*)["'](@denext\/[\w-]+)(?:\/[^"']*)?["']/g;
  for (const file of files.keys()) {
    if (!/\.(ts|tsx|js)$/.test(file)) continue;
    const text = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    for (const m of text.matchAll(spec)) {
      if (members.has(m[1]) && workspaceResolved(m[1])) imported.add(members.get(m[1])!);
    }
  }
  // Generated code text, not imports: migrate / codemod write these specifiers into an app.
  for (const textOnly of ["effect", "pages-router", "react-router", "tanstack-start"]) {
    imported.delete(textOnly);
  }
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

Deno.test("docs-corpus version: it is denext's version, and denext imports exactly that version", async () => {
  const root = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const corpus = await corpusVersion();
  assertEquals(
    corpus,
    root.version,
    "packages/docs-corpus/deno.json must carry denext's version (deno task bump moves both)",
  );
  // No caret: an older denext must never resolve a newer corpus. The workspace member satisfies
  // the exact specifier locally only while the versions match.
  assertEquals(root.imports[CORPUS_PACKAGE], `jsr:${CORPUS_PACKAGE}@${root.version}`);
});

Deno.test("ui version: denext's version, pinned exactly both ways", async () => {
  const root = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const ui = JSON.parse(
    await Deno.readTextFile(new URL("../packages/ui/deno.json", import.meta.url)),
  );
  assertEquals(ui.name, "@denext/ui");
  assertEquals(ui.version, root.version, "deno task bump moves @denext/ui with denext");
  // denext X.Y.Z loads exactly @denext/ui X.Y.Z, which imports exactly @denext/denext X.Y.Z: the
  // UI is built on denext's internals (`internal/ui-host`), so the pair must never mix versions.
  assertEquals(root.imports["@denext/ui"], `jsr:@denext/ui@${root.version}`);
  assertEquals(ui.imports["@denext/denext"], `jsr:@denext/denext@${root.version}`);
  assertEquals(root.exports["./internal/ui-host"], "./src/ui/host.ts");
  assert(SAME_VERSION_MEMBERS.includes("ui") && RUNTIME_MEMBERS.includes("ui"));
});

Deno.test("migrate version: denext's version, pinned exactly both ways", async () => {
  const root = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const migrate = JSON.parse(
    await Deno.readTextFile(new URL("../packages/migrate/deno.json", import.meta.url)),
  );
  assertEquals(migrate.name, "@denext/migrate");
  assertEquals(migrate.version, root.version, "deno task bump moves @denext/migrate with denext");
  // denext X.Y.Z loads exactly @denext/migrate X.Y.Z, which imports exactly @denext/denext X.Y.Z
  // (its `internal/migrate-host` export), so the pair never mixes versions.
  assertEquals(root.imports["@denext/migrate"], `jsr:@denext/migrate@${root.version}`);
  assertEquals(migrate.imports["@denext/denext"], `jsr:@denext/denext@${root.version}`);
  assertEquals(root.exports["./internal/migrate-host"], "./src/build/migrate-host.ts");
  assert(SAME_VERSION_MEMBERS.includes("migrate") && RUNTIME_MEMBERS.includes("migrate"));
});

Deno.test("docs-corpus version: the module's source hash, and the manifest's version", async () => {
  const text = await Deno.readTextFile(CORPUS_MODULE);
  assertEquals(moduleSourceHash(text)?.length, 64);
  assertEquals(moduleSourceHash('export const CORPUS_SOURCE_HASH = "abc123";'), "abc123");
  const dir = await Deno.makeTempDir();
  try {
    const manifest = `${dir}/deno.json`;
    await Deno.writeTextFile(
      manifest,
      '{\n  "name": "@denext/docs-corpus",\n  "version": "4.3.0-rc.1"\n}\n',
    );
    assertEquals(await corpusVersion(manifest), "4.3.0-rc.1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docs-corpus version: the release publishes its own version, or refuses a conflicting one", async () => {
  const version = await corpusVersion();
  const local = moduleSourceHash(await Deno.readTextFile(CORPUS_MODULE))!;
  const served = (hash: string) => `export const CORPUS_SOURCE_HASH: string = "${hash}";\n`;
  const path = `/${CORPUS_PACKAGE}/${version}/mod.ts`;
  // Not on JSR yet: this release publishes it.
  assertEquals(await corpusReleaseState(version, fakeJsr({})), { state: "missing", version });
  assertEquals(await publishedSourceHash(version, fakeJsr({})), null);
  // On JSR with the same content (a resumed release): nothing to publish.
  const same = fakeJsr({ [CORPUS_PACKAGE]: [version] }, { [path]: served(local) });
  assertEquals(await publishedSourceHash(version, same), local);
  assertEquals(await corpusReleaseState(version, same), { state: "published", version });
  // On JSR with other content: a conflict, never another version (a newer one JSR lacks too).
  const other = "0".repeat(64);
  const stale = fakeJsr({ [CORPUS_PACKAGE]: [version] }, { [path]: served(other) });
  const conflict = await corpusReleaseState(version, stale);
  assertEquals(conflict, { state: "conflict", version, local, published: other });
  if (conflict.state !== "conflict") throw new Error("unreachable");
  const message = corpusConflictMessage(conflict);
  assertStringIncludes(message, `${CORPUS_PACKAGE}@${version} with another corpus`);
  assertStringIncludes(message, other);
  // A corpus that is not at the release's version is refused before JSR is asked.
  await assertRejects(
    () => corpusReleaseState(`${version}-other.1`, fakeJsr({})),
    Error,
    "the bump moves both",
  );
});

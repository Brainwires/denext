// The over-the-air UI manifest: the pinned version algorithm (src/mobile/ota-manifest.ts),
// the directory walk that writes `_denext/ota.json` (src/build/ota-manifest.ts), the
// `denext ota manifest` verb, and `createOtaHandler`'s serving rules (src/server/ota-handler.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  isExcludedFromOtaManifest,
  isOtaManifest,
  makeOtaManifest,
  OTA_MANIFEST_PATH,
  OTA_NOTES_MAX_LENGTH,
  otaManifestVersion,
  sha256Hex,
} from "../src/mobile/ota-manifest.ts";
import { collectOtaManifest, writeOtaManifest } from "../src/build/ota-manifest.ts";
import { createOtaHandler } from "../src/server/ota-handler.ts";
import { buildRegistry } from "../src/cli/register.ts";

const encoder = new TextEncoder();

// Pinned: the build stamp, every server and every installed app compare versions derived by
// this algorithm, and an installed app compares against stamps written by older builds.
// Changing the output here makes every phone re-download a UI it already has. (The same
// fixture pins the T3 Code prototype this algorithm was ported from.)
const INDEX_HTML_SHA = "b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628";
const APP_JS_SHA = "0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393";
const FIXTURE_VERSION = "ea8c7ce6dad4c988f73137f27a971e6840a0b5343fb10ce7a7fc6b5648372a9f";

Deno.test("ota manifest: hashes file bytes as lowercase hex SHA-256", async () => {
  assertEquals(await sha256Hex(encoder.encode("<html></html>")), INDEX_HTML_SHA);
  assertEquals(await sha256Hex(encoder.encode("console.log(1)")), APP_JS_SHA);
});

Deno.test("ota manifest: versions the sorted path/sha lines, independent of input order", async () => {
  const files = [
    { path: "index.html", sha256: INDEX_HTML_SHA },
    { path: "_denext/client/app.js", sha256: APP_JS_SHA },
  ];
  assertEquals(await otaManifestVersion(files), FIXTURE_VERSION);
  assertEquals(await otaManifestVersion(files.toReversed()), FIXTURE_VERSION);
  // By construction: SHA-256 over "<path>\t<sha>\n" lines in path order.
  const lines = `_denext/client/app.js\t${APP_JS_SHA}\nindex.html\t${INDEX_HTML_SHA}\n`;
  assertEquals(await sha256Hex(encoder.encode(lines)), FIXTURE_VERSION);
});

Deno.test("ota manifest: any changed file changes the version", async () => {
  const changed = await otaManifestVersion([
    { path: "index.html", sha256: INDEX_HTML_SHA },
    { path: "_denext/client/app.js", sha256: INDEX_HTML_SHA },
  ]);
  assert(changed !== FIXTURE_VERSION);
});

Deno.test("ota manifest: makeOtaManifest sorts by path and stamps the version", async () => {
  const manifest = await makeOtaManifest([
    { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
    { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
  ]);
  assertEquals(manifest.version, FIXTURE_VERSION);
  assertEquals(manifest.files.map((f) => f.path), ["_denext/client/app.js", "index.html"]);
});

Deno.test("ota manifest: leaves out .gz siblings and the manifest itself", () => {
  assertEquals(OTA_MANIFEST_PATH, "_denext/ota.json");
  assert(isExcludedFromOtaManifest("_denext/client/app.js.gz"));
  assert(isExcludedFromOtaManifest("_denext/ota.json"));
  assert(!isExcludedFromOtaManifest("_denext/client/app.js"));
  assert(!isExcludedFromOtaManifest("index.html"));
  assert(!isExcludedFromOtaManifest("nested/_denext/ota.json"));
});

Deno.test("ota manifest: isOtaManifest checks the shape", () => {
  const file = { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 };
  assert(isOtaManifest({ version: FIXTURE_VERSION, files: [file] }));
  assert(!isOtaManifest(null));
  assert(!isOtaManifest({ version: "not-hex", files: [file] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION.toUpperCase(), files: [file] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, size: -1 }] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, size: 1.5 }] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, path: "" }] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, sha256: "x" }] }));
});

Deno.test("ota manifest: required/notes are carried but never change the version", async () => {
  const files = [
    { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
    { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
  ];
  const plain = await makeOtaManifest(files);
  assert(!("required" in plain) && !("notes" in plain), "no metadata keys unless given");
  const tagged = await makeOtaManifest(files, { required: true, notes: "Fixes sign-in" });
  assertEquals(tagged.version, FIXTURE_VERSION);
  assertEquals(tagged.required, true);
  assertEquals(tagged.notes, "Fixes sign-in");
  assertEquals((await makeOtaManifest(files, { required: false })).required, false);
  assertEquals(OTA_NOTES_MAX_LENGTH, 2000);
  await makeOtaManifest(files, { notes: "x".repeat(OTA_NOTES_MAX_LENGTH) });
  await assertRejects(
    () => makeOtaManifest(files, { notes: "x".repeat(OTA_NOTES_MAX_LENGTH + 1) }),
    RangeError,
    "limit is 2000",
  );
});

Deno.test("ota manifest: isOtaManifest checks required/notes and tolerates unknown keys", () => {
  const base = {
    version: FIXTURE_VERSION,
    files: [{ path: "index.html", sha256: INDEX_HTML_SHA, size: 13 }],
  };
  assert(isOtaManifest({ ...base, required: true, notes: "hi" }));
  assert(isOtaManifest({ ...base, required: false, notes: "" }));
  assert(isOtaManifest({ ...base, notes: "x".repeat(OTA_NOTES_MAX_LENGTH) }));
  assert(isOtaManifest({ ...base, somethingNew: 1 }));
  assert(!isOtaManifest({ ...base, required: "true" }));
  assert(!isOtaManifest({ ...base, required: null }));
  assert(!isOtaManifest({ ...base, notes: 1 }));
  assert(!isOtaManifest({ ...base, notes: null }));
  assert(!isOtaManifest({ ...base, notes: "x".repeat(OTA_NOTES_MAX_LENGTH + 1) }));
});

/** A web root with the two fixture files, a .gz sibling and a stale manifest. */
async function webRoot(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_" });
  await Deno.writeTextFile(join(dir, "index.html"), "<html></html>");
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "_denext", "client", "app.js"), "console.log(1)");
  await Deno.writeTextFile(join(dir, "_denext", "client", "app.js.gz"), "gz bytes");
  await Deno.writeTextFile(join(dir, "_denext", "ota.json"), "{stale}");
  return dir;
}

Deno.test("writeOtaManifest: walks the web root and writes _denext/ota.json", async () => {
  const dir = await webRoot();
  try {
    const manifest = await writeOtaManifest(dir);
    assertEquals(manifest, {
      version: FIXTURE_VERSION,
      files: [
        { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
        { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
      ],
    });
    const written = JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json")));
    assertEquals(written, manifest);
    // Rewriting is stable: the manifest never covers itself.
    assertEquals(await collectOtaManifest(dir), manifest);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeOtaManifest: refuses a directory without index.html", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_noindex_" });
  try {
    await assertRejects(() => writeOtaManifest(dir), Error, "has no index.html");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota manifest <dir> (re)writes the manifest", async () => {
  const dir = await webRoot();
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("ota")!.run({
      positionals: ["manifest", dir],
      flags: {},
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
    const written = JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json")));
    assertEquals(written.version, FIXTURE_VERSION);
    assert(lines.some((l) => l.includes(FIXTURE_VERSION)), lines.join("\n"));
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota manifest --required --notes writes the metadata; omitted flags omit the keys", async () => {
  const dir = await webRoot();
  const log = console.log;
  console.log = () => {};
  const run = (flags: Record<string, string | boolean>) =>
    buildRegistry().get("ota")!.run({
      positionals: ["manifest", dir],
      flags,
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  const written = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json"))) as Record<
      string,
      unknown
    >;
  try {
    await run({ required: true, notes: "Fixes sign-in" });
    const tagged = await written();
    assertEquals(tagged.version, FIXTURE_VERSION);
    assertEquals(tagged.required, true);
    assertEquals(tagged.notes, "Fixes sign-in");
    assert(isOtaManifest(tagged));

    await run({ notes: "Just notes" });
    const notesOnly = await written();
    assert(!("required" in notesOnly), JSON.stringify(notesOnly));
    assertEquals(notesOnly.notes, "Just notes");

    await run({});
    const plain = await written();
    assert(!("required" in plain) && !("notes" in plain), JSON.stringify(plain));
    assertEquals(plain.version, FIXTURE_VERSION);
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota: --required and --notes are declared flags", () => {
  const flags = buildRegistry().get("ota")!.flags ?? [];
  assertEquals(
    flags.map((f) => [f.name, f.type]),
    [["required", "boolean"], ["notes", "string"]],
  );
});

Deno.test("createOtaHandler: serves the manifest and only the files it lists, no-store", async () => {
  const dir = await webRoot();
  try {
    await writeOtaManifest(dir);
    await Deno.writeTextFile(join(dir, "later.txt"), "added after the manifest");
    const ota = createOtaHandler({ dir, basePath: "/ui/" });
    const get = (path: string, method = "GET") =>
      ota(new Request(`http://host${path}`, { method }));

    const manifest = await get("/ui/_denext/ota.json");
    assertEquals(manifest?.status, 200);
    assertEquals(manifest?.headers.get("cache-control"), "no-store");
    assert(isOtaManifest(await manifest!.json()));

    const app = await get("/ui/_denext/client/app.js");
    assertEquals(await app?.text(), "console.log(1)");
    assertEquals(app?.headers.get("cache-control"), "no-store");
    assertEquals(app?.headers.get("content-type")?.split(";")[0], "text/javascript");
    const head = await get("/ui/index.html", "HEAD");
    assertEquals(head?.status, 200);
    assertEquals(await head?.text(), "");

    // A file written after the stamp, the .gz sibling, a traversal and anything outside the
    // base path or not GET/HEAD are not the handler's.
    assertEquals(await get("/ui/later.txt"), null);
    assertEquals(await get("/ui/_denext/client/app.js.gz"), null);
    assertEquals(await get("/ui/../index.html"), null);
    assertEquals(await get("/index.html"), null);
    assertEquals(await get("/ui/index.html", "POST"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createOtaHandler: nothing is served without a manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_none_" });
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<html></html>");
    const ota = createOtaHandler({ dir });
    assertEquals(await ota(new Request("http://host/index.html")), null);
    assertEquals(await ota(new Request("http://host/_denext/ota.json")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

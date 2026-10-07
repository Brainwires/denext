// Vendor what earlier releases' native installers WROTE into an app, so the upgrade tests
// (tests/mobile-add-ota.test.ts, tests/mobile-add-main-activity.test.ts, tests/ota-reverify.test.ts)
// run from a committed fixture instead of `git show <tag>:…`. CI checks out without tags, so a
// tag-dependent test was silently ignored there; a released tag never changes, so its output is
// captured once and committed.
//
//   deno run -A scripts/gen-release-template-fixtures.ts     # needs the release tags locally
//
// Add a release to the lists below when a later test needs its templates, then re-run. Writes
// tests/fixtures/release-templates.json: each text once (`blobs`, by SHA-256), referenced by hash.

import { join } from "@std/path";
import { sha256Text } from "../src/build/native-template-marker.ts";

const ROOT = new URL("../", import.meta.url);
/** Where the fixture is committed. */
export const RELEASE_TEMPLATES_OUT = new URL("tests/fixtures/release-templates.json", ROOT);

/** Releases whose raw OTA templates (`OTA_IOS_FILES` + `OTA_ANDROID_FILES`) are kept. */
const OTA_RAW_TAGS = ["v2.7.0", "v2.7.1", "v2.8.0", "v2.8.1", "v2.8.2", "v2.8.3"];
/** Releases whose rendered (marker-line) OTA templates are kept. */
const OTA_WRITTEN_TAGS = ["v2.10.0-rc.2", "v3.2.0"];
/** Releases whose OTA-only `preparedMainActivity` (with a `${pkg}` placeholder) is kept. */
const MAIN_ACTIVITY_PREPARED_TAGS = [
  "v2.7.0",
  "v2.7.1",
  "v2.8.0",
  "v2.8.1",
  "v2.8.2",
  "v2.8.3",
  "v2.9.0",
];
/** Releases whose composed `mainActivitySource` (every feature combination) is kept. */
const MAIN_ACTIVITY_COMPOSED_TAGS = ["v2.10.0-rc.1", "v2.10.0-rc.2", "v2.10.0-rc.3"];
/** The package the composed activities are rendered for (the one the test upgrades). */
export const MAIN_ACTIVITY_PACKAGE = "com.brainwires.t3code";

/** The fixture's shape (every text is a key into `blobs`). */
export interface ReleaseTemplates {
  "//": string;
  blobs: Record<string, string>;
  otaRaw: Record<string, Record<string, string>>;
  otaWritten: Record<string, { generation: number; files: Record<string, string> }>;
  mainActivityPrepared: Record<string, string>;
  mainActivityComposed: Record<string, Array<{ set: string[]; text: string }>>;
}

async function git(args: string[]): Promise<Uint8Array> {
  const out = await new Deno.Command("git", { args, cwd: ROOT, stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return out.stdout;
}

const showAt = async (tag: string, path: string) =>
  new TextDecoder().decode(await git(["show", `${tag}:${path}`]));

/** Import `source` (a module at a tag) from a temp file, its `./` imports pointed at this checkout. */
async function importAt(source: string): Promise<Record<string, unknown>> {
  const build = new URL("src/build/", ROOT).href;
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(file, source.replaceAll(`from "./`, `from "${build}`));
    return await import(`file://${file}`);
  } finally {
    await Deno.remove(file);
  }
}

/** Each text once, by SHA-256: `keep` stores one and returns its key. */
class Blobs {
  readonly texts: Record<string, string> = {};
  async keep(text: string): Promise<string> {
    const key = await sha256Text(text);
    this.texts[key] = text;
    return key;
  }
}

/** `OTA_IOS_FILES` + `OTA_ANDROID_FILES` of an OTA templates module. */
const otaFiles = (mod: Record<string, unknown>) =>
  ({ ...mod.OTA_IOS_FILES as object, ...mod.OTA_ANDROID_FILES as object }) as Record<
    string,
    string
  >;

async function otaRawAt(tag: string, blobs: Blobs): Promise<Record<string, string>> {
  const mod = await importAt(await showAt(tag, "src/build/ota-native-templates.ts"));
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(otaFiles(mod))) out[name] = await blobs.keep(text);
  return out;
}

async function otaWrittenAt(
  tag: string,
  blobs: Blobs,
): Promise<{ generation: number; files: Record<string, string> }> {
  const mod = await importAt(await showAt(tag, "src/build/ota-native-templates.ts"));
  const render = mod.renderOtaTemplate as (text: string) => Promise<string>;
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(otaFiles(mod))) {
    files[name] = await blobs.keep(await render(text));
  }
  return { generation: mod.OTA_TEMPLATE_VERSION as number, files };
}

async function preparedMainActivityAt(tag: string, blobs: Blobs): Promise<string> {
  const src = await showAt(tag, "src/build/mobile-ota-install.ts");
  const m = /function preparedMainActivity\(pkg: string\): string \{\n {2}return `([\s\S]*?)`;\n\}/
    .exec(src);
  if (!m) throw new Error(`${tag}: no preparedMainActivity`);
  return await blobs.keep(m[1]);
}

/** `src/build` at `tag`, extracted into `dir`. */
async function extractBuildAt(tag: string, dir: string): Promise<void> {
  const tar = await git(["archive", tag, "src/build"]);
  const untar = new Deno.Command("tar", { args: ["-x", "-C", dir], stdin: "piped" }).spawn();
  const w = untar.stdin.getWriter();
  await w.write(tar);
  await w.close();
  if (!(await untar.status).success) throw new Error(`untar ${tag}`);
}

async function composedMainActivitiesAt(
  tag: string,
  blobs: Blobs,
): Promise<Array<{ set: string[]; text: string }>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_main_activity_tag_" });
  try {
    await extractBuildAt(tag, dir);
    const file = join(dir, "src/build/mobile-native-install.ts");
    const src = await Deno.readTextFile(file);
    const order = JSON.parse(
      /const FEATURE_ORDER[^=]*= (\[[\s\S]*?\]);/.exec(src)![1].replace(/,\s*\]/, "]"),
    ) as string[];
    const mod = await import(`file://${file}`);
    const out: Array<{ set: string[]; text: string }> = [];
    for (let mask = 1; mask < 1 << order.length; mask++) {
      const set = order.filter((_, i) => mask & (1 << i));
      const text = await mod.mainActivitySource(MAIN_ACTIVITY_PACKAGE, new Set(set));
      out.push({ set, text: await blobs.keep(text) });
    }
    return out;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** `fn(tag)` for each of `tags`, as `{ tag: result }`. */
async function byTag<T>(
  tags: string[],
  fn: (tag: string) => Promise<T>,
): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const tag of tags) out[tag] = await fn(tag);
  return out;
}

export async function generateReleaseTemplates(): Promise<ReleaseTemplates> {
  const blobs = new Blobs();
  const otaRaw = await byTag(OTA_RAW_TAGS, (t) => otaRawAt(t, blobs));
  const otaWritten = await byTag(OTA_WRITTEN_TAGS, (t) => otaWrittenAt(t, blobs));
  const mainActivityPrepared = await byTag(
    MAIN_ACTIVITY_PREPARED_TAGS,
    (t) => preparedMainActivityAt(t, blobs),
  );
  const mainActivityComposed = await byTag(
    MAIN_ACTIVITY_COMPOSED_TAGS,
    (t) => composedMainActivitiesAt(t, blobs),
  );
  return {
    "//": "Generated by scripts/gen-release-template-fixtures.ts from the release tags: what " +
      "earlier releases' native installers wrote. Do not edit; re-run the script.",
    blobs: Object.fromEntries(
      Object.entries(blobs.texts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    otaRaw,
    otaWritten,
    mainActivityPrepared,
    mainActivityComposed,
  };
}

if (import.meta.main) {
  const fixture = await generateReleaseTemplates();
  await Deno.writeTextFile(RELEASE_TEMPLATES_OUT, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${RELEASE_TEMPLATES_OUT.pathname} (${Object.keys(fixture.blobs).length} texts)`,
  );
}

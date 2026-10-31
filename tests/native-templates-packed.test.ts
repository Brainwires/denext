// The native templates ship packed (src/build/native-templates.packed.ts: Brotli + base64,
// generated from the readable sources under src/build/native-templates/, which are not
// published). Every record must decode byte-for-byte to its source, key order included, and
// the published modules must hand out those same texts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { templateGroups } from "../scripts/gen-native-templates.ts";
import { packTexts } from "../scripts/lib/pack-texts.ts";
import { NATIVE_TEMPLATES } from "../src/build/native-templates.packed.ts";
import { packedRecords } from "../src/build/packed-text.ts";
import { OTA_ANDROID_FILES, OTA_IOS_FILES } from "../src/build/ota-native-templates.ts";
import { NATIVE_VIEWS_IOS_FILES } from "../src/build/native-views-native-templates.ts";
import { WIDGETS_ANDROID_FILES } from "../src/build/widget-native-templates.ts";
import * as otaSource from "../src/build/native-templates/ota.ts";
import * as nativeViewsSource from "../src/build/native-templates/native-views.ts";
import * as widgetSource from "../src/build/native-templates/widget.ts";

Deno.test("packed native templates: every record decodes to its source (run `deno task gen:native-templates`)", async () => {
  const sources = await templateGroups();
  const packed = NATIVE_TEMPLATES as unknown as Record<string, Record<string, object>>;
  assertEquals(Object.keys(packed).sort(), Object.keys(sources).sort(), "the groups");
  for (const [group, records] of Object.entries(sources)) {
    assertEquals(
      Object.keys(packed[group]).sort(),
      Object.keys(records).sort(),
      `${group}'s records`,
    );
    for (const [name, record] of Object.entries(records)) {
      const decoded = packed[group][name] as Record<string, string>;
      assertEquals(Object.keys(decoded), Object.keys(record), `${group}.${name}'s file order`);
      for (const [file, text] of Object.entries(record)) {
        assert(decoded[file] === text, `${group}.${name}["${file}"] differs from its source`);
      }
    }
  }
});

Deno.test("packed native templates: the published modules read the packed texts", () => {
  assertEquals({ ...OTA_IOS_FILES }, { ...otaSource.OTA_IOS_FILES });
  assertEquals({ ...OTA_ANDROID_FILES }, { ...otaSource.OTA_ANDROID_FILES });
  assertEquals({ ...NATIVE_VIEWS_IOS_FILES }, { ...nativeViewsSource.NATIVE_VIEWS_IOS_FILES });
  assertEquals({ ...WIDGETS_ANDROID_FILES }, { ...widgetSource.WIDGETS_ANDROID_FILES });
});

Deno.test("packedRecords: lazy, ordered, read-only records and a clear error for a missing text", () => {
  const groups = { g: { R: { "b.swift": "B\n", "a.java": "A ${x} \\`\n" } } };
  const { layout, packed } = packTexts(groups);
  const records = packedRecords(layout, packed);
  assertEquals(Object.keys(records.g.R), ["b.swift", "a.java"]);
  assertEquals<Record<string, string>>({ ...records.g.R }, groups.g.R);
  assertThrows(() => {
    (records.g.R as Record<string, string>)["a.java"] = "x";
  }, TypeError);
  const broken = packedRecords({ g: { R: ["missing.swift"] } }, packed);
  assertThrows(() => broken.g.R["missing.swift"], Error, 'g.R["missing.swift"] is missing');
  // Nothing decodes until a text is read: a bad pack throws only on the first read.
  const bad = packedRecords({ g: { R: ["x"] } }, "not-brotli");
  assertThrows(() => bad.g.R.x);
});

Deno.test("packed native templates: a checkout outside its workspace reads its own pack, never a docs-corpus release", async () => {
  // An app that links a denext checkout by path, or CI running the checkout's CLI from another
  // directory, resolves `@denext/docs-corpus` through its own import map: a JSR release, which
  // for an unreleased commit lacks that commit's pack, or is younger than Deno's minimum
  // dependency age. The layout module must read the checkout's file instead. Here the corpus maps
  // to a version that does not exist, so any read through it fails the import.
  const root = new URL("../", import.meta.url);
  const dir = await Deno.makeTempDir({ prefix: "denext_native_pack_" });
  try {
    const copy = async (file: string) => {
      const to = join(dir, ...file.split("/"));
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.copyFile(new URL(file, root), to);
    };
    await copy("src/build/native-templates.packed.ts");
    await copy("src/build/checkout-file.ts");
    await copy("src/build/packed-text.ts");
    await copy("packages/docs-corpus/native-templates.ts");
    const imports = JSON.parse(await Deno.readTextFile(new URL("deno.json", root))).imports;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "@std/encoding": imports["@std/encoding"],
          "@std/encoding/": `${imports["@std/encoding"].replace(/^jsr:/, "jsr:/")}/`,
          "@denext/docs-corpus": "jsr:@denext/docs-corpus@0.0.0-unpublished.0",
          "@denext/docs-corpus/": "jsr:/@denext/docs-corpus@0.0.0-unpublished.0/",
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "probe.ts"),
      'import { NATIVE_TEMPLATES } from "./src/build/native-templates.packed.ts";\n' +
        "console.log(JSON.stringify(Object.keys(NATIVE_TEMPLATES.ota.OTA_IOS_FILES)));\n",
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-lock", "--config", join(dir, "deno.json"), join(dir, "probe.ts")],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const decoder = new TextDecoder();
    assert(out.success, decoder.decode(out.stderr));
    assertEquals(JSON.parse(decoder.decode(out.stdout)), Object.keys(otaSource.OTA_IOS_FILES));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("packed native templates: a vendored @denext/denext reads the docs-corpus package, not a checkout path", async () => {
  // `"vendor": true` copies @denext/denext to vendor/jsr.io/@denext/denext/<version>/: a `file:`
  // module, but no checkout, so there is no packages/docs-corpus beside it. The layout module must
  // import `@denext/docs-corpus/native-templates` (vendored beside it, mapped here to the
  // workspace's package) instead of a path that is not there.
  const root = new URL("../", import.meta.url);
  const dir = await Deno.makeTempDir({ prefix: "denext_native_pack_vendor_" });
  try {
    const pkg = join(dir, "vendor", "jsr.io", "@denext", "denext", "9.9.9");
    for (const file of ["native-templates.packed.ts", "checkout-file.ts", "packed-text.ts"]) {
      await Deno.mkdir(join(pkg, "src", "build"), { recursive: true });
      await Deno.copyFile(new URL(`src/build/${file}`, root), join(pkg, "src", "build", file));
    }
    const imports = JSON.parse(await Deno.readTextFile(new URL("deno.json", root))).imports;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "@std/encoding": imports["@std/encoding"],
          "@std/encoding/": `${imports["@std/encoding"].replace(/^jsr:/, "jsr:/")}/`,
          "@denext/docs-corpus/native-templates":
            new URL("packages/docs-corpus/native-templates.ts", root).href,
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "probe.ts"),
      `import { NATIVE_TEMPLATES } from "./vendor/jsr.io/@denext/denext/9.9.9/src/build/native-templates.packed.ts";\n` +
        "console.log(JSON.stringify(Object.keys(NATIVE_TEMPLATES.ota.OTA_IOS_FILES)));\n",
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-lock", "--config", join(dir, "deno.json"), join(dir, "probe.ts")],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const decoder = new TextDecoder();
    assert(out.success, decoder.decode(out.stderr));
    assertEquals(JSON.parse(decoder.decode(out.stdout)), Object.keys(otaSource.OTA_IOS_FILES));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

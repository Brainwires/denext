// The native templates ship packed (src/build/native-templates.packed.ts: Brotli + base64,
// generated from the readable sources under src/build/native-templates/, which are not
// published). Every record must decode byte-for-byte to its source, key order included, and
// the published modules must hand out those same texts.

import { assert, assertEquals, assertThrows } from "@std/assert";
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

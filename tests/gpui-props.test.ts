// denext/gpui's NTB1 id table: src/gpui/props.json is the byte-for-byte copy of the canonical
// table (thalora-web-browser docs/b1-props.json, pinned by hash in scripts/gen-gpui-props.ts), and
// src/gpui/props.generated.ts is what the generator makes of it. Ids are never renumbered: the
// spec's fixed numbers are asserted here too.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  CANONICAL,
  generatePropsModule,
  PROPS_JSON,
  PROPS_TS,
  renderPropsModule,
  sha256Hex,
} from "../scripts/gen-gpui-props.ts";
import {
  ENUM,
  KIND,
  LISTEN,
  NTB_VERSION,
  PROP,
  PROPS_JSON_SHA256,
  STYLE_PROP,
} from "../src/gpui/props.generated.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

Deno.test("props.json is the pinned canonical copy, unmodified", async () => {
  const bytes = await Deno.readFile(`${ROOT}${PROPS_JSON}`);
  assertEquals(await sha256Hex(bytes), CANONICAL.sha256);
  assertEquals(PROPS_JSON_SHA256, CANONICAL.sha256);
});

Deno.test("props.generated.ts is current (deno task gen:gpui-props)", async () => {
  assertEquals(await Deno.readTextFile(`${ROOT}${PROPS_TS}`), await generatePropsModule(ROOT));
});

Deno.test("the generated table names its source and matches the JSON", async () => {
  const text = await Deno.readTextFile(`${ROOT}${PROPS_TS}`);
  assertStringIncludes(text, "thalora-web-browser `docs/b1-props.json` @ 7debb58");
  const json = JSON.parse(await Deno.readTextFile(`${ROOT}${PROPS_JSON}`));
  assertEquals(NTB_VERSION, json.version);
  assertEquals({ ...KIND }, json.kinds);
  assertEquals({ ...STYLE_PROP }, json.style);
  assertEquals({ ...PROP }, json.props);
  assertEquals(JSON.parse(JSON.stringify(ENUM)), json.enums);
  assertEquals({ ...LISTEN }, json.listen);
});

Deno.test("the spec's fixed ids", () => {
  assertEquals(KIND, {
    View: 1,
    Text: 2,
    RawText: 3,
    Image: 4,
    ScrollView: 5,
    TextInput: 6,
    Pressable: 7,
  });
  assertEquals(LISTEN, { press: 1, layout: 2, scroll: 4, focus: 8, text: 16, key: 32, image: 64 });
  assertEquals([STYLE_PROP.display, STYLE_PROP.textDecorationLine], [1, 58]);
  assertEquals([PROP.value, PROP.eventCount, PROP.placeholderTextColor], [1, 6, 14]);
});

Deno.test("an edited copy is refused, with the way out", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/src/gpui`, { recursive: true });
    const bytes = await Deno.readFile(`${ROOT}${PROPS_JSON}`);
    await Deno.writeFile(`${dir}/${PROPS_JSON}`, new Uint8Array([...bytes, 0x0a]));
    await assertRejects(() => generatePropsModule(`${dir}/`), Error, "Copy the canonical file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderPropsModule quotes keys that are not identifiers", () => {
  const text = renderPropsModule({
    version: 1,
    kinds: { View: 1 },
    style: {},
    props: {},
    enums: { flexDirection: { "row-reverse": 2 } },
    listen: {},
  }, "abc");
  assertStringIncludes(text, '"row-reverse": 2,');
  assertStringIncludes(text, "(sha256 abc)");
});

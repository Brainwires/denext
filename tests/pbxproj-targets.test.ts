// The pbxproj target editors (src/build/pbxproj.ts: addNativeTarget, addEmbedPhase,
// addTargetDependency, addTargetBuildSetting, targetBuildSetting, addSourceFiles' `group`)
// against the real Capacitor 8 project file (tests/fixtures/capacitor8/project.pbxproj, from the
// T3 Code Capacitor shell). Each result is parsed back with an independent old-style plist
// parser: every object id is unique, every id the file mentions is an object, and the new target
// is referenced from the project, the Products group, the app's embed phase and its dependency.
// Every editor is idempotent.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  addEmbedPhase,
  addNativeTarget,
  addSourceFiles,
  addTargetBuildSetting,
  addTargetDependency,
  applicationTargetName,
  type NativeTargetSpec,
  targetBuildSetting,
} from "../src/build/pbxproj.ts";

const FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

/** Deterministic ids: 24-hex counters that cannot collide with the fixture's. */
function counterIds(start = 0xE00000): () => string {
  let n = start;
  return () => (n++).toString(16).toUpperCase().padStart(24, "0");
}

// ---- an independent OpenStep (old-style) plist parser ----------------------------------------

type PValue = string | PValue[] | PDict;
interface PDict {
  [key: string]: PValue;
}

/** An old-style plist reader over `text`, from offset `i`. */
class PlistReader {
  i = 0;
  constructor(readonly text: string) {}

  /** Skip whitespace, a `//` line and block comments. */
  skip(): void {
    for (;;) {
      while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i++;
      if (this.text.startsWith("//", this.i)) {
        this.i = this.text.indexOf("\n", this.i) + 1 || this.text.length;
      } else if (this.text.startsWith("/*", this.i)) this.i = this.text.indexOf("*/", this.i) + 2;
      else return;
    }
  }

  expect(c: string): void {
    this.skip();
    if (this.text[this.i] !== c) throw new Error(`expected ${c} at ${this.i}`);
    this.i++;
  }

  /** Whether the next token is `c` (consumed when it is). */
  take(c: string): boolean {
    this.skip();
    if (this.text[this.i] !== c) return false;
    this.i++;
    return true;
  }

  dict(): PDict {
    const dict: PDict = {};
    while (!this.take("}")) {
      const key = this.value();
      if (typeof key !== "string") throw new Error(`non-string key at ${this.i}`);
      if (Object.hasOwn(dict, key)) throw new Error(`duplicate key ${key}`);
      this.expect("=");
      dict[key] = this.value();
      this.expect(";");
    }
    return dict;
  }

  list(): PValue[] {
    const list: PValue[] = [];
    while (!this.take(")")) {
      list.push(this.value());
      this.take(",");
    }
    return list;
  }

  quoted(): string {
    let out = "";
    while (this.text[this.i] !== '"') {
      if (this.text[this.i] === "\\") this.i++;
      out += this.text[this.i++];
    }
    this.i++;
    return out;
  }

  value(): PValue {
    if (this.take("{")) return this.dict();
    if (this.take("(")) return this.list();
    if (this.take('"')) return this.quoted();
    const m = /^[A-Za-z0-9_$./:+-]+/.exec(this.text.slice(this.i));
    if (!m) throw new Error(`unexpected ${this.text.slice(this.i, this.i + 20)}`);
    this.i += m[0].length;
    return m[0];
  }
}

/** Parse an old-style plist (a `//` header line, block comments), rejecting duplicate keys. */
function parsePlist(text: string): PDict {
  const reader = new PlistReader(text);
  const root = reader.value();
  reader.skip();
  if (reader.i !== text.length) throw new Error("trailing text");
  return root as PDict;
}

/** The parsed project: its objects and helpers over them. */
function project(text: string) {
  const root = parsePlist(text);
  const objects = root.objects as Record<string, PDict>;
  const byIsa = (isa: string) => Object.entries(objects).filter(([, o]) => o.isa === isa);
  const target = (name: string) => {
    const found = byIsa("PBXNativeTarget").find(([, o]) => o.name === name);
    assert(found, `no target ${name}`);
    return { id: found[0], ...found[1] } as PDict & { id: string };
  };
  return { root, objects, byIsa, target };
}

/** Every 24-hex id mentioned anywhere in the file resolves to an object. */
function assertReferencesResolve(text: string): void {
  const { objects } = project(text);
  const ids = new Set(text.replace(/\/\*[\s\S]*?\*\//g, "").match(/\b[0-9A-F]{24}\b/g));
  for (const id of ids) assert(Object.hasOwn(objects, id), `dangling id ${id}`);
}

const SHARE: NativeTargetSpec = {
  name: "DenextShareExtension",
  productType: "com.apple.product-type.app-extension",
  productFileType: "wrapper.app-extension",
  productExtension: "appex",
  files: ["Info.plist", "DenextShareExtension.entitlements"],
  buildSettings: (config) => ({
    INFOPLIST_FILE: "DenextShareExtension/Info.plist",
    LD_RUNPATH_SEARCH_PATHS: ["$(inherited)", "@executable_path/../../Frameworks"],
    PRODUCT_BUNDLE_IDENTIFIER: `com.example.app.share${config === "Debug" ? ".debug" : ""}`,
    PRODUCT_NAME: "$(TARGET_NAME)",
  }),
};

/** The fixture with the share extension added, compiled, embedded and depended on. */
function withShareExtension(text = FIXTURE, randomId = counterIds()): string {
  let t = addNativeTarget(text, SHARE, { randomId }).text;
  t = addSourceFiles(t, ["ShareViewController.swift"], { target: SHARE.name, randomId }).text;
  t = addEmbedPhase(t, { host: "App", extension: SHARE.name }, { randomId }).text;
  return addTargetDependency(t, { host: "App", dependency: SHARE.name }, { randomId }).text;
}

Deno.test("fixture: the parser reads the untouched project and every id resolves", () => {
  const p = project(FIXTURE);
  assertEquals(p.target("App").productType, "com.apple.product-type.application");
  assertReferencesResolve(FIXTURE);
  assertEquals(applicationTargetName(FIXTURE), "App");
});

Deno.test("addNativeTarget: a complete target, referenced from the project and Products", () => {
  const result = addNativeTarget(FIXTURE, SHARE, { randomId: counterIds() });
  assert(result.added);
  assertReferencesResolve(result.text);
  const p = project(result.text);
  const ext = p.target(SHARE.name);
  assertEquals(ext.productType, SHARE.productType);
  assertEquals(ext.productName, SHARE.name);
  // The project lists it; the product is in Products; the group is in the main group.
  const [, proj] = p.byIsa("PBXProject")[0];
  assert((proj.targets as string[]).includes(ext.id));
  const product = p.objects[ext.productReference as string];
  assertEquals(product.isa, "PBXFileReference");
  assertEquals(product.explicitFileType, "wrapper.app-extension");
  assertEquals(product.path, "DenextShareExtension.appex");
  assertEquals(product.sourceTree, "BUILT_PRODUCTS_DIR");
  assert((p.objects[proj.productRefGroup as string].children as string[]).includes(
    ext.productReference as string,
  ));
  const group = p.byIsa("PBXGroup").find(([, g]) => g.path === SHARE.name);
  assert(group, "the extension's group");
  assert((p.objects[proj.mainGroup as string].children as string[]).includes(group[0]));
  assertEquals(
    (group[1].children as string[]).map((id) => p.objects[id].path),
    ["Info.plist", "DenextShareExtension.entitlements"],
  );
  // Its own three phases, and one configuration per project configuration.
  assertEquals(
    (ext.buildPhases as string[]).map((id) => p.objects[id].isa),
    ["PBXSourcesBuildPhase", "PBXFrameworksBuildPhase", "PBXResourcesBuildPhase"],
  );
  const list = p.objects[ext.buildConfigurationList as string];
  assertEquals(list.isa, "XCConfigurationList");
  assertEquals(list.defaultConfigurationName, "Release");
  const configs = (list.buildConfigurations as string[]).map((id) => p.objects[id]);
  assertEquals(configs.map((c) => c.name), ["Debug", "Release"]);
  const debug = configs[0].buildSettings as PDict;
  assertEquals(debug.PRODUCT_BUNDLE_IDENTIFIER, "com.example.app.share.debug");
  assertEquals(debug.PRODUCT_NAME, "$(TARGET_NAME)");
  assertEquals(debug.LD_RUNPATH_SEARCH_PATHS, [
    "$(inherited)",
    "@executable_path/../../Frameworks",
  ]);
  // Nothing else of the App target changed.
  assertEquals(p.target("App").buildPhases, project(FIXTURE).target("App").buildPhases);
});

Deno.test("addNativeTarget: fresh ids are unique and never reuse a fixture id", () => {
  const before = new Set(Object.keys(project(FIXTURE).objects));
  // Every other id offered is the App target's (taken): each is skipped for a fresh one.
  const fresh = counterIds();
  let n = 0;
  const text = withShareExtension(FIXTURE, () => n++ % 2 ? fresh() : "504EC3031FED79650016851F");
  const after = Object.keys(project(text).objects);
  assertEquals(new Set(after).size, after.length);
  assertEquals(after.filter((id) => !before.has(id)).length, 17);
  assertReferencesResolve(text);
  // A generator that only offers taken ids gives up instead of looping.
  assertThrows(
    () => addNativeTarget(FIXTURE, SHARE, { randomId: () => "504EC3031FED79650016851F" }),
    Error,
    "could not generate a unique object id",
  );
});

Deno.test("addNativeTarget: an existing target of that name is left exactly as it is", () => {
  const once = addNativeTarget(FIXTURE, SHARE, { randomId: counterIds() }).text;
  const edited = once.replace("com.example.app.share.debug", "com.example.custom");
  const again = addNativeTarget(edited, { ...SHARE, buildSettings: () => ({ X: "1" }) });
  assertEquals(again, { text: edited, added: false });
});

Deno.test("addEmbedPhase + addTargetDependency: the app embeds and depends on the extension", () => {
  const text = withShareExtension();
  assertReferencesResolve(text);
  const p = project(text);
  const app = p.target("App");
  const ext = p.target(SHARE.name);
  // One Copy Files phase to PlugIns (13) in the app, holding the extension's product.
  const copy = (app.buildPhases as string[]).map((id) => p.objects[id])
    .filter((o) => o.isa === "PBXCopyFilesBuildPhase");
  assertEquals(copy.length, 1);
  assertEquals(copy[0].dstSubfolderSpec, "13");
  assertEquals(copy[0].name, "Embed Foundation Extensions");
  const embedded = (copy[0].files as string[]).map((id) => p.objects[id]);
  assertEquals(embedded.map((b) => b.fileRef), [ext.productReference]);
  assertEquals((embedded[0].settings as PDict).ATTRIBUTES, ["RemoveHeadersOnCopy"]);
  // The dependency: target → the extension; its proxy → the project and the extension.
  const deps = (app.dependencies as string[]).map((id) => p.objects[id]);
  assertEquals(deps.length, 1);
  assertEquals(deps[0].isa, "PBXTargetDependency");
  assertEquals(deps[0].target, ext.id);
  const proxy = p.objects[deps[0].targetProxy as string];
  assertEquals(proxy.isa, "PBXContainerItemProxy");
  assertEquals(proxy.containerPortal, p.root.rootObject);
  assertEquals(proxy.proxyType, "1");
  assertEquals(proxy.remoteGlobalIDString, ext.id);
  assertEquals(proxy.remoteInfo, SHARE.name);
  // The source file went to the extension, not the app.
  const extSources = p.objects[(ext.buildPhases as string[])[0]].files as string[];
  assertEquals(
    extSources.map((id) => p.objects[p.objects[id].fileRef as string].path),
    ["ShareViewController.swift"],
  );
  assert(!text.includes("ShareViewController.swift in Sources */,\n\t\t\t\t504EC"));
});

Deno.test("target editors: new sections go where Xcode sorts them", () => {
  const text = withShareExtension();
  const sections = [...text.matchAll(/\/\* Begin (\w+) section \*\//g)].map((m) => m[1]);
  assertEquals(sections, [...sections].sort());
  assert(sections.includes("PBXContainerItemProxy"));
  assert(sections.includes("PBXCopyFilesBuildPhase"));
  assert(sections.includes("PBXTargetDependency"));
  // Every Begin has its End, in order.
  for (const s of sections) {
    assert(text.indexOf(`/* Begin ${s} section */`) < text.indexOf(`/* End ${s} section */`));
  }
});

Deno.test("target editors: running everything again changes nothing", () => {
  const once = withShareExtension();
  assertEquals(withShareExtension(once, counterIds(0xF00000)), once);
  assertEquals(addEmbedPhase(once, { host: "App", extension: SHARE.name }).added, false);
  assertEquals(addTargetDependency(once, { host: "App", dependency: SHARE.name }).added, false);
});

Deno.test("addEmbedPhase: a second extension joins the same embed phase", () => {
  const widgets = { ...SHARE, name: "DenextWidgets", files: [] };
  let text = withShareExtension();
  text = addNativeTarget(text, widgets, { randomId: counterIds(0xF00000) }).text;
  text = addEmbedPhase(text, { host: "App", extension: widgets.name }).text;
  text = addTargetDependency(text, { host: "App", dependency: widgets.name }).text;
  assertReferencesResolve(text);
  const p = project(text);
  const app = p.target("App");
  const copy = (app.buildPhases as string[]).map((id) => p.objects[id])
    .filter((o) => o.isa === "PBXCopyFilesBuildPhase");
  assertEquals(copy.length, 1);
  assertEquals(
    (copy[0].files as string[]).map((id) => p.objects[p.objects[id].fileRef as string].path),
    ["DenextShareExtension.appex", "DenextWidgets.appex"],
  );
  assertEquals((app.dependencies as string[]).length, 2);
  assertEquals(p.byIsa("PBXContainerItemProxy").length, 2);
});

Deno.test("addSourceFiles: `group` compiles another group's file into the app, once", () => {
  let text = withShareExtension();
  text = addSourceFiles(text, ["DenextShareInbox.swift"], { target: SHARE.name }).text;
  const shared = addSourceFiles(text, ["DenextShareInbox.swift"], { group: SHARE.name });
  assertEquals(shared.added, ["DenextShareInbox.swift"]);
  const p = project(shared.text);
  const refs = p.byIsa("PBXFileReference").filter(([, o]) => o.path === "DenextShareInbox.swift");
  assertEquals(refs.length, 1, "one file reference, compiled by both targets");
  const inSources = (name: string) =>
    (p.objects[(p.target(name).buildPhases as string[])[0]].files as string[])
      .some((id) => p.objects[id].fileRef === refs[0][0]);
  assert(inSources("App"));
  assert(inSources(SHARE.name));
  assertEquals(
    addSourceFiles(shared.text, ["DenextShareInbox.swift"], { group: SHARE.name }).text,
    shared.text,
  );
  assertThrows(
    () => addSourceFiles(text, ["X.swift"], { group: "Nope" }),
    Error,
    'no group "Nope"',
  );
});

Deno.test("targetBuildSetting / addTargetBuildSetting: read per configuration, add only where unset", () => {
  assertEquals(
    [...targetBuildSetting(FIXTURE, "App", "PRODUCT_BUNDLE_IDENTIFIER")],
    [["Debug", "com.brainwires.t3code"], ["Release", "com.brainwires.t3code"]],
  );
  assertEquals(
    [...targetBuildSetting(FIXTURE, "App", "CODE_SIGN_ENTITLEMENTS").values()],
    [undefined, undefined],
  );
  const set = addTargetBuildSetting(
    FIXTURE,
    "App",
    "CODE_SIGN_ENTITLEMENTS",
    "App/App.entitlements",
  );
  assert(set.added);
  assertEquals(
    [...targetBuildSetting(set.text, "App", "CODE_SIGN_ENTITLEMENTS").values()],
    ["App/App.entitlements", "App/App.entitlements"],
  );
  // Sorted in: right after ASSETCATALOG_COMPILER_APPICON_NAME, before CODE_SIGN_STYLE.
  assert(set.text.includes(
    "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;",
  ));
  // The project-level configurations are not the target's.
  assertEquals(set.text.split("CODE_SIGN_ENTITLEMENTS").length - 1, 2);
  assertReferencesResolve(set.text);
  // An existing value is kept, and a second run is a no-op.
  assertEquals(
    addTargetBuildSetting(set.text, "App", "CODE_SIGN_ENTITLEMENTS", "Other").added,
    false,
  );
  const list = addTargetBuildSetting(FIXTURE, "App", "OTHER_LDFLAGS", ["$(inherited)", "-ObjC"]);
  assertEquals(
    (project(list.text).objects["504EC3171FED79650016851F"].buildSettings as PDict)
      .OTHER_LDFLAGS,
    ["$(inherited)", "-ObjC"],
  );
  assertNotEquals(list.text, FIXTURE);
});

Deno.test("target editors: unknown targets are refused", () => {
  assertThrows(
    () => addEmbedPhase(FIXTURE, { host: "App", extension: "Nope" }),
    Error,
    'no native target "Nope"',
  );
  assertThrows(
    () => addTargetDependency(FIXTURE, { host: "Nope", dependency: "App" }),
    Error,
    'no native target "Nope"',
  );
  assertThrows(() => targetBuildSetting(FIXTURE, "Nope", "X"), Error, 'no native target "Nope"');
});

// A small, text-based editor for Xcode `project.pbxproj` files: just enough to add source
// files to a target (PBXFileReference + PBXBuildFile + the target's group + its Sources build
// phase), as `denext mobile add-ota` needs, and to add an app extension target (a
// PBXNativeTarget with its group, product, build phases and configurations), embed it in the
// app (a PBXCopyFilesBuildPhase) and make the app depend on it (PBXTargetDependency +
// PBXContainerItemProxy), as `denext mobile add share-extension / widget` need. It edits the
// text in place and never re-serialises the file, so everything it does not touch keeps its
// bytes. It is idempotent: a file already referenced, grouped or compiled, a target that
// exists, an extension already embedded or depended on, is not added again.
//
// The format: an old-style (NeXTSTEP) plist whose `objects = { … }` dictionary maps 24-hex
// ids to `{ isa = …; … }` objects. Xcode writes one object per line in the PBXBuildFile and
// PBXFileReference sections and multi-line blocks elsewhere; this editor finds objects by
// brace matching (skipping quoted strings and comments), so it copes with either layout.

/** One object of the `objects` dictionary: its id and the text span of its `{ … }` body. */
interface PbxObject {
  id: string;
  /** The `isa` value. */
  isa: string;
  /** Offset of the opening `{`. */
  open: number;
  /** Offset just past the closing `}`. */
  close: number;
  /** The text between the braces. */
  body: string;
}

/**
 * When a quoted string or a comment starts at `i`, the index of its last character (so a
 * scan resumes after it); otherwise `i` itself.
 */
function skipOpaque(text: string, i: number): number {
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j;
  }
  if (text[i] === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 1;
  }
  return i;
}

/**
 * The index just past the `close` bracket matching the `open` bracket at `from`; skips
 * quoted strings and comments, which may hold any bracket.
 */
function matchBracket(text: string, from: number, open = "{", close = "}"): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    i = skipOpaque(text, i);
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  throw new Error(`project.pbxproj: unbalanced ${open}${close}`);
}

/** Every object in the `objects` dictionary, in file order. */
function parseObjects(text: string): PbxObject[] {
  const start = text.search(/\bobjects\s*=\s*\{/);
  if (start < 0) throw new Error("project.pbxproj: no `objects` dictionary");
  const objectsOpen = text.indexOf("{", start);
  const objectsClose = matchBracket(text, objectsOpen) - 1;
  const entry = /([0-9A-Fa-f]{24})(?:\s*\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\/)?\s*=\s*\{/g;
  entry.lastIndex = objectsOpen + 1;
  const out: PbxObject[] = [];
  for (let m = entry.exec(text); m && m.index < objectsClose; m = entry.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    const body = text.slice(open + 1, close - 1);
    out.push({ id: m[1], isa: /\bisa\s*=\s*(\w+)\s*;/.exec(body)?.[1] ?? "", open, close, body });
    entry.lastIndex = close;
  }
  return out;
}

/**
 * The value of `key = value;` in an object body (quotes stripped), if present. A value may
 * carry Xcode's trailing name comment (`fileRef = <id> /* Foo.swift *\/;`).
 */
function field(body: string, key: string): string | undefined {
  const value = `("(?:[^"\\\\]|\\\\.)*"|[^;\\s]+)`;
  const comment = `(?:\\s*\\/\\*[\\s\\S]*?\\*\\/)?`;
  const m = new RegExp(`(?:^|[\\s;{])${key}\\s*=\\s*${value}${comment}\\s*;`).exec(body);
  if (!m) return undefined;
  return m[1].startsWith('"') ? m[1].slice(1, -1) : m[1];
}

/** The span of the `( … )` of `key = ( … );` in `src`: offsets of `(` and of `)`. */
function listSpan(src: string, key: string): { open: number; close: number } | undefined {
  const m = new RegExp(`(?:^|[\\s;{])${key}\\s*=\\s*\\(`).exec(src);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  return { open, close: matchBracket(src, open, "(", ")") - 1 };
}

/** The ids listed in `key = ( id, … );` of an object body (their comments ignored). */
function listIds(body: string, key: string): string[] {
  const span = listSpan(body, key);
  if (!span) return [];
  const inner = body.slice(span.open + 1, span.close).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...inner.matchAll(/\b([0-9A-Fa-f]{24})\b/g)].map((x) => x[1]);
}

/** A factory of fresh 24-hex ids: none is in `text`, and none repeats. */
function makeIdFactory(text: string, random: () => string): () => string {
  const taken = new Set([...text.matchAll(/\b[0-9A-F]{24}\b/gi)].map((m) => m[0].toUpperCase()));
  return () => {
    for (let tries = 0; tries < 1000; tries++) {
      const id = random().toUpperCase();
      if (/^[0-9A-F]{24}$/.test(id) && !taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new Error("project.pbxproj: could not generate a unique object id");
  };
}

/** 24 random hex digits. */
function randomId(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}

/** Options for {@linkcode addSourceFiles}. */
export interface AddSourceFilesOptions {
  /** The native target to compile into (default: the only application target, else `App`). */
  target?: string;
  /**
   * The group (by `path` or `name`) holding the files, e.g. `"DenextWidgets"` to compile a file
   * of an extension's folder into the app too (default: the target's own group).
   */
  group?: string;
  /** Id generator, for deterministic tests (default: random, checked for uniqueness). */
  randomId?: () => string;
}

/** What {@linkcode addSourceFiles} did. */
export interface AddSourceFilesResult {
  /** The edited project text (identical to the input when nothing was added). */
  text: string;
  /** File names newly added to the target, in the order given. */
  added: string[];
}

/** The app target: `name` if given, else the single application target, else `App`. */
function findTarget(objects: PbxObject[], name: string | undefined): PbxObject {
  const targets = objects.filter((o) => o.isa === "PBXNativeTarget");
  const byName = (n: string) => targets.find((t) => field(t.body, "name") === n);
  const apps = targets.filter((t) =>
    field(t.body, "productType") === "com.apple.product-type.application"
  );
  const target = name ? byName(name) : apps.length === 1 ? apps[0] : byName("App");
  if (!target) {
    throw new Error(`project.pbxproj: no native target ${name ? `"${name}"` : "for the app"}`);
  }
  return target;
}

/**
 * The group the target's sources live in: the group holding the file that one of the
 * target's compiled sources references (e.g. `AppDelegate.swift`), else a group whose
 * `path` or `name` is the target's name.
 */
function findGroup(objects: PbxObject[], sources: PbxObject, targetName: string): PbxObject {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const groups = objects.filter((o) => o.isa === "PBXGroup");
  for (const buildFileId of listIds(sources.body, "files")) {
    const ref = field(byId.get(buildFileId)?.body ?? "", "fileRef");
    const holder = ref && groups.find((g) => listIds(g.body, "children").includes(ref));
    if (holder) return holder;
  }
  const named = groups.find((g) =>
    field(g.body, "path") === targetName || field(g.body, "name") === targetName
  );
  if (!named) throw new Error(`project.pbxproj: no group for target "${targetName}"`);
  return named;
}

/** One pending text insertion. */
interface Insertion {
  at: number;
  text: string;
}

/** The start of the line holding the `End <section> section` marker (insert above it). */
function sectionEnd(text: string, section: string): number {
  const at = text.indexOf(`/* End ${section} section */`);
  if (at < 0) throw new Error(`project.pbxproj: no ${section} section`);
  return text.lastIndexOf("\n", at) + 1;
}

/** Where to insert into `key = ( … )` of `obj`: above its `)` line, or inline before `)`. */
function listEnd(text: string, obj: PbxObject, key: string): { at: number; indent: string } {
  const span = listSpan(obj.body, key);
  if (!span) throw new Error(`project.pbxproj: object ${obj.id} has no ${key} list`);
  const close = obj.open + 1 + span.close;
  const lineStart = text.lastIndexOf("\n", close) + 1;
  // Pretty-printed (`\t\t\t);` on its own line): insert a new line above the `)`, one tab
  // deeper. Single-line lists get inline entries.
  const onOwnLine = /^\s*$/.test(text.slice(lineStart, close));
  return onOwnLine
    ? { at: lineStart, indent: text.slice(lineStart, close) + "\t" }
    : { at: close, indent: "" };
}

/** Render a list entry at `pos` (own line, or inline). */
function listEntry(pos: { indent: string }, entry: string): string {
  return pos.indent ? `${pos.indent}${entry},\n` : ` ${entry},`;
}

/**
 * Add Swift (or other) source files that live in the target's group folder to an Xcode
 * app target: a PBXFileReference, a PBXBuildFile, a child of the target's group, and an
 * entry in the target's Sources build phase, each with a fresh unique 24-hex id. Files
 * already present are not duplicated (a reference with the same `path` in the group is
 * reused, and a build file already in the Sources phase is left alone), so running it twice
 * changes nothing.
 *
 * @param text The `project.pbxproj` contents.
 * @param fileNames File names relative to the target's group folder, e.g. `["Foo.swift"]`.
 * @param options Target name and id generator.
 * @returns The edited text and the names that were newly added.
 */
export function addSourceFiles(
  text: string,
  fileNames: readonly string[],
  options: AddSourceFilesOptions = {},
): AddSourceFilesResult {
  const newId = makeIdFactory(text, options.randomId ?? randomId);
  const objects = parseObjects(text);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const target = findTarget(objects, options.target);
  const targetName = field(target.body, "name") ?? "App";
  const sources = listIds(target.body, "buildPhases").map((id) => byId.get(id))
    .find((o) => o?.isa === "PBXSourcesBuildPhase");
  if (!sources) throw new Error(`project.pbxproj: target "${targetName}" has no Sources phase`);
  const group = options.group === undefined
    ? findGroup(objects, sources, targetName)
    : groupNamed(objects, options.group);
  const groupChildren = listIds(group.body, "children");
  const compiled = listIds(sources.body, "files").map((id) =>
    field(byId.get(id)?.body ?? "", "fileRef")
  );

  const insertions: Insertion[] = [];
  const added: string[] = [];
  const buildFileEnd = sectionEnd(text, "PBXBuildFile");
  const fileRefEnd = sectionEnd(text, "PBXFileReference");
  const groupPos = listEnd(text, group, "children");
  const sourcesPos = listEnd(text, sources, "files");
  for (const name of fileNames) {
    const existingRef = objects.find((o) =>
      o.isa === "PBXFileReference" && groupChildren.includes(o.id) &&
      (field(o.body, "path") === name || field(o.body, "name") === name)
    );
    const refId = existingRef?.id ?? newId();
    if (!existingRef) {
      insertions.push({
        at: fileRefEnd,
        text: `\t\t${refId} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = ${
          fileType(name)
        }; path = ${quote(name)}; sourceTree = "<group>"; };\n`,
      });
      insertions.push({ at: groupPos.at, text: listEntry(groupPos, `${refId} /* ${name} */`) });
    }
    if (compiled.includes(refId)) continue;
    const buildId = newId();
    insertions.push({
      at: buildFileEnd,
      text:
        `\t\t${buildId} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${refId} /* ${name} */; };\n`,
    });
    insertions.push({
      at: sourcesPos.at,
      text: listEntry(sourcesPos, `${buildId} /* ${name} in Sources */`),
    });
    added.push(name);
  }
  return { text: applyInsertions(text, insertions), added };
}

/** `text` with `insertions` applied (the same text when there are none). */
function applyInsertions(text: string, insertions: readonly Insertion[]): string {
  // Apply from the end so earlier offsets stay valid; a stable sort keeps same-offset
  // insertions in the order they were queued.
  const ordered = insertions.map((ins, i) => ({ ...ins, i }))
    .sort((a, b) => b.at - a.at || b.i - a.i);
  let out = text;
  for (const ins of ordered) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return out;
}

/** The group whose `path` or `name` is `name`. */
function groupNamed(objects: PbxObject[], name: string): PbxObject {
  const group = objects.find((o) =>
    o.isa === "PBXGroup" && (field(o.body, "path") === name || field(o.body, "name") === name)
  );
  if (!group) throw new Error(`project.pbxproj: no group "${name}"`);
  return group;
}

/** Xcode's `lastKnownFileType` for a source file name. */
function fileType(name: string): string {
  if (name.endsWith(".swift")) return "sourcecode.swift";
  if (name.endsWith(".plist")) return "text.plist.xml";
  if (name.endsWith(".entitlements")) return "text.plist.entitlements";
  if (name.endsWith(".m")) return "sourcecode.c.objc";
  if (name.endsWith(".h")) return "sourcecode.c.h";
  return "text";
}

/** A plist string: bare when it is only safe characters, else quoted. */
function quote(value: string): string {
  return /^[A-Za-z0-9_$./-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

// ---------------------------------------------------------------------------------------------
// Targets: app extensions, their embedding and the app's dependency on them.

/** A build setting value: a string, or a list (written `( a, b, )`). */
export type BuildSettingValue = string | readonly string[];

/** What {@linkcode addNativeTarget} creates. */
export interface NativeTargetSpec {
  /** The target name; also its group and folder under the project (`ios/App/<name>/`). */
  name: string;
  /** The product type, e.g. `com.apple.product-type.app-extension`. */
  productType: string;
  /** The product's `explicitFileType`, e.g. `wrapper.app-extension`. */
  productFileType: string;
  /** The product's extension, e.g. `appex`. */
  productExtension: string;
  /**
   * Files of the target's folder listed in its group but built by no phase (its Info.plist and
   * entitlements). Sources are added afterwards with {@linkcode addSourceFiles}.
   */
  files?: readonly string[];
  /** The target's build settings for each of the project's configurations (`Debug`, `Release`). */
  buildSettings: (configuration: string) => Readonly<Record<string, BuildSettingValue>>;
}

/** Options for the target editors. */
export interface TargetEditOptions {
  /** Id generator, for deterministic tests (default: random, checked for uniqueness). */
  randomId?: () => string;
}

/** What a target editor did: the edited text, and whether it changed anything. */
export interface TargetEditResult {
  /** The edited project text (identical to the input when nothing was added). */
  text: string;
  /** Whether anything was added. */
  added: boolean;
}

/** The `PBXProject` object (the `rootObject`). */
function projectObject(objects: PbxObject[]): PbxObject {
  const project = objects.find((o) => o.isa === "PBXProject");
  if (!project) throw new Error("project.pbxproj: no PBXProject object");
  return project;
}

/** The native target named `name`, if any. */
function targetNamed(objects: PbxObject[], name: string): PbxObject | undefined {
  return objects.find((o) => o.isa === "PBXNativeTarget" && field(o.body, "name") === name);
}

/** The native target named `name`; throws when there is none. */
function requireTarget(objects: PbxObject[], name: string): PbxObject {
  const target = targetNamed(objects, name);
  if (!target) throw new Error(`project.pbxproj: no native target "${name}"`);
  return target;
}

/** The XCBuildConfiguration objects of the configuration list `listId`. */
function configurationsOf(objects: PbxObject[], listId: string | undefined): PbxObject[] {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const list = listId === undefined ? undefined : byId.get(listId);
  if (!list) throw new Error(`project.pbxproj: no configuration list ${listId ?? "(none)"}`);
  return listIds(list.body, "buildConfigurations").flatMap((id) => {
    const config = byId.get(id);
    return config ? [config] : [];
  });
}

/** Sections in the order Xcode writes them (alphabetical by isa). */
function sectionNames(text: string): string[] {
  return [...text.matchAll(/\/\* Begin (\w+) section \*\//g)].map((m) => m[1]);
}

/**
 * `text` with an empty `/* Begin <name> section *\/ … End` pair where Xcode would put it (the
 * sections are sorted by isa), unless the section is already there.
 */
function withSection(text: string, name: string): string {
  if (text.includes(`/* Begin ${name} section */`)) return text;
  const block = `/* Begin ${name} section */\n/* End ${name} section */\n`;
  const next = sectionNames(text).find((s) => s > name);
  if (next !== undefined) {
    const at = text.indexOf(`/* Begin ${next} section */`);
    return `${text.slice(0, at)}${block}\n${text.slice(at)}`;
  }
  const ends = [...text.matchAll(/\/\* End \w+ section \*\/\n/g)];
  const last = ends[ends.length - 1];
  if (!last) throw new Error("project.pbxproj: no object sections");
  const at = last.index + last[0].length;
  return `${text.slice(0, at)}\n${block}${text.slice(at)}`;
}

/** A value as the pbxproj writes it (quoted unless only safe characters). */
function settingValue(value: BuildSettingValue, indent: string): string {
  if (typeof value === "string") return quote(value);
  return `(\n${value.map((v) => `${indent}\t${quote(v)},\n`).join("")}${indent})`;
}

/** A `buildSettings = { … };` block, keys sorted as Xcode sorts them. */
function buildSettingsBlock(settings: Readonly<Record<string, BuildSettingValue>>): string {
  const lines = Object.keys(settings).sort().map((key) =>
    `\t\t\t\t${key} = ${settingValue(settings[key], "\t\t\t\t")};\n`
  );
  return `\t\t\tbuildSettings = {\n${lines.join("")}\t\t\t};\n`;
}

/** A multi-line object `\t\t<id> /* comment *\/ = { … };` from its pre-rendered field lines. */
function objectBlock(id: string, comment: string | undefined, fields: string): string {
  return `\t\t${id}${comment === undefined ? "" : ` /* ${comment} */`} = {\n${fields}\t\t};\n`;
}

/** A `key = ( … );` list field of an object block, items with their comments. */
function listField(key: string, items: readonly string[]): string {
  return `\t\t\t${key} = (\n${items.map((i) => `\t\t\t\t${i},\n`).join("")}\t\t\t);\n`;
}

/** An empty build phase of `isa`. */
function phaseBlock(id: string, isa: string, comment: string): string {
  return objectBlock(
    id,
    comment,
    `\t\t\tisa = ${isa};\n\t\t\tbuildActionMask = 2147483647;\n${
      listField("files", [])
    }\t\t\trunOnlyForDeploymentPostprocessing = 0;\n`,
  );
}

/**
 * Add a native target (an app extension) to the project: its product (a PBXFileReference in the
 * Products group), its group (`path = <name>`, under the main group, listing `spec.files`), empty
 * Sources / Frameworks / Resources phases, one XCBuildConfiguration per project configuration
 * (`spec.buildSettings`) in their own XCConfigurationList, the PBXNativeTarget, and its entry in
 * the project's `targets`. A target with that name already there is left exactly as it is (its
 * settings may have been edited in Xcode), so running it twice changes nothing.
 *
 * @param text The `project.pbxproj` contents.
 * @param spec The target to add.
 * @param options Id generator.
 * @returns The edited text, and whether the target was added.
 */
export function addNativeTarget(
  text: string,
  spec: NativeTargetSpec,
  options: TargetEditOptions = {},
): TargetEditResult {
  if (targetNamed(parseObjects(text), spec.name)) return { text, added: false };
  let out = text;
  for (
    const section of [
      "PBXFileReference",
      "PBXFrameworksBuildPhase",
      "PBXGroup",
      "PBXNativeTarget",
      "PBXResourcesBuildPhase",
      "PBXSourcesBuildPhase",
      "XCBuildConfiguration",
      "XCConfigurationList",
    ]
  ) out = withSection(out, section);
  const objects = parseObjects(out);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const project = projectObject(objects);
  const mainGroup = byId.get(field(project.body, "mainGroup") ?? "");
  const products = byId.get(field(project.body, "productRefGroup") ?? "");
  if (!mainGroup || !products) {
    throw new Error("project.pbxproj: the project has no main group or Products group");
  }
  const configNames = configurationsOf(objects, field(project.body, "buildConfigurationList"))
    .map((c) => field(c.body, "name") ?? "");
  const newId = makeIdFactory(out, options.randomId ?? randomId);
  const product = `${spec.name}.${spec.productExtension}`;
  const ids = {
    product: newId(),
    group: newId(),
    sources: newId(),
    frameworks: newId(),
    resources: newId(),
    list: newId(),
    target: newId(),
    configs: configNames.map(() => newId()),
    files: (spec.files ?? []).map(() => newId()),
  };
  const listComment = `Build configuration list for PBXNativeTarget "${spec.name}"`;
  const fileRefs = (spec.files ?? []).map((name, i) =>
    `\t\t${ids.files[i]} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = ${
      fileType(name)
    }; path = ${quote(name)}; sourceTree = "<group>"; };\n`
  );
  const productsPos = listEnd(out, products, "children");
  const mainPos = listEnd(out, mainGroup, "children");
  const targetsPos = listEnd(out, project, "targets");
  const insertions: Insertion[] = [
    {
      at: sectionEnd(out, "PBXFileReference"),
      text:
        `\t\t${ids.product} /* ${product} */ = {isa = PBXFileReference; explicitFileType = ${
          quote(spec.productFileType)
        }; includeInIndex = 0; path = ${quote(product)}; sourceTree = BUILT_PRODUCTS_DIR; };\n` +
        fileRefs.join(""),
    },
    { at: productsPos.at, text: listEntry(productsPos, `${ids.product} /* ${product} */`) },
    { at: mainPos.at, text: listEntry(mainPos, `${ids.group} /* ${spec.name} */`) },
    {
      at: sectionEnd(out, "PBXGroup"),
      text: objectBlock(
        ids.group,
        spec.name,
        `\t\t\tisa = PBXGroup;\n${
          listField("children", (spec.files ?? []).map((n, i) => `${ids.files[i]} /* ${n} */`))
        }\t\t\tpath = ${quote(spec.name)};\n\t\t\tsourceTree = "<group>";\n`,
      ),
    },
    {
      at: sectionEnd(out, "PBXSourcesBuildPhase"),
      text: phaseBlock(ids.sources, "PBXSourcesBuildPhase", "Sources"),
    },
    {
      at: sectionEnd(out, "PBXFrameworksBuildPhase"),
      text: phaseBlock(ids.frameworks, "PBXFrameworksBuildPhase", "Frameworks"),
    },
    {
      at: sectionEnd(out, "PBXResourcesBuildPhase"),
      text: phaseBlock(ids.resources, "PBXResourcesBuildPhase", "Resources"),
    },
    {
      at: sectionEnd(out, "PBXNativeTarget"),
      text: objectBlock(
        ids.target,
        spec.name,
        `\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ${ids.list} /* ${listComment} */;\n${
          listField("buildPhases", [
            `${ids.sources} /* Sources */`,
            `${ids.frameworks} /* Frameworks */`,
            `${ids.resources} /* Resources */`,
          ])
        }${listField("buildRules", [])}${listField("dependencies", [])}\t\t\tname = ${
          quote(spec.name)
        };\n\t\t\tproductName = ${
          quote(spec.name)
        };\n\t\t\tproductReference = ${ids.product} /* ${product} */;\n\t\t\tproductType = ${
          quote(spec.productType)
        };\n`,
      ),
    },
    { at: targetsPos.at, text: listEntry(targetsPos, `${ids.target} /* ${spec.name} */`) },
    {
      at: sectionEnd(out, "XCBuildConfiguration"),
      text: configNames.map((name, i) =>
        objectBlock(
          ids.configs[i],
          name,
          `\t\t\tisa = XCBuildConfiguration;\n${
            buildSettingsBlock(spec.buildSettings(name))
          }\t\t\tname = ${quote(name)};\n`,
        )
      ).join(""),
    },
    {
      at: sectionEnd(out, "XCConfigurationList"),
      text: objectBlock(
        ids.list,
        listComment,
        `\t\t\tisa = XCConfigurationList;\n${
          listField(
            "buildConfigurations",
            configNames.map((n, i) => `${ids.configs[i]} /* ${n} */`),
          )
        }\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = ${
          quote(configNames.includes("Release") ? "Release" : configNames[0] ?? "Release")
        };\n`,
      ),
    },
  ];
  return { text: applyInsertions(out, insertions), added: true };
}

/** The Copy Files destination for app extensions (`PlugIns/`). */
const PLUGINS_SUBFOLDER = "13";

/**
 * Embed the product of target `extension` in target `host` (the app): a build file with
 * `RemoveHeadersOnCopy` in the host's "Embed Foundation Extensions" Copy Files phase (to
 * `PlugIns/`), which is created when the host has none. Unchanged when it is already embedded.
 *
 * @param text The `project.pbxproj` contents.
 * @param targets The host (app) target and the extension target, by name.
 * @param options Id generator.
 * @returns The edited text, and whether the embed was added.
 */
export function addEmbedPhase(
  text: string,
  targets: { host: string; extension: string },
  options: TargetEditOptions = {},
): TargetEditResult {
  const before = parseObjects(text);
  const productId = field(requireTarget(before, targets.extension).body, "productReference");
  if (!productId) throw new Error(`project.pbxproj: target "${targets.extension}" has no product`);
  const out = withSection(text, "PBXCopyFilesBuildPhase");
  const objects = parseObjects(out);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const host = requireTarget(objects, targets.host);
  const product = field(byId.get(productId)?.body ?? "", "path") ?? `${targets.extension}.appex`;
  const phase = listIds(host.body, "buildPhases").map((id) => byId.get(id)).find((o) =>
    o?.isa === "PBXCopyFilesBuildPhase" && field(o.body, "dstSubfolderSpec") === PLUGINS_SUBFOLDER
  );
  const embedded = phase &&
    listIds(phase.body, "files").some((id) =>
      field(byId.get(id)?.body ?? "", "fileRef") === productId
    );
  if (embedded) return { text, added: false };
  const newId = makeIdFactory(out, options.randomId ?? randomId);
  const buildId = newId();
  const phaseName = phase
    ? field(phase.body, "name") ?? "CopyFiles"
    : "Embed Foundation Extensions";
  const insertions: Insertion[] = [{
    at: sectionEnd(out, "PBXBuildFile"),
    text:
      `\t\t${buildId} /* ${product} in ${phaseName} */ = {isa = PBXBuildFile; fileRef = ${productId} /* ${product} */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n`,
  }];
  const entry = `${buildId} /* ${product} in ${phaseName} */`;
  if (phase) {
    const pos = listEnd(out, phase, "files");
    insertions.push({ at: pos.at, text: listEntry(pos, entry) });
  } else {
    const phaseId = newId();
    insertions.push({
      at: sectionEnd(out, "PBXCopyFilesBuildPhase"),
      text: objectBlock(
        phaseId,
        phaseName,
        `\t\t\tisa = PBXCopyFilesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = "";\n\t\t\tdstSubfolderSpec = ${PLUGINS_SUBFOLDER};\n${
          listField("files", [entry])
        }\t\t\tname = ${quote(phaseName)};\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n`,
      ),
    });
    const pos = listEnd(out, host, "buildPhases");
    insertions.push({ at: pos.at, text: listEntry(pos, `${phaseId} /* ${phaseName} */`) });
  }
  return { text: applyInsertions(out, insertions), added: true };
}

/**
 * Make target `host` depend on target `dependency` (so building the app builds the extension
 * first): a PBXContainerItemProxy and a PBXTargetDependency, listed in the host's
 * `dependencies`. Unchanged when the host already depends on it.
 *
 * @param text The `project.pbxproj` contents.
 * @param targets The host (app) target and the target it depends on, by name.
 * @param options Id generator.
 * @returns The edited text, and whether the dependency was added.
 */
export function addTargetDependency(
  text: string,
  targets: { host: string; dependency: string },
  options: TargetEditOptions = {},
): TargetEditResult {
  const before = parseObjects(text);
  const beforeById = new Map(before.map((o) => [o.id, o]));
  const dependencyId = requireTarget(before, targets.dependency).id;
  const existing = listIds(requireTarget(before, targets.host).body, "dependencies");
  if (existing.some((id) => field(beforeById.get(id)?.body ?? "", "target") === dependencyId)) {
    return { text, added: false };
  }
  const out = withSection(withSection(text, "PBXContainerItemProxy"), "PBXTargetDependency");
  const objects = parseObjects(out);
  const host = requireTarget(objects, targets.host);
  const project = projectObject(objects);
  const newId = makeIdFactory(out, options.randomId ?? randomId);
  const proxyId = newId();
  const depId = newId();
  const name = quote(targets.dependency);
  const pos = listEnd(out, host, "dependencies");
  const insertions: Insertion[] = [
    {
      at: sectionEnd(out, "PBXContainerItemProxy"),
      text: objectBlock(
        proxyId,
        "PBXContainerItemProxy",
        `\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = ${project.id} /* Project object */;\n\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = ${dependencyId};\n\t\t\tremoteInfo = ${name};\n`,
      ),
    },
    {
      at: sectionEnd(out, "PBXTargetDependency"),
      text: objectBlock(
        depId,
        "PBXTargetDependency",
        `\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = ${dependencyId} /* ${targets.dependency} */;\n\t\t\ttargetProxy = ${proxyId} /* PBXContainerItemProxy */;\n`,
      ),
    },
    { at: pos.at, text: listEntry(pos, `${depId} /* PBXTargetDependency */`) },
  ];
  return { text: applyInsertions(out, insertions), added: true };
}

/**
 * The value of build setting `key` in each configuration of target `target` (its own
 * settings, not inherited ones), keyed by configuration name; a list setting reads as its raw
 * text. Undefined for a configuration that does not set it.
 *
 * @param text The `project.pbxproj` contents.
 * @param target The target name.
 * @param key The build setting.
 * @returns Configuration name → value.
 */
export function targetBuildSetting(
  text: string,
  target: string,
  key: string,
): Map<string, string | undefined> {
  const objects = parseObjects(text);
  const configs = configurationsOf(
    objects,
    field(requireTarget(objects, target).body, "buildConfigurationList"),
  );
  return new Map(
    configs.map((c) => [field(c.body, "name") ?? "", settingIn(c.body, key)] as const),
  );
}

/** The span of a configuration body's `buildSettings = { … }` dict: its `{` and `}` offsets. */
function settingsSpan(body: string): { open: number; close: number } | undefined {
  const m = /(?:^|[\s;{])buildSettings\s*=\s*\{/.exec(body);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  return { open, close: matchBracket(body, open) - 1 };
}

/** `key`'s value in a configuration body's build settings. */
function settingIn(body: string, key: string): string | undefined {
  const span = settingsSpan(body);
  return span ? field(body.slice(span.open, span.close + 1), key) : undefined;
}

/**
 * Where a new setting `key` goes in the build settings between `from` and `end` (the start of
 * the closing `};` line): above the first key sorting after it, else at `end`.
 */
function sortedSettingLine(text: string, from: number, end: number, key: string): number {
  const keyLine = /\n(\t+)([A-Za-z0-9_]+(?:\[[^\]\n]*\])*)\s*=/g;
  keyLine.lastIndex = from - 1;
  let depthIndent: string | undefined;
  for (let m = keyLine.exec(text); m && m.index < end; m = keyLine.exec(text)) {
    depthIndent ??= m[1];
    if (m[1] === depthIndent && m[2] > key) return m.index + 1;
  }
  return end;
}

/**
 * Set build setting `key` to `value` in every configuration of target `target` that does not
 * set it yet; a configuration that already sets it (to anything) keeps its value.
 *
 * @param text The `project.pbxproj` contents.
 * @param target The target name.
 * @param key The build setting.
 * @param value Its value.
 * @returns The edited text, and whether any configuration changed.
 */
export function addTargetBuildSetting(
  text: string,
  target: string,
  key: string,
  value: BuildSettingValue,
): TargetEditResult {
  const objects = parseObjects(text);
  const configs = configurationsOf(
    objects,
    field(requireTarget(objects, target).body, "buildConfigurationList"),
  );
  const insertions: Insertion[] = [];
  for (const config of configs) {
    const span = settingsSpan(config.body);
    if (!span || settingIn(config.body, key) !== undefined) continue;
    const close = config.open + 1 + span.close;
    const lineStart = text.lastIndexOf("\n", close) + 1;
    const indent = text.slice(lineStart, close);
    if (indent.trim() !== "") {
      throw new Error(`project.pbxproj: unexpected buildSettings layout in ${config.id}`);
    }
    insertions.push({
      at: sortedSettingLine(text, config.open + 1 + span.open + 1, lineStart, key),
      text: `${indent}\t${key} = ${settingValue(value, `${indent}\t`)};\n`,
    });
  }
  return { text: applyInsertions(text, insertions), added: insertions.length > 0 };
}

/**
 * The app's target name: the only `com.apple.product-type.application` target, else `App`
 * (the Capacitor default), as {@linkcode addSourceFiles} picks it.
 *
 * @param text The `project.pbxproj` contents.
 * @returns The target name.
 */
export function applicationTargetName(text: string): string {
  return field(findTarget(parseObjects(text), undefined).body, "name") ?? "App";
}

// A small, text-based editor for Xcode `project.pbxproj` files: just enough to add source
// files to an app target (PBXFileReference + PBXBuildFile + the target's group + its Sources
// build phase), as `denext mobile add-ota` needs. It edits the text in place and never
// re-serialises the file, so everything it does not touch keeps its bytes. It is idempotent:
// a file already referenced, grouped or compiled is not added again.
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
  const group = findGroup(objects, sources, targetName);
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
  if (insertions.length === 0) return { text, added };
  // Apply from the end so earlier offsets stay valid; a stable sort keeps same-offset
  // insertions in the order they were queued.
  const ordered = insertions.map((ins, i) => ({ ...ins, i }))
    .sort((a, b) => b.at - a.at || b.i - a.i);
  let out = text;
  for (const ins of ordered) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return { text: out, added };
}

/** Xcode's `lastKnownFileType` for a source file name. */
function fileType(name: string): string {
  if (name.endsWith(".swift")) return "sourcecode.swift";
  if (name.endsWith(".m")) return "sourcecode.c.objc";
  if (name.endsWith(".h")) return "sourcecode.c.h";
  return "text";
}

/** A plist string: bare when it is only safe characters, else quoted. */
function quote(value: string): string {
  return /^[A-Za-z0-9_$./-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

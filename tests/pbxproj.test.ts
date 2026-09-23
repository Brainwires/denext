// The text-based project.pbxproj editor (src/build/pbxproj.ts) against a real Capacitor 8
// project file (tests/fixtures/capacitor8/project.pbxproj, from the T3 Code Capacitor shell):
// the four entries per file land in the right sections with fresh ids, nothing else changes,
// and a second run is a no-op.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { addSourceFiles } from "../src/build/pbxproj.ts";

const FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const FILES = ["DenextBridgeViewController.swift", "DenextOtaPlugin.swift", "DenextOtaStore.swift"];

/** Deterministic ids: 24-hex counters that cannot collide with the fixture's. */
function counterIds(): () => string {
  let n = 0;
  return () => (0xDE0000 + n++).toString(16).toUpperCase().padStart(24, "0");
}

/** The text between `/* Begin <section> section *\/` and its End marker. */
function section(text: string, name: string): string {
  const start = text.indexOf(`/* Begin ${name} section */`);
  const end = text.indexOf(`/* End ${name} section */`);
  assert(start >= 0 && end > start, `no ${name} section`);
  return text.slice(start, end);
}

/** The body of the object whose id line starts with `\t\t<id>`. */
function objectBody(text: string, id: string): string {
  const start = text.indexOf(`\n\t\t${id} `);
  assert(start >= 0, `no object ${id}`);
  return text.slice(start, text.indexOf("\n\t\t};", start));
}

Deno.test("addSourceFiles: adds a file ref, build file, group child and Sources entry each", () => {
  const { text, added } = addSourceFiles(FIXTURE, FILES, { randomId: counterIds() });
  assertEquals(added, FILES);
  for (const name of FILES) {
    const ref = new RegExp(
      `\\t\\t([0-9A-F]{24}) /\\* ${name} \\*/ = \\{isa = PBXFileReference; lastKnownFileType = sourcecode\\.swift; path = ${name}; sourceTree = "<group>"; \\};\\n`,
    ).exec(section(text, "PBXFileReference"));
    assert(ref, `file reference for ${name}`);
    const build = new RegExp(
      `\\t\\t([0-9A-F]{24}) /\\* ${name} in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${
        ref[1]
      } /\\* ${name} \\*/; \\};\\n`,
    ).exec(section(text, "PBXBuildFile"));
    assert(build, `build file for ${name}`);
    // In the App group (the one holding AppDelegate.swift) and the App target's Sources phase.
    assert(
      objectBody(text, "504EC3061FED79650016851F").includes(`\t\t\t\t${ref[1]} /* ${name} */,\n`),
    );
    assert(
      objectBody(text, "504EC3001FED79650016851F").includes(
        `\t\t\t\t${build[1]} /* ${name} in Sources */,\n`,
      ),
    );
    // Not in the Resources or Frameworks phases.
    assert(!objectBody(text, "504EC3021FED79650016851F").includes(build[1]));
    assert(!objectBody(text, "504EC3011FED79650016851F").includes(build[1]));
  }
  // Only additions: removing the 12 new lines gives back the fixture byte for byte.
  const fixtureLines = new Set(FIXTURE.split("\n"));
  const newLines = text.split("\n").filter((l) => !fixtureLines.has(l));
  assertEquals(newLines.length, FILES.length * 4);
  assertEquals(text.split("\n").filter((l) => fixtureLines.has(l)).join("\n"), FIXTURE);
  // Every id in the file is still unique.
  const ids = [...text.matchAll(/^\t\t([0-9A-F]{24}) /gm)].map((m) => m[1]);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("addSourceFiles: idempotent — a second run changes nothing", () => {
  const once = addSourceFiles(FIXTURE, FILES).text;
  const twice = addSourceFiles(once, FILES);
  assertEquals(twice.added, []);
  assertEquals(twice.text, once);
});

Deno.test("addSourceFiles: a file already referenced and compiled is left alone", () => {
  // T3NativePlugin.swift is already in the App group and its Sources phase.
  const r = addSourceFiles(FIXTURE, ["T3NativePlugin.swift", "New.swift"]);
  assertEquals(r.added, ["New.swift"]);
  assertEquals(
    r.text.split("T3NativePlugin.swift").length,
    FIXTURE.split("T3NativePlugin.swift").length,
  );
});

Deno.test("addSourceFiles: a referenced but uncompiled file only gains the build entries", () => {
  // Drop T3NativePlugin.swift from the Sources phase and its PBXBuildFile, keep its ref.
  const uncompiled = FIXTURE.split("\n").filter((l) =>
    !l.includes("T3NativePlugin.swift in Sources")
  )
    .join("\n");
  const r = addSourceFiles(uncompiled, ["T3NativePlugin.swift"], { randomId: counterIds() });
  assertEquals(r.added, ["T3NativePlugin.swift"]);
  assertEquals(
    r.text.match(/isa = PBXFileReference;[^\n]*path = T3NativePlugin\.swift;/g)?.length,
    1,
    "the existing file reference is reused",
  );
  assertEquals(r.text.match(/T3NativePlugin\.swift in Sources/g)?.length, 2);
});

Deno.test("addSourceFiles: generated ids never collide with existing ones", () => {
  // A generator that proposes an id already in the file, then its own repeat, then fresh ones.
  const proposals = [
    "504EC3001FED79650016851F",
    "ABCDEF000000000000000001",
    "abcdef000000000000000001",
    "ABCDEF000000000000000002",
  ];
  let i = 0;
  const r = addSourceFiles(FIXTURE, ["One.swift"], { randomId: () => proposals[i++] });
  assert(r.text.includes("ABCDEF000000000000000001 /* One.swift */ = {isa = PBXFileReference"));
  assert(
    r.text.includes("ABCDEF000000000000000002 /* One.swift in Sources */ = {isa = PBXBuildFile"),
  );
  assertThrows(
    () => addSourceFiles(FIXTURE, ["Two.swift"], { randomId: () => "504EC3001FED79650016851F" }),
    Error,
    "unique object id",
  );
});

Deno.test("addSourceFiles: an unknown target or a non-project file is refused", () => {
  assertThrows(() => addSourceFiles(FIXTURE, FILES, { target: "Nope" }), Error, "no native target");
  assertThrows(() => addSourceFiles("// not a project", FILES), Error, "objects");
});

Deno.test("addSourceFiles: brackets inside comments and quoted strings do not confuse it", () => {
  // A group child whose name holds `)` and `}`, and a quoted path with a brace.
  const tricky = FIXTURE.replace(
    "504EC3071FED79650016851F /* AppDelegate.swift */,\n",
    "504EC3071FED79650016851F /* AppDelegate.swift */,\n\t\t\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* Odd ) } name.txt */,\n",
  ).replace(
    "/* End PBXFileReference section */",
    'AAAAAAAAAAAAAAAAAAAAAAAA /* Odd ) } name.txt */ = {isa = PBXFileReference; path = "Odd ) } name.txt"; sourceTree = "<group>"; };\n/* End PBXFileReference section */',
  );
  const once = addSourceFiles(tricky, FILES);
  assertEquals(once.added, FILES);
  assertEquals(addSourceFiles(once.text, FILES).added, []);
  assert(once.text.includes('path = "Odd ) } name.txt"'));
});

// addSwiftPackageProduct (src/build/pbxproj.ts): a remote Swift package and one of its products
// linked into the app target the way Xcode's "Add Package Dependencies" writes it, against the
// real Capacitor 8 project (which already links its local CapApp-SPM package) and against one with
// no Swift packages at all; idempotent, and the result still parses as a property list.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { addSwiftPackageProduct } from "../src/build/pbxproj.ts";

const FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const SQLCIPHER = {
  url: "https://github.com/sqlcipher/SQLCipher.swift.git",
  minimumVersion: "4.14.0",
  product: "SQLCipher",
};

/** Deterministic ids: 24-hex counters that cannot collide with the fixture's. */
function counterIds(): () => string {
  let n = 0;
  return () => (0xC10000 + n++).toString(16).toUpperCase().padStart(24, "0");
}

/** The text between `/* Begin <section> section *\/` and its End marker. */
function section(text: string, name: string): string {
  const start = text.indexOf(`/* Begin ${name} section */`);
  const end = text.indexOf(`/* End ${name} section */`);
  assert(start >= 0 && end > start, `no ${name} section`);
  return text.slice(start, end);
}

/** The `key = ( … );` list of the object whose body contains `marker`. */
function listOf(text: string, marker: string, key: string): string {
  const at = text.indexOf(marker);
  assert(at >= 0, marker);
  const open = text.indexOf(`${key} = (`, at);
  return text.slice(open, text.indexOf(");", open));
}

/** Whether macOS's plutil parses `text` (skipped elsewhere: true). */
async function plistParses(text: string): Promise<boolean> {
  if (Deno.build.os !== "darwin") return true;
  const dir = await Deno.makeTempDir({ prefix: "denext_pbx_" });
  try {
    const file = join(dir, "project.pbxproj");
    await Deno.writeTextFile(file, text);
    return (await new Deno.Command("plutil", { args: ["-lint", file], stdout: "null" }).output())
      .success;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("addSwiftPackageProduct: a remote package, its product and the Frameworks entry", async () => {
  const { text, added } = addSwiftPackageProduct(FIXTURE, SQLCIPHER, { randomId: counterIds() });
  assert(added);
  const ref = section(text, "XCRemoteSwiftPackageReference");
  assertStringIncludes(ref, 'XCRemoteSwiftPackageReference "SQLCipher.swift"');
  assertStringIncludes(ref, 'repositoryURL = "https://github.com/sqlcipher/SQLCipher.swift.git";');
  assertStringIncludes(ref, "kind = upToNextMajorVersion;");
  assertStringIncludes(ref, "minimumVersion = 4.14.0;");
  const products = section(text, "XCSwiftPackageProductDependency");
  assertStringIncludes(products, "productName = SQLCipher;");
  assertStringIncludes(products, "CapApp-SPM", "the existing local product stays");
  const projectRefs = listOf(text, "isa = PBXProject;", "packageReferences");
  assertStringIncludes(projectRefs, "CapApp-SPM");
  assertStringIncludes(projectRefs, "SQLCipher.swift");
  assertStringIncludes(
    listOf(text, "isa = PBXNativeTarget;", "packageProductDependencies"),
    "SQLCipher",
  );
  assertStringIncludes(
    listOf(text, "504EC3011FED79650016851F /* Frameworks */ = {", "files"),
    "SQLCipher in Frameworks",
  );
  assertStringIncludes(
    section(text, "PBXBuildFile"),
    "/* SQLCipher in Frameworks */ = {isa = PBXBuildFile; productRef =",
  );
  assert(await plistParses(text), "plutil -lint");
});

Deno.test("addSwiftPackageProduct: a second run changes nothing; a known package is reused", () => {
  const once = addSwiftPackageProduct(FIXTURE, SQLCIPHER, { randomId: counterIds() }).text;
  const twice = addSwiftPackageProduct(once, SQLCIPHER, { randomId: counterIds() });
  assertEquals(twice.added, false);
  assertEquals(twice.text, once);
  // A second product of the same package shares its reference.
  const other = addSwiftPackageProduct(once, { ...SQLCIPHER, product: "Other" }).text;
  assertEquals(other.match(/isa = XCRemoteSwiftPackageReference;/g)?.length, 1);
  assertEquals(other.match(/isa = XCSwiftPackageProductDependency;/g)?.length, 3);
});

Deno.test("addSwiftPackageProduct: a project without Swift packages gains the sections and lists", async () => {
  const bare = FIXTURE
    .replace(/\t\t\tpackageProductDependencies = \([^)]*\);\n/, "")
    .replace(/\t\t\tpackageReferences = \([^)]*\);\n/, "")
    .replace(
      /\n\/\* Begin XCLocalSwiftPackageReference section \*\/[\s\S]*?\/\* End XCLocalSwiftPackageReference section \*\/\n/,
      "\n",
    )
    .replace(
      /\n\/\* Begin XCSwiftPackageProductDependency section \*\/[\s\S]*?\/\* End XCSwiftPackageProductDependency section \*\/\n/,
      "\n",
    )
    .replace(/\t\t4D22ABE92AF431CB00220026 [^\n]*\n/, "")
    .replace(/\t\t\t\t4D22ABE92AF431CB00220026 [^\n]*\n/, "");
  assert(!bare.includes("packageReferences"));
  const { text, added } = addSwiftPackageProduct(bare, SQLCIPHER, { randomId: counterIds() });
  assert(added);
  assertStringIncludes(listOf(text, "isa = PBXProject;", "packageReferences"), "SQLCipher.swift");
  assertStringIncludes(
    listOf(text, "isa = PBXNativeTarget;", "packageProductDependencies"),
    "SQLCipher",
  );
  section(text, "XCRemoteSwiftPackageReference");
  section(text, "XCSwiftPackageProductDependency");
  assert(await plistParses(text), "plutil -lint");
  assertEquals(addSwiftPackageProduct(text, SQLCIPHER).added, false);
});

Deno.test("addSwiftPackageProduct: an unknown target is refused", () => {
  assertThrows(() => addSwiftPackageProduct(FIXTURE, SQLCIPHER, { target: "Nope" }));
});

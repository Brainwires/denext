// `denext create` scaffolding: the generated file set/content, and that the
// generated app actually type-checks against the framework.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { type ScaffoldFile, scaffoldFiles, scaffoldProject } from "../../src/build/scaffold.ts";

Deno.test("scaffoldFiles: plain project", () => {
  const files = scaffoldFiles({ dir: "/x" });
  const paths = files.map((f) => f.path).sort();
  assertEquals(paths, [
    ".gitignore",
    "app/layout.tsx",
    "app/page.tsx",
    "deno.json",
    "public/styles.css",
  ]);
  const denoJson = files.find((f) => f.path === "deno.json")!.content;
  assertStringIncludes(denoJson, "jsr:@denext/denext");
  assertStringIncludes(denoJson, '"jsxImportSource": "denext"');
  assert(!files.some((f) => f.path === "denext.config.ts"), "no config without options");
});

Deno.test("scaffoldFiles: tailwind wires globals import + input + config", () => {
  const files = scaffoldFiles({ dir: "/x", tailwind: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("styles/tailwind.css"));
  assert(paths.includes("denext.config.ts"));
  assert(!paths.includes("public/styles.css"), "tailwind replaces the static stylesheet");
  assertStringIncludes(
    files.find((f) => f.path === "app/layout.tsx")!.content,
    'import "./globals.css"',
  );
  assertStringIncludes(files.find((f) => f.path === "denext.config.ts")!.content, "tailwind:");
});

Deno.test("scaffoldFiles: src-dir + compiler", () => {
  const files = scaffoldFiles({ dir: "/x", srcDir: true, compiler: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("src/app/page.tsx"));
  assert(paths.includes("src/app/layout.tsx"));
  assertStringIncludes(
    files.find((f) => f.path === "denext.config.ts")!.content,
    "experimental: { reactCompiler: true }",
  );
});

Deno.test("scaffoldFiles: src-dir + tailwind writes output under src/app", () => {
  const files = scaffoldFiles({ dir: "/x", srcDir: true, tailwind: true });
  const config = files.find((f) => f.path === "denext.config.ts")!.content;
  // The compiled output must live where the layout imports it from (src/app).
  assertStringIncludes(config, 'output: "src/app/globals.css"');
  assertStringIncludes(
    files.find((f) => f.path === "src/app/layout.tsx")!.content,
    'import "./globals.css"',
  );
  // Generated output is gitignored.
  assertStringIncludes(files.find((f) => f.path === ".gitignore")!.content, "src/app/globals.css");
});

// Every keyword each scaffolded packaging script must mention.
// macOS: covers sign + universal + notarize.
const MACOS_PACKAGING_KEYWORDS = [
  "codesign",
  "lipo",
  "notarytool",
  "DENEXT_CODESIGN_IDENTITY",
  "--include",
];
// Linux: builds via `deno desktop --target`, tars the bundle, and uses
// underscore-free arch labels (x64) so the .desktop survives.
const LINUX_PACKAGING_KEYWORDS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "tar",
  "appimagetool",
  '"x64"',
  "--target",
];
// Windows: builds the .exe via `deno desktop --target`, zips it, and
// Authenticode-signs when a cert is configured.
const WINDOWS_PACKAGING_KEYWORDS = [
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "signtool",
  "DENEXT_WINDOWS_CERT",
  "WebView2",
  "--target",
];

/** Asserts the desktop scaffold emits `script` and that it mentions every keyword. */
function assertPackagingScript(files: ScaffoldFile[], script: string, keywords: string[]) {
  const file = files.find((f) => f.path === script);
  assert(file, `desktop scaffold includes ${script}`);
  for (const kw of keywords) {
    assertStringIncludes(file!.content, kw);
  }
}

Deno.test("scaffoldFiles: desktop wires the deno-desktop entry, config block, and tasks", () => {
  const files = scaffoldFiles({ dir: "/x", desktop: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("desktop.ts"));
  const desktop = files.find((f) => f.path === "desktop.ts")!.content;
  // The serve + window plumbing lives in denext's desktop runtime; the entry is a
  // thin call to runDesktop() that resolves out/ relative to import.meta.url.
  assertStringIncludes(desktop, "runDesktop");
  assertStringIncludes(desktop, "denext/desktop");
  assertStringIncludes(desktop, "import.meta.url");
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertStringIncludes(dj.tasks.export, "export .");
  assertStringIncludes(dj.tasks.desktop, "deno desktop desktop.ts");
  // `desktop:package` runs the packaging script (which exports, builds with `out/`
  // embedded, code-signs, and can do multi-arch + notarization).
  assertStringIncludes(dj.tasks["desktop:package"], "scripts/package-macos.ts");
  assertEquals(dj.desktop.app.identifier, "com.example.denext");
  assertStringIncludes(files.find((f) => f.path === ".gitignore")!.content, "dist/");
  // App-icon convention: an icons/ folder with instructions.
  const icons = files.find((f) => f.path === "icons/README.md");
  assert(icons, "desktop scaffold includes icons/README.md");
  assertStringIncludes(icons!.content, "app.icns");
  // The packaging script is scaffolded and covers sign + universal + notarize.
  assertPackagingScript(files, "scripts/package-macos.ts", MACOS_PACKAGING_KEYWORDS);
  // Linux packaging: a package-linux.ts + its task.
  assertStringIncludes(dj.tasks["desktop:package:linux"], "scripts/package-linux.ts");
  assertPackagingScript(files, "scripts/package-linux.ts", LINUX_PACKAGING_KEYWORDS);
  // Windows packaging: a package-windows.ts + its task.
  assertStringIncludes(dj.tasks["desktop:package:windows"], "scripts/package-windows.ts");
  assertPackagingScript(files, "scripts/package-windows.ts", WINDOWS_PACKAGING_KEYWORDS);
});

Deno.test("scaffoldFiles: scaffolded macOS package script matches the examples/native copy", async () => {
  // The checked-in example is the browsable reference; keep it byte-identical to what
  // the scaffold emits so the two never drift.
  const scaffolded = scaffoldFiles({ dir: "/x", desktop: true })
    .find((f) => f.path === "scripts/package-macos.ts")!.content;
  const example = await Deno.readTextFile(
    new URL("../../examples/native/scripts/package-macos.ts", import.meta.url),
  );
  assertEquals(scaffolded, example);
});

Deno.test("scaffoldFiles: scaffolded Windows package script matches the examples/native copy", async () => {
  const scaffolded = scaffoldFiles({ dir: "/x", desktop: true })
    .find((f) => f.path === "scripts/package-windows.ts")!.content;
  const example = await Deno.readTextFile(
    new URL("../../examples/native/scripts/package-windows.ts", import.meta.url),
  );
  assertEquals(scaffolded, example);
});

Deno.test("scaffoldFiles: scaffolded Linux package script matches the examples/native copy", async () => {
  const scaffolded = scaffoldFiles({ dir: "/x", desktop: true })
    .find((f) => f.path === "scripts/package-linux.ts")!.content;
  const example = await Deno.readTextFile(
    new URL("../../examples/native/scripts/package-linux.ts", import.meta.url),
  );
  assertEquals(scaffolded, example);
});

Deno.test("scaffoldFiles: capacitor wires config, package.json, and mobile tasks", () => {
  const files = scaffoldFiles({ dir: "/x", capacitor: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("capacitor.config.ts"));
  assert(paths.includes("package.json"));
  assertStringIncludes(
    files.find((f) => f.path === "capacitor.config.ts")!.content,
    'webDir: "out"', // matches denext's static export dir
  );
  const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
  assert(pkg.devDependencies["@capacitor/cli"], "capacitor cli devDependency");
  assert(pkg.devDependencies["@capacitor/ios"] && pkg.devDependencies["@capacitor/android"]);
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertStringIncludes(dj.tasks["mobile:sync"], "cap");
  assertStringIncludes(dj.tasks["mobile:ios"], "open ios");
  const gi = files.find((f) => f.path === ".gitignore")!.content;
  assertStringIncludes(gi, "node_modules/");
  assertStringIncludes(gi, "ios/");
});

Deno.test("scaffoldFiles: compatibilityMode adds React + Next import aliases", () => {
  const files = scaffoldFiles({ dir: "/x", compatibilityMode: true });
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertStringIncludes(dj.imports["react"], "@denext/denext");
  assertStringIncludes(dj.imports["react"], "/react");
  assertStringIncludes(dj.imports["react-dom"], "/react-dom");
  assertStringIncludes(dj.imports["react/jsx-runtime"], "/react/jsx-runtime");
  assertStringIncludes(dj.imports["next/"], "/next/"); // prefix maps all next/* submodules
  assertStringIncludes(dj.imports["react-is"], "/react-is");
  assertStringIncludes(dj.imports["next-intl"], "/next-intl");
  assertStringIncludes(dj.imports["next-intl/"], "/next-intl/");
  assertStringIncludes(dj.imports["better-sqlite3"], "/better-sqlite3");
  // Off by default.
  const plain = JSON.parse(
    scaffoldFiles({ dir: "/x" }).find((f) => f.path === "deno.json")!.content,
  );
  assert(!("react" in plain.imports), "no react/next aliases without --compatibility");
});

Deno.test("scaffoldFiles: desktop + capacitor together share one static-export task", () => {
  const files = scaffoldFiles({ dir: "/x", desktop: true, capacitor: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("desktop.ts") && paths.includes("capacitor.config.ts"));
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  // Both native targets consume the same `out/` static export — Capacitor via its
  // webDir, the desktop entry via runDesktop() (which defaults to out/).
  assertStringIncludes(dj.tasks.export, "export .");
  assertStringIncludes(files.find((f) => f.path === "capacitor.config.ts")!.content, '"out"');
  assertStringIncludes(files.find((f) => f.path === "desktop.ts")!.content, "runDesktop");
});

Deno.test("scaffoldFiles: the start task runs least-privilege (not -A)", () => {
  const files = scaffoldFiles({ dir: "/x" });
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertStringIncludes(dj.tasks.start, "--allow-net --allow-read --allow-env");
  assert(!dj.tasks.start.includes(" -A "), "start must not grant all permissions");
});

Deno.test("scaffoldProject refuses a non-empty directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    await Deno.writeTextFile(join(dir, "existing.txt"), "x");
    let threw = false;
    try {
      await scaffoldProject({ dir });
    } catch {
      threw = true;
    }
    assert(threw, "should refuse to scaffold into a non-empty dir");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("init scaffolds into an existing dir but won't overwrite existing files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_init_" });
  try {
    // A pre-existing unrelated file (e.g. a git repo's README) is fine for init.
    await Deno.writeTextFile(join(dir, "README.md"), "# my project\n");
    const written = await scaffoldProject({ dir, allowExisting: true });
    assert(written.includes("app/page.tsx"));
    assertEquals(await Deno.readTextFile(join(dir, "README.md")), "# my project\n");

    // A second init must refuse (deno.json now exists).
    let threw = false;
    try {
      await scaffoldProject({ dir, allowExisting: true });
    } catch {
      threw = true;
    }
    assert(threw, "init must refuse to overwrite an existing generated file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a scaffolded app type-checks against the framework", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    await scaffoldProject({ dir });
    // The generated deno.json points at the (unpublished) JSR package; rewrite its
    // imports to this repo's local files so `deno check` can resolve them.
    const repo = fromFileUrl(new URL("../../", import.meta.url));
    const denoJson = {
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "deno.unstable", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": join(repo, "mod.ts"),
        "denext/jsx-runtime": join(repo, "src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": join(repo, "src/jsx/jsx-runtime.ts"),
        "denext/server": join(repo, "src/server/mod.ts"),
        "denext/client": join(repo, "src/client/mod.ts"),
      },
    };
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(denoJson, null, 2));

    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        join(dir, "deno.json"),
        join(dir, "app", "page.tsx"),
        join(dir, "app", "layout.tsx"),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      out.code,
      0,
      `generated app failed type-check:\n${new TextDecoder().decode(out.stderr)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

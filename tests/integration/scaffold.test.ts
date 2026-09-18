// `denext create` scaffolding: the generated file set/content, and that the
// generated app actually type-checks against the framework.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { type ScaffoldFile, scaffoldFiles, scaffoldProject } from "../../src/build/scaffold.ts";
import { createTestApp, createTestClient } from "../../src/testing/mod.ts";

Deno.test("scaffoldFiles: plain project", () => {
  const files = scaffoldFiles({ dir: "/x" });
  const paths = files.map((f) => f.path).sort();
  assertEquals(paths, [
    ".gitignore",
    "README.md",
    "app/counter.tsx",
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

Deno.test("scaffoldFiles: the page is a Server Component and the counter is a 'use client' island", () => {
  // ONE story, Next's: Server Components by default, interactivity in "use client" islands —
  // the same shape `denext generate component` writes and AGENTS.md teaches. A hooks-bearing
  // route would hydrate as a whole (the isomorphic-route compatibility path) and fail the
  // build the moment it imported a server-only `lib/db.ts`.
  const files = scaffoldFiles({ dir: "/x" });
  const page = files.find((f) => f.path === "app/page.tsx")!.content;
  assert(!page.includes("use client"), "the page must not be a client component");
  assert(!/\buse[A-Z]\w*\(/.test(page), `the page must not call a hook:\n${page}`);
  assert(!page.includes("onClick"), "the page must not carry an event handler");
  assertStringIncludes(page, 'import { Counter } from "./counter.tsx"');
  assertStringIncludes(page, "<Counter />");

  const counter = files.find((f) => f.path === "app/counter.tsx")!.content;
  assert(counter.startsWith('"use client";'), "the island opens with the directive");
  assertStringIncludes(counter, 'from "denext"');
  assertStringIncludes(counter, "useState(0)");
  assertStringIncludes(counter, "onClick=");
  assertStringIncludes(counter, "export function Counter()");
  // Tailwind variant: the classes move with the markup they style.
  const tw = scaffoldFiles({ dir: "/x", tailwind: true });
  assertStringIncludes(tw.find((f) => f.path === "app/counter.tsx")!.content, "text-green-600");
  assertStringIncludes(tw.find((f) => f.path === "app/page.tsx")!.content, "max-w-xl");
  // The README points at the island.
  assertStringIncludes(files.find((f) => f.path === "README.md")!.content, "app/counter.tsx");
});

Deno.test("scaffoldFiles: the minimal template has no island", () => {
  const files = scaffoldFiles({ dir: "/x", template: "minimal" });
  const paths = files.map((f) => f.path);
  assert(!paths.includes("app/counter.tsx"), "minimal is a bare page");
  const page = files.find((f) => f.path === "app/page.tsx")!.content;
  assert(!page.includes("counter"), "minimal's page imports nothing");
  assert(!files.find((f) => f.path === "README.md")!.content.includes("counter.tsx"));
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
    "reactCompiler: true,",
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
  // Capacitor 8: the CLI, core and both native platforms on one release range.
  for (const name of ["cli", "core", "ios", "android"]) {
    assertEquals(pkg.devDependencies[`@capacitor/${name}`], "^8.5.2", `@capacitor/${name}`);
  }
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertEquals(dj.imports["@capacitor/cli"], "npm:@capacitor/cli@^8.5.2");
  // mobile:sync exports first, then syncs `out/` with the pinned CLI.
  assert(dj.tasks["mobile:sync"].startsWith("deno task export && "), dj.tasks["mobile:sync"]);
  assertStringIncludes(dj.tasks["mobile:sync"], "npm:@capacitor/cli@^8.5.2 sync");
  assertStringIncludes(dj.tasks["mobile:ios"], "@capacitor/cli@^8.5.2 open ios");
  assertStringIncludes(dj.tasks["mobile:android"], "@capacitor/cli@^8.5.2 open android");
  const gi = files.find((f) => f.path === ".gitignore")!.content.split("\n");
  assert(gi.includes("node_modules/"));
  // Capacitor 8 (Swift Package Manager) native projects are committed: only their build
  // outputs and the web assets `cap sync` copies in are ignored, never the whole platform dir.
  assert(!gi.includes("ios/") && !gi.includes("android/"), "ios/ + android/ stay tracked");
  assert(gi.includes("ios/App/App/public/"), "synced iOS web assets are ignored");
  assert(gi.includes("android/app/src/main/assets/public/"), "synced Android web assets ignored");
  assert(gi.includes("android/app/build/"), "Android build output is ignored");
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

Deno.test("scaffoldFiles: the start task runs least-privilege (not -A) but can write the durable cache", () => {
  const files = scaffoldFiles({ dir: "/x" });
  const dj = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertStringIncludes(
    dj.tasks.start,
    "--allow-net --allow-read --allow-env --allow-write=.denext",
  );
  assert(!dj.tasks.start.includes(" -A "), "start must not grant all permissions");
  // The default cache store is node:sqlite under .denext/ — without this grant it silently
  // downgrades to the per-process memory store. Write is scoped to that one directory.
  assert(!/--allow-write(?![=])/.test(dj.tasks.start), "write must be scoped, not blanket");
  // dev/build bundle (and spawn tooling), so they keep -A and need no separate write grant.
  assertStringIncludes(dj.tasks.dev, "deno run -A ");
  assertStringIncludes(dj.tasks.build, "deno run -A ");
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

Deno.test("scaffoldProject writes the .vscode files that turn on the Deno LSP (unless vscode: false)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    const written = await scaffoldProject({ dir });
    // Reported relative, like every other scaffolded path.
    assert(written.includes(".vscode/settings.json"), written.join(", "));
    assert(written.includes(".vscode/extensions.json"), written.join(", "));
    assert(written.includes("app/counter.tsx"), "the island is written to disk");
    const settings = JSON.parse(await Deno.readTextFile(join(dir, ".vscode", "settings.json")));
    assertEquals(settings["deno.enable"], true);
    const ext = JSON.parse(await Deno.readTextFile(join(dir, ".vscode", "extensions.json")));
    assertEquals(ext.recommendations, ["denoland.vscode-deno"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }

  const bare = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    const written = await scaffoldProject({ dir: bare, vscode: false });
    assert(!written.some((p) => p.startsWith(".vscode/")), "--no-vscode writes no editor files");
    let exists = true;
    try {
      await Deno.stat(join(bare, ".vscode"));
    } catch {
      exists = false;
    }
    assert(!exists, ".vscode/ must not be created");
    assert(!(await Deno.readTextFile(join(bare, "README.md"))).includes(".vscode"));
  } finally {
    await Deno.remove(bare, { recursive: true });
  }
});

Deno.test("init merges into an existing .vscode/settings.json instead of refusing or clobbering", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_init_" });
  try {
    await Deno.mkdir(join(dir, ".vscode"));
    // VSCode settings are JSONC — a comment must not make the file unreadable.
    await Deno.writeTextFile(
      join(dir, ".vscode", "settings.json"),
      '{\n  // keep me\n  "editor.tabSize": 2\n}\n',
    );
    await Deno.writeTextFile(
      join(dir, ".vscode", "extensions.json"),
      '{ "recommendations": ["esbenp.prettier-vscode"] }\n',
    );
    const written = await scaffoldProject({ dir, allowExisting: true });
    assert(written.includes(".vscode/settings.json"));
    const settings = JSON.parse(await Deno.readTextFile(join(dir, ".vscode", "settings.json")));
    assertEquals(settings, { "editor.tabSize": 2, "deno.enable": true });
    const ext = JSON.parse(await Deno.readTextFile(join(dir, ".vscode", "extensions.json")));
    assertEquals(ext.recommendations, ["esbenp.prettier-vscode", "denoland.vscode-deno"]);
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

Deno.test("a scaffolded app serves its home page with the island server-rendered", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    await scaffoldProject({ dir });
    // In-process, no build: the modules resolve `denext` through this test's import map.
    const client = createTestClient(await createTestApp(dir));
    const res = await client.get("/");
    assertEquals(res.status, 200);
    assertStringIncludes(res.text, "Hello from denext");
    // The island is server-rendered (its pre-hydration state), inside the server page.
    assertStringIncludes(res.text, "server-rendered (not yet hydrated)");
    assertStringIncludes(res.text, "Clicked 0 times");
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
        join(dir, "app", "counter.tsx"),
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

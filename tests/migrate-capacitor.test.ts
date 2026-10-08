// `denext migrate --enable-capacitor`: an iOS / Android Capacitor target for a migrated app (a
// Vite SPA modelled on T3 Code's `apps/web`, a Next App Router app, an Expo app), the `--check`
// plan, the steps the CLI runs (install, export, `cap add`), and the follow-ups from the T3
// migration: `.gitignore` for the desktop bundle and the native build outputs, and a local
// denext checkout's own dependencies never overriding the app's.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import {
  appIdFromPackageName,
  type CapacitorStep,
  runCapacitorSteps,
} from "../src/build/migrate-capacitor.ts";
import { createMigrateCommand } from "../src/cli/commands/migrate.ts";
import type { PlannedCommand } from "../src/build/mobile-capabilities.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

const REPO_ROOT = Deno.cwd();

/** The 24-byte head of a `size`×`size` PNG: all the icon resolver reads of one. */
function pngHead(size: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, size);
  v.setUint32(20, size);
  return b;
}

type Files = Record<string, string | Uint8Array | Record<string, unknown>>;

async function writeTree(root: string, files: Files): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    if (body instanceof Uint8Array) await Deno.writeFile(path, body);
    else await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
}

/** Run `fn` on a fresh temp dir holding `files`. */
async function withTree(files: Files, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_cap_" }));
  try {
    await writeTree(root, files);
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/**
 * A pnpm monorepo with a Vite SPA at `apps/web`, shaped like T3 Code (upstream a9fb6a80):
 * a scoped package name, `catalog:` deps (Effect 4 among them), a `prepare` script, a proxy
 * built in code, React Compiler, Tailwind, the hosted-mode env switch and backend URLs, and
 * an apple-touch-icon.
 */
function t3Like(extra: { devDependencies?: Record<string, string> } = {}): Files {
  return {
    "pnpm-workspace.yaml": "packages:\n  - apps/*\ncatalog:\n  effect: 4.0.0-beta.1\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "package.json": {
      name: "t3code",
      private: true,
      scripts: { prepare: "effect-language-service patch" },
    },
    "apps/web/package.json": {
      name: "@t3tools/web",
      version: "0.0.45",
      private: true,
      type: "module",
      scripts: { dev: "vp dev", build: "vp build" },
      dependencies: {
        react: "19.2.6",
        "react-dom": "19.2.6",
        effect: "catalog:",
        "@tanstack/react-router": "^1.160.2",
        "@t3tools/contracts": "workspace:*",
      },
      devDependencies: {
        "@tailwindcss/vite": "^4.0.0",
        vite: "^8.0.0",
        ...extra.devDependencies,
      },
    },
    "apps/web/vite.config.ts": `import { reactCompilerPreset } from "@vitejs/plugin-react";
const PREFIXES = ["/api", "/ws"];
export default {
  plugins: [reactCompilerPreset()],
  server: { proxy: Object.fromEntries(PREFIXES.map((p) => [p, "http://127.0.0.1:3773"])) },
};
`,
    "apps/web/index.html": `<!doctype html><html><head><title>T3 Code (Alpha)</title>` +
      `<link rel="apple-touch-icon" href="/apple-touch-icon.png" /></head>` +
      `<body><div id="root"></div><script type="module" src="/src/bootstrap.ts"></script>` +
      `</body></html>`,
    "apps/web/src/bootstrap.ts": `const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL;
const http = import.meta.env.VITE_HTTP_URL;
const ws = import.meta.env.VITE_WS_URL;
const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
document.getElementById("root")!.textContent = [channel, http, ws, key].join();
`,
    "apps/web/src/index.css": '@import "tailwindcss";\n',
    "apps/web/public/apple-touch-icon.png": pngHead(180),
  };
}

const CAP = "^8.5.2";

Deno.test("migrate --enable-capacitor: a T3-shaped Vite SPA gets a Capacitor target", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    const r = await migrateProject(dir, { capacitor: true });
    const c = r.capacitor!;
    assert(c, "a capacitor report");
    assertEquals(c.appId, "com.t3tools.web");
    assertEquals(c.appIdSource, "package name");
    assertEquals(c.placeholderId, true);
    assertEquals(c.appName, "T3 Code");
    assertEquals(c.configWritten, true);
    assertEquals(c.platforms, []);

    // capacitor.config.ts, snapshotted (the type-check test below compiles one).
    assertEquals(
      await Deno.readTextFile(join(dir, "capacitor.config.ts")),
      `// generated by \`denext migrate\` — safe to edit; re-running may overwrite
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // TODO: a placeholder — derived from the package name; set your bundle id (or --app-id).
  appId: "com.t3tools.web",
  appName: "T3 Code",
  // denext's static export (\`deno task export\`) writes here; Capacitor bundles it.
  webDir: "out",
};

export default config;
`,
    );

    // The config keys the shell needs: no .gz siblings, and the app icon pinned.
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(cfg, "precompress: false,");
    assertStringIncludes(cfg, 'icon: "./public/apple-touch-icon.png",');
    assertEquals(r.spa!.appIcon!.mobile, true);

    // The mobile:* tasks run the app's installed Capacitor CLI and denext's own CLI.
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertStringIncludes(deno.tasks["mobile:sync"], "deno task export && deno run -A ");
    assertStringIncludes(deno.tasks["mobile:sync"], " ota manifest out && npx cap sync");
    assertEquals(deno.tasks["mobile:ios"], "npx cap open ios");
    assertEquals(deno.tasks["mobile:android"], "npx cap open android");
    assertStringIncludes(deno.tasks["mobile:build:ios"], "--node-modules-dir=none");
    assert(String(deno.tasks["mobile:build:ios"]).endsWith(" mobile build ios"));
    assert(String(deno.tasks["mobile:build:android"]).endsWith(" mobile build android"));

    // The native build outputs are ignored.
    const ignore = await Deno.readTextFile(join(dir, ".gitignore"));
    for (const line of ["ios/App/build/", "ios/App/App/public/", "android/app/build/"]) {
      assertStringIncludes(ignore, `\n${line}\n`);
    }

    // The install: the project's package manager, dev deps, no lifecycle scripts.
    assertEquals(c.packages, [
      `@capacitor/cli@${CAP}`,
      `@capacitor/core@${CAP}`,
      `@capacitor/ios@${CAP}`,
      `@capacitor/android@${CAP}`,
    ]);
    assertEquals(c.steps.length, 1);
    assertEquals(c.steps[0].label, "install");
    assertEquals(c.steps[0].command, {
      cmd: "pnpm",
      args: ["add", "-D", "--ignore-scripts", ...c.packages],
      cwd: dir,
    });
    assertEquals(
      c.steps[0].line,
      `pnpm add -D --ignore-scripts @capacitor/cli@${CAP} @capacitor/core@${CAP} ` +
        `@capacitor/ios@${CAP} @capacitor/android@${CAP}`,
    );
    assertEquals(c.steps[0].skip, undefined);

    // What migrate cannot know.
    const review = c.review.map((f) => `${f.item}: ${f.reason}`).join("\n");
    assertStringIncludes(review, "capacitor.config.ts: appId com.t3tools.web is derived");
    assertStringIncludes(review, "build-time switches: VITE_HOSTED_APP_CHANNEL:");
    assertStringIncludes(review, "backend addresses: VITE_HTTP_URL, VITE_WS_URL:");
    assertStringIncludes(review, "the dev proxy in vite.config.ts");
    assertStringIncludes(review, "CORS: the backend must allow the origins capacitor://localhost");
    assertStringIncludes(review, "https://localhost");
    assert(!review.includes("VITE_CLERK_PUBLISHABLE_KEY"), "a key that is neither is not listed");
  });
});

Deno.test("migrate --enable-capacitor: --app-id, --platform, and packages already installed", async () => {
  await withTree(
    t3Like({ devDependencies: { "@capacitor/cli": "8.5.2", "@capacitor/core": "8.5.2" } }),
    async (root) => {
      const dir = join(root, "apps/web");
      await Deno.mkdir(join(dir, "android"));
      const r = await migrateProject(dir, {
        capacitor: true,
        appId: "com.acme.t3",
        platforms: ["ios", "android"],
      });
      const c = r.capacitor!;
      assertEquals(c.appId, "com.acme.t3");
      assertEquals(c.appIdSource, "--app-id");
      assertEquals(c.placeholderId, false);
      assertEquals(c.packages, [`@capacitor/ios@${CAP}`, `@capacitor/android@${CAP}`]);
      assertEquals(c.steps.map((s) => s.label), ["install", "export", "add ios", "add android"]);
      assertStringIncludes(c.steps[1].line, " export .");
      assertEquals(c.steps[1].command.cmd, "deno");
      assertEquals(c.steps[2].line, "npx cap add ios");
      assertEquals(c.steps[2].skip, undefined);
      assertEquals(c.steps[3].skip, "android/ already exists");
      const cap = await Deno.readTextFile(join(dir, "capacitor.config.ts"));
      assertStringIncludes(cap, 'appId: "com.acme.t3",');
      assert(!cap.includes("TODO"), "no placeholder note for a given id");
      assert(!c.review.some((f) => f.item === "capacitor.config.ts"), "no app id review item");
    },
  );
});

Deno.test("migrate --enable-capacitor: an invalid --app-id or --platform is refused before writing", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    await assertRejects(
      () => migrateProject(dir, { capacitor: true, appId: "com.acme-app" }),
      Error,
      "is not a valid app id",
    );
    await assertRejects(
      () => migrateProject(dir, { capacitor: true, platforms: ["windows"] }),
      Error,
      "--platform",
    );
    const wrote = await Deno.stat(join(dir, "deno.json")).then(() => true, () => false);
    assertEquals(wrote, false);
  });
});

Deno.test("migrate --enable-capacitor: the app id comes from the desktop identifier", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { desktop: { app: { name: "T3", identifier: "com.example.t3.desktop" } } };\n`,
    );
    const r = await migrateProject(dir, { capacitor: true });
    assertEquals(r.capacitor!.appId, "com.example.t3.desktop");
    assertEquals(r.capacitor!.appIdSource, "desktop identifier");
    assertEquals(r.capacitor!.placeholderId, false);
  });
});

Deno.test("migrate --enable-capacitor: a kept config is reported; no lockfile → the install is printed", async () => {
  await withTree(
    {
      "package.json": { name: "web", dependencies: { react: "^19", "react-dom": "^19" } },
      "vite.config.ts": "export default {};\n",
      "index.html": `<!doctype html><html><head><title>Web</title></head><body>` +
        `<div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx": "export {};\n",
      "capacitor.config.json": { appId: "io.acme.web", appName: "Acme", webDir: "dist" },
    },
    async (dir) => {
      const r = await migrateProject(dir, { capacitor: true, platforms: ["ios"] });
      const c = r.capacitor!;
      assertEquals(c.configWritten, false);
      assertEquals(c.existingConfig, "capacitor.config.json");
      assertEquals(c.appId, "io.acme.web");
      assertEquals(c.appIdSource, "capacitor config");
      assertEquals(c.appName, "Acme");
      const ts = await Deno.stat(join(dir, "capacitor.config.ts")).then(() => true, () => false);
      assertEquals(ts, false, "no second config beside the kept one");
      assert(
        c.review.some((f) => f.item === "capacitor.config.json" && f.reason.includes('"dist"')),
        "the kept config's webDir is flagged",
      );
      assertEquals(
        c.steps[0].line,
        `npm install -D --ignore-scripts @capacitor/cli@${CAP} ` +
          `@capacitor/core@${CAP} @capacitor/ios@${CAP}`,
      );
      assertStringIncludes(c.steps[0].skip!, "no lockfile");
      assertStringIncludes(c.steps[2].skip!, "not installed yet");
      const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
      assertStringIncludes(deno.tasks["mobile:ios"], "npm:@capacitor/cli@");
    },
  );
});

Deno.test("runCapacitorSteps: runs in order, leaves skipped steps, stops at a failure", async () => {
  const cmd = (name: string): PlannedCommand => ({ cmd: name, args: [], cwd: "/x" });
  const steps: CapacitorStep[] = [
    { label: "install", command: cmd("a"), line: "a" },
    { label: "export", command: cmd("b"), line: "b" },
    { label: "add ios", command: cmd("c"), line: "c", skip: "ios/ already exists" },
    { label: "add android", command: cmd("d"), line: "d" },
  ];
  const seen: string[] = [];
  const ok = await runCapacitorSteps(steps, (c) => {
    seen.push(c.cmd);
    return Promise.resolve({ code: 0 });
  });
  assertEquals(seen, ["a", "b", "d"]);
  assertEquals(ok, {
    ran: ["a", "b", "d"],
    pending: [{ line: "c", reason: "ios/ already exists" }],
  });
  const bad = await runCapacitorSteps(
    steps,
    (c) => Promise.resolve({ code: c.cmd === "b" ? 3 : 0 }),
  );
  assertEquals(bad.ran, ["a"]);
  assertEquals(bad.failed, { line: "b", code: 3 });
  assertEquals(bad.pending.map((p) => p.line), ["c", "d"]);
});

Deno.test("appIdFromPackageName: a scope becomes the domain", () => {
  assertEquals(appIdFromPackageName("@t3tools/web", "T3"), "com.t3tools.web");
  assertEquals(appIdFromPackageName("my-app", "x"), "com.example.myapp");
  assertEquals(appIdFromPackageName(undefined, "T3 Code"), "com.example.t3code");
  assertEquals(appIdFromPackageName("@1x/2y", "x"), "com.app1x.app2y");
});

Deno.test("migrate --check --enable-capacitor: the files, the commands and the review items", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    const report = await checkMigration(dir, {
      capacitor: true,
      appId: "com.acme.t3",
      platforms: ["ios"],
    });
    assertEquals(report.verdict, "review");
    const changed = report.changes.map((c) => `${c.action} ${c.path}`);
    assert(changed.includes("create capacitor.config.ts"), changed.join(", "));
    assertEquals(report.commands, [
      `pnpm add -D --ignore-scripts @capacitor/cli@${CAP} @capacitor/core@${CAP} ` +
      `@capacitor/ios@${CAP}`,
      report.commands![1],
      "npx cap add ios",
    ]);
    assertStringIncludes(report.commands![1], " export .");
    assert(report.review.some((f) => f.item === "CORS"), "CORS is a review item");
    assertEquals(
      report.command,
      "denext migrate --enable-capacitor --app-id com.acme.t3 --platform ios",
    );
    const wrote = await Deno.stat(join(dir, "capacitor.config.ts")).then(() => true, () => false);
    assertEquals(wrote, false, "a check writes nothing");
  });
});

Deno.test("migrate --enable-capacitor: a Next App Router app, and a Pages Router app is refused", async () => {
  await withTree(
    {
      "package.json": { name: "shop", dependencies: { next: "15.0.0", react: "19.0.0" } },
      "package-lock.json": "{}",
      "app/layout.tsx": "export default function L({ children }) { return children; }\n",
      "app/page.tsx": "export default function P() { return null; }\n",
      "app/api/hello/route.ts": "export function GET() { return Response.json({}); }\n",
      "app/actions.ts": '"use server";\nexport async function save() {}\n',
      "assets/icon.png": pngHead(1024),
    },
    async (dir) => {
      const r = await migrateProject(dir, { capacitor: true, appId: "com.acme.shop" });
      const c = r.capacitor!;
      assertEquals(c.configWritten, true);
      assertEquals(c.appName, "shop");
      assertStringIncludes(
        await Deno.readTextFile(join(dir, "capacitor.config.ts")),
        'webDir: "out"',
      );
      const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
      assertStringIncludes(cfg, 'icon: "./assets/icon.png"');
      assert(!cfg.includes("precompress"), "the App Router export never precompresses");
      const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
      assertEquals(deno.tasks["mobile:ios"], "npx cap open ios");
      const review = c.review.map((f) => `${f.item}: ${f.reason}`).join("\n");
      assertStringIncludes(review, "server code: app/actions.ts, app/api/hello/route.ts:");
      assertStringIncludes(review, "denext mobile add export-routes");
      assertStringIncludes(
        await Deno.readTextFile(join(dir, ".gitignore")),
        "\nandroid/app/build/\n",
      );
    },
  );
  await withTree(
    {
      "package.json": { name: "old", dependencies: { next: "15.0.0", react: "19.0.0" } },
      "pages/index.tsx": "export default function P() { return null; }\n",
    },
    async (dir) => {
      const r = await migrateProject(dir, { capacitor: true });
      assertEquals(r.capacitor, undefined);
      assertStringIncludes(r.capacitorSkipped!, "Pages Router");
      const cap = await Deno.stat(join(dir, "capacitor.config.ts")).then(() => true, () => false);
      assertEquals(cap, false);
    },
  );
});

Deno.test("migrate --from expo --enable-capacitor: the same shell, the steps, --app-id wins", async () => {
  await withTree(
    {
      "package.json": {
        name: "acme",
        main: "index.ts",
        dependencies: { expo: "~57.0.18", react: "19.2.3", "react-native": "0.86.3" },
      },
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "app.json": { expo: { name: "Acme", ios: { bundleIdentifier: "com.acme.app" } } },
      "index.ts": "export {};\n",
    },
    async (dir) => {
      const plain = await migrateProject(dir, { from: "expo", denextLocalPath: REPO_ROOT });
      assertEquals(plain.capacitor, undefined, "the shell steps need the flag");
      assertEquals(plain.expo!.capacitor.appId, "com.acme.app");
      const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
      assertEquals(deno.tasks["mobile:ios"], "npx cap open ios");
      assertStringIncludes(await Deno.readTextFile(join(dir, ".gitignore")), "\nios/App/build/\n");

      const r = await migrateProject(dir, {
        from: "expo",
        denextLocalPath: REPO_ROOT,
        capacitor: true,
        appId: "com.acme.other",
      });
      assertEquals(r.capacitor!.appId, "com.acme.other");
      assertEquals(r.expo!.capacitor.appId, "com.acme.other");
      assertStringIncludes(
        await Deno.readTextFile(join(dir, "capacitor.config.ts")),
        'appId: "com.acme.other"',
      );
      assertEquals(r.capacitor!.steps[0].command.cmd, "pnpm");
    },
  );
});

Deno.test("migrate CLI --enable-capacitor: runs the install and cap add, and reports", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    const ran: PlannedCommand[] = [];
    const command = createMigrateCommand((c) => {
      ran.push(c);
      return Promise.resolve({ code: 0 });
    });
    const out = capture();
    try {
      await command.run(makeCtx({
        positionals: [dir],
        flags: { "enable-capacitor": true, "app-id": "com.acme.t3", platform: "ios" },
      }));
    } finally {
      out.restore();
    }
    assertEquals(ran.map((c) => c.cmd), ["pnpm", "deno", "npx"]);
    assertEquals(ran[2].args, ["cap", "add", "ios"]);
    const log = out.logs.join("\n");
    assertStringIncludes(log, "Capacitor: wrote capacitor.config.ts");
    assertStringIncludes(log, "com.acme.t3");
    assertStringIncludes(log, "ran: npx cap add ios");
    assertStringIncludes(log, "CORS");
  });
});

Deno.test("migrate CLI --enable-capacitor: a failed install prints what is left", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    const command = createMigrateCommand(() => Promise.resolve({ code: 1 }));
    const out = capture();
    try {
      await command.run(makeCtx({
        positionals: [dir],
        flags: { "enable-capacitor": true, platform: "ios" },
      }));
    } finally {
      out.restore();
    }
    const log = out.logs.join("\n");
    assertStringIncludes(log, "failed (exit 1): pnpm add -D --ignore-scripts");
    assertStringIncludes(log, "npx cap add ios");
  });
});

Deno.test("migrate CLI: --enable-capacitor on a Pages Router app says it was not applied", async () => {
  await withTree(
    {
      "package.json": { name: "old", dependencies: { next: "15.0.0", react: "19.0.0" } },
      "pages/index.tsx": "export default function P() { return null; }\n",
    },
    async (dir) => {
      const out = capture();
      try {
        await createMigrateCommand(() => Promise.resolve({ code: 0 })).run(makeCtx({
          positionals: [dir],
          flags: { "enable-capacitor": true },
        }));
      } finally {
        out.restore();
      }
      assertStringIncludes(out.logs.join("\n"), "--enable-capacitor not applied");
      const report = await checkMigration(dir, { capacitor: true });
      assert(report.wontMigrate.some((f) => f.item === "--enable-capacitor"));
    },
  );
});

Deno.test("migrate --desktop: .gitignore covers the bundle `deno task desktop` writes", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    await migrateProject(dir, { desktop: true });
    const ignore = await Deno.readTextFile(join(dir, ".gitignore"));
    assertStringIncludes(ignore, "\n/*.app/\n");
    assert(!ignore.includes("ios/App/build/"), "no Capacitor lines without a Capacitor target");
  });
});

Deno.test("migrate --denext-local-path: denext's own deps never override the app's", async () => {
  // SPA path (pnpm → manual node_modules): the app's `effect` (Effect 4, a catalog: range)
  // resolves from node_modules; the checkout's `effect@^3` must not shadow it.
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    await migrateProject(dir, { denextLocalPath: REPO_ROOT });
    const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
    assertEquals(imports.effect, undefined, "the app's effect is not mapped to denext's");
    assertEquals(imports.jsqr, undefined, "a dep denext's runtime source never imports");
    assertStringIncludes(imports["@std/path"], "jsr:@std/path", "one denext's source does");
    assertStringIncludes(imports.esbuild, "npm:esbuild");
  });
  // Next path: a `catalog:` effect is not pinned, and denext's must not fill the gap.
  await withTree(
    {
      "package.json": {
        name: "n",
        dependencies: { next: "15.0.0", react: "19.0.0", effect: "catalog:" },
      },
      "app/page.tsx": "export default function P() { return null; }\n",
    },
    async (dir) => {
      await migrateProject(dir, { denextLocalPath: REPO_ROOT });
      const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
      assertEquals(imports.effect, undefined);
      assert(imports["@denext/effect"], "the bridge is still mapped");
    },
  );
});

Deno.test("capacitor.config.ts type-checks against @capacitor/cli (when cached)", async () => {
  await withTree(t3Like(), async (root) => {
    const dir = join(root, "apps/web");
    await migrateProject(dir, { capacitor: true });
    const probe = join(root, "probe");
    await Deno.mkdir(probe);
    await Deno.copyFile(join(dir, "capacitor.config.ts"), join(probe, "capacitor.config.ts"));
    await Deno.writeTextFile(
      join(probe, "deno.json"),
      JSON.stringify({ imports: { "@capacitor/cli": "npm:@capacitor/cli@8.5.2" } }),
    );
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--cached-only", "--node-modules-dir=none", "capacitor.config.ts"],
      cwd: probe,
      stdout: "null",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(stderr);
    if (code !== 0 && /cached-only|not found in cache|Could not find/i.test(err)) {
      console.log("  (skipped: @capacitor/cli@8.5.2 is not in the Deno cache)");
      return;
    }
    assertEquals(code, 0, err);
  });
});

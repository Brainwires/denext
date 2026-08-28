// `denext migrate` on a Vite React SPA: generates a `mode:"spa"` denext.config.ts +
// a deno.json (react aliases + `~/` path alias), derives `spa.env` from the Vite
// `define`/`import.meta.env` usage, detects Tailwind, and (with --desktop) writes a
// thin desktop.ts + `spa.proxy` (prefixes parsed from the Vite proxy).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";

async function writeViteApp(dir: string, opts: { pnpm?: boolean } = {}): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "web",
      version: "1.2.3",
      dependencies: {
        react: "^19",
        "react-dom": "^19",
        "@tailwindcss/vite": "^4",
        "lucide-react": "^0.4",
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "vite.config.ts"),
    `export default {
  define: {
    "import.meta.env.VITE_FOO": JSON.stringify(""),
    "import.meta.env.APP_VERSION": JSON.stringify("x"),
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3773" },
      "/ws": { target: "http://localhost:3773", ws: true },
    },
  },
};
`,
  );
  await Deno.writeTextFile(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>My App</title></head><body>` +
      `<div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
  );
  await Deno.writeTextFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { jsx: "react-jsx", paths: { "~/*": ["./src/*"] } } }),
  );
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "src", "index.css"), "@import 'tailwindcss';\n");
  // A web icon so the desktop task wires `--icon` (its existence is all migrate checks;
  // the icon file itself is composed at build time by `export`).
  await Deno.mkdir(join(dir, "public"), { recursive: true });
  await Deno.writeTextFile(join(dir, "public", "apple-touch-icon.png"), "\x89PNG\r\n");
  await Deno.writeTextFile(
    join(dir, "src", "app.tsx"),
    `export const api = import.meta.env.VITE_BAR;\n`,
  );
  if (opts.pnpm) await Deno.writeTextFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
}

Deno.test("migrate SPA (pnpm + --desktop): config, aliases, env union, tailwind, parsed proxy", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_" });
  try {
    await writeViteApp(dir, { pnpm: true });
    // backend given but prefixes NOT — exercises the vite.config proxy parser.
    const r = await migrateProject(dir, { desktop: true, backend: "http://127.0.0.1:3773" });

    assertEquals(r.kind, "spa");
    assertEquals(r.spa?.nodeModulesDir, "manual");
    assertEquals(r.spa?.tailwind, true);
    // env keys are the union of vite define + src usage, sorted.
    assertEquals(r.spa?.envKeys, ["APP_VERSION", "VITE_BAR", "VITE_FOO"]);
    // proxy prefixes parsed from the literal vite.config proxy.
    assertEquals(r.spa?.proxy, { prefixes: ["/api", "/ws"], target: "http://127.0.0.1:3773" });

    // deno.json
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(cfg.nodeModulesDir, "manual");
    assert(cfg.unstable.includes("sloppy-imports"));
    assertEquals(cfg.compilerOptions.jsx, "react-jsx");
    assertEquals(cfg.compilerOptions.jsxImportSource, "react");
    assert(String(cfg.imports["react"]).includes("@denext/denext"), "react → denext");
    assert(String(cfg.imports["react-dom/client"]).includes("/react-dom/client"));
    assertEquals(cfg.imports["~/"], "./src/");
    assert(String(cfg.imports["denext/desktop"]).includes("/desktop"));
    // manual mode → npm deps resolve from node_modules, no npm: passthrough entries.
    assert(!("lucide-react" in cfg.imports), "no npm passthrough under manual");
    assert(cfg.tasks.dev && cfg.tasks.desktop, "dev + desktop tasks");
    // The desktop bundle must trim the app's npm snapshot (`--exclude-unused-npm`),
    // embed the static export it serves at runtime (`--include out`), bake the runtime
    // permissions the compiled app needs (env/net/read), and wire the composed app icon.
    assert(
      cfg.tasks.desktop.includes("--exclude-unused-npm"),
      "desktop task trims unused npm",
    );
    assert(cfg.tasks.desktop.includes("--include out"), "desktop task embeds the export");
    assert(
      cfg.tasks.desktop.includes("--allow-env") &&
        cfg.tasks.desktop.includes("--allow-net") &&
        cfg.tasks.desktop.includes("--allow-read"),
      "desktop task bakes the runtime permissions",
    );
    assert(
      cfg.tasks.desktop.includes("--icon desktop-icon.png"),
      "desktop task wires the composed icon (built by `export`)",
    );

    // denext.config.ts
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(config.includes('mode: "spa"'));
    // Surfaces the icon override so it's discoverable (commented → the build-time
    // auto-detection stays the default).
    assert(
      config.includes("desktop: { icon:"),
      "denext.config.ts shows the spa.desktop.icon override",
    );
    assert(config.includes("compatibilityMode: true"));
    assert(
      config.includes('tailwind: { input: "./src/index.css", output: "./src/index.gen.css" }'),
    );
    assert(config.includes('entry: "./src/main.tsx"'));
    assert(config.includes('title: "My App"'));
    assert(config.includes('VITE_FOO: ""') && config.includes('VITE_BAR: ""'));
    assert(config.includes("APP_VERSION: pkg.version"));
    assert(config.includes('import pkg from "./package.json"'));
    assert(config.includes('prefixes: ["/api", "/ws"]'));
    assert(config.includes('target: "http://127.0.0.1:3773"'));

    // desktop.ts
    const desktop = await Deno.readTextFile(join(dir, "desktop.ts"));
    assert(desktop.includes("runDesktop"));
    assert(desktop.includes('import config from "./denext.config.ts"'));
    assert(desktop.includes("config.spa?.proxy"));
    assertEquals(r.spa?.desktopWritten, true);

    // .gitignore ignores the generated build artifacts: build cache, export, the Tailwind
    // output (this app uses Tailwind), and desktop-icon.png (--desktop).
    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"));
    for (const entry of [".denext/", "out/", "src/index.gen.css", "desktop-icon.png"]) {
      assert(gitignore.includes(entry), `.gitignore missing ${entry}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate SPA (no pnpm, no --desktop): nodeModulesDir auto + npm passthrough, no desktop.ts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_auto_" });
  try {
    await writeViteApp(dir, { pnpm: false });
    const r = await migrateProject(dir);

    assertEquals(r.kind, "spa");
    assertEquals(r.spa?.nodeModulesDir, "auto");
    assertEquals(r.spa?.desktopWritten, false);
    assertEquals(r.spa?.proxy, undefined);

    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(cfg.nodeModulesDir, "auto");
    assert(
      String(cfg.imports["lucide-react"]).startsWith("npm:lucide-react@"),
      "npm passthrough under auto",
    );
    assert(!("denext/desktop" in cfg.imports), "no desktop import without --desktop");
    assert(!cfg.tasks.desktop, "no desktop task");

    assertEquals(await exists(join(dir, "desktop.ts")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

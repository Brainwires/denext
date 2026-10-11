// A denext app inside a pnpm workspace (src/build/pnpm-workspace.ts): Deno 2.9 rewrites the
// workspace's root package.json from pnpm-workspace.yaml when a process in its manual
// node_modules cannot find an `npm:` package there (the denext CLI's own esbuild). Every
// `deno run` of the CLI denext starts for such an app (`mobile build`'s export, `mobile dev` /
// `desktop dev`'s dev server, the UI's children, a binary's pinned re-exec) goes through
// `cliInvocation`, which adds `--node-modules-dir=none` there and nowhere else.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { cliInvocation } from "../src/ui/proc.ts";
import { cliNpmModeArgs, inPnpmWorkspace } from "../src/build/pnpm-workspace.ts";
import { migrateProject } from "../src/build/migrate.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

const ROOT_PACKAGE_JSON = '{\n  "name": "mono",\n  "private": true\n}\n';

/** A pnpm workspace with `apps/web`, a Vite React SPA (react is aliased to denext). */
async function workspace(): Promise<{ root: string; app: string }> {
  const root = await Deno.makeTempDir({ prefix: "denext_pnpm_ws_" });
  const app = join(root, "apps", "web");
  const files: Record<string, string> = {
    "package.json": ROOT_PACKAGE_JSON,
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/web/package.json": JSON.stringify({
      name: "web",
      private: true,
      type: "module",
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { vite: "^7.0.0" },
    }),
    "apps/web/node_modules/.modules.yaml": "layoutVersion: 5\n",
    "apps/web/vite.config.ts": "export default {};\n",
    "apps/web/index.html":
      '<!doctype html><html><head><title>W</title></head><body><div id="root">' +
      '</div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    "apps/web/src/main.tsx": 'import { createRoot } from "react-dom/client";\n' +
      'createRoot(document.getElementById("root")!).render(<p>hi</p>);\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), content);
  }
  return { root, app };
}

/** Run `deno <args>` in `cwd`; the exit code and output. */
async function deno(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    env: { DENEXT_MIN_DEP_AGE: "0", NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder();
  return { code, out: text.decode(stdout) + text.decode(stderr) };
}

Deno.test("pnpm workspace: detected at or above the project; the CLI flag only there", async () => {
  const { root, app } = await workspace();
  const outside = await Deno.makeTempDir({ prefix: "denext_no_ws_" });
  try {
    assert(inPnpmWorkspace(app));
    assert(inPnpmWorkspace(root));
    assertEquals(inPnpmWorkspace(outside), false);
    assertEquals(cliNpmModeArgs(app), ["--node-modules-dir=none"]);
    assertEquals(cliNpmModeArgs(outside), []);
    assertEquals(cliNpmModeArgs(undefined), []);

    const inside = cliInvocation({ dir: app });
    assertEquals(inside.slice(0, 3), ["run", "-A", "--node-modules-dir=none"]);
    // Elsewhere the argv is what it always was.
    assertEquals(cliInvocation({ dir: outside }).slice(0, 2), ["run", "-A"]);
    assertEquals(cliInvocation({ dir: outside }).length, 3);
    assertEquals(cliInvocation().length, 3);
    // The offline flags still follow.
    assertEquals(cliInvocation({ dir: app, offline: true }).slice(2, 5), [
      "--node-modules-dir=none",
      "--deny-net",
      "--cached-only",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("pnpm workspace: migrate + export leave the root package.json byte-identical", async () => {
  const { root, app } = await workspace();
  const pkg = join(root, "package.json");
  try {
    const result = await migrateProject(app, { denextLocalPath: REPO });
    assertEquals(result.kind, "spa");
    assertEquals(await Deno.readTextFile(pkg), ROOT_PACKAGE_JSON, "after migrate");
    const denoJson = JSON.parse(await Deno.readTextFile(join(app, "deno.json")));
    assertEquals(denoJson.nodeModulesDir, "manual", "a pnpm app keeps its node_modules");

    // The export child exactly as `denext mobile build` starts it.
    const exported = await deno(
      [...cliInvocation({ dir: app }), "export", app, "--platform", "android"],
      app,
    );
    assertEquals(exported.code, 0, exported.out);
    assertEquals(await Deno.readTextFile(pkg), ROOT_PACKAGE_JSON, "after export");

    // What the flag prevents: a module whose `npm:` import is not in the pnpm node_modules,
    // run as the CLI is. With the flag it resolves from Deno's cache; without it, Deno 2.9
    // fails and "migrates" pnpm-workspace.yaml into the root package.json.
    const probe = join(app, "probe.ts");
    await Deno.writeTextFile(probe, 'import "npm:esbuild@^0.24.0";\nconsole.log("loaded");\n');
    const prefix = cliInvocation({ dir: app }).slice(0, -1);
    const withFlag = await deno([...prefix, probe], app);
    assertEquals(withFlag.code, 0, withFlag.out);
    assertEquals(await Deno.readTextFile(pkg), ROOT_PACKAGE_JSON, "with the flag");
    if (Deno.version.deno.startsWith("2.9.")) {
      const bare = await deno(["run", "-A", probe], app);
      assertNotEquals(bare.code, 0, bare.out);
      assertNotEquals(await Deno.readTextFile(pkg), ROOT_PACKAGE_JSON, "without the flag");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// CI regression test: a PACKAGED desktop app is self-contained even when its import map points at
// local modules by ABSOLUTE path (macOS / Linux; Linux under a display, e.g. xvfb-run).
//
// A compiled binary embeds every module of its graph, but resolves an absolute local import-map
// target (`"denext/desktop": "file:///…/src/build/desktop.ts"`) to the build machine's path: it read
// denext from the build machine's disk while that existed, and failed with `Module not found` once
// the folder was moved. The package scripts now hand `deno desktop` a relocatable copy of the map
// (`desktopIncludeArgs` → `--import-map .deno-desktop/import-map.json`).
//
// This builds a tiny app in a temp folder whose deno.json maps `denext` (a copy of this checkout's
// `mod.ts` + `src/`) and a probe module by absolute `file:` URL, with a desktop extension that
// imports the probe; packages it with the scaffolded script on denext's pinned runtime; MOVES the
// denext copy and the probe away; then launches the packaged executable and requires it to load the
// extension (the probe's marker) and start listening, with no `Module not found`.
//
//   deno run -A scripts/ci/desktop-relocation-smoke.ts

import { join, toFileUrl } from "@std/path";
import {
  DESKTOP_RUNTIME_CONFIG_FILE,
  desktopRuntimeConfigText,
} from "../../src/build/desktop-app-config.ts";
import {
  copyDenext,
  denextDenoJson,
  packageApp,
  report,
  requireMacOrLinux,
  ROOT,
} from "./_packaged-app.ts";

const APP_NAME = "relocation-smoke";
const MARKER = "relocation-probe: loaded from the embedded graph";

requireMacOrLinux("desktop-relocation-smoke");

/** Write the app: deno.json (absolute `file:` targets), config, entry, extension, export. */
async function writeApp(app: string, denext: string, probe: string): Promise<void> {
  const root = await denextDenoJson(denext);
  const imports = root.imports;
  imports["relocation-probe"] = toFileUrl(join(probe, "probe.ts")).href;
  const desktopApp = { name: APP_NAME, identifier: "dev.denext.relocation-smoke" };
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify(
      {
        compilerOptions: root.compilerOptions,
        imports,
        desktop: { app: desktopApp },
      },
      null,
      2,
    ),
  );
  const config = {
    desktop: {
      app: desktopApp,
      installers: { macos: [], linux: [], windows: [] },
      capabilities: { extensions: ["./ext.ts"] },
    },
  };
  await Deno.writeTextFile(
    join(app, "denext.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
  );
  // The entry reads the config's runtime part from `.deno-desktop/config.json`, as a scaffolded
  // one does: a first copy here, which the package script's sync rewrites from the config.
  await Deno.mkdir(join(app, ".deno-desktop"), { recursive: true });
  await Deno.writeTextFile(
    join(app, DESKTOP_RUNTIME_CONFIG_FILE),
    desktopRuntimeConfigText(config),
  );
  await Deno.writeTextFile(
    join(app, "desktop.ts"),
    'import config from "./.deno-desktop/config.json" with { type: "json" };\n' +
      'import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";\n' +
      "await runDesktop({\n" +
      "  importMetaUrl: import.meta.url,\n" +
      "  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),\n" +
      "});\n",
  );
  // The extension's own graph reaches the probe (an absolute import-map target of its own).
  await Deno.writeTextFile(
    join(app, "ext.ts"),
    'import { defineDesktopExtension } from "denext/desktop";\n' +
      'import { probe } from "relocation-probe";\n' +
      'export default defineDesktopExtension({ name: "relocation", methods: { probe: { handler: () => probe() } } });\n',
  );
  await Deno.writeTextFile(
    join(probe, "probe.ts"),
    `console.log(${JSON.stringify(MARKER)});\nexport const probe = () => "ok";\n`,
  );
  await Deno.mkdir(join(app, "out"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "out", "index.html"),
    "<!doctype html><title>relocation smoke</title><p>ok</p>\n",
  );
}

/** Launch `exe` through `desktop-launch-smoke.ts` (listens, stays up, stopped), echoing and
 * returning the app's output and whether the smoke passed. */
async function launch(exe: string): Promise<{ output: string; ok: boolean }> {
  const smoke = join(ROOT, "scripts", "ci", "desktop-launch-smoke.ts");
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", smoke, exe],
    stdin: "null",
  }).output();
  Deno.stdout.writeSync(stdout);
  Deno.stderr.writeSync(stderr);
  const decoder = new TextDecoder();
  return { output: decoder.decode(stdout) + decoder.decode(stderr), ok: code === 0 };
}

const scratch = await Deno.makeTempDir({ prefix: "denext-relocation-" });
const denext = join(scratch, "denext");
const probe = join(scratch, "probe");
const app = join(scratch, "app");
const problems: string[] = [];
try {
  await Deno.mkdir(probe);
  await Deno.mkdir(app);
  await copyDenext(denext);
  await writeApp(app, denext, probe);
  const exe = await packageApp(app, APP_NAME);

  // The build machine's copies are gone: the app must run from what it embedded.
  await Deno.rename(denext, `${denext}.moved`);
  await Deno.rename(probe, `${probe}.moved`);
  const { output, ok } = await launch(exe);
  if (/Module not found/.test(output)) {
    problems.push("the packaged app tried to load a module from the build machine's disk");
  }
  if (!output.includes(MARKER)) problems.push("the extension's own import did not load");
  if (!ok) problems.push("the app did not launch, listen and stay up");
} finally {
  await Deno.remove(scratch, { recursive: true }).catch(() => {});
}

report(
  "desktop relocation smoke",
  problems,
  "absolute import-map targets load from the packaged app",
);

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

import { copy } from "@std/fs";
import { join, resolve, toFileUrl } from "@std/path";

const ROOT = resolve(import.meta.dirname!, "..", "..");
const OS = Deno.build.os;
const APP_NAME = "relocation-smoke";
const MARKER = "relocation-probe: loaded from the embedded graph";
/** The Linux bundle directory's suffix per architecture (`dist/<name>-<label>`). */
const LINUX_LABELS: Record<string, string> = { x86_64: "x64", aarch64: "arm64" };

if (OS !== "darwin" && OS !== "linux") {
  console.error("desktop-relocation-smoke: macOS / Linux only");
  Deno.exit(2);
}

/** Run a command in `cwd`, streaming its output; throw on a non-zero exit. */
async function run(cmd: string[], cwd: string): Promise<void> {
  const { code } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
}

/** Write the app: deno.json (absolute `file:` targets), config, entry, extension, export. */
async function writeApp(app: string, denext: string, probe: string): Promise<void> {
  const root = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const rootImports = root.imports as Record<string, string>;
  const imports: Record<string, string> = {};
  for (const [key, value] of Object.entries(rootImports)) {
    imports[key] = value.startsWith("./") ? toFileUrl(join(denext, value)).href : value;
  }
  imports["denext/desktop"] = toFileUrl(join(denext, "src", "build", "desktop.ts")).href;
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
  await Deno.writeTextFile(
    join(app, "denext.config.ts"),
    `export default ${
      JSON.stringify({
        desktop: {
          app: desktopApp,
          installers: { macos: [], linux: [], windows: [] },
          capabilities: { extensions: ["./ext.ts"] },
        },
      })
    };\n`,
  );
  await Deno.writeTextFile(
    join(app, "desktop.ts"),
    'import config from "./denext.config.ts";\n' +
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

/** macOS: the `.app`'s `Contents/MacOS/<CFBundleExecutable>`. */
async function macExecutable(bundle: string): Promise<string> {
  const plist = await Deno.readTextFile(join(bundle, "Contents", "Info.plist"));
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!exe) throw new Error(`no CFBundleExecutable in ${bundle}`);
  return join(bundle, "Contents", "MacOS", exe);
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
  await Deno.mkdir(denext);
  await Deno.mkdir(probe);
  await Deno.mkdir(app);
  await copy(join(ROOT, "mod.ts"), join(denext, "mod.ts"));
  await copy(join(ROOT, "src"), join(denext, "src"));
  await writeApp(app, denext, probe);

  const cli = join(ROOT, "cli.ts");
  await run(
    [Deno.execPath(), "run", "-A", cli, "desktop", "package", "--regenerate-scripts", "."],
    app,
  );
  const script = OS === "darwin" ? "package-macos.ts" : "package-linux.ts";
  await run([Deno.execPath(), "run", "-A", join("scripts", script), "--no-export"], app);
  // Linux: the bundle directory `dist/<name>-<label>` holds a launcher of the same name.
  const linuxBundle = `${APP_NAME}-${LINUX_LABELS[Deno.build.arch]}`;
  const exe = OS === "darwin"
    ? await macExecutable(join(app, "dist", `${APP_NAME}.app`))
    : join(app, "dist", linuxBundle, linuxBundle);

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

if (problems.length > 0) {
  console.error(`\n✗ desktop relocation smoke:\n  - ${problems.join("\n  - ")}`);
  Deno.exit(1);
}
console.log(
  "\n✓ desktop relocation smoke: absolute import-map targets load from the packaged app",
);

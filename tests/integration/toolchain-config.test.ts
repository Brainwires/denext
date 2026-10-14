// The toolchain re-exec keeps the project's config. `deno task build` in a scaffolded app runs
// `deno run -A jsr:@denext/denext@<v>/cli build`: Deno discovers the app's deno.json from the
// working directory because the main module is a `jsr:` specifier, but the CLI then re-runs itself
// on denext's Deno toolchain from the module it actually loaded (an https URL there), which
// discovers no config — so `denext.config.ts`'s import-map-only dependencies were "not a
// dependency" in the child. Here the app's import map points the `jsr:` CLI specifier at this
// checkout's `cli.ts` (a local script, which discovers the CHECKOUT's config instead — the same
// mismatch), and the toolchain is a wrapper around this Deno, so the whole path runs for real.
// The pin is replaced by one this Deno is not: when the suite itself runs on the pinned toolchain
// (`denext task test`, or a `deno` that is the toolchain on PATH), the CLI is already where it
// would re-exec to and stays in-process — the path under test would never run.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, isAbsolute, join, toFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../..", import.meta.url));
const CLI = join(ROOT, "cli.ts");

/** The checkout's import map with its relative targets made absolute, for an app outside it. */
async function frameworkImports(): Promise<Record<string, string>> {
  const { imports } = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    imports: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(imports).map((
      [k, v],
    ) => [k, v.startsWith("./") ? toFileUrl(join(ROOT, v)).href : v]),
  );
}

/** A one-page app whose denext.config.ts imports a dependency only its import map names. */
async function scaffold(dir: string): Promise<void> {
  const write = (rel: string, text: string) => Deno.writeTextFile(join(dir, rel), text);
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await write(
    "deno.json",
    JSON.stringify(
      {
        tasks: { build: "deno run -A jsr:@denext/denext/cli build" },
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          ...await frameworkImports(),
          "jsr:@denext/denext/cli": toFileUrl(CLI).href,
          "cfgdep": "./cfgdep.ts",
        },
      },
      null,
      2,
    ),
  );
  await write("cfgdep.ts", 'export const label = "from-import-map";\n');
  await write(
    "denext.config.ts",
    'import { label } from "cfgdep";\n\nexport default { features: { CFGDEP: label.length > 0 } };\n',
  );
  await write("app/page.tsx", "export default function Home() {\n  return <h1>hi</h1>;\n}\n");
}

/** A pin naming a toolchain version this Deno is not, so the CLI re-execs whatever it runs on. */
async function foreignPin(dir: string): Promise<string> {
  const path = join(dir, "toolchain-pin.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify({ schema: 1, version: `0.0.0-not-${Deno.version.deno}`, targets: {} }),
  );
  return path;
}

/** A toolchain stand-in: records its argv, then runs this Deno with it. */
async function toolchainWrapper(dir: string): Promise<{ path: string; log: string }> {
  const path = join(dir, "deno-toolchain");
  const log = join(dir, "toolchain-argv.log");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexec '${Deno.execPath()}' "$@"\n`,
  );
  await Deno.chmod(path, 0o755);
  return { path, log };
}

Deno.test({
  name: "a jsr: CLI's toolchain re-exec builds an app whose config needs its import map",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "denext-tc-config-" });
    try {
      const app = join(tmp, "app");
      await Deno.mkdir(app);
      await scaffold(app);
      const w = await toolchainWrapper(tmp);
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["task", "build"],
        cwd: app,
        env: {
          DENEXT_DENO: w.path,
          DENEXT_TOOLCHAIN_ACTIVE: "",
          DENEXT_TOOLCHAIN_PIN_FILE: await foreignPin(tmp),
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      const stderr = d.decode(out.stderr);
      assert(!stderr.includes("not a dependency"), stderr);
      assertEquals(out.code, 0, `${d.decode(out.stdout)}\n${stderr}`);
      const argv = (await Deno.readTextFile(w.log)).trimEnd().split("\n");
      assertEquals(argv[0], "run", "the build re-ran on the toolchain");
      const at = argv.indexOf("--config");
      assert(at > 0 && isAbsolute(argv[at + 1]), `the child got the config: ${argv.join(" ")}`);
      assertEquals(await Deno.realPath(argv[at + 1]), await Deno.realPath(join(app, "deno.json")));
      assert(await Deno.stat(join(app, ".denext")).then((s) => s.isDirectory), "the build wrote");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

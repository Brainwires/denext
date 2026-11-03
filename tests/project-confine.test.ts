// The symlink policy for the commands that write into a project they did not create (migrate,
// init, upgrade, mobile add, desktop add, patch): a write never follows a symlink — to a file or
// a directory — out of the project, nor a dangling one; a link that stays inside is followed.
// Each command is driven against a project whose committed links point at a sibling "outside"
// directory, and the outside directory must come through untouched.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { assertInsideProject, OutsideProjectError } from "../src/build/project-confine.ts";
import { confineWrites, mfs } from "../src/build/migrate-io.ts";
import { migrateProject } from "../src/build/migrate.ts";
import { scaffoldProject } from "../src/build/scaffold.ts";
import { runUpgrade } from "../src/cli/commands/upgrade.ts";
import type { CommandContext } from "../src/cli/command.ts";
import type { UpgradeLookups } from "../src/build/upgrade.ts";
import { addDesktopCapabilities } from "../src/build/desktop-capabilities.ts";
import { addMobileCapabilities } from "../src/build/mobile-capabilities.ts";
import type { CommandRunner } from "../src/build/mobile-capabilities.ts";
import { npmPackageDir } from "../src/build/patches.ts";
import { FILE_SYMLINKS, symlinkDir } from "./helpers/symlink.ts";

/** A project directory and a sibling "outside" one, both removed afterwards. */
async function withProject(fn: (dir: string, outside: string) => Promise<void>): Promise<void> {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_confine_" }));
  const dir = join(base, "app");
  const outside = join(base, "outside");
  await Deno.mkdir(dir);
  await Deno.mkdir(outside);
  try {
    await fn(dir, outside);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

/** Every file under `dir`, relative, with its text. */
async function tree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const e of Deno.readDir(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) Object.assign(out, await tree(dir, rel));
    else if (e.isFile) out[rel] = await Deno.readTextFile(join(dir, rel));
  }
  return out;
}

Deno.test("assertInsideProject: paths, linked folders and files, dangling links", async () => {
  await withProject(async (dir, outside) => {
    await assertInsideProject(dir, join(dir, "app/page.tsx")); // not there yet: fine
    await assertRejects(() => assertInsideProject(dir, join(dir, "../x")), OutsideProjectError);
    await symlinkDir(outside, join(dir, "out"));
    await assertRejects(
      () => assertInsideProject(dir, join(dir, "out/a/b.ts")),
      OutsideProjectError,
      "leads out of the project",
    );
    // Removing or renaming the link itself acts on the entry, which is inside.
    await assertInsideProject(dir, join(dir, "out"), { entry: true });
    await Deno.mkdir(join(dir, "real"));
    await symlinkDir(join(dir, "real"), join(dir, "in"));
    await assertInsideProject(dir, join(dir, "in/page.tsx")); // a link that stays inside
    if (!FILE_SYMLINKS) return;
    await Deno.writeTextFile(join(outside, "secret"), "s");
    await Deno.symlink(join(outside, "secret"), join(dir, "deno.json"), { type: "file" });
    await assertRejects(
      () => assertInsideProject(dir, join(dir, "deno.json")),
      OutsideProjectError,
    );
    // Windows needs the link's type when the target does not exist.
    await Deno.symlink(join(outside, "missing"), join(dir, "dangling"), { type: "file" });
    await assertRejects(
      () => assertInsideProject(dir, join(dir, "dangling")),
      OutsideProjectError,
      "dangling",
    );
    await assertRejects(
      () => assertInsideProject(dir, join(dir, "dangling/x")),
      OutsideProjectError,
    );
  });
});

Deno.test("confineWrites: migrate's file seam refuses writes, moves and removals out of the project", async () => {
  await withProject(async (dir, outside) => {
    await symlinkDir(outside, join(dir, "public"));
    await Deno.writeTextFile(join(outside, "keep.txt"), "keep");
    await confineWrites(dir, async () => {
      await assertRejects(() => mfs.writeTextFile(join(dir, "public/x.txt"), "x"));
      await assertRejects(() => mfs.mkdir(join(dir, "public/sub"), { recursive: true }));
      await assertRejects(() => mfs.remove(join(dir, "public/keep.txt")));
      await assertRejects(() => mfs.rename(join(dir, "public/keep.txt"), join(dir, "k.txt")));
      await mfs.writeTextFile(join(dir, "inside.txt"), "ok"); // an ordinary write goes through
    });
    assertEquals(await tree(outside), { "keep.txt": "keep" });
    // Outside a confined run the seam is the plain Deno call.
    await mfs.writeTextFile(join(dir, "public/free.txt"), "f");
    assertEquals(await Deno.readTextFile(join(outside, "free.txt")), "f");
  });
});

Deno.test("migrate: a .vscode linked out of the project is left alone, not written through", async () => {
  await withProject(async (dir, outside) => {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { next: "15", react: "19", "react-dom": "19" } }),
    );
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(join(dir, "app/page.tsx"), "export default () => null;\n");
    await Deno.writeTextFile(join(outside, "settings.json"), '{"mine":true}\n');
    await symlinkDir(outside, join(dir, ".vscode"));
    const r = await migrateProject(dir);
    assert(r.wrote.some((p) => p.endsWith("deno.json")), "the migration still ran");
    assertEquals(await tree(outside), { "settings.json": '{"mine":true}\n' });
  });
});

Deno.test("init: a folder linked out of the project is refused before anything lands there", async () => {
  await withProject(async (dir, outside) => {
    await symlinkDir(outside, join(dir, "app"));
    await assertRejects(
      () => scaffoldProject({ dir, template: "default", allowExisting: true, vscode: false }),
      OutsideProjectError,
    );
    assertEquals(await tree(outside), {});
  });
});

/** A registry with one newer denext. */
const LOOKUPS: UpgradeLookups = {
  versions: () => Promise.resolve({ latest: "3.2.0", versions: ["3.0.0", "3.2.0"] }),
  denextRange: () => Promise.resolve(null),
};

/** `denext upgrade <dir>`, its output captured. */
async function upgrade(dir: string): Promise<{ code: number; printed: string }> {
  const printed: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.error = console.log;
  try {
    const code = await runUpgrade(
      {
        positionals: [dir],
        flags: {},
        global: { json: false, verbose: false, quiet: false },
        rest: [],
      } as CommandContext,
      LOOKUPS,
      () => Promise.resolve(true),
    );
    return { code, printed: printed.join("\n") };
  } finally {
    [console.log, console.error] = [log, err];
  }
}

Deno.test("upgrade: a workspace member outside the project (../ or a link) is not rewritten", async () => {
  await withProject(async (dir, outside) => {
    const pinned = '{"imports":{"denext":"jsr:@denext/denext@^3.0.0"}}\n';
    await Deno.writeTextFile(join(outside, "deno.json"), pinned);
    await symlinkDir(outside, join(dir, "linked"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"workspace":["../outside","./linked"],"imports":{"denext":"jsr:@denext/denext@^3.0.0"}}\n',
    );
    const { code, printed } = await upgrade(dir);
    assertEquals(code, 0, printed);
    assert((await Deno.readTextFile(join(dir, "deno.json"))).includes("^3.2.0"), printed);
    assertEquals(await Deno.readTextFile(join(outside, "deno.json")), pinned);
    assert(printed.includes("workspace member ../outside is outside the project"), printed);
    assert(printed.includes("workspace member ./linked is outside the project"), printed);
  });
});

Deno.test("upgrade: an editor settings file linked out of the project is not edited", async () => {
  await withProject(async (dir, outside) => {
    const settings = '{"deno.enable": true}\n';
    await Deno.writeTextFile(join(outside, "settings.json"), settings);
    await symlinkDir(outside, join(dir, ".vscode"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"imports":{"denext":"jsr:@denext/denext@^3.0.0"}}\n',
    );
    const { code, printed } = await upgrade(dir);
    assertEquals(code, 0, printed);
    assertEquals(await Deno.readTextFile(join(outside, "settings.json")), settings);
  });
});

Deno.test({
  name: "upgrade / desktop add: a config symlinked out of the project is not written through",
  ignore: !FILE_SYMLINKS,
  fn: async () => {
    await withProject(async (dir, outside) => {
      const pinned = '{"imports":{"denext":"jsr:@denext/denext@^3.0.0"}}\n';
      await Deno.writeTextFile(join(outside, "deno.json"), pinned);
      await Deno.symlink(join(outside, "deno.json"), join(dir, "deno.json"));
      const { code, printed } = await upgrade(dir);
      assertEquals(code, 1, printed);
      assert(printed.includes("leads out of the project"), printed);
      assertEquals(await Deno.readTextFile(join(outside, "deno.json")), pinned);

      const config = "export default {};\n";
      await Deno.writeTextFile(join(outside, "denext.config.ts"), config);
      await Deno.symlink(join(outside, "denext.config.ts"), join(dir, "denext.config.ts"));
      await assertRejects(
        () => addDesktopCapabilities({ dir, capabilities: ["clipboard"] }),
        OutsideProjectError,
      );
      assertEquals(await Deno.readTextFile(join(outside, "denext.config.ts")), config);
    });
  },
});

const MANIFEST = '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' +
  "    <application></application>\n</manifest>\n";

Deno.test("mobile add: a native folder linked out of the project is refused before any write", async () => {
  await withProject(async (dir, outside) => {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.ts"),
      "export default { appId: 'dev.example', webDir: 'out' };\n",
    );
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "pnpm-lock.yaml"), "");
    await Deno.mkdir(join(dir, ".git"));
    await Deno.writeTextFile(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
    await Deno.mkdir(join(outside, "app/src/main"), { recursive: true });
    await Deno.writeTextFile(join(outside, "app/src/main/AndroidManifest.xml"), MANIFEST);
    await symlinkDir(outside, join(dir, "android"));
    const calls: unknown[] = [];
    const run: CommandRunner = (c) => (calls.push(c), Promise.resolve({ code: 0 }));
    await assertRejects(
      () => addMobileCapabilities({ capabilities: ["network"], cwd: dir, run }),
      OutsideProjectError,
    );
    assertEquals(calls, [], "nothing was installed either");
    assertEquals(
      await Deno.readTextFile(join(outside, "app/src/main/AndroidManifest.xml")),
      MANIFEST,
    );
  });
});

Deno.test("patch: a package name that walks out of node_modules is refused", async () => {
  for (const name of ["../../x", "..", "@scope/..", "a/../../b", "/etc"]) {
    await assertRejects(() => npmPackageDir("/project", name), Error, "not an npm package name");
  }
});

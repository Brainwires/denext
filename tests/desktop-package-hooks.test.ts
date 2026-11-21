// desktop.packageHooks (src/build/desktop-package-hooks.ts, runDesktopPackageMain): the project's
// own steps around a packaging run live in denext.config.ts and its modules, so
// `denext desktop package --regenerate-scripts` never drops them. `pre` runs before main, `post`
// after it succeeded with the artifacts main returned; a failed main skips `post`; a hook that
// throws fails the run; the config check refuses a bad shape; and the scaffolded scripts pass
// their target OS and URL.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { runDesktopPackageMain } from "../src/build/desktop.ts";
import { runDesktopPackageHook } from "../src/build/desktop-package-hooks.ts";
import { desktopPackageHooksProblem } from "../src/desktop/package-hooks-config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { DESKTOP_PACKAGE_SCRIPTS } from "../src/build/native-templates/desktop-package-scripts.ts";

/** A temporary project with a config, hook modules that log to `log.json`, and `scripts/`. */
async function project(
  hooks: string,
  fn: (dir: string, log: () => Promise<unknown[]>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-package-hooks-" }));
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.mkdir(join(dir, "hooks"));
    const logFile = join(dir, "log.json");
    for (const stage of ["pre", "post"]) {
      await Deno.writeTextFile(
        join(dir, "hooks", `${stage}.ts`),
        `export default async (ctx: Record<string, unknown>) => {
  const file = ${JSON.stringify(logFile)};
  const prev = await Deno.readTextFile(file).then(JSON.parse, () => []);
  prev.push(ctx);
  await Deno.writeTextFile(file, JSON.stringify(prev));
  if (ctx.args && (ctx.args as string[]).includes("--fail-${stage}")) throw new Error("${stage} hook failed");
};\n`,
      );
    }
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { desktop: { packageHooks: ${hooks} } };\n`,
    );
    const log = () => Deno.readTextFile(logFile).then(JSON.parse, () => []);
    await fn(dir, log);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const BOTH = `{ pre: "hooks/pre.ts", post: "./hooks/post.ts" }`;

Deno.test("packageHooks: pre runs before main, post after it with the artifacts", async () => {
  await project(BOTH, async (dir, log) => {
    const order: string[] = [];
    const entryUrl = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    await runDesktopPackageMain(async () => {
      order.push(`main saw ${(await log()).length} hook run(s)`);
      return ["dist/app_1.0_amd64.deb"];
    }, { entryUrl, args: ["--arch", "x86_64"] });
    assertEquals(order, ["main saw 1 hook run(s)"]);
    assertEquals(await log(), [
      {
        stage: "pre",
        os: "linux",
        projectDir: dir,
        distDir: join(dir, "dist"),
        args: ["--arch", "x86_64"],
      },
      {
        stage: "post",
        os: "linux",
        projectDir: dir,
        distDir: join(dir, "dist"),
        args: ["--arch", "x86_64"],
        artifacts: ["dist/app_1.0_amd64.deb"],
      },
    ]);
  });
});

Deno.test("packageHooks: the target OS comes from the options, else the script's name", async () => {
  await project(`{ pre: "hooks/pre.ts" }`, async (dir, log) => {
    const url = (name: string) => toFileUrl(join(dir, "scripts", name)).href;
    await runDesktopPackageMain(() => Promise.resolve(), {
      entryUrl: url("package-macos.ts"),
      args: [],
    });
    await runDesktopPackageMain(() => Promise.resolve(), {
      entryUrl: url("package-windows.ts"),
      args: [],
    });
    await runDesktopPackageMain(() => Promise.resolve(), {
      entryUrl: url("build.ts"),
      os: "linux",
      args: [],
    });
    assertEquals((await log() as Array<{ os: string }>).map((c) => c.os), [
      "darwin",
      "windows",
      "linux",
    ]);
  });
});

Deno.test("packageHooks: a failed main skips post; a throwing hook fails the run", async () => {
  await project(BOTH, async (dir, log) => {
    const entryUrl = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    await assertRejects(
      () =>
        runDesktopPackageMain(() => Promise.reject(new Error("build broke")), {
          entryUrl,
          args: [],
        }),
      Error,
      "build broke",
    );
    assertEquals((await log() as Array<{ stage: string }>).map((c) => c.stage), ["pre"]);
    let ran = false;
    await assertRejects(
      () =>
        runDesktopPackageMain(() => {
          ran = true;
          return Promise.resolve();
        }, { entryUrl, args: ["--fail-pre"] }),
      Error,
      "pre hook failed",
    );
    assert(!ran, "main must not run after a failed pre hook");
  });
});

Deno.test("packageHooks: no hooks configured, or no config at all, runs main alone", async () => {
  await project(`{}`, async (dir, log) => {
    let ran = 0;
    const entryUrl = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    await runDesktopPackageMain(() => (ran++, Promise.resolve()), { entryUrl, args: [] });
    await Deno.remove(join(dir, "denext.config.ts"));
    await runDesktopPackageMain(() => (ran++, Promise.resolve()), { entryUrl, args: [] });
    assertEquals(ran, 2);
    assertEquals(await log(), []);
  });
});

Deno.test("packageHooks: a module without a default function is refused", async () => {
  const context = {
    stage: "post" as const,
    os: "linux" as const,
    projectDir: "/p",
    distDir: "/p/dist",
    args: [],
  };
  const config = { desktop: { packageHooks: { post: "hooks/post.ts" } } };
  const err = await assertRejects(() =>
    runDesktopPackageHook({ config, context, load: () => Promise.resolve({ default: 1 }) })
  );
  assertStringIncludes(String(err), "must default-export a function");
  let loaded = "";
  const ran = await runDesktopPackageHook({
    config,
    context,
    load: (u) => (loaded = u, Promise.resolve({ default: () => {} })),
  });
  assert(ran);
  assertEquals(loaded, toFileUrl(join("/p", "hooks/post.ts")).href);
  assertEquals(
    await runDesktopPackageHook({ config: undefined, context, load: () => Promise.reject() }),
    false,
  );
});

Deno.test("packageHooks: the config check refuses a bad shape, an absolute path and ..", () => {
  assertEquals(desktopPackageHooksProblem(undefined), null);
  assertEquals(desktopPackageHooksProblem({ pre: "hooks/a.ts", post: "b.mjs" }), null);
  assertEquals(desktopPackageHooksProblem([])?.[0], "desktop.packageHooks");
  assertEquals(desktopPackageHooksProblem({ during: "a.ts" })?.[0], "desktop.packageHooks.during");
  for (const bad of ["/abs/a.ts", "C:\\a.ts", "../a.ts", "hooks/../../a.ts", "a.sh", 3]) {
    assert(desktopPackageHooksProblem({ pre: bad }) !== null, `accepted ${bad}`);
  }
  assertThrows(
    () => validateDenextConfig({ desktop: { packageHooks: { post: "../x.ts" } } } as DenextConfig),
    Error,
    "desktop.packageHooks.post",
  );
});

Deno.test("packageHooks: every scaffolded script returns its artifacts and passes its OS and URL", () => {
  const os: Record<string, string> = {
    "package-macos.ts": '{ os: "darwin", entryUrl: import.meta.url }',
    "package-linux.ts": "{ os: OS, entryUrl: import.meta.url }",
    "package-windows.ts": "{ os: OS, entryUrl: import.meta.url }",
  };
  for (const [name, script] of Object.entries(DESKTOP_PACKAGE_SCRIPTS)) {
    assertStringIncludes(script, `await runDesktopPackageMain(main, ${os[name]});`);
    assertStringIncludes(script, "async function main(): Promise<string[]>");
  }
});

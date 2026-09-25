// `denext mobile dev`: the temporary `server.url` edit of a Capacitor config and its restore.
// Every edge is injected: no dev server starts and no real `cap` runs.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { PlannedCommand } from "../src/build/mobile-capabilities.ts";
import {
  capacitorConfigFile,
  type MobileDevDeps,
  type MobileDevServer,
  restoreCapacitorConfig,
  runMobileDev,
  withDevServerUrl,
} from "../src/build/mobile-dev.ts";

const URL_ = "http://192.168.1.5:3000";

/** Capacitor's own `npx cap init` TypeScript template, plus a comment to keep. */
const TS_TEMPLATE = `import type { CapacitorConfig } from "@capacitor/cli";

// the app id is registered with Apple — do not change
const config: CapacitorConfig = {
  appId: "com.example.app",
  appName: "Example",
  webDir: "dist",
};

export default config;
`;

Deno.test("withDevServerUrl edits the stock TS template in place, keeping every other byte", async () => {
  const out = await withDevServerUrl("capacitor.config.ts", TS_TEMPLATE, URL_);
  assertStringIncludes(out, "// the app id is registered with Apple — do not change");
  assertStringIncludes(out, `url: "${URL_}"`);
  assertStringIncludes(out, "cleartext: true");
  assert(out.startsWith('import type { CapacitorConfig } from "@capacitor/cli";'));
  assert(out.trimEnd().endsWith("export default config;"));
});

Deno.test("withDevServerUrl merges into an existing server block", async () => {
  const source = `export default {
  appId: "a.b",
  server: { androidScheme: "https", url: "http://old:1" },
};
`;
  const out = await withDevServerUrl("capacitor.config.ts", source, URL_);
  assertStringIncludes(out, 'androidScheme: "https"');
  assertStringIncludes(out, `url: "${URL_}"`);
  assert(!out.includes("http://old:1"));
  assertStringIncludes(out, "cleartext: true");
});

Deno.test("withDevServerUrl handles JSON, defineConfig-style calls and CommonJS", async () => {
  const json = await withDevServerUrl(
    "capacitor.config.json",
    '{ "appId": "a.b", "server": { "hostname": "app" } }',
    URL_,
  );
  assertEquals(JSON.parse(json).server, { hostname: "app", url: URL_, cleartext: true });
  const call = await withDevServerUrl(
    "capacitor.config.ts",
    'export default define({ appId: "a.b" });\n',
    URL_,
  );
  assertStringIncludes(call, `url: "${URL_}"`);
  const cjs = await withDevServerUrl(
    "capacitor.config.js",
    'module.exports = { appId: "a.b" };\n',
    URL_,
  );
  assertStringIncludes(cjs, `url: "${URL_}"`);
});

Deno.test("withDevServerUrl refuses a config it cannot find an object in", async () => {
  await assertRejects(
    () => withDevServerUrl("capacitor.config.ts", "export default makeConfig();\n", URL_),
    Error,
    "could not find the exported config object",
  );
});

/** A Capacitor project in a temp dir, with the stock TS config. */
async function project(): Promise<{ root: string; file: string }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-mobile-dev-" }));
  const file = join(root, "capacitor.config.ts");
  await Deno.writeTextFile(file, TS_TEMPLATE);
  return { root, file };
}

/** Recording fakes; `copyCode` is what each `cap copy` returns, in order. */
function fakes(root: string, file: string, copyCode: number[] = [0, 0]) {
  const calls: PlannedCommand[] = [];
  const seen: string[] = [];
  let stopped = 0;
  const server: MobileDevServer = {
    url: URL_,
    attached: false,
    finished: new Promise(() => {}),
    stop: () => {
      stopped++;
      return Promise.resolve();
    },
  };
  const deps: MobileDevDeps = {
    run: async (command) => {
      calls.push(command);
      seen.push(await Deno.readTextFile(file)); // what `cap copy` would have pushed
      return { code: copyCode.shift() ?? 0 };
    },
    startServer: () => Promise.resolve(server),
    waitForStop: () => Promise.resolve(),
    log: () => {},
  };
  return { deps, calls, seen, stopped: () => stopped, root };
}

Deno.test("mobile dev writes server.url for the session, then restores it and re-copies", async () => {
  const { root, file } = await project();
  try {
    const f = fakes(root, file);
    await runMobileDev({ cwd: root }, f.deps);
    assertEquals(f.calls.map((c) => [c.cmd, ...c.args, c.cwd]), [
      ["npx", "cap", "copy", root],
      ["npx", "cap", "copy", root],
    ]);
    assertStringIncludes(f.seen[0], `url: "${URL_}"`, "the session copy points at the server");
    assertEquals(f.seen[1], TS_TEMPLATE, "the closing copy pushes the original config");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE, "byte-identical afterwards");
    assertEquals(await restoreCapacitorConfig(root), null, "no backup left behind");
    assertEquals(f.stopped(), 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev restores the config when cap copy fails, and still stops the server", async () => {
  const { root, file } = await project();
  try {
    const f = fakes(root, file, [1, 0]);
    await assertRejects(() => runMobileDev({ cwd: root }, f.deps), Error, "exited with 1");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
    assertEquals(f.stopped(), 1);
    assertEquals(f.calls.length, 2, "the restore re-copies");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev leaves the config alone when the dev server fails to start", async () => {
  const { root, file } = await project();
  try {
    const f = fakes(root, file);
    const deps = { ...f.deps, startServer: () => Promise.reject(new Error("no server")) };
    await assertRejects(() => runMobileDev({ cwd: root }, deps), Error, "no server");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
    assertEquals(f.calls.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a killed session's edit is restored by the next run (and by --restore)", async () => {
  const { root, file } = await project();
  try {
    // Simulate a run killed mid-session: the edit and its backup are both on disk.
    const edited = await withDevServerUrl(file, TS_TEMPLATE, "http://10.0.0.9:3000");
    await Deno.mkdir(join(root, ".denext"));
    const backup = join(root, ".denext", "mobile-dev-backup.json");
    await Deno.writeTextFile(
      backup,
      JSON.stringify({ file: "capacitor.config.ts", original: TS_TEMPLATE }),
    );
    await Deno.writeTextFile(file, edited);
    assertEquals(await restoreCapacitorConfig(root), file);
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);

    // Through a full run, the heal is logged and the session still restores at the end.
    await Deno.writeTextFile(
      backup,
      JSON.stringify({ file: "capacitor.config.ts", original: TS_TEMPLATE }),
    );
    await Deno.writeTextFile(file, edited);
    const lines: string[] = [];
    const f = fakes(root, file);
    await runMobileDev({ cwd: root }, { ...f.deps, log: (l) => lines.push(l) });
    assert(lines.some((l) => l.includes("did not exit cleanly")));
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a planted backup cannot redirect the restore outside the config file", async () => {
  const { root } = await project();
  try {
    await Deno.mkdir(join(root, ".denext"));
    await Deno.writeTextFile(
      join(root, ".denext", "mobile-dev-backup.json"),
      JSON.stringify({ file: "../elsewhere.txt", original: "pwned" }),
    );
    await assertRejects(() => restoreCapacitorConfig(root), Error, "not a mobile dev backup");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capacitorConfigFile follows Capacitor's lookup order; none is an error", async () => {
  const { root, file } = await project();
  try {
    await Deno.writeTextFile(join(root, "capacitor.config.json"), "{}");
    assertEquals(await capacitorConfigFile(root), file, ".ts wins over .json");
    await Deno.remove(file);
    await Deno.remove(join(root, "capacitor.config.json"));
    assertEquals(await capacitorConfigFile(root), null);
    await assertRejects(
      () => runMobileDev({ cwd: root }, fakes(root, file).deps),
      Error,
      "no Capacitor project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

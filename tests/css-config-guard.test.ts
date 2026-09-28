// The css→shim import-map entries denext injects into an app's deno.json never outlive the
// run: a killed run restores on the signal, a leftover is healed at the next start (comments
// kept), build output copied into out/ + Capacitor shells is never shimmed, and both doctors
// report a leak.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  healLeakedCssShims,
  isInjectedCssShimEntry,
  leakedCssShimKeys,
  leakedCssShimKeysIn,
  signalExitCode,
} from "../src/build/css-config-guard.ts";
import { buildAppCss } from "../src/build/css.ts";
import { cssShimLeakCheck } from "../src/cli/commands/doctor.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** A committed JSONC config plus the entries an interrupted run leaked into it. */
function leakedConfig(dir: string): { clean: string; leaked: string } {
  const css = toFileUrl(join(dir, "src/styles.css")).href;
  const out = toFileUrl(join(dir, "out/_denext/client/index.css")).href;
  const shim = (n: number) => toFileUrl(join(dir, `.denext/css-shims/css_${n}.js`)).href;
  const head = `{
  // the app's own comment
  "nodeModulesDir": "none",
  "imports": {
    "denext": "../../mod.ts", // trailing comment
    "@/": "./src/"`;
  const tail = `
  },
  "tasks": { "dev": "denext dev ." }
}
`;
  return {
    clean: `${head}${tail}`,
    leaked: `${head},
    "${css}": "${shim(1)}",
    "@/styles.css": "${shim(1)}",
    "${out}": "${shim(0)}"${tail}`,
  };
}

Deno.test("isInjectedCssShimEntry: shim values and absolute css keys only", () => {
  assert(isInjectedCssShimEntry("file:///a/x.css", "file:///a/.denext/css-shims/css_0.js"));
  assert(isInjectedCssShimEntry("@/x.module.css", "file:///a/.denext/css-shims/css_12.js"));
  assert(isInjectedCssShimEntry("file:///a/x.scss", "./somewhere.js"));
  assert(!isInjectedCssShimEntry("denext", "../../mod.ts"));
  assert(!isInjectedCssShimEntry("@/", "./src/"));
  assert(!isInjectedCssShimEntry("styles", "./src/styles.css"));
  assert(!isInjectedCssShimEntry("x", "./css-shims-lib/mod.js"));
});

Deno.test("healLeakedCssShims strips the leaked entries, keeps everything else byte-for-byte", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_heal_" });
  const configPath = join(dir, "deno.json");
  const { clean, leaked } = leakedConfig(dir);
  try {
    await Deno.writeTextFile(configPath, leaked);
    assertEquals(leakedCssShimKeysIn(leaked).length, 3);
    const removed = await healLeakedCssShims(configPath);
    assertEquals(removed.length, 3);
    // Comments, the other imports, formatting: identical to the committed file.
    assertEquals(await Deno.readTextFile(configPath), clean);
    // A clean config is left alone (no write, nothing reported).
    assertEquals(await healLeakedCssShims(configPath), []);
    assertEquals(await Deno.readTextFile(configPath), clean);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("leakedCssShimKeys reads a live run's backup, not its transient entries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_leakkeys_" });
  const outDir = join(dir, ".denext");
  const configPath = join(dir, "deno.json");
  const { clean, leaked } = leakedConfig(dir);
  try {
    await Deno.mkdir(outDir);
    // A run in progress: the config holds its redirects, the backup the committed bytes.
    await Deno.writeTextFile(configPath, leaked);
    await Deno.writeTextFile(join(outDir, "app-config.pre-css.json"), clean);
    assertEquals(await leakedCssShimKeys(configPath, outDir), []);
    assertEquals(await cssShimLeakCheck(configPath, outDir), null);
    // No run: the entries are a leak, and doctor fails on it with the fix.
    await Deno.remove(join(outDir, "app-config.pre-css.json"));
    const check = await cssShimLeakCheck(configPath, outDir);
    assert(check && !check.ok && check.critical);
    assertStringIncludes(check.detail, "3 leaked css-shim import entries");
    assertStringIncludes(check.detail, "fix:");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor flags leaked css-shim imports in the app's deno.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mdleak_" });
  try {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "dev.example", webDir: "out" }),
    );
    await Deno.writeTextFile(join(dir, "deno.json"), leakedConfig(dir).leaked);
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    const found = report.findings.filter((f) => f.check === "css-shim-imports");
    assertEquals(found.length, 1);
    assertEquals(found[0].level, "error");
    await Deno.writeTextFile(join(dir, "deno.json"), leakedConfig(dir).clean);
    const after = await runMobileDoctor({ root: dir, profile: "release" });
    assertEquals(after.findings.filter((f) => f.check === "css-shim-imports"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildAppCss never shims the css copied into out/, ios/ or android/", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_cssexcl_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "imports": {} }\n`);
    const files = [
      "src/styles.css",
      "out/_denext/client/index.css",
      "ios/App/App/public/_denext/client/index.css",
      "android/app/src/main/assets/public/_denext/client/index.css",
      "node_modules/pkg/x.css",
      // A nested folder that merely shares a name is still app source.
      "src/out/panel.css",
    ];
    for (const f of files) {
      await Deno.mkdir(join(dir, f, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, f), "a { color: red }\n");
    }
    const css = await buildAppCss({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
    });
    assert(css);
    assertEquals(css.cssFiles.map((f) => f.slice(dir.length + 1)).sort(), [
      join("src", "out", "panel.css"),
      join("src", "styles.css"),
    ]);
    assertEquals(Object.keys(css.importMap).length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The child: patch the config the way the CLI does, guard it, say "ready", then wait. */
function childSource(): string {
  const css = toFileUrl(join(ROOT, "src/build/css.ts")).href;
  const guard = toFileUrl(join(ROOT, "src/build/css-config-guard.ts")).href;
  return `
import { injectAppConfigRedirects, restoreAppConfigSync } from "${css}";
import { guardRestore } from "${guard}";
const [configPath, outDir, mode] = Deno.args;
guardRestore(() => restoreAppConfigSync(configPath, outDir));
await injectAppConfigRedirects(configPath, outDir, {
  "file:///elsewhere/x.css": "file:///elsewhere/.denext/css-shims/css_0.js",
});
if (mode === "exit") Deno.exit(0);
console.log("ready");
setInterval(() => {}, 1000);
`;
}

/** Spawn the patching child and wait for its "ready" line. */
async function spawnPatcher(dir: string, mode: "signal" | "exit") {
  const script = join(dir, "child.ts");
  await Deno.writeTextFile(script, childSource());
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(ROOT, "deno.json"),
      script,
      join(dir, "deno.json"),
      join(dir, ".denext"),
      mode,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  return child;
}

async function readUntilReady(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`child exited before patching: ${seen}`);
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
}

Deno.test({
  name: "a run killed with SIGTERM mid-patch restores the committed deno.json",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_killpatch_" });
    const configPath = join(dir, "deno.json");
    const original = `{\n  "nodeModulesDir": "manual",\n  "imports": { "~/": "./src/" }\n}\n`;
    try {
      await Deno.writeTextFile(configPath, original);
      const child = await spawnPatcher(dir, "signal");
      await readUntilReady(child.stdout);
      // Patched while it runs.
      assertStringIncludes(await Deno.readTextFile(configPath), "css-shims");
      child.kill("SIGTERM");
      const status = await child.status;
      assertEquals(status.code, signalExitCode("SIGTERM"));
      assertEquals(await Deno.readTextFile(configPath), original);
      let bak = true;
      await Deno.stat(join(dir, ".denext/app-config.pre-css.json")).catch(() => (bak = false));
      assert(!bak, "the backup is removed with the restore");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("a run that calls Deno.exit mid-patch restores the committed deno.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_exitpatch_" });
  const configPath = join(dir, "deno.json");
  const original = `{\n  "nodeModulesDir": "manual",\n  "imports": {}\n}\n`;
  try {
    await Deno.writeTextFile(configPath, original);
    const child = await spawnPatcher(dir, "exit");
    await child.stdout.cancel();
    assertEquals((await child.status).code, 0);
    assertEquals(await Deno.readTextFile(configPath), original);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("only a manual node_modules or an npm: import gets the app config patched", async () => {
  const cases: [string, boolean][] = [
    [`{ "nodeModulesDir": "none", "imports": {} }`, false],
    [`{ "nodeModulesDir": "auto", "imports": {} }`, false],
    [`{ "imports": { "x": "jsr:@std/path" } }`, false],
    [`{ "nodeModulesDir": "manual", "imports": {} }`, true],
    [`{ "imports": { "zod": "npm:zod@3" } }`, true],
  ];
  for (const [config, patched] of cases) {
    const dir = await Deno.makeTempDir({ prefix: "denext_anchor_" });
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), config + "\n");
      await Deno.mkdir(join(dir, "src"));
      await Deno.writeTextFile(join(dir, "src/a.css"), "a { color: red }\n");
      const css = await buildAppCss({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir: join(dir, ".denext"),
      });
      assert(css);
      assertEquals(css.appConfigRedirects !== undefined, patched, config);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

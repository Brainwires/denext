// The Android `MainActivity` every denext native installer shares (src/build/mobile-native-install.ts):
// it is written under a `// denext-main-activity-template:` marker line, and an unedited one
// (marked, or byte-for-byte what an earlier release wrote before the marker) is upgraded to the
// current source when a feature is added. An edited one is kept.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type AndroidFeature,
  mainActivitySource,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  registerInMainActivity,
} from "../src/build/mobile-native-install.ts";
import { markedTemplateIntact, renderMarkedTemplate } from "../src/build/native-template-marker.ts";

const FEATURES: readonly AndroidFeature[] = ["share-receive", "widgets", "auth-session", "ota"];
const PACKAGES = ["com.example.app", "com.brainwires.t3code"];

/** Every non-empty combination of the Android features. */
function combinations(): AndroidFeature[][] {
  const out: AndroidFeature[][] = [];
  for (let mask = 1; mask < 1 << FEATURES.length; mask++) {
    out.push(FEATURES.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

/** The activity's path for `pkg`, relative to the project root. */
const activityPath = (pkg: string) =>
  `android/app/src/main/java/${pkg.replaceAll(".", "/")}/MainActivity.java`;

/** `text` without its first (marker) line: what releases before the marker wrote. */
const unmarked = (text: string) => text.slice(text.indexOf("\n") + 1);

/** A project holding only `text` as its MainActivity; `fn` runs, then the project goes. */
async function withActivity(
  pkg: string,
  text: string,
  fn: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_main_activity_" });
  const path = activityPath(pkg);
  try {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), text);
    await fn(dir, path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Register `feature` in the project at `dir`, returning the report. */
async function register(dir: string, feature: AndroidFeature): Promise<NativeInstallReport> {
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  await registerInMainActivity(
    new NativeInstaller<NativeInstallOptions, NativeInstallReport>({ dir }, report),
    feature,
  );
  return report;
}

/** Add `feature` to `text` and check the result is the current source for `expected`. */
async function assertUpgrades(
  pkg: string,
  text: string,
  feature: AndroidFeature,
  expected: ReadonlySet<AndroidFeature>,
  label: string,
): Promise<void> {
  await withActivity(pkg, text, async (dir, path) => {
    const report = await register(dir, feature);
    assertEquals(report.manual, [], label);
    assertEquals(report.kept, [], label);
    assertEquals(
      await Deno.readTextFile(join(dir, path)),
      await mainActivitySource(pkg, expected),
      label,
    );
    assertEquals(report.upgraded, text.startsWith("// denext-") ? [] : [path], label);
  });
}

Deno.test("MainActivity: written under an intact marker line, package on the next line", async () => {
  for (const set of combinations()) {
    const text = await mainActivitySource("com.example.app", new Set(set));
    assert(text.startsWith("// denext-main-activity-template: 1 sha256="), set.join("+"));
    assertEquals(await markedTemplateIntact("main-activity", text), true);
    assert(unmarked(text).startsWith("package com.example.app;\n"));
  }
});

Deno.test("MainActivity: every pre-marker shape upgrades to the current source, any package", async () => {
  // Releases before the marker wrote exactly today's body (their hashes are pinned in
  // SHIPPED_MAIN_ACTIVITY_SHA256; the git-backed test below checks them against the tags).
  for (const pkg of PACKAGES) {
    for (const set of combinations()) {
      const old = unmarked(await mainActivitySource(pkg, new Set(set)));
      for (const feature of FEATURES) {
        await assertUpgrades(
          pkg,
          old,
          feature,
          new Set([...set, feature]),
          `${pkg} ${set.join("+")} + ${feature}`,
        );
      }
    }
  }
});

Deno.test("MainActivity: a marked one is recognised and composes across features", async () => {
  const pkg = "com.example.app";
  // Build it up one installer at a time, in an order unlike FEATURE_ORDER.
  const order: AndroidFeature[] = ["widgets", "ota", "share-receive", "auth-session"];
  await withActivity(
    pkg,
    `package ${pkg};\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n`,
    async (dir, path) => {
      const done = new Set<AndroidFeature>();
      for (const feature of order) {
        const report = await register(dir, feature);
        done.add(feature);
        assertEquals(report.manual, [], feature);
        assertEquals(report.upgraded, [], feature);
        assertEquals(report.written, [path], feature);
        assertEquals(await Deno.readTextFile(join(dir, path)), await mainActivitySource(pkg, done));
      }
      const text = await Deno.readTextFile(join(dir, path));
      // OTA's prepare stays first thing; every registration runs before super.onCreate.
      const prepare = text.indexOf("DenextOta.prepare(this, bridgeBuilder);");
      const superCall = text.indexOf("super.onCreate(savedInstanceState);");
      for (
        const cls of ["DenextAuthSessionPlugin", "DenextShareReceivePlugin", "DenextWidgetsPlugin"]
      ) {
        const at = text.indexOf(`registerPlugin(${cls}.class);`);
        assert(prepare < at && at < superCall, cls);
      }
      // Every feature again: nothing changes.
      for (const feature of order) {
        const again = await register(dir, feature);
        assertEquals(again.written, []);
        assertEquals(again.unchanged, [path]);
      }
    },
  );
});

Deno.test("MainActivity: a marked one from another generation is upgraded", async () => {
  const pkg = "com.example.app";
  const body = unmarked(await mainActivitySource(pkg, new Set(["ota"]))).replace(
    "    @Override",
    "    // an older generation's wording\n    @Override",
  );
  await withActivity(
    pkg,
    await renderMarkedTemplate("main-activity", 0, body),
    async (dir, path) => {
      const report = await register(dir, "auth-session");
      assertEquals(report.manual, []);
      assertEquals(report.upgraded, [path]);
      assertEquals(
        await Deno.readTextFile(join(dir, path)),
        await mainActivitySource(pkg, new Set(["ota", "auth-session"])),
      );
    },
  );
  // Already registering the feature: still brought up to the current source.
  await withActivity(
    pkg,
    await renderMarkedTemplate("main-activity", 0, body),
    async (dir, path) => {
      const report = await register(dir, "ota");
      assertEquals(report.upgraded, [path]);
      assertEquals(
        await Deno.readTextFile(join(dir, path)),
        await mainActivitySource(pkg, new Set(["ota"])),
      );
    },
  );
});

Deno.test("MainActivity: an edited one is kept", async () => {
  const pkg = "com.example.app";
  const current = await mainActivitySource(pkg, new Set(["ota"]));
  const edit = (text: string) =>
    text.replace(
      "super.onCreate(savedInstanceState);",
      "super.onCreate(savedInstanceState);\n        init();",
    );
  for (
    const [label, text] of [
      ["edited, marked", edit(current)],
      ["edited, pre-marker", edit(unmarked(current))],
    ]
  ) {
    // Adding a feature it lacks: a manual step, the file untouched.
    await withActivity(pkg, text, async (dir, path) => {
      const report = await register(dir, "auth-session");
      assertEquals(report.written, [], label);
      assertEquals(report.manual.length, 1, label);
      assert(report.manual[0].startsWith(path), label);
      assertStringIncludes(report.manual[0], "registerPlugin(DenextAuthSessionPlugin.class);");
      assertEquals(await Deno.readTextFile(join(dir, path)), text, label);
    });
    // A feature it already registers: left alone.
    await withActivity(pkg, text, async (dir, path) => {
      const report = await register(dir, "ota");
      assertEquals(report.written, [], label);
      assertEquals(report.manual, [], label);
      assertEquals(report.unchanged, [path], label);
      assertEquals(await Deno.readTextFile(join(dir, path)), text, label);
    });
  }
});

Deno.test("MainActivity: a marked one registering a plugin this release does not know is kept", async () => {
  const pkg = "com.example.app";
  const body = unmarked(await mainActivitySource(pkg, new Set(["ota"]))).replace(
    "        super.onCreate(",
    "        registerPlugin(DenextFuturePlugin.class);\n        super.onCreate(",
  );
  const text = await renderMarkedTemplate("main-activity", 9, body);
  await withActivity(pkg, text, async (dir, path) => {
    const report = await register(dir, "widgets");
    assertEquals(report.written, []);
    assertEquals(report.manual.length, 1);
    assertEquals(await Deno.readTextFile(join(dir, path)), text);
  });
});

/** Whether this checkout has the release tags (a shallow CI clone may not). */
async function hasTag(tag: string): Promise<boolean> {
  try {
    const out = await new Deno.Command("git", {
      args: ["rev-parse", "-q", "--verify", `refs/tags/${tag}`],
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

/** `git show <tag>:<path>` as text. */
async function showAt(tag: string, path: string): Promise<string> {
  const out = await new Deno.Command("git", { args: ["show", `${tag}:${path}`] }).output();
  assert(out.success, `git show ${tag}:${path}`);
  return new TextDecoder().decode(out.stdout);
}

/** The OTA-only MainActivity `add-ota` wrote at `tag` (v2.7.0 … v2.9.0: `preparedMainActivity`). */
async function preparedMainActivityAt(tag: string, pkg: string): Promise<string> {
  const src = await showAt(tag, "src/build/mobile-ota-install.ts");
  const m = /function preparedMainActivity\(pkg: string\): string \{\n {2}return `([\s\S]*?)`;\n\}/
    .exec(src);
  assert(m, `${tag}: preparedMainActivity`);
  return m[1].replace("${pkg}", pkg);
}

/** `mainActivitySource` for every feature combination of `tag` (v2.10.0-rc.1 …). */
async function composedMainActivitiesAt(
  tag: string,
  pkg: string,
): Promise<Array<{ set: AndroidFeature[]; text: string }>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_main_activity_tag_" });
  try {
    const archive = new Deno.Command("git", {
      args: ["archive", tag, "src/build"],
      stdout: "piped",
    }).spawn();
    const untar = new Deno.Command("tar", { args: ["-x", "-C", dir], stdin: "piped" }).spawn();
    await archive.stdout.pipeTo(untar.stdin);
    assert((await archive.status).success && (await untar.status).success, `git archive ${tag}`);
    const file = join(dir, "src/build/mobile-native-install.ts");
    const src = await Deno.readTextFile(file);
    const order = JSON.parse(
      /const FEATURE_ORDER[^=]*= (\[[\s\S]*?\]);/.exec(src)![1].replace(/,\s*\]/, "]"),
    ) as AndroidFeature[];
    const mod = await import(`file://${file}`);
    const out: Array<{ set: AndroidFeature[]; text: string }> = [];
    for (let mask = 1; mask < 1 << order.length; mask++) {
      const set = order.filter((_, i) => mask & (1 << i));
      out.push({ set, text: await mod.mainActivitySource(pkg, new Set(set)) });
    }
    return out;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "MainActivity: what v2.7.0 … v2.10.0-rc.3 wrote upgrades to the current source",
  ignore: !(await hasTag("v2.10.0-rc.3")),
  async fn() {
    const pkg = "com.brainwires.t3code";
    for (const tag of ["v2.7.0", "v2.7.1", "v2.8.0", "v2.8.1", "v2.8.2", "v2.8.3", "v2.9.0"]) {
      const old = await preparedMainActivityAt(tag, pkg);
      await assertUpgrades(pkg, old, "widgets", new Set(["ota", "widgets"]), tag);
    }
    let shapes = 0;
    for (const tag of ["v2.10.0-rc.1", "v2.10.0-rc.2", "v2.10.0-rc.3"]) {
      for (const { set, text } of await composedMainActivitiesAt(tag, pkg)) {
        const label = `${tag} ${set.join("+")}`;
        // Adding a feature it lacks, and re-adding one it has (brought up to date either way).
        const missing = FEATURES.find((f) => !set.includes(f)) ?? "ota";
        await assertUpgrades(
          pkg,
          text,
          missing,
          new Set([...set, missing]),
          `${label} + ${missing}`,
        );
        await assertUpgrades(pkg, text, set[0], new Set(set), `${label} + ${set[0]}`);
        shapes++;
      }
    }
    assertEquals(shapes, 3 + 3 + 15);
  },
});

Deno.test("MainActivity: one a newer denext wrote is never downgraded", async () => {
  const pkg = "com.example.app";
  const body = unmarked(await mainActivitySource(pkg, new Set(["ota"]))).replace(
    "    @Override",
    "    // a newer generation's wording\n    @Override",
  );
  const newer = await renderMarkedTemplate("main-activity", 99, body);
  // Adding a feature it lacks: a manual step naming the newer denext, the file untouched.
  await withActivity(pkg, newer, async (dir, path) => {
    const report = await register(dir, "auth-session");
    assertEquals(report.written, []);
    assertEquals(report.upgraded, []);
    assertEquals(report.manual.length, 1);
    assert(report.manual[0].startsWith(`${path} was written by a newer denext`));
    assertStringIncludes(report.manual[0], "registerPlugin(DenextAuthSessionPlugin.class);");
    assertEquals(await Deno.readTextFile(join(dir, path)), newer);
  });
  // A feature it already registers: unchanged.
  await withActivity(pkg, newer, async (dir, path) => {
    const report = await register(dir, "ota");
    assertEquals(report.written, []);
    assertEquals(report.manual, []);
    assertEquals(report.unchanged, [path]);
    assertEquals(await Deno.readTextFile(join(dir, path)), newer);
  });
});

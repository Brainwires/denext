// The copy of denext an app's `denext` import reaches (src/build/app-framework-root.ts), and the
// native bundle config that folds that copy into the running framework (prepareConfig). A build
// imports the RUNNING framework by URL (generated entries, client transforms); an app whose
// `denext` reached another copy bundled two runtimes.

import { assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  appDenextRoot,
  appDenextRootFor,
  foldAppDenext,
  JSR_DENEXT_ROOT,
  jsrRangeAdmits,
  lockedVersion,
  lockfilePath,
} from "../src/build/app-framework-root.ts";
import { frameworkFileUrl, frameworkRootUrl, prepareConfig } from "../src/build/bundle.ts";

const CHECKOUT = { root: "file:///src/denext/", version: "3.4.2" };
const PUBLISHED = { root: `${JSR_DENEXT_ROOT}3.4.2/`, version: "3.4.2" };
const SERVED = { root: "http://127.0.0.1:8799/", version: "3.4.2" };

Deno.test("jsrRangeAdmits reads a requirement the way Deno does", () => {
  const cases: Array<[string, string, boolean | null]> = [
    ["3.4.2", "3.4.2", true],
    ["3.4.1", "3.4.2", false], // a full version is exact
    ["^3.4.1", "3.4.2", true],
    ["^3.3.0", "3.4.2", true],
    ["^3.4.3", "3.4.2", false],
    ["^4.0.0", "3.4.2", false],
    ["~3.4.0", "3.4.2", true],
    ["~3.3.0", "3.4.2", false],
    ["^0.2.1", "0.3.0", false],
    ["^0.0.3", "0.0.4", false],
    ["3", "3.4.2", true],
    ["3.4", "3.4.2", true],
    ["3.3", "3.4.2", false],
    ["*", "3.4.2", true],
    ["", "3.4.2", true],
    [">=3.0.0", "3.4.2", null],
  ];
  for (const [range, version, want] of cases) {
    assertEquals(jsrRangeAdmits(range, version), want, `${range} admits ${version}`);
  }
});

Deno.test("appDenextRoot: an app mapping no denext, or the running framework, is unchanged", () => {
  assertEquals(appDenextRoot(undefined, CHECKOUT), CHECKOUT.root);
  assertEquals(appDenextRoot(`${CHECKOUT.root}mod.ts`, CHECKOUT), CHECKOUT.root);
  assertEquals(appDenextRoot(`${PUBLISHED.root}mod.ts`, PUBLISHED), PUBLISHED.root);
  // A value that is not denext's root module (a local shim) says nothing about the root.
  assertEquals(appDenextRoot("file:///app/my-denext.ts", CHECKOUT), CHECKOUT.root);
});

Deno.test("appDenextRoot: an app mapping denext to another checkout or URL uses that root", () => {
  assertEquals(appDenextRoot("file:///other/denext/mod.ts", CHECKOUT), "file:///other/denext/");
  assertEquals(appDenextRoot(`${SERVED.root}mod.ts`, CHECKOUT), SERVED.root);
  assertEquals(
    appDenextRoot(`${JSR_DENEXT_ROOT}3.3.0/mod.ts`, PUBLISHED),
    `${JSR_DENEXT_ROOT}3.3.0/`,
  );
});

Deno.test("appDenextRoot: a checkout the app's jsr requirement admits is linked in place", () => {
  const spec = "jsr:@denext/denext@^3.4.0";
  assertEquals(appDenextRoot(spec, CHECKOUT), CHECKOUT.root);
  // Deno links the checkout whatever version the lockfile recorded.
  assertEquals(appDenextRoot(spec, CHECKOUT, "3.4.1"), CHECKOUT.root);
  assertEquals(appDenextRoot("jsr:@denext/denext", CHECKOUT), CHECKOUT.root);
  // A requirement this does not model is assumed linked (the build's behavior before).
  assertEquals(appDenextRoot("jsr:@denext/denext@>=3.0.0", CHECKOUT, "3.3.0"), CHECKOUT.root);
});

Deno.test("appDenextRoot: a jsr requirement the running framework does not meet is the published copy", () => {
  // Exact pin, no lockfile.
  assertEquals(appDenextRoot("jsr:@denext/denext@3.3.0", CHECKOUT), `${JSR_DENEXT_ROOT}3.3.0/`);
  // A range the checkout misses: the lockfile's version.
  assertEquals(
    appDenextRoot("jsr:@denext/denext@^3.5.0", CHECKOUT, "3.5.1"),
    `${JSR_DENEXT_ROOT}3.5.1/`,
  );
  // ...and with no lockfile there is no telling: the running framework, as before.
  assertEquals(appDenextRoot("jsr:@denext/denext@^3.5.0", CHECKOUT), CHECKOUT.root);
});

Deno.test("appDenextRoot: the published CLI and the app's locked jsr version", () => {
  const spec = "jsr:@denext/denext@^3.4.0";
  // The normal published configuration: one version, one root.
  assertEquals(appDenextRoot(spec, PUBLISHED, "3.4.2"), PUBLISHED.root);
  assertEquals(appDenextRoot(spec, PUBLISHED), PUBLISHED.root);
  // A CLI of another version than the app's lockfile holds.
  assertEquals(appDenextRoot(spec, PUBLISHED, "3.4.1"), `${JSR_DENEXT_ROOT}3.4.1/`);
  // The framework served over http (CONTRIBUTING's remote-build check) is never linked.
  assertEquals(appDenextRoot(spec, SERVED, "3.4.2"), `${JSR_DENEXT_ROOT}3.4.2/`);
});

Deno.test("lockedVersion reads v5 and v3 lockfiles", () => {
  const v5 = {
    specifiers: { "jsr:@denext/denext@^3.4.0": "3.4.2", "jsr:@denext/denext@*": "3.4.1" },
  };
  assertEquals(lockedVersion(v5, "jsr:@denext/denext@^3.4.0"), "3.4.2");
  assertEquals(lockedVersion(v5, "jsr:@denext/denext"), "3.4.1");
  assertEquals(lockedVersion(v5, "jsr:@denext/denext@3.3.0"), undefined);
  const v3 = { specifiers: { "jsr:@denext/denext@^3": "jsr:@denext/denext@3.4.2" } };
  assertEquals(lockedVersion(v3, "jsr:@denext/denext@^3"), "3.4.2");
  assertEquals(lockedVersion(null, "jsr:@denext/denext@^3"), undefined);
  assertEquals(lockedVersion({ specifiers: {} }, "constructor"), undefined);
});

Deno.test("lockfilePath follows the config's lock field", () => {
  const cfg = join("/app", "deno.json");
  assertEquals(lockfilePath(cfg, undefined), join("/app", "deno.lock"));
  assertEquals(lockfilePath(cfg, "locks/app.lock"), join("/app", "locks", "app.lock"));
  assertEquals(lockfilePath(cfg, { path: "x.lock" }), join("/app", "x.lock"));
  assertEquals(lockfilePath(cfg, false), undefined);
});

Deno.test("appDenextRootFor reads the lockfile beside the config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_app_root_" });
  try {
    const cfg = join(dir, "deno.json");
    const spec = "jsr:@denext/denext@^3.5.0";
    await Deno.writeTextFile(
      join(dir, "deno.lock"),
      JSON.stringify({ version: "5", specifiers: { [spec]: "3.5.2" } }),
    );
    assertEquals(await appDenextRootFor(cfg, {}, spec, CHECKOUT), `${JSR_DENEXT_ROOT}3.5.2/`);
    assertEquals(await appDenextRootFor(cfg, { lock: false }, spec, CHECKOUT), CHECKOUT.root);
    // Unreadable or absent lockfiles fall back to the requirement.
    await Deno.writeTextFile(join(dir, "deno.lock"), "{not json");
    assertEquals(await appDenextRootFor(cfg, {}, spec, CHECKOUT), CHECKOUT.root);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("foldAppDenext maps another copy's root onto the running framework's", () => {
  assertEquals(foldAppDenext(CHECKOUT.root, CHECKOUT.root), {});
  assertEquals(foldAppDenext(CHECKOUT.root, "file:///other/denext/"), {
    "file:///other/denext/": CHECKOUT.root,
  });
  assertEquals(foldAppDenext(CHECKOUT.root, `${JSR_DENEXT_ROOT}3.3.0/`), {
    [`${JSR_DENEXT_ROOT}3.3.0/`]: CHECKOUT.root,
  });
  // Roots that nest would fold the running framework into itself.
  assertEquals(foldAppDenext(CHECKOUT.root, "file:///src/"), {});
  assertEquals(foldAppDenext(CHECKOUT.root, `${CHECKOUT.root}vendor/`), {});
});

/** The merged config prepareConfig writes for an app config. */
async function mergedImports(
  config: Record<string, unknown>,
  importMap?: Record<string, string>,
): Promise<Record<string, string>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_prepare_config_" });
  try {
    const configPath = join(dir, "deno.json");
    await Deno.writeTextFile(configPath, JSON.stringify(config));
    const merged = await prepareConfig(dir, { configPath, importMap });
    return JSON.parse(await Deno.readTextFile(merged)).imports;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("prepareConfig: an app on this framework gets no fold", async () => {
  const imports = await mergedImports({ imports: { denext: frameworkFileUrl("mod.ts") } });
  assertEquals(imports["denext/client-runtime"], frameworkFileUrl("src/client/client-runtime.ts"));
  assertEquals(imports["denext/live"], frameworkFileUrl("src/live.ts"));
  assertEquals(imports[frameworkRootUrl()], undefined);
  assertEquals(Object.values(imports).filter((v) => v === frameworkRootUrl()), []);
});

Deno.test("prepareConfig: an app on another copy of denext has it folded into this one", async () => {
  const other = toFileUrl(await Deno.makeTempDir({ prefix: "denext_other_root_" })).href + "/";
  try {
    const mode = frameworkFileUrl("src/runtime/async-context-mode.ts");
    const imports = await mergedImports(
      { imports: { denext: `${other}mod.ts`, "denext/devtools": "file:///mine/devtools.ts" } },
      { [mode]: "file:///out/asyncctx/mode.ts" },
    );
    assertEquals(imports[other], frameworkRootUrl());
    // The generated entries' imports stay on the running framework; the app's own entry and the
    // build's redirects are kept.
    assertEquals(
      imports["denext/client-runtime"],
      frameworkFileUrl("src/client/client-runtime.ts"),
    );
    assertEquals(imports["denext/devtools"], "file:///mine/devtools.ts");
    assertEquals(imports["denext"], `${other}mod.ts`);
    assertEquals(imports[mode], "file:///out/asyncctx/mode.ts");
  } finally {
    await Deno.remove(new URL(other), { recursive: true });
  }
});

Deno.test("prepareConfig: an app pinned to another published version is folded", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_prepare_jsr_" });
  try {
    const spec = "jsr:@denext/denext@0.1.0";
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: { denext: spec } }));
    const merged = await prepareConfig(dir, { configPath: join(dir, "deno.json") });
    const imports = JSON.parse(await Deno.readTextFile(merged)).imports;
    assertEquals(imports[`${JSR_DENEXT_ROOT}0.1.0/`], frameworkRootUrl());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

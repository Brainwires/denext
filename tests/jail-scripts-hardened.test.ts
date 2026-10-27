// The lifecycle-script jail on the runtimes after 3.0.0-rc.5, as denext prepares a project for
// them (src/build/jail-scripts.ts): rc.6's per-package write roots and `executables` sweep
// (Brainwires/deno DENEXT.md item 111), denext.1's `knownPackages` and `deno info --json`
// `lifecycleJail` (item 124), and denext.1's package.json `"deno"` object as the settings' home in a
// project without a deno.json (item 125). Each is gated on the runtime version, so stock Deno and
// rc.5 behave as before. Nothing here runs an install or touches the network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { JAIL_NOT_NEEDED, JAIL_SCRIPT_EXCEPTIONS } from "../src/build/jail-exceptions.ts";
import {
  applyJailExceptions,
  explainJailFailures,
  JAIL_HARDENED_RELEASE,
  jailConfinement,
  jailFailures,
  jailRuntime,
  jailSnippet,
  type LifecycleJail,
  parseLifecycleJail,
  readJailSetting,
  readLifecycleJail,
  upstreamByNameAdvice,
} from "../src/build/jail-scripts.ts";

const RC5 = "3.0.0-rc.5";
const RC6 = "3.0.0-rc.6";
const DENEXT1 = "3.0.0-denext.1";
/** No environment: a test never inherits the runner's `npm_config_*`. */
const NO_ENV = () => undefined;

/** A temp project holding `files` (objects are JSON); returns its (real) path. */
async function project(files: Record<string, unknown>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_jail_hardened_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** A JSON(C) file's object. */
async function readObject(path: string): Promise<Record<string, unknown>> {
  return parseJsonc(await Deno.readTextFile(path)) as Record<string, unknown>;
}

/** `supplyChain.jailScripts` below `prefix` (`["deno"]` for package.json) in a file. */
async function jailIn(path: string, prefix: string[] = []): Promise<Record<string, unknown>> {
  let doc: unknown = await readObject(path);
  for (const key of [...prefix, "supplyChain", "jailScripts"]) {
    doc = (doc as Record<string, unknown> | undefined)?.[key];
  }
  return (doc ?? {}) as Record<string, unknown>;
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false);
}

Deno.test("jail runtime: each feature from its release, none on stock Deno", () => {
  assertEquals(JAIL_HARDENED_RELEASE, DENEXT1);
  const none = {
    onByDefault: false,
    hostLists: false,
    writeRoots: false,
    knownPackages: false,
    confinementInfo: false,
    packageJsonHome: false,
  };
  // stock Deno, the runtimes before the jail's default, and no version at all get nothing
  for (const v of ["2.9.8", "3.0.0-rc.4", "2.9.7-denext.22", ""]) {
    assertEquals(jailRuntime(v), none, v);
  }
  assertEquals(jailRuntime(RC5), { ...none, onByDefault: true });
  assertEquals(jailRuntime(RC6), {
    ...none,
    onByDefault: true,
    hostLists: true,
    writeRoots: true,
  });
  const all = {
    onByDefault: true,
    hostLists: true,
    writeRoots: true,
    knownPackages: true,
    confinementInfo: true,
    packageJsonHome: true,
  };
  for (const v of [DENEXT1, "3.0.0-denext.2", "3.0.0-denext.10", "3.0.0", "3.1.0"]) {
    assertEquals(jailRuntime(v), all, v);
  }
});

Deno.test("jail runtime: the hardened gate is 3.0.0-denext.1, above every 3.0.0-rc.N", () => {
  assertEquals(JAIL_HARDENED_RELEASE, DENEXT1);
  const rc6Features = {
    onByDefault: true,
    hostLists: true,
    writeRoots: true,
    knownPackages: false,
    confinementInfo: false,
    packageJsonHome: false,
  };
  // the release candidates, whatever their number, sort below the denext line: none is hardened
  for (const v of [RC6, "3.0.0-rc.7", "3.0.0-rc.10", "3.0.0-rc.99"]) {
    assertEquals(jailRuntime(v), rc6Features, v);
  }
  // denext.1 and every later denext.N are at or above the gate (plain semver puts them below rc)
  for (const v of [DENEXT1, "3.0.0-denext.2", "3.0.0-denext.10"]) {
    const rt = jailRuntime(v);
    assert(rt.knownPackages && rt.confinementInfo && rt.packageJsonHome, v);
  }
});

Deno.test("jail rc.6: browser caches keep their executables; Prisma writes node_modules/.prisma", async () => {
  const files = {
    "deno.json": "{}\n",
    "package.json": {
      dependencies: { puppeteer: "24", "@prisma/client": "6", "playwright-chromium": "1" },
      devDependencies: { cypress: "15" },
    },
  };
  const rc6 = await project(files);
  const rc5 = await project(files);
  try {
    const r = await applyJailExceptions(rc6, { version: RC6, env: NO_ENV });
    assertEquals(r.action, "written");
    const pkgs = (await jailIn(join(rc6, "deno.json"))).packages as Record<
      string,
      Record<string, unknown>
    >;
    for (const name of ["puppeteer", "playwright-chromium", "cypress"]) {
      assertEquals(pkgs[name].executables, true, name);
    }
    assertEquals(pkgs.cypress.write, ["~/.cache/Cypress"]);
    // a jailed script writes only its own package from rc.6: the client's sibling directory
    assertEquals(pkgs["@prisma/client"].write, ["node_modules/.prisma"]);
    assertFalse(pkgs["@prisma/client"].executables !== undefined);
    // node_modules is the installer's to create, not denext's
    assertFalse(await exists(join(rc6, "node_modules")));
    // rc.5 confines writes to node_modules as a whole and sweeps nothing: neither is written
    await applyJailExceptions(rc5, { version: RC5, env: NO_ENV });
    const old = (await jailIn(join(rc5, "deno.json"))).packages as Record<
      string,
      Record<string, unknown>
    >;
    assertEquals(old.puppeteer.executables, undefined);
    assertEquals(old["@prisma/client"].write, undefined);
  } finally {
    await Deno.remove(rc6, { recursive: true });
    await Deno.remove(rc5, { recursive: true });
  }
});

Deno.test("jail rc.6: an entry written for rc.5 is completed, its own grants kept", async () => {
  const rc5Entry = {
    env: ["PUPPETEER_CACHE_DIR", "PUPPETEER_DOWNLOAD_BASE_URL", "PUPPETEER_SKIP_DOWNLOAD"],
    net: true,
  };
  const deno = JSON.stringify({
    supplyChain: {
      jailScripts: {
        packages: {
          puppeteer: rc5Entry,
          "@prisma/client": { net: ["binaries.prisma.sh"], write: ["generated"] },
          // brought in by @prisma/client; writes only its own package, so nothing to add
          "@prisma/engines": { net: true },
        },
      },
    },
  });
  const dir = await project({
    "deno.json": deno,
    "package.json": { dependencies: { puppeteer: "24", "@prisma/client": "6" } },
  });
  try {
    // on rc.5 it is complete
    const old = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(old.action, "configured");
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), deno);
    const r = await applyJailExceptions(dir, { version: RC6, env: NO_ENV });
    assertEquals(r.action, "written");
    assertEquals(r.missing.map((m) => m.entry.name), ["@prisma/client", "puppeteer"]);
    const pkgs = (await jailIn(join(dir, "deno.json"))).packages as Record<string, unknown>;
    assertEquals(pkgs.puppeteer, {
      ...rc5Entry,
      write: ["~/.cache/puppeteer"],
      executables: true,
    });
    assertEquals(pkgs["@prisma/client"], {
      net: ["binaries.prisma.sh"],
      write: ["generated", "node_modules/.prisma"],
    });
    const text = r.lines.join("\n");
    assertStringIncludes(
      text,
      'puppeteer: added "write": ["~/.cache/puppeteer"] and "executables"',
    );
    // a second run finds nothing to add
    const again = await applyJailExceptions(dir, { version: RC6, env: NO_ENV });
    assertEquals(again.action, "configured");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail denext.1: reviewed declared hosts are written to knownPackages, never before", async () => {
  for (const e of JAIL_SCRIPT_EXCEPTIONS.filter((e) => e.declaredHosts)) {
    assertEquals(e.exception, {}, `${e.name}: knownPackages is its only grant`);
    for (const h of e.declaredHosts!) assertFalse(h.includes("github"), `${e.name}: ${h}`);
  }
  const files = {
    "deno.json": "{}\n",
    "package.json": { dependencies: { grpc: "1", nodegit: "0.27", wrtc: "0.4", zod: "3" } },
  };
  const dir = await project(files);
  try {
    const rc6 = await applyJailExceptions(dir, { version: RC6, env: NO_ENV });
    assertEquals(rc6.action, "none", "a declared host is allowed by itself before denext.1");
    const r = await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    assertEquals(r.action, "written");
    assertEquals(await jailIn(join(dir, "deno.json")), {
      knownPackages: {
        grpc: ["node-precompiled-binaries.grpc.io"],
        nodegit: ["axonodegit.s3.amazonaws.com"],
        wrtc: ["node-webrtc.s3.amazonaws.com"],
      },
    });
    // the user's own list stays; only a missing one is added
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        supplyChain: { jailScripts: { knownPackages: { grpc: ["mirror.example.com"] } } },
      }),
    );
    await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    const known = (await jailIn(join(dir, "deno.json"))).knownPackages as Record<string, unknown>;
    assertEquals(known.grpc, ["mirror.example.com"]);
    assertEquals(Object.keys(known).sort(), ["grpc", "nodegit", "wrtc"]);
    assertEquals(
      readJailSetting({ denoJson: await readObject(join(dir, "deno.json")) }).knownPackages,
      known,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail denext.1: the snippet carries packages and knownPackages, in package.json's deno", () => {
  const grpc = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === "grpc")!;
  const msw = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === "msw")!;
  const reqs = [
    { entry: grpc, trigger: "grpc", exception: {}, known: ["node-precompiled-binaries.grpc.io"] },
    { entry: msw, trigger: "msw", exception: { write: ["public"] } },
  ];
  const inner = {
    supplyChain: {
      jailScripts: {
        packages: { msw: { write: ["public"] } },
        knownPackages: { grpc: ["node-precompiled-binaries.grpc.io"] },
      },
    },
  };
  assertEquals(JSON.parse(jailSnippet(reqs)), inner);
  assertEquals(JSON.parse(jailSnippet(reqs, "package.json")), { deno: inner });
});

Deno.test('jail denext.1: a package.json project\'s settings live in its "deno" object', async () => {
  const pkg = {
    name: "nest-app",
    scripts: { start: "nest start" },
    dependencies: { puppeteer: "24" },
  };
  const dir = await project({ "package.json": pkg });
  try {
    // rc.6: deno.json is the only home, and creating one would leave Node mode: the snippet
    const old = await applyJailExceptions(dir, { version: RC6, env: NO_ENV });
    assertEquals([old.action, old.home], ["manual", "deno.json"]);
    assertStringIncludes(old.lines[0], "add this to deno.json");
    const r = await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    assertEquals([r.action, r.home], ["written", "package.json"]);
    assertEquals(r.configPath, join(dir, "package.json"));
    assertStringIncludes(r.lines[0], 'package.json: "deno".supplyChain.jailScripts exception');
    assertFalse(await exists(join(dir, "deno.json")), "no deno.json: Node mode stays");
    const doc = await readObject(join(dir, "package.json"));
    assertEquals([doc.name, doc.scripts], [pkg.name, pkg.scripts], "the rest is kept");
    const jail = await jailIn(join(dir, "package.json"), ["deno"]);
    assertEquals(Object.keys(jail.packages as object), ["puppeteer"]);
    // read back from there: configured, and the source names the object
    assertEquals(
      (await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV })).action,
      "configured",
    );
    doc.deno = { allowScripts: ["npm:puppeteer"], supplyChain: { jailScripts: false } };
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(doc));
    const off = await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    assertEquals(off.action, "off");
    assertStringIncludes(
      off.lines[0],
      'package.json "deno".supplyChain.jailScripts turns the jail off',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('jail denext.1: a "deno" field without the settings is not read; a string one isn\'t edited', async () => {
  // an object with neither key is not the settings (a dependency may name an entry point)
  const dir = await project({
    "package.json": { deno: { entry: "./main.ts" }, dependencies: { re2: "1" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    assertEquals(r.action, "written");
    const doc = await readObject(join(dir, "package.json"));
    assertEquals((doc.deno as Record<string, unknown>).entry, "./main.ts");
    // a `"deno"` that isn't an object is left alone: the JSON to add is reported instead
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ deno: "./main.ts", dependencies: { re2: "1" } }),
    );
    const manual = await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    assertEquals(manual.action, "manual");
    assertStringIncludes(manual.lines[0], "add this to package.json");
    assert(JSON.parse(manual.snippet!).deno.supplyChain.jailScripts.packages.re2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail denext.1: beside a deno.json, package.json's object is ignored and doctor says so", async () => {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await project({
    "deno.json": "{}\n",
    "package.json": {
      deno: { supplyChain: { jailScripts: false } },
      dependencies: { re2: "1" },
    },
  });
  const seatbelt: LifecycleJail = { osSandbox: "seatbelt", hostLists: "proxy", warnings: [] };
  try {
    // the deno.json is the only home: the package.json `false` doesn't turn the jail off
    const r = await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    assertEquals([r.action, r.home], ["written", "deno.json"]);
    const check = await jailScriptsCheck(dir, {
      version: DENEXT1,
      env: NO_ENV,
      os: "linux",
      lifecycleJail: seatbelt,
    });
    assertEquals(check?.ok, false);
    assertStringIncludes(check!.detail, "which Deno ignores beside a deno.json");
    // rc.6 reads no package.json settings, so there is nothing to flag
    const rc6 = await jailScriptsCheck(dir, { version: RC6, env: NO_ENV, os: "linux" });
    assertEquals(rc6?.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The doctor's jail check, run on a temp project holding `files`, removed afterwards. */
async function withDoctor(
  files: Record<string, unknown>,
  fn: (
    check: typeof import("../src/cli/commands/doctor.ts").jailScriptsCheck,
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await project(files);
  try {
    await fn(jailScriptsCheck, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Linux with Landlock, as `deno info --json` reports it. */
const LANDLOCK: LifecycleJail = {
  osSandbox: "landlock",
  hostLists: "proxy",
  networkNamespace: true,
  warnings: [],
};

/** Windows, as `deno info --json` reports it. */
const WINDOWS: LifecycleJail = {
  osSandbox: "none",
  reason: "Windows has no OS sandbox for lifecycle scripts",
  hostLists: "unconfined",
  warnings: [],
};

/** A project with no dependency in the built-in list. */
const PLAIN = { "deno.json": "{}\n", "package.json": { dependencies: { zod: "3" } } };

const DENEXT1_LINUX = { version: DENEXT1, env: NO_ENV, os: "linux" as const };

Deno.test("doctor denext.1: confined by the OS, and what that can't hold", async () => {
  await withDoctor(PLAIN, async (check, dir) => {
    const confined = await check(dir, { ...DENEXT1_LINUX, lifecycleJail: LANDLOCK });
    assertEquals([confined?.ok, confined?.detail], [true, "confined by the OS (landlock)"]);
    const partial = await check(dir, {
      ...DENEXT1_LINUX,
      lifecycleJail: { ...LANDLOCK, hostLists: "unconfined", networkNamespace: false },
    });
    assertStringIncludes(partial!.detail, "other programs reach any host");
    assertStringIncludes(partial!.detail, "no network namespace");
  });
});

Deno.test("doctor denext.1: no OS sandbox, a warning only when scripts are approved", async () => {
  await withDoctor(PLAIN, async (check, dir) => {
    const opts = { ...DENEXT1_LINUX, os: "windows" as const, lifecycleJail: WINDOWS };
    const bare = await check(dir, opts);
    assertEquals(bare?.ok, true, "nothing approved: nothing runs unconfined");
    assertStringIncludes(bare!.detail, "no OS sandbox (Windows has no OS sandbox");
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ allowScripts: ["npm:re2"] }));
    const exposed = await check(dir, opts);
    assertEquals([exposed?.ok, exposed?.critical], [false, false]);
    // with a listed dependency the runtime's report replaces the static Windows note
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ supplyChain: { jailScripts: { packages: { re2: { net: true } } } } }),
    );
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { re2: "1" } }),
    );
    const listed = await check(dir, opts);
    assertStringIncludes(listed!.detail, "exceptions configured for re2 (no OS sandbox");
    assertFalse(listed!.detail.includes("on Windows the OS can't confine"));
  });
});

Deno.test("doctor denext.1: off, with its source; rc.5 and a silent runtime as before", async () => {
  await withDoctor({ ...PLAIN, ".npmrc": "jail-scripts=false\n" }, async (check, dir) => {
    const off = await check(dir, { ...DENEXT1_LINUX, lifecycleJail: WINDOWS });
    assertEquals(
      [off?.ok, off?.detail],
      [true, "off (.npmrc jail-scripts): dependencies' install scripts run unconfined"],
    );
    await Deno.remove(join(dir, ".npmrc"));
    // rc.5 doesn't report it: as before, no listed dependency means no check
    assertEquals(
      await check(dir, { ...DENEXT1_LINUX, version: RC5, lifecycleJail: WINDOWS }),
      null,
    );
    // denext.1 without an injected report asks the runtime; one that doesn't answer leaves it out
    const asked = await check(dir, DENEXT1_LINUX);
    assert(asked === null || /^(confined|no OS)/.test(asked.detail));
  });
});

Deno.test('doctor denext.1: a package.json project\'s missing exception names its "deno" object', async () => {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await project({ "package.json": { dependencies: { re2: "1" } } });
  try {
    const opts = { version: DENEXT1, env: NO_ENV, os: "linux" as const, lifecycleJail: null };
    const missing = await jailScriptsCheck(dir, opts);
    assertEquals(missing?.ok, false);
    assertStringIncludes(
      missing!.detail,
      '{"deno":{"supplyChain":{"jailScripts":{"packages":{"re2"',
    );
    assertStringIncludes(missing!.detail, 'to package.json "deno"');
    await applyJailExceptions(dir, { version: DENEXT1, env: NO_ENV });
    const configured = await jailScriptsCheck(dir, opts);
    assertEquals([configured?.ok, configured?.detail], [true, "exceptions configured for re2"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('jail denext.1: install-log fixes and upstreamByName name package.json\'s "deno"', () => {
  const log = "error: script 'install' in 're2@1.21.0' failed with exit code 1\n" +
    "getaddrinfo ENOTFOUND github.com\n" +
    "error: script 'postinstall' in 'evil@1.0.0' failed with exit code 1\n" +
    "Error: EACCES: permission denied, open '/home/me/.zshrc'\n";
  const text = explainJailFailures(jailFailures(log, "linux"), DENEXT1, {}, "package.json").join(
    "\n",
  );
  assertStringIncludes(text, 'fix: package.json "deno" "supplyChain"');
  assertStringIncludes(text, 'in package.json "deno"');
  const proxied = "error: script 'postinstall' in 'pkg@1.0.0' failed with exit code 1\n" +
    "Warning jail-scripts: the upstream proxy refused a tunnel to cdn.example.com:443 by its " +
    "checked address (203.0.113.9)\n";
  const advice = upstreamByNameAdvice({
    output: proxied,
    denoJson: { supplyChain: { jailScripts: { packages: { pkg: { net: ["cdn.example.com"] } } } } },
    home: "package.json",
    version: DENEXT1,
  });
  assertStringIncludes(advice.join("\n"), 'fix: package.json "deno" "supplyChain"');
});

Deno.test("lifecycleJail: parsed from deno info --json, anything else is null", async () => {
  const info = {
    version: 1,
    denoDir: "/x",
    lifecycleJail: {
      osSandbox: "landlock",
      hostLists: "proxy",
      networkNamespace: false,
      warnings: ["jail-scripts: no namespace", 3],
    },
  };
  assertEquals(parseLifecycleJail(JSON.stringify(info)), {
    osSandbox: "landlock",
    hostLists: "proxy",
    networkNamespace: false,
    warnings: ["jail-scripts: no namespace"],
  });
  const none = {
    lifecycleJail: { osSandbox: "none", reason: "no Landlock", hostLists: "unconfined" },
  };
  assertEquals(parseLifecycleJail(JSON.stringify(none))?.reason, "no Landlock");
  assertEquals(parseLifecycleJail(JSON.stringify(none))?.warnings, []);
  for (const bad of ["", "not json", "[]", '{"version":1}', '{"lifecycleJail":{"osSandbox":1}}']) {
    assertEquals(parseLifecycleJail(bad), null, bad);
  }
  assertEquals(jailConfinement(none.lifecycleJail as LifecycleJail).state, "no-os-sandbox");
  // a runtime that can't run, or doesn't report it (the test's own Deno is rc.5 or stock)
  assertEquals(await readLifecycleJail(join(Deno.cwd(), "no-such-deno"), Deno.cwd()), null);
  const own = await readLifecycleJail(Deno.execPath(), Deno.cwd());
  assert(own === null || typeof own.osSandbox === "string");
});

Deno.test({
  name: "lifecycleJail: read from the runtime's own deno info --json",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await project({});
    try {
      const fake = join(dir, "deno");
      const out = JSON.stringify({
        lifecycleJail: { osSandbox: "seatbelt", hostLists: "proxy", warnings: [] },
      });
      await Deno.writeTextFile(
        fake,
        `#!/bin/sh\n[ "$1 $2" = "info --json" ] || exit 2\nprintf '%s' '${out}'\n`,
      );
      await Deno.chmod(fake, 0o755);
      assertEquals(await readLifecycleJail(fake, dir), {
        osSandbox: "seatbelt",
        hostLists: "proxy",
        warnings: [],
      });
      await Deno.writeTextFile(fake, "#!/bin/sh\nexit 1\n");
      assertEquals(await readLifecycleJail(fake, dir), null, "a failed run");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("jail: bcrypt and bufferutil say approving works only where the OS confines (denext.1)", () => {
  for (const name of ["bcrypt", "bufferutil"]) {
    const why = JAIL_NOT_NEEDED.find((n) => n.name === name)?.why ?? "";
    assertStringIncludes(why, "unapproved", name);
    assertStringIncludes(why, "where the OS confines lifecycle scripts", name);
    assertStringIncludes(why, "3.0.0-denext.1", name);
  }
});

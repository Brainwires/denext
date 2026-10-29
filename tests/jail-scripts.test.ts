// The lifecycle-script jail as denext prepares a project for it (src/build/jail-scripts.ts, the
// built-in list in src/build/jail-exceptions.ts): which packages need an exception, when the jail
// is on (opt-in up to runtime 3.0.0-rc.4, default from 3.0.0-rc.5), what `migrate` / `create` /
// `add` write into deno.json, what `denext doctor` reports, and how an install log's jail failures
// are explained. Nothing here runs an install or touches the network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  JAIL_NOT_NEEDED,
  JAIL_SCRIPT_EXCEPTIONS,
  type JailPackageException,
} from "../src/build/jail-exceptions.ts";
import {
  applyJailExceptions,
  entryException,
  explainJailFailures,
  JAIL_DEFAULT_RELEASE,
  jailEffective,
  jailFailures,
  jailOnByDefault,
  narrowWriteTarget,
  npmPackageName,
  npmrcValue,
  readJailProject,
  readJailSetting,
  UPSTREAM_BY_NAME_RELEASE,
  upstreamByNameAdvice,
  userNpmrcPath,
} from "../src/build/jail-scripts.ts";
import { compareDenoVersions } from "../src/build/deno-version.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));
/** A runtime that jails by default, and one that jails only on request. */
const RC5 = "3.0.0-rc.5";
const RC3 = "3.0.0-rc.3";
const RC6 = "3.0.0-rc.6";
/** No environment: a test never inherits the runner's `npm_config_*`. */
const NO_ENV = () => undefined;

type Tree = Record<string, unknown>;

/** A temp project holding `files` (objects are JSON); returns its (real) path. */
async function project(files: Tree): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_jail_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** The project's deno.json `supplyChain.jailScripts`. */
async function jailConfig(dir: string): Promise<unknown> {
  const doc = parseJsonc(await Deno.readTextFile(join(dir, "deno.json"))) as Record<
    string,
    { jailScripts?: unknown } | undefined
  >;
  return doc.supplyChain?.jailScripts;
}

/** The list's exception for `name`. */
function listed(name: string): JailPackageException {
  const entry = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === name);
  assert(entry, name);
  return entry.exception;
}

/** A plain-JSON copy (what JSON.stringify writes) of an exception. */
function plain(e: JailPackageException): unknown {
  return JSON.parse(JSON.stringify(e));
}

/** Whether a list entry grants anything: the network, env, project directories or known hosts. */
function entryGrants(e: (typeof JAIL_SCRIPT_EXCEPTIONS)[number]): boolean {
  const lists = [e.exception.env, e.writeTargets, e.declaredHosts];
  return e.exception.net === true || lists.some((l) => (l?.length ?? 0) > 0);
}

/** One list entry is in deno.json's exception shape and says why. */
function assertEntryShape(e: (typeof JAIL_SCRIPT_EXCEPTIONS)[number]): void {
  assert(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(e.name), e.name);
  assert(e.reason.length > 20, `${e.name} says why`);
  for (const key of Object.keys(e.exception)) {
    assert(["env", "write", "net"].includes(key), `${e.name}: ${key}`);
  }
  const env = [...e.exception.env ?? []];
  assert(entryGrants(e), `${e.name} grants something`);
  for (const v of env) assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(v), v);
  assertEquals(env, [...env].sort(), e.name);
  assertFalse((e.via ?? []).includes(e.name), e.name);
}

Deno.test("jail exceptions: the built-in list is sorted, unique and in deno.json's shape", () => {
  const names = JAIL_SCRIPT_EXCEPTIONS.map((e) => e.name);
  assertEquals(names, [...names].sort(), "sorted by name");
  assertEquals(new Set(names).size, names.length, "one entry per package");
  JAIL_SCRIPT_EXCEPTIONS.forEach(assertEntryShape);
  for (const n of JAIL_NOT_NEEDED) assertFalse(names.includes(n.name), `${n.name} needs none`);
  // the packages the brief names as breaking under the jail are all covered
  for (const name of ["puppeteer", "sharp", "@prisma/engines", "electron", "playwright-chromium"]) {
    assert(names.includes(name), name);
  }
});

Deno.test("jail: on by default from runtime 3.0.0-rc.5, never on stock or older builds", () => {
  assertEquals(JAIL_DEFAULT_RELEASE, RC5);
  for (const v of [RC5, "3.0.0-rc.6", "3.0.0-rc.10", "3.0.0", "3.1.0"]) {
    assert(jailOnByDefault(v), v);
  }
  for (const v of [RC3, "3.0.0-rc.4", "2.9.7-denext.22", "2.9.7", ""]) {
    assertFalse(jailOnByDefault(v), String(v));
  }
  // no version: the checked-in pin decides the default (3.0.0-rc.5 or later: on)
  assertEquals(
    jailOnByDefault(),
    compareDenoVersions(toolchainPin.version, RC5) >= 0,
  );
  assertEquals(jailOnByDefault(undefined), jailOnByDefault(toolchainPin.version));
});

Deno.test("jail: the user-level ~/.npmrc counts too (npm's userconfig, else HOME)", async () => {
  assertEquals(readJailSetting({ userNpmrc: "jail-scripts=false\n" }).state, "off");
  const para = readJailSetting({ userNpmrc: "paranoid=true\n" });
  assertEquals([para.state, para.paranoid], ["on", "~/.npmrc paranoid"]);
  // The project's file asking for the jail still wins over the user's turning it off.
  assertEquals(
    readJailSetting({ npmrc: "jail-scripts=true", userNpmrc: "jail-scripts=false" }).state,
    "on",
  );
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assertEquals(userNpmrcPath(env({ HOME: "/h" })), join("/h", ".npmrc"));
  assertEquals(userNpmrcPath(env({ USERPROFILE: "C:/u" })), join("C:/u", ".npmrc"));
  assertEquals(userNpmrcPath(env({ HOME: "/h", npm_config_userconfig: "/etc/x" })), "/etc/x");
  assertEquals(userNpmrcPath(env({})), null);
  // readJailProject reads it from the home directory the environment names.
  const home = await project({ ".npmrc": "jail-scripts=false\n" });
  const dir = await project({ "deno.json": "{}\n" });
  try {
    const read = await readJailProject(dir, { env: env({ HOME: home }) });
    assertEquals([read.setting.state, read.setting.source], ["off", "~/.npmrc jail-scripts"]);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: settings merge as the runtime merges them, the stricter one winning", () => {
  assertEquals(readJailSetting({}).state, "default");
  const off = readJailSetting({ denoJson: { supplyChain: { jailScripts: false } } });
  assertEquals([off.state, off.source], ["off", "deno.json supplyChain.jailScripts"]);
  assertEquals(readJailSetting({ npmrc: "; c\n# c\njail-scripts = false\n" }).state, "off");
  assertEquals(
    readJailSetting({ env: (n) => n === "NPM_CONFIG_JAIL_SCRIPTS" ? "FALSE" : undefined }).state,
    "off",
  );
  // a .npmrc can't quietly turn off what deno.json asks for, nor the reverse
  const on = readJailSetting({
    denoJson: { supplyChain: { jailScripts: false } },
    npmrc: "jail-scripts=true",
  });
  assertEquals([on.state, on.source], ["on", ".npmrc jail-scripts"]);
  const obj = readJailSetting({
    denoJson: { supplyChain: { jailScripts: { packages: { sharp: { net: true } } } } },
    npmrc: "jail-scripts=false",
    version: RC5,
  });
  assertEquals([obj.state, obj.packages], ["on", { sharp: { net: true } }]);
  assertEquals(readJailSetting({ denoJson: { supplyChain: { paranoid: true } } }).state, "on");
  assertEquals(readJailSetting({ npmrc: "paranoid=true" }).state, "on");
  assertEquals(
    readJailSetting({ env: (n) => n === "npm_config_paranoid" ? "true" : undefined }).state,
    "on",
  );
  assertEquals(npmrcValue("a=1\na=2", "a"), "2", "the last value wins");
  assertEquals(npmrcValue("b=1", "a"), undefined);
  // what the state means per runtime
  assert(jailEffective({ state: "on", packages: {} }, RC3));
  assertFalse(jailEffective({ state: "off", packages: {} }, RC5));
  assert(jailEffective({ state: "default", packages: {} }, RC5));
  assertFalse(jailEffective({ state: "default", packages: {} }, RC3));
});

Deno.test("jail: from runtime 3.0.0-rc.6 a packages-only jailScripts object doesn't ask for the jail", async () => {
  const packagesOnly = { supplyChain: { jailScripts: { packages: { sharp: { net: true } } } } };
  const off = readJailSetting({
    denoJson: packagesOnly,
    npmrc: "jail-scripts=false",
    version: RC6,
  });
  assertEquals([off.state, off.source, off.packages], [
    "off",
    ".npmrc jail-scripts",
    { sharp: { net: true } },
  ]);
  assertEquals(readJailSetting({ denoJson: packagesOnly, version: RC6 }).state, "default");
  const known = { supplyChain: { jailScripts: { knownPackages: { a: ["a.example"] } } } };
  assertEquals(readJailSetting({ denoJson: known, version: RC6 }).state, "default");
  // `net`, or an object with neither list, still asks for it
  for (const jailScripts of [{ net: false, packages: {} }, { upstreamByName: true }, {}]) {
    const on = readJailSetting({
      denoJson: { supplyChain: { jailScripts } },
      npmrc: "jail-scripts=false",
      version: RC6,
    });
    assertEquals([on.state, on.source], ["on", "deno.json supplyChain.jailScripts"]);
  }
  // stock Deno (no jail) keeps the old reading; jailEffective is false there anyway
  assertEquals(readJailSetting({ denoJson: packagesOnly, version: null }).state, "on");
  // next to `jail-scripts=false`, nothing is written and doctor flags nothing missing
  const config = JSON.stringify({ supplyChain: { jailScripts: { packages: {} } } });
  const dir = await project({
    "deno.json": config,
    ".npmrc": "jail-scripts=false\n",
    "package.json": { dependencies: { re2: "1" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC6, env: NO_ENV });
    assertEquals([r.action, r.effective], ["off", false]);
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), config);
    const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
    const check = await jailScriptsCheck(dir, { version: RC6, env: NO_ENV, os: "linux" });
    assertEquals([check?.ok, check?.detail], [
      true,
      "off (.npmrc jail-scripts); re2 runs unconfined",
    ]);
    // on rc.5 the same object still turns the jail on
    const rc5 = await jailScriptsCheck(dir, { version: RC5, env: NO_ENV, os: "linux" });
    assertEquals(rc5?.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: npm package names from specifiers", () => {
  assertEquals(npmPackageName("npm:puppeteer@^24"), "puppeteer");
  assertEquals(npmPackageName("npm:@prisma/client@6/runtime"), "@prisma/client");
  assertEquals(npmPackageName("npm:/sharp"), "sharp");
  assertEquals(npmPackageName("jsr:@std/path"), null);
});

const DENO_JSON = `{
  // the app's own comment survives
  "tasks": { "dev": "denext dev" },
  "imports": { "puppeteer": "npm:puppeteer@^24.1.0" }
}
`;

Deno.test("jail: with the jail on by default, the needed exceptions are written into deno.json", async () => {
  const dir = await project({
    "deno.json": DENO_JSON,
    "package.json": { dependencies: { sharp: "^0.34.0", react: "19.1.0" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "written");
    assert(r.effective);
    assertEquals(r.missing.map((m) => m.entry.name), ["puppeteer", "sharp"]);
    const text = await Deno.readTextFile(join(dir, "deno.json"));
    assertStringIncludes(text, "// the app's own comment survives");
    assertEquals(await jailConfig(dir), {
      packages: { puppeteer: plain(listed("puppeteer")), sharp: plain(listed("sharp")) },
    });
    assertStringIncludes(r.lines[0], "puppeteer and sharp");
    assertStringIncludes(r.lines.join("\n"), "scratch directory", "the caveat is said");
    // a second run finds them configured and changes nothing
    const again = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(again.action, "configured");
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), text);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: on a runtime that jails only on request nothing is written", async () => {
  const dir = await project({ "deno.json": DENO_JSON });
  try {
    const r = await applyJailExceptions(dir, { version: RC3, env: NO_ENV });
    assertEquals([r.action, r.effective], ["pending", false]);
    assertStringIncludes(r.lines[0], `runtime ${RC5}`);
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), DENO_JSON);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: an opted-out project is left alone; the jail is never turned off", async () => {
  const deno = JSON.stringify({ supplyChain: { jailScripts: false }, imports: {} });
  const dir = await project({
    "deno.json": deno,
    "package.json": { dependencies: { sharp: "1" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "off");
    assertStringIncludes(r.lines[0], "deno.json supplyChain.jailScripts turns the jail off");
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), deno);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: `jail-scripts=true` in .npmrc turns it on before rc.5, so exceptions are written", async () => {
  const dir = await project({
    "deno.json": "{}\n",
    ".npmrc": "jail-scripts=true\n",
    "package.json": { devDependencies: { electron: "^38.0.0" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC3, env: NO_ENV });
    assertEquals(r.action, "written");
    assertEquals(await jailConfig(dir), { packages: { electron: plain(listed("electron")) } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: the user's own exceptions stay; only the missing ones are added", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({
      supplyChain: { jailScripts: { net: false, packages: { puppeteer: { env: ["X"] } } } },
    }),
    "package.json": { dependencies: { puppeteer: "24", "better-sqlite3": "12" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.missing.map((m) => m.entry.name), ["better-sqlite3"]);
    assertEquals(await jailConfig(dir), {
      net: false,
      packages: { puppeteer: { env: ["X"] }, "better-sqlite3": { net: true } },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: `jailScripts: true` becomes the object (still on) holding the exceptions", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ supplyChain: { jailScripts: true } }),
    "package.json": { dependencies: { "ffmpeg-static": "5" } },
  });
  try {
    await applyJailExceptions(dir, { version: RC3, env: NO_ENV });
    assertEquals(await jailConfig(dir), {
      packages: { "ffmpeg-static": plain(listed("ffmpeg-static")) },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: with no deno.json (or one that may not be edited) the snippet is reported", async () => {
  const dir = await project({ "package.json": { dependencies: { cypress: "15" } } });
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "manual");
    assertEquals(JSON.parse(r.snippet!), {
      supplyChain: { jailScripts: { packages: { cypress: plain(listed("cypress")) } } },
    });
    assertStringIncludes(r.lines.join("\n"), '"cypress"');
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    const kept = await applyJailExceptions(dir, { version: RC5, env: NO_ENV, edit: false });
    assertEquals(kept.action, "manual");
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), "{}");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail: project directories are resolved: Prisma's output, msw's worker, git hooks", async () => {
  const root = await project({
    ".git/hooks/.keep": "",
    "app/deno.json": "{}",
    "app/package.json": {
      dependencies: { prisma: "6", "@prisma/client": "6", msw: "2", lefthook: "1" },
      msw: { workerDirectory: ["./public/", "static"] },
    },
    "app/prisma/schema.prisma": `generator client {
  provider = "prisma-client"
  output   = "../generated/client"
}
generator js {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/x"
}
`,
  });
  const dir = join(root, "app");
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "written");
    const jail = await jailConfig(dir) as { packages: Record<string, JailPackageException> };
    assertEquals(jail.packages["@prisma/client"].write, ["generated/client"]);
    assertEquals(jail.packages["@prisma/engines"], plain(listed("@prisma/engines")));
    assertEquals(
      r.required.find((q) => q.entry.name === "@prisma/engines")?.trigger,
      "prisma",
      "brought in by prisma",
    );
    assertEquals(jail.packages.msw, { write: ["public", "static"] });
    assertEquals(jail.packages.lefthook, { write: ["../.git/hooks"] });
    // the granted directories exist (Landlock skips a missing one)
    for (const d of ["generated/client", "public", "static"]) {
      assert((await Deno.stat(join(dir, d))).isDirectory, d);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("jail: write targets outside the project are refused", async () => {
  for (
    const bad of [
      "",
      " ",
      "/",
      "/abs",
      "C:/x",
      "c:\\x",
      "\\\\host\\share",
      ".",
      "./",
      "..",
      "../x",
      "a/../../x",
      "../../../home/u/.ssh",
      "a\\..\\..\\x",
    ]
  ) {
    assertFalse(narrowWriteTarget(bad), JSON.stringify(bad));
    assertFalse(narrowWriteTarget(bad, "prisma-output"), JSON.stringify(bad));
  }
  for (const ok of ["generated/client", "public", "./static", "a/b/c"]) {
    assert(narrowWriteTarget(ok, "msw-worker"), ok);
  }
  // only git-hooks may sit above the project, and only as the repository's .git/hooks
  assert(narrowWriteTarget("../.git/hooks", "git-hooks"));
  assert(narrowWriteTarget("../../.git/hooks", "git-hooks"));
  assertFalse(narrowWriteTarget("../.git/hooks", "prisma-output"));
  assertFalse(narrowWriteTarget("../other/.git/hooks", "git-hooks"));

  const root = await project({
    "app/deno.json": "{}",
    "app/package.json": {
      dependencies: { prisma: "6", "@prisma/client": "6", msw: "2" },
      msw: { workerDirectory: ["../../outside", "/abs/worker"] },
    },
    "app/prisma/schema.prisma": `generator a {
  provider = "prisma-client"
  output   = "/"
}
generator b {
  provider = "prisma-client"
  output   = "../../../home/u/.ssh"
}
`,
  });
  const dir = join(root, "app");
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    const jail = await jailConfig(dir) as { packages?: Record<string, JailPackageException> };
    assertEquals(jail?.packages?.["@prisma/client"]?.write, undefined, "no Prisma grant");
    assertEquals(jail?.packages?.msw?.write, undefined, "no msw grant");
    const lines = r.lines.join("\n");
    assertStringIncludes(lines, '"../../home/u/.ssh"', "the Prisma output above the project");
    assertStringIncludes(lines, '"../../outside"', "the msw directory above the project");
    assertStringIncludes(lines, "abs/worker");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("jail: a write-only package with nothing to write needs no exception", async () => {
  const dir = await project({
    "deno.json": "{}",
    "package.json": { dependencies: { msw: "2", "simple-git-hooks": "2" } },
  });
  try {
    // no workerDirectory, and no .git above a temp dir
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "none");
    assertEquals(r.lines, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** An install log as denext's Deno prints a dependency's failed lifecycle scripts. */
const INSTALL_LOG = `Download https://registry.npmjs.org/puppeteer
\x1b[33mWarning\x1b[0m something unrelated
error: script 'postinstall' in 'puppeteer@24.1.0' failed with exit code 1
stderr:
Error: getaddrinfo ENOTFOUND storage.googleapis.com

error: script 'install' in '@acme/native@1.0.0' failed with exit code 1
stderr:
Error: EACCES: permission denied, mkdir '/Users/me/.acme'

error: script 'postinstall' in 'helper@2.0.0' failed with exit code 127
stderr:
npx: running a real npx is not allowed in a jailed npm lifecycle script (jail-scripts)

error: script 'postinstall' in 'plain@1.0.0' failed with exit code 2
stderr:
TypeError: x is not a function
`;

Deno.test("jail: an install log's jail failures are recognised and explained", () => {
  // as on Linux / macOS, where the OS sandbox's own errors are the jail's too
  const failures = jailFailures(INSTALL_LOG, "linux");
  assertEquals(
    failures.map((f) => [f.name, f.version, f.script, f.exitCode, f.signs]),
    [
      ["puppeteer", "24.1.0", "postinstall", 1, ["net"]],
      ["@acme/native", "1.0.0", "install", 1, ["write"]],
      ["helper", "2.0.0", "postinstall", 127, ["npm"]],
      ["plain", "1.0.0", "postinstall", 2, []],
    ],
  );
  const text = explainJailFailures(failures, RC5).join("\n");
  assertStringIncludes(text, "puppeteer@24.1.0's postinstall script failed in the lifecycle");
  const puppeteer = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === "puppeteer")!;
  assertStringIncludes(text, `"puppeteer": ${JSON.stringify(entryException(puppeteer, RC5))}`);
  // on a runtime with host lists the fix names the hosts, not the whole network
  assertStringIncludes(
    explainJailFailures(failures, "3.0.0-rc.6").join("\n"),
    '"net":["storage.googleapis.com"]',
  );
  assertStringIncludes(text, '"supplyChain.jailScripts.packages" → "@acme/native" → "write"');
  assertStringIncludes(text, "never allowed in the jail");
  assertFalse(text.includes("plain@"), "a failure without a sign of the jail is not blamed on it");
  assertEquals(jailFailures("no failures here"), []);
  // an unknown package that hit the network gets a warning and review advice, never a grant
  const net = jailFailures(
    "error: script 'install' in 'x@1.0.0' failed with exit code 1\nNotCapable: Requires net access",
    "linux",
  );
  const netText = explainJailFailures(net).join("\n");
  assertFalse(netText.includes('"net":true'), "no paste-ready whole-network grant");
  assertFalse(netText.includes("fix:"), "no paste-ready fix for an unreviewed package");
  assertStringIncludes(netText, "common sign of malware");
  assertStringIncludes(netText, '"net": ["<host>"]');
  const deno = jailFailures(
    "error: script 'install' in 'y@1.0.0' failed with exit code 1\n" +
      "error: This deno subcommand is not allowed in a jailed npm lifecycle script (jail-scripts).",
    "linux",
  );
  assertEquals(deno[0].signs, ["deno"]);
});

Deno.test("jail: a forged failure line can't shape the advice; a host list is never widened", () => {
  // the script prints a line naming a package of its own making
  const forged = 'evil"}}},"x":{"net":true';
  const failures = jailFailures(
    `error: script 'postinstall' in '${forged}@1.0.0' failed with exit code 1\n` +
      "NotCapable: Requires net access",
    "linux",
  );
  assertEquals(failures.map((f) => f.name), [forged]);
  const text = explainJailFailures(failures, RC5).join("\n");
  assertStringIncludes(text, JSON.stringify(forged), "the name is quoted");
  assertFalse(text.includes("fix:"));
  assertFalse(text.includes('{"net":true}'));
  // a name spanning lines is not a match at all
  assertEquals(
    jailFailures("error: script 'install' in 'a\nb@1.0.0' failed with exit code 1", "linux"),
    [],
  );

  // a built-in entry on a runtime without host lists: the project's host list is kept
  const puppeteer = jailFailures(
    "error: script 'postinstall' in 'puppeteer@24.1.0' failed with exit code 1\n" +
      "Error: getaddrinfo ENOTFOUND storage.googleapis.com",
    "linux",
  );
  const kept = explainJailFailures(puppeteer, RC5, {
    puppeteer: { net: ["storage.googleapis.com"] },
  }).join("\n");
  assertFalse(kept.includes('"net":true'), "an existing host list is not widened");
  assertStringIncludes(kept, '"net":["storage.googleapis.com"]');
  // with no list of the project's own, the reviewed entry's grant is pasted as before
  assertStringIncludes(explainJailFailures(puppeteer, RC5).join("\n"), '"net":true');
});

/** A host-listed package's script failing through a proxy that refused the checked address. */
const PROXY_LOG = `\x1b[33mWarning\x1b[0m jail-scripts: the upstream proxy refused a tunnel to ` +
  `storage.googleapis.com:443 by its checked address (403 Forbidden); if this network's proxy ` +
  `only accepts host names, set "upstreamByName": true in supplyChain.jailScripts in deno.json.
error: script 'postinstall' in 'puppeteer@24.1.0' failed with exit code 1
stderr:
Error: fetch failed
`;

/** deno.json with a host list for puppeteer (and `extra` merged into jailScripts). */
function hostListed(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplyChain: {
      jailScripts: { packages: { puppeteer: { net: ["storage.googleapis.com"] } }, ...extra },
    },
  };
}

Deno.test("jail: upstreamByName is suggested when a listed host failed through a name-only proxy", () => {
  const advice = upstreamByNameAdvice({ output: PROXY_LOG, denoJson: hostListed(), env: NO_ENV });
  const text = advice.join("\n");
  assertStringIncludes(text, "puppeteer (storage.googleapis.com)");
  assertStringIncludes(text, '"jailScripts": { "upstreamByName": true }');
  assertStringIncludes(text, "refuses a name that resolves to this machine or its network");
  assertStringIncludes(text, "resolves the name again itself");
  assertStringIncludes(text, "Keep the jail on");
  assertFalse(text.includes('"jailScripts": false'), "never suggests turning the jail off");
  // already on, or no host list (whole network / unlisted package): nothing to suggest
  assertEquals(
    upstreamByNameAdvice({ output: PROXY_LOG, denoJson: hostListed({ upstreamByName: true }) }),
    [],
  );
  for (const net of [true, ["example.com"]]) {
    const denoJson = { supplyChain: { jailScripts: { packages: { puppeteer: { net } } } } };
    assertEquals(upstreamByNameAdvice({ output: PROXY_LOG, denoJson, env: NO_ENV }), []);
  }
  assertEquals(upstreamByNameAdvice({ output: PROXY_LOG, denoJson: null }), []);
  // no proxy in sight: a failed download is not a proxy problem
  const plain = INSTALL_LOG;
  assertEquals(upstreamByNameAdvice({ output: plain, denoJson: hostListed(), env: NO_ENV }), []);
  // a proxy named in the environment, on a runtime that has the setting
  const proxyEnv = (n: string) => n === "HTTPS_PROXY" ? "http://proxy.corp:3128" : undefined;
  const viaEnv = upstreamByNameAdvice({
    output: plain,
    denoJson: hostListed(),
    env: proxyEnv,
    version: UPSTREAM_BY_NAME_RELEASE,
  });
  assertStringIncludes(viaEnv.join("\n"), "puppeteer (storage.googleapis.com)");
  assertFalse(viaEnv.join("\n").includes("proxy.corp"), "the proxy URL is never echoed");
  // ...but not before that runtime, nor for an https:// proxy the jail doesn't chain through
  assertEquals(
    upstreamByNameAdvice({ output: plain, denoJson: hostListed(), env: proxyEnv, version: RC5 }),
    [],
  );
  const httpsProxy = (n: string) => n === "HTTPS_PROXY" ? "https://proxy.corp" : undefined;
  assertEquals(
    upstreamByNameAdvice({
      output: plain,
      denoJson: hostListed(),
      env: httpsProxy,
      version: UPSTREAM_BY_NAME_RELEASE,
    }),
    [],
  );
  // a host outside the allow-list is the list's problem, not the proxy's
  const unlisted = "error: script 'postinstall' in 'puppeteer@24.1.0' failed with exit code 1\n" +
    "jail-scripts: cdn.example.com:443 is not in this lifecycle script's network allow-list\n" +
    "Error: fetch failed\n";
  assertEquals(
    upstreamByNameAdvice({
      output: unlisted,
      denoJson: hostListed(),
      env: proxyEnv,
      version: UPSTREAM_BY_NAME_RELEASE,
    }),
    [],
  );
  // the status form of the warning, and an IPv6 / bracketed host
  const status = "jail-scripts: the upstream proxy (or the server) answered 400 to a request " +
    "for [2001:db8::1]:443 by its checked address; …\n" +
    "error: script 'install' in 'mirror-pkg@1.0.0' failed with exit code 1\n";
  const v6 = upstreamByNameAdvice({
    output: status,
    denoJson: {
      supplyChain: { jailScripts: { packages: { "mirror-pkg": { net: ["[2001:db8::1]"] } } } },
    },
  });
  assertStringIncludes(v6.join("\n"), "mirror-pkg (2001:db8::1)");
});

Deno.test("doctor: the jail check suggests upstreamByName from an install log", async () => {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await project({ "deno.json": hostListed(), "package.json": { dependencies: {} } });
  try {
    const check = await jailScriptsCheck(dir, { version: RC5, env: NO_ENV, installLog: PROXY_LOG });
    assertEquals([check?.ok, check?.critical], [false, false]);
    assertStringIncludes(check!.detail, "puppeteer@24.1.0's postinstall script failed");
    assertStringIncludes(check!.detail, '"upstreamByName": true');
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(hostListed({ upstreamByName: true })),
    );
    const set = await jailScriptsCheck(dir, { version: RC5, env: NO_ENV, installLog: PROXY_LOG });
    assertFalse(set!.detail.includes("upstreamByName"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: the jail check flags a missing exception, then passes once it is written", async () => {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await project({ "deno.json": "{}", "package.json": { dependencies: { re2: "1" } } });
  try {
    const opts = { version: RC5, env: NO_ENV, os: "linux" as const };
    const missing = await jailScriptsCheck(dir, opts);
    assertEquals([missing?.ok, missing?.critical], [false, false]);
    assertStringIncludes(missing!.detail, "re2 needs an exception");
    assertStringIncludes(missing!.detail, '{"supplyChain":{"jailScripts":{"packages":{"re2"');
    assertStringIncludes(missing!.detail, `on by default from runtime ${RC5}`);
    // before rc.5 it is a heads-up, not a failure
    const pending = await jailScriptsCheck(dir, { version: RC3, env: NO_ENV, os: "linux" });
    assertEquals(pending?.ok, true);
    assertStringIncludes(pending!.detail, "will need an exception");
    await applyJailExceptions(dir, opts);
    const configured = await jailScriptsCheck(dir, opts);
    assertEquals([configured?.ok, configured?.detail], [true, "exceptions configured for re2"]);
    // an install log's jail failures fail the check, with the fix
    const logged = await jailScriptsCheck(dir, { ...opts, installLog: INSTALL_LOG });
    assertEquals(logged?.ok, false);
    assertStringIncludes(logged!.detail, "the install log shows: puppeteer@24.1.0");
    // opted out
    await Deno.writeTextFile(join(dir, ".npmrc"), "jail-scripts=false\n");
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    const off = await jailScriptsCheck(dir, opts);
    assertEquals([off?.ok, off?.detail], [true, "off (.npmrc jail-scripts); re2 runs unconfined"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: no listed dependency and no log, no jail check; a missing log exits 1", async () => {
  const { doctorCommand, jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await project({ "deno.json": "{}", "package.json": { dependencies: { zod: "3" } } });
  const out = capture();
  const exit = stubExit();
  try {
    assertEquals(await jailScriptsCheck(dir, { version: RC5, env: NO_ENV }), null);
    const ctx = makeCtx({ flags: { "install-log": "missing.log" }, global: { cwd: dir } });
    let threw = false;
    try {
      await doctorCommand.run(ctx);
    } catch (e) {
      threw = (e as Error).message === "__exit__1";
    }
    assert(threw);
    assertStringIncludes(out.errs.join("\n"), "can't read --install-log missing.log");
  } finally {
    exit.restore();
    out.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate: detects the dependencies and writes the exceptions, listed for review", async () => {
  const { checkMigration } = await import("../src/build/migrate-check.ts");
  const { migrateProject } = await import("../src/build/migrate.ts");
  const files: Tree = {
    "package.json": {
      name: "jail-app",
      dependencies: { next: "15.3.0", react: "19.1.0", "react-dom": "19.1.0", puppeteer: "24.1.0" },
    },
    ".npmrc": "jail-scripts=true\n",
    "app/layout.tsx": "export default function L({ children }) { return children; }\n",
    "app/page.tsx": "export default function P() { return null; }\n",
  };
  const dir = await project(files);
  const prior = Deno.env.get("npm_config_jail_scripts");
  Deno.env.delete("npm_config_jail_scripts");
  try {
    const options = { denextLocalPath: REPO_ROOT, from: "next" as const };
    // the dry run plans it and lists it for review, writing nothing
    const report = await checkMigration(dir, options);
    const finding = report.review.find((f) => f.item === "lifecycle-script jail: puppeteer");
    assert(finding, JSON.stringify(report.review));
    assertStringIncludes(finding.reason, "written to deno.json");
    const planned = report.changes.find((c) => c.path === "deno.json");
    assert(planned);
    assertFalse(await Deno.stat(join(dir, "deno.json")).then(() => true, () => false));
    // the real run writes it
    const r = await migrateProject(dir, options);
    assertEquals(r.jailScripts?.action, "written");
    assertEquals(await jailConfig(dir), { packages: { puppeteer: plain(listed("puppeteer")) } });
  } finally {
    if (prior !== undefined) Deno.env.set("npm_config_jail_scripts", prior);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "add: the added packages' exceptions are written before `deno add`, with a hint on failure",
  {
    ignore: Deno.build.os === "windows",
  },
  async () => {
    const { addCommand, addedNpmPackages, JAIL_FAILURE_HINT } = await import(
      "../src/cli/commands/deps.ts"
    );
    assertEquals(
      addedNpmPackages(["npm:sharp@^0.34", "jsr:@std/path", "--dev", "zod"]),
      ["sharp"],
    );
    assertEquals(addedNpmPackages(["--npm", "keytar", "jsr:@std/fs"]), ["keytar"]);
    const dir = await project({ "deno.json": "{}\n", ".npmrc": "jail-scripts=true\n" });
    const fake = join(dir, "fake-deno.sh");
    await Deno.writeTextFile(fake, "#!/bin/sh\nexit 3\n");
    await Deno.chmod(fake, 0o755);
    const prior = Deno.env.get("DENO_BIN");
    Deno.env.set("DENO_BIN", fake);
    const out = capture();
    const exit = stubExit();
    try {
      try {
        await addCommand.run(makeCtx({ rest: ["npm:sharp@^0.34"], global: { cwd: dir } }));
      } catch (e) {
        assertEquals((e as Error).message, "__exit__3");
      }
      assertEquals(exit.calls, [3]);
      // Written before `deno add`, then taken out again when it failed.
      assertEquals(await Deno.readTextFile(join(dir, "deno.json")), "{}\n");
      const errs = out.errs.join("\n");
      assertStringIncludes(
        errs,
        "denext add: deno.json: supplyChain.jailScripts exception for sharp",
      );
      assertStringIncludes(errs, "jail exceptions were taken out");
      assertStringIncludes(errs, JAIL_FAILURE_HINT);
    } finally {
      exit.restore();
      out.restore();
      if (prior === undefined) Deno.env.delete("DENO_BIN");
      else Deno.env.set("DENO_BIN", prior);
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("add: a failed add takes its jail exceptions out; a good one keeps them; a config deno add changed is left", async () => {
  const { addWithJail } = await import("../src/cli/commands/deps.ts");
  const ctx = (dir: string) => makeCtx({ rest: ["npm:sharp@^0.34"], global: { cwd: dir } });
  const config = '{\n  // mine\n  "imports": {}\n}\n';
  const out = capture();
  const dirs: string[] = [];
  try {
    // A failed add: the file is exactly what it was.
    const failed = await project({ "deno.json": config, ".npmrc": "jail-scripts=true\n" });
    dirs.push(failed);
    let seen: unknown;
    assertEquals(
      await addWithJail(ctx(failed), async (args, cwd) => {
        assertEquals(args[0], "add");
        seen = await jailConfig(cwd); // the exception is in place while deno add runs
        return 1;
      }),
      1,
    );
    assertEquals(seen, { packages: { sharp: plain(listed("sharp")) } });
    assertEquals(await Deno.readTextFile(join(failed, "deno.json")), config);
    // A good add keeps them.
    const good = await project({ "deno.json": config, ".npmrc": "jail-scripts=true\n" });
    dirs.push(good);
    assertEquals(await addWithJail(ctx(good), () => Promise.resolve(0)), 0);
    assertEquals(await jailConfig(good), { packages: { sharp: plain(listed("sharp")) } });
    // A failed add that changed deno.json itself: left as it is, and said so.
    const changed = await project({ "deno.json": config, ".npmrc": "jail-scripts=true\n" });
    dirs.push(changed);
    const code = await addWithJail(ctx(changed), async (_args, cwd) => {
      const path = join(cwd, "deno.json");
      await Deno.writeTextFile(path, (await Deno.readTextFile(path)) + "\n");
      return 2;
    });
    assertEquals(code, 2);
    assertEquals(await jailConfig(changed), { packages: { sharp: plain(listed("sharp")) } });
    assertStringIncludes(out.errs.join("\n"), "were left in place");
  } finally {
    out.restore();
    for (const dir of dirs) await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("create/init: an existing package.json's dependencies get their exceptions", async () => {
  const { initCommand } = await import("../src/cli/commands/create.ts");
  const dir = await project({
    "package.json": { name: "existing", dependencies: { keytar: "7" } },
    ".npmrc": "jail-scripts=true\n",
  });
  const priorAge = Deno.env.get("DENEXT_MIN_DEP_AGE");
  Deno.env.set("DENEXT_MIN_DEP_AGE", "0");
  const out = capture();
  try {
    await initCommand.run(makeCtx({ positionals: [dir], flags: { yes: true, "no-vscode": true } }));
    assertEquals(await jailConfig(dir), { packages: { keytar: plain(listed("keytar")) } });
    assertStringIncludes(out.logs.join("\n"), "supplyChain.jailScripts exception for keytar");
  } finally {
    out.restore();
    if (priorAge === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
    else Deno.env.set("DENEXT_MIN_DEP_AGE", priorAge);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail exceptions: the toolchain docs list every package in the built-in list", async () => {
  const docs = await Deno.readTextFile(join(REPO_ROOT, "site/app/docs/toolchain/content.md"));
  assertStringIncludes(docs, "## Supply chain: lifecycle-script jail");
  for (const { name } of JAIL_SCRIPT_EXCEPTIONS) {
    const browser = /^playwright-(\w+)$/.exec(name)?.[1];
    assertStringIncludes(
      docs,
      browser && browser !== "chromium" ? `\`-${browser}\`` : `\`${name}\``,
    );
  }
  for (const { name } of JAIL_NOT_NEEDED) assertStringIncludes(docs, `\`${name}\``);
});

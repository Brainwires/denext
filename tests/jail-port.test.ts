// The built-in lifecycle-script host grants denext writes into a project's
// `supplyChain.jailScripts.packages` open port 443 only, as the runtime's own built-in list does
// (its `cli/supply_chain/builtin_exceptions.rs`, `BUILTIN_PORT`): a bare host there is every port.
// `denext doctor` still accepts an entry an older denext wrote with bare hosts, and says how to
// narrow it. Nothing here runs an install or touches the network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  BUILTIN_JAIL_PORT,
  DECLARED_HOST_REDIRECTS,
  JAIL_SCRIPT_EXCEPTIONS,
} from "../src/build/jail-exceptions.ts";
import { applyJailExceptions, entryException } from "../src/build/jail-scripts.ts";
import { jailScriptsCheck } from "../src/cli/commands/doctor.ts";

const RC6 = "3.0.0-rc.6";
const DENEXT1 = "3.0.0-denext.1";
const DENEXT18 = "3.0.0-denext.18";
const NO_ENV = () => undefined;

const GITHUB = [
  "github.com:443",
  "objects.githubusercontent.com:443",
  "release-assets.githubusercontent.com:443",
];
const NODE = ["nodejs.org:443"];

/** The runtime's `BUILTIN_EXCEPTIONS` hosts, flattened per package (its `host_list()`). */
const RUNTIME_HOSTS: Record<string, readonly string[]> = {
  "@prisma/engines": ["binaries.prisma.sh:443"],
  "@sentry/cli": ["downloads.sentry-cdn.com:443"],
  "@tensorflow/tfjs-node": ["storage.googleapis.com:443", ...NODE],
  "better-sqlite3": [...GITHUB, ...NODE],
  canvas: [...GITHUB, ...NODE],
  chromedriver: [
    "chromedriver.storage.googleapis.com:443",
    "googlechromelabs.github.io:443",
    "storage.googleapis.com:443",
  ],
  electron: GITHUB,
  "ffmpeg-static": GITHUB,
  keytar: [...GITHUB, ...NODE],
  "node-pty": NODE,
  "node-sass": [...GITHUB, ...NODE],
  re2: [...GITHUB, ...NODE],
  sharp: [...GITHUB, ...NODE],
  sqlite3: [...GITHUB, ...NODE],
};

/** A temp project holding `files` (objects are JSON); returns its (real) path. */
async function project(files: Record<string, unknown>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_jail_port_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** `supplyChain.jailScripts.packages` in a deno.json. */
async function packagesIn(dir: string): Promise<Record<string, { net?: unknown }>> {
  const doc = parseJsonc(await Deno.readTextFile(join(dir, "deno.json"))) as {
    supplyChain?: { jailScripts?: { packages?: Record<string, { net?: unknown }> } };
  };
  return doc.supplyChain?.jailScripts?.packages ?? {};
}

/** Every string in the `net` lists of `packages`. */
function netHosts(packages: Record<string, { net?: unknown }>): string[] {
  return Object.values(packages).flatMap((p) => Array.isArray(p.net) ? p.net : []);
}

Deno.test("jail port: the built-in list is the runtime's, host for host, all on port 443", () => {
  assertEquals(BUILTIN_JAIL_PORT, 443);
  for (const [name, hosts] of Object.entries(RUNTIME_HOSTS)) {
    const entry = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === name);
    assert(entry, `${name} is in denext's list`);
    assertEquals([...new Set(entry.hosts)].sort(), [...new Set(hosts)].sort(), name);
  }
  for (const entry of JAIL_SCRIPT_EXCEPTIONS) {
    for (const host of entry.hosts ?? []) {
      assert(host.endsWith(":443"), `${entry.name}: ${host} is pinned to port 443`);
    }
    // a declared host is matched by name (`knownPackages`), as the runtime lists it
    for (const host of entry.declaredHosts ?? []) assertFalse(host.includes(":"), host);
  }
  assertEquals(DECLARED_HOST_REDIRECTS["github.com"], GITHUB.slice(1));
});

Deno.test("jail port: every host list denext computes carries :443, on every runtime that takes one", () => {
  for (const version of [RC6, DENEXT1, DENEXT18]) {
    for (const entry of JAIL_SCRIPT_EXCEPTIONS) {
      const { net } = entryException(entry, version);
      if (!Array.isArray(net)) continue;
      for (const host of net) assert(host.endsWith(":443"), `${version} ${entry.name}: ${host}`);
    }
  }
});

Deno.test("jail port: the grants written into deno.json carry :443", async () => {
  const dir = await project({
    "deno.json": "{}\n",
    "package.json": {
      dependencies: {
        sharp: "0.34",
        puppeteer: "24",
        electron: "39",
        "playwright-chromium": "1",
        bcrypt: "5",
      },
    },
  });
  try {
    assertEquals(
      (await applyJailExceptions(dir, { version: DENEXT18, env: NO_ENV })).action,
      "written",
    );
    const pkgs = await packagesIn(dir);
    assertEquals(pkgs.sharp.net, [...GITHUB, ...NODE].sort());
    assertEquals(pkgs.puppeteer.net, ["storage.googleapis.com:443"]);
    assertEquals(pkgs.electron.net, GITHUB);
    // bcrypt's declared github.com redirects, written as a `net` list before denext.19
    assertEquals(pkgs.bcrypt.net, GITHUB.slice(1));
    const all = netHosts(pkgs);
    assert(all.length > 0);
    for (const host of all) assert(host.endsWith(":443"), host);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor jail port: an older bare-host grant still passes, with a hint; :443 needs none", async () => {
  const bare = ["github.com", "nodejs.org", "objects.githubusercontent.com"];
  const dir = await project({
    "deno.json": JSON.stringify({
      supplyChain: { jailScripts: { packages: { sharp: { net: bare } } } },
    }),
    "package.json": { dependencies: { sharp: "0.34" } },
  });
  const opts = { version: RC6, env: NO_ENV, os: "linux" as const };
  try {
    const old = await jailScriptsCheck(dir, opts);
    assertEquals(old?.ok, true);
    assertStringIncludes(old!.detail, "exceptions configured for sharp");
    assertStringIncludes(old!.detail, 'sharp\'s "net" grants github.com, nodejs.org, ');
    assertStringIncludes(old!.detail, '"github.com:443"');
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        supplyChain: { jailScripts: { packages: { sharp: { net: [...GITHUB, ...NODE] } } } },
      }),
    );
    const current = await jailScriptsCheck(dir, opts);
    assertEquals([current?.ok, current?.detail], [true, "exceptions configured for sharp"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

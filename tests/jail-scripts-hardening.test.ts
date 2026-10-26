// The supply-chain audit's fixes to denext's lifecycle-script jail integration
// (plans/audit-4.8-supply-chain.md): per-package host lists and `~` download caches on runtimes
// that take them (Brainwires/deno DENEXT.md item 108), workspace members (the runtime reads
// `supplyChain` from the root deno.json alone), write grants that would cover the whole project,
// `denext doctor` on Windows (the OS can't confine there), and the npm supply-chain policy the
// configs denext generates for a build child carry. Nothing here runs an install or touches the
// network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { JAIL_SCRIPT_EXCEPTIONS } from "../src/build/jail-exceptions.ts";
import { applyJailExceptions, jailFailures } from "../src/build/jail-scripts.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));
/** A runtime that takes host lists and `~` paths, and the newest one that does not. */
const RC6 = "3.0.0-rc.6";
const RC5 = "3.0.0-rc.5";
/** No environment: a test never inherits the runner's `npm_config_*`. */
const NO_ENV = () => undefined;

/** A temp project holding `files` (objects are JSON); returns its (real) path. */
async function project(files: Record<string, unknown>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_jail_au3_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** A config file's parsed object. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return parseJsonc(await Deno.readTextFile(path)) as Record<string, unknown>;
}

/** deno.json's `supplyChain.jailScripts.packages` in `dir`. */
async function packagesIn(dir: string): Promise<Record<string, Record<string, unknown>>> {
  const doc = await readJson(join(dir, "deno.json"));
  const supply = doc.supplyChain as { jailScripts?: { packages?: unknown } } | undefined;
  return (supply?.jailScripts?.packages ?? {}) as Record<string, Record<string, unknown>>;
}

/** What the runtime (item 108) accepts as one host of a `net` list. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/;

Deno.test("jail hosts: every network grant in the built-in list names its hosts", () => {
  for (const e of JAIL_SCRIPT_EXCEPTIONS) {
    const entry = e as typeof e & {
      hosts?: readonly string[];
      cache?: { env: string; path: string };
    };
    if (e.exception.net) {
      assert(entry.hosts?.length, `${e.name} lists the hosts it downloads from`);
      for (const h of entry.hosts!) assert(HOST.test(h), `${e.name}: ${h}`);
    }
    if (entry.cache) {
      assert(entry.cache.path.startsWith("~/"), `${e.name}: a cache under the home`);
      assert(e.exception.env?.includes(entry.cache.env), `${e.name} passes ${entry.cache.env}`);
    }
  }
});

Deno.test("jail hosts: on rc.6 a browser download gets its hosts and a `~` cache, not `net: true`", async () => {
  const dir = await project({
    "deno.json": "{}\n",
    "package.json": { dependencies: { puppeteer: "24", sharp: "0.34", msw: "2" } },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC6, env: NO_ENV });
    assertEquals(r.action, "written");
    const pkgs = await packagesIn(dir);
    assertEquals(pkgs.puppeteer, {
      env: ["PUPPETEER_CACHE_DIR", "PUPPETEER_DOWNLOAD_BASE_URL", "PUPPETEER_SKIP_DOWNLOAD"],
      write: ["~/.cache/puppeteer"],
      net: ["storage.googleapis.com"],
    });
    assertEquals(pkgs.sharp.net, [
      "github.com",
      "nodejs.org",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
    // `~` is the runtime's to resolve: no literal `~` directory appears in the project
    assertFalse(await Deno.stat(join(dir, "~")).then(() => true, () => false));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail hosts: before rc.6 neither a host list nor a `~` path is written", async () => {
  const dir = await project({
    "deno.json": "{}\n",
    "package.json": { dependencies: { puppeteer: "24" } },
  });
  try {
    await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    const pkgs = await packagesIn(dir);
    assertEquals(pkgs.puppeteer.net, true, "rc.5 rejects a host list");
    assertEquals(pkgs.puppeteer.write, undefined, "rc.5 reads `~` as a directory name");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail workspace: a member's dependencies are configured in the root deno.json", async () => {
  const root = await project({
    "deno.json": { workspace: ["./apps/web", "./packages/*"] },
    "apps/web/deno.json": "{}\n",
    "apps/web/package.json": { dependencies: { keytar: "7" } },
    "packages/ui/deno.json": "{}\n",
    "packages/ui/package.json": {
      dependencies: { msw: "2" },
      msw: { workerDirectory: ["public"] },
    },
  });
  try {
    const member = join(root, "apps/web");
    const r = await applyJailExceptions(member, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "written");
    assertEquals(r.configPath, join(root, "deno.json"));
    const pkgs = await packagesIn(root);
    assertEquals(Object.keys(pkgs).sort(), ["keytar", "msw"], "every member's dependencies");
    // a member's write path is relative to the root deno.json, as the runtime resolves it
    assertEquals(pkgs.msw, { write: ["packages/ui/public"] });
    assertEquals(await Deno.readTextFile(join(member, "deno.json")), "{}\n", "member untouched");
    // the root's settings decide: a member opting out changes nothing
    await Deno.writeTextFile(
      join(member, "deno.json"),
      JSON.stringify({ supplyChain: { jailScripts: false } }),
    );
    const again = await applyJailExceptions(member, { version: RC5, env: NO_ENV });
    assertEquals(again.action, "configured");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("jail workspace: doctor says a member's own supplyChain is ignored", async () => {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  const root = await project({
    "deno.json": { workspace: ["./app"] },
    "app/deno.json": { supplyChain: { jailScripts: { packages: { re2: { net: true } } } } },
    "app/package.json": { dependencies: { re2: "1" } },
  });
  try {
    const check = await jailScriptsCheck(
      join(root, "app"),
      {
        version: RC5,
        env: NO_ENV,
        os: "linux",
      } as Parameters<typeof jailScriptsCheck>[1],
    );
    assertEquals(check?.ok, false);
    assertStringIncludes(check!.detail, "Deno ignores in a workspace member");
    assertStringIncludes(check!.detail, "re2 needs an exception", "the root has none");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("jail writes: a directory covering the whole project or beyond is never granted", async () => {
  const dir = await project({
    "deno.json": "{}\n",
    "package.json": {
      dependencies: { msw: "2" },
      msw: { workerDirectory: [".", "../..", "/", "public/"] },
    },
  });
  try {
    const r = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(r.action, "written");
    assertEquals((await packagesIn(dir)).msw, { write: ["public"] });
    const text = r.lines.join("\n");
    assertStringIncludes(text, 'not granting write to ".", "../..", ');
    // nothing narrow left: nothing written, and the user is told
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { msw: "2" }, msw: { workerDirectory: "./" } }),
    );
    const only = await applyJailExceptions(dir, { version: RC5, env: NO_ENV });
    assertEquals(only.action, "manual");
    assertStringIncludes(only.lines.join("\n"), 'msw: not granting write to "."');
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), "{}\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A Windows install log: a locked file and a real DNS failure, then the jail's own clamp. */
const WINDOWS_LOG = `error: script 'install' in 'locked@1.0.0' failed with exit code 1
Error: EPERM: operation not permitted, rename 'C:\\\\app\\\\node_modules\\\\locked\\\\a'
error: script 'install' in 'dns@1.0.0' failed with exit code 1
Error: getaddrinfo ENOTFOUND example.invalid
error: script 'postinstall' in 'clamped@1.0.0' failed with exit code 1
NotCapable: Requires write access to "C:\\\\Users\\\\me\\\\.clamped", run again with the --allow-write flag
`;

Deno.test("jail on Windows: only Deno's own clamp messages are read as the jail's", () => {
  const signs = (os: typeof Deno.build.os) =>
    jailFailures(WINDOWS_LOG, os).map((f) => [f.name, f.signs]);
  assertEquals(signs("windows"), [["locked", []], ["dns", []], ["clamped", ["write"]]]);
  // where the OS sandbox confines, its errors are the jail's
  assertEquals(signs("linux"), [["locked", ["write"]], ["dns", ["net"]], ["clamped", ["write"]]]);
});

Deno.test("jail on Windows: doctor says what the jail can't confine, and that paranoid refuses", async () => {
  const { jailScriptsCheck } = await import("../src/cli/commands/doctor.ts");
  type Opts = Parameters<typeof jailScriptsCheck>[1];
  const dir = await project({
    "deno.json": {
      allowScripts: ["npm:re2"],
      supplyChain: { paranoid: true, jailScripts: { packages: { re2: { net: true } } } },
    },
    "package.json": { dependencies: { re2: "1" } },
  });
  try {
    const opts = { version: RC5, env: NO_ENV };
    const win = await jailScriptsCheck(dir, { ...opts, os: "windows" } as Opts);
    assertEquals(win?.ok, false);
    assertStringIncludes(win!.detail, "paranoid, which refuses to run an approved dependency");
    // the object form of allowScripts approves too
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        allowScripts: { allow: ["npm:re2"] },
        supplyChain: { paranoid: true, jailScripts: { packages: { re2: { net: true } } } },
      }),
    );
    const allow = await jailScriptsCheck(dir, { ...opts, os: "windows" } as Opts);
    assertEquals(allow?.ok, false);
    const linux = await jailScriptsCheck(dir, { ...opts, os: "linux" } as Opts);
    assertEquals([linux?.ok, linux?.detail], [true, "exceptions configured for re2"]);
    // without paranoid, Windows passes with the note on what isn't confined
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ supplyChain: { jailScripts: { packages: { re2: { net: true } } } } }),
    );
    const note = await jailScriptsCheck(dir, { ...opts, os: "windows" } as Opts);
    assertEquals(note?.ok, true);
    assertStringIncludes(
      note!.detail,
      "on Windows the OS can't confine the scripts' other programs",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generated configs carry the workspace root's supplyChain, write paths absolute", async () => {
  const { writeMergedModuleConfig } = await import("../src/build/module-config.ts");
  const root = await project({
    "deno.json": {
      workspace: ["./app"],
      supplyChain: {
        paranoid: true,
        advisoryCheck: "required",
        jailScripts: { packages: { msw: { write: ["public", "~/.cache/x"] } } },
      },
    },
    "app/deno.json": { imports: {} },
  });
  try {
    const out = join(root, "app/.denext");
    const path = await writeMergedModuleConfig(
      out,
      join(root, "app/deno.json"),
      join(REPO_ROOT, "deno.json"),
    );
    const merged = await readJson(path);
    assertEquals(merged.supplyChain, {
      paranoid: true,
      advisoryCheck: "required",
      jailScripts: { packages: { msw: { write: [join(root, "public"), "~/.cache/x"] } } },
    });
    // a standalone app without one adds nothing
    const { supplyChainConfig } = await import("../src/build/workspace-imports.ts");
    await Deno.mkdir(join(root, "solo"));
    await Deno.writeTextFile(join(root, "solo/deno.json"), "{}");
    assertEquals(await supplyChainConfig(join(root, "solo/deno.json")), {});
    await Deno.writeTextFile(
      join(root, "solo/deno.json"),
      JSON.stringify({ supplyChain: { jailScripts: { packages: { a: { net: true } } } } }),
    );
    assertEquals(await supplyChainConfig(join(root, "solo/deno.json")), {
      supplyChain: { jailScripts: { packages: { a: { net: true } } } },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("jail: the deno.json edit never follows a symlink out of the project (F-L11)", async () => {
  const outside = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_jail_out_" }));
  const target = join(outside, "deno.json");
  const original = `{ "imports": { "puppeteer": "npm:puppeteer@^24.1.0" } }\n`;
  await Deno.writeTextFile(target, original);
  const dir = await project({ "package.json": { dependencies: { sharp: "^0.34.0" } } });
  try {
    try {
      await Deno.symlink(target, join(dir, "deno.json"));
    } catch {
      return; // no symlink privilege (Windows without Developer Mode): nothing to check
    }
    let refused: unknown = null;
    await applyJailExceptions(dir, { version: RC5, env: NO_ENV }).catch((e) => refused = e);
    assert(refused instanceof Error, "the write through the symlink is refused");
    assertStringIncludes((refused as Error).message, "refusing to write");
    assertEquals(await Deno.readTextFile(target), original, "the outside file is untouched");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

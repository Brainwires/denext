// The lifecycle-script jail, planned for the runtime the installs actually run on (not the pin),
// the hosts an unreviewed package's failed script tried to reach, and a configured `"net": true`
// that a runtime with host lists can narrow (the 4.8 supply-chain audit's Lows).

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  explainJailFailures,
  jailEffective,
  jailFailures,
  jailRuntime,
  type JailRuntimeSeams,
  readJailSetting,
} from "../src/build/jail-scripts.ts";
import { JAIL_SCRIPT_EXCEPTIONS } from "../src/build/jail-exceptions.ts";
import { jailScriptsCheck } from "../src/cli/commands/doctor.ts";
import { addWithJail } from "../src/cli/commands/deps.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

const RC5 = "3.0.0-rc.5";
const RC6 = "3.0.0-rc.6";
const NO_ENV = () => undefined;

async function project(files: Record<string, unknown>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_jail_rt_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** A runtime probe: installs run on `/bin/other-deno`, which prints `out`. */
function other(out: string | null, pinned: string | null = RC5): JailRuntimeSeams {
  return {
    executable: () => "/bin/other-deno",
    current: { path: "/bin/self", identity: { deno: RC5, denext: RC5 } },
    versionOutput: () => Promise.resolve(out),
    pinned,
  };
}

const STOCK = other("deno 2.9.8 (stable, release, x86_64-unknown-linux-gnu)\nv8 14.0\n");
const DENEXT_RC6 = other(`deno ${RC6} (stable, release)\ndenext ${RC6} (Brainwires)\n`);

Deno.test("jailRuntime: the Deno installs run on, not the pin", async () => {
  // This process is the pinned toolchain and installs run on it.
  const self = await jailRuntime({
    executable: () => "/bin/self",
    current: { path: "/bin/self", identity: { deno: RC5, denext: RC5 } },
    pinned: RC5,
  });
  assertEquals([self.version, self.overridden], [RC5, false]);
  // DENEXT_DENO=stock / a DENO_BIN: stock Deno has no jail at all.
  const stock = await jailRuntime(STOCK);
  assertEquals([stock.version, stock.overridden], [null, true]);
  assertStringIncludes(stock.label, "stock Deno 2.9.8 at /bin/other-deno");
  // DENEXT_DENO=<path> to another release of denext's Deno: planned for that release.
  const rc6 = await jailRuntime(DENEXT_RC6);
  assertEquals([rc6.version, rc6.overridden], [RC6, true]);
  assertStringIncludes(rc6.label, `(the pin is ${RC5})`);
  // A binary whose version can't be read is planned for as the pin.
  const unknown = await jailRuntime(other(null));
  assertEquals([unknown.version, unknown.overridden], [RC5, true]);
  assertStringIncludes(unknown.label, "could not be read");
  // The real process: whatever it is, it answers.
  const real = await jailRuntime();
  assert(real.label.length > 0);
});

Deno.test("jailEffective: a Deno with no jail never jails, whatever the project asks", () => {
  const on = readJailSetting({ npmrc: "jail-scripts=true\n" });
  assertEquals(jailEffective(on, RC5), true);
  assertEquals(jailEffective(on, null), false);
});

Deno.test("denext add under stock Deno writes no exception; under the pin it does", async () => {
  const ctx = (dir: string) => makeCtx({ rest: ["npm:sharp@^0.34"], global: { cwd: dir } });
  const out = capture();
  const dirs: string[] = [];
  try {
    const stockDir = await project({ "deno.json": "{}\n", ".npmrc": "jail-scripts=true\n" });
    dirs.push(stockDir);
    assertEquals(await addWithJail(ctx(stockDir), () => Promise.resolve(0), STOCK), 0);
    assertEquals(await Deno.readTextFile(join(stockDir, "deno.json")), "{}\n");
    assertStringIncludes(out.errs.join("\n"), "planned for stock Deno 2.9.8");
    const rc6Dir = await project({ "deno.json": "{}\n" });
    dirs.push(rc6Dir);
    await addWithJail(ctx(rc6Dir), () => Promise.resolve(0), DENEXT_RC6);
    const doc = parseJsonc(await Deno.readTextFile(join(rc6Dir, "deno.json"))) as {
      supplyChain: { jailScripts: { packages: { sharp: { net: unknown } } } };
    };
    // rc.6 takes host lists: the pin (rc.5) would have written `"net": true`.
    assert(Array.isArray(doc.supplyChain.jailScripts.packages.sharp.net));
  } finally {
    out.restore();
    for (const dir of dirs) await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: the jail check says which runtime installs run on when it is not the pin", async () => {
  const dir = await project({
    "deno.json": "{}\n",
    "package.json": { dependencies: { re2: "1" } },
  });
  try {
    const stock = await jailScriptsCheck(dir, { env: NO_ENV, os: "linux", runtime: STOCK });
    assertEquals(stock?.ok, true, "no jail, nothing missing");
    assertStringIncludes(stock!.detail, "installs run on stock Deno 2.9.8");
    const pinned = await jailScriptsCheck(dir, { version: RC5, env: NO_ENV, os: "linux" });
    assertEquals(pinned?.ok, false);
    assertFalse(pinned!.detail.includes("installs run on"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: a built-in package's `net: true` is offered its host list where the runtime takes one", async () => {
  const dir = await project({
    "deno.json": {
      supplyChain: {
        jailScripts: { packages: { sharp: { net: true, env: ["MY_VAR"], write: ["vendor/x"] } } },
      },
    },
    "package.json": { dependencies: { sharp: "0.34" } },
  });
  try {
    const rc6 = await jailScriptsCheck(dir, { version: RC6, env: NO_ENV, os: "linux" });
    assertEquals([rc6?.ok, rc6?.critical], [false, false]);
    assertStringIncludes(rc6!.detail, `sharp's exception grants the whole network ("net": true)`);
    const sharp = JAIL_SCRIPT_EXCEPTIONS.find((e) => e.name === "sharp")!;
    // The project's own env / write are kept beside the entry's.
    assertStringIncludes(
      rc6!.detail,
      JSON.stringify({
        sharp: {
          net: [...sharp.hosts!].sort(),
          env: ["MY_VAR", ...sharp.exception.env ?? []],
          write: ["vendor/x"],
        },
      }),
    );
    // A runtime without host lists has nothing narrower to offer.
    const rc5 = await jailScriptsCheck(dir, { version: RC5, env: NO_ENV, os: "linux" });
    assertEquals([rc5?.ok, rc5?.detail], [true, "exceptions configured for sharp"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jail failures: an unreviewed package's advice names the hosts its log shows, never a forged one", () => {
  const log = "error: script 'install' in 'x@1.0.0' failed with exit code 1\n" +
    'NotCapable: Requires net access to "evil.example.com:443"\n' +
    "Error: getaddrinfo ENOTFOUND cdn.example.org.\n" +
    "jail-scripts: Evil.Example.com:443 is not in this lifecycle script's network allow-list\n" +
    'NotCapable: Requires net access to "a"}},"net":true"\n' +
    'NotCapable: Requires net access to "10.0.0.1:80"\n';
  const [linux] = jailFailures(log, "linux");
  assertEquals(linux.hosts, ["cdn.example.org", "evil.example.com"]);
  const text = explainJailFailures([linux], RC6).join("\n");
  assertStringIncludes(text, "the log shows it reaching cdn.example.org, evil.example.com");
  assertStringIncludes(text, '"net": ["cdn.example.org", "evil.example.com"]');
  assertFalse(text.includes('"net":true'));
  assertFalse(text.includes("fix:"), "still no paste-ready fix for an unreviewed package");
  assertFalse(text.includes("takes no host list"));
  // A runtime without host lists: install on one that has them rather than grant everything.
  assertStringIncludes(
    explainJailFailures([linux], RC5).join("\n"),
    `runtime ${RC5} takes no host list, so install it on ${RC6} or later`,
  );
  // On Windows a resolver failure is not the jail's: only the clamp's hosts count.
  assertEquals(jailFailures(log, "windows")[0].hosts, ["evil.example.com"]);
});

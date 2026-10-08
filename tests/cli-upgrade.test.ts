// `denext upgrade` (src/build/upgrade.ts + src/cli/commands/upgrade.ts): every first-party pin
// moves together, to the newest denext every pinned package has a compatible version for —
// against injected registry lookups, so nothing here touches the network.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import {
  applyUpgrade,
  compareVersions,
  findPins,
  jsrLookups,
  planUpgrade,
  satisfies,
  type UpgradeLookups,
} from "../src/build/upgrade.ts";
import { runUpgrade } from "../src/cli/commands/upgrade.ts";
import type { CommandContext } from "../src/cli/command.ts";
import CATALOG from "../src/plugin/catalog.json" with { type: "json" };

/** A fake registry: versions per package, and the denext range each version declares. */
function registry(
  packages: Record<string, Record<string, string | null>>,
): UpgradeLookups & { rangeCalls: string[] } {
  const rangeCalls: string[] = [];
  return {
    rangeCalls,
    versions: (name) => {
      const versions = Object.keys(packages[name] ?? {});
      return Promise.resolve(versions.length ? { latest: versions.at(-1)!, versions } : null);
    },
    denextRange: (name, version) => {
      rangeCalls.push(`${name}@${version}`);
      const range = packages[name]?.[version];
      return Promise.resolve(range === undefined ? undefined : range);
    },
  };
}

const CONFIG = `{
  // pinned by denext create
  "tasks": {
    "dev": "deno run -A jsr:@denext/denext@^3.0.0/cli dev .",
    "start": "deno run -A jsr:@denext/denext@3.0.0/cli start ."
  },
  "imports": {
    "denext": "jsr:@denext/denext@^3.0.0",
    "denext/server": "jsr:@denext/denext@^3.0.0/server",
    "@denext/myplug": "jsr:@denext/myplug@~0.2.0",
    "@std/assert": "jsr:@std/assert@^1"
  }
}
`;

Deno.test("semver: precedence and the ranges denext packages use", () => {
  assert(compareVersions("3.2.0", "3.10.0") < 0);
  assert(compareVersions("3.2.0-rc.2", "3.2.0-rc.10") < 0);
  assert(compareVersions("3.2.0-rc.9", "3.2.0") < 0);
  assertEquals(compareVersions("1.0.0", "1.0.0"), 0);
  assert(satisfies("3.4.1", "^3.2.0"));
  assertFalse(satisfies("4.0.0", "^3.2.0"));
  assertFalse(satisfies("3.1.9", "^3.2.0"));
  assert(satisfies("0.4.7", "^0.4.0"));
  assertFalse(satisfies("0.5.0", "^0.4.0"));
  assert(satisfies("3.2.9", "~3.2.0"));
  assertFalse(satisfies("3.3.0", "~3.2.0"));
  assert(satisfies("3.2.0", "3.2.0"));
  assertFalse(satisfies("3.2.1", "3.2.0"));
  assert(satisfies("9.0.0", ">=3.2.0"));
  assertFalse(satisfies("3.3.0-rc.1", "^3.2.0"), "a prerelease needs a prerelease range");
  assert(satisfies("3.3.0-rc.2", "^3.3.0-rc.1"));
  assertFalse(satisfies("3.2.0", "nonsense"));
});

Deno.test("findPins: each @denext package once, at its newest pinned version, denext first", () => {
  assertEquals(findPins(CONFIG), [
    { name: "@denext/denext", version: "3.0.0" },
    { name: "@denext/myplug", version: "0.2.0" },
  ]);
  assertEquals(findPins('{"imports":{"denext":"jsr:@denext/denext/cli"}}'), []);
});

Deno.test("applyUpgrade rewrites every specifier, keeping its operator and the file around it", () => {
  const out = applyUpgrade(CONFIG, [
    { name: "@denext/denext", from: "3.0.0", to: "3.2.0" },
    { name: "@denext/myplug", from: "0.2.0", to: "0.3.1" },
  ]);
  assertEquals(
    out,
    CONFIG.replaceAll("@^3.0.0", "@^3.2.0").replace("@3.0.0/cli", "@3.2.0/cli")
      .replace("myplug@~0.2.0", "myplug@~0.3.1"),
  );
  assert(out.includes("// pinned by denext create"), "comments survive");
  assert(out.includes("jsr:@std/assert@^1"), "a third-party pin is untouched");
});

Deno.test("plan: the newest denext every pinned package supports; nothing moves backwards", async () => {
  const lookups = registry({
    "@denext/denext": { "3.0.0": null, "3.1.0": null, "3.2.0": null, "3.3.0-rc.1": null },
    // 0.4.0 needs a denext that doesn't exist yet → denext 3.2.0 with myplug 0.3.0.
    "@denext/myplug": {
      "0.1.0": "^3.0.0",
      "0.2.0": "^3.0.0",
      "0.3.0": "^3.2.0",
      "0.4.0": "^3.5.0",
    },
  });
  const plan = await planUpgrade(CONFIG, {}, lookups);
  assert(plan.ok);
  assertEquals(plan.steps, [
    { name: "@denext/denext", from: "3.0.0", to: "3.2.0" },
    { name: "@denext/myplug", from: "0.2.0", to: "0.3.0" },
  ]);
  assert(plan.changed);
  assertFalse(lookups.rangeCalls.includes("@denext/myplug@0.1.0"), "older versions are not tried");
});

Deno.test("plan: when the newest denext has no compatible package version, an older one is chosen", async () => {
  const plan = await planUpgrade(
    CONFIG,
    {},
    registry({
      "@denext/denext": { "3.0.0": null, "3.1.0": null, "3.2.0": null },
      "@denext/myplug": { "0.2.0": "~3.1.0" }, // only ever built against 3.1.x
    }),
  );
  assert(plan.ok);
  assertEquals(plan.steps.map((s) => s.to), ["3.1.0", "0.2.0"]);
});

Deno.test("plan: --to with no compatible package version is an error, never a skew", async () => {
  const lookups = registry({
    "@denext/denext": { "3.0.0": null, "3.2.0": null },
    "@denext/myplug": { "0.2.0": "~3.0.0" },
  });
  const plan = await planUpgrade(CONFIG, { to: "3.2.0" }, lookups);
  assertFalse(plan.ok);
  assert(!plan.ok && plan.reason.includes("@denext/myplug"), JSON.stringify(plan));
  const unknown = await planUpgrade(CONFIG, { to: "9.9.9" }, lookups);
  assert(!unknown.ok && unknown.reason.includes("not a published version"));
  const none = await planUpgrade('{"imports":{}}', {}, lookups);
  assert(!none.ok && none.reason.includes("no versioned"));
});

Deno.test("plan: a package that imports no denext keeps its major unless --allow-major; up to date is a no-op", async () => {
  const lookups = registry({
    "@denext/denext": { "3.0.0": null },
    "@denext/myplug": { "0.2.0": null, "0.2.5": null, "0.9.0": null },
  });
  const plan = await planUpgrade(CONFIG, {}, lookups);
  assert(plan.ok);
  // ^0.2.0 admits 0.2.x only: 0.9.0 is a breaking release nothing ties to denext's version.
  assertEquals(plan.steps.map((s) => s.to), ["3.0.0", "0.2.5"]);
  const major = await planUpgrade(CONFIG, { allowMajor: true }, lookups);
  assert(major.ok);
  assertEquals(major.steps.map((s) => s.to), ["3.0.0", "0.9.0"]);
  const current = await planUpgrade(
    CONFIG,
    {},
    registry({ "@denext/denext": { "3.0.0": null }, "@denext/myplug": { "0.2.0": "^3.0.0" } }),
  );
  assert(current.ok && !current.changed);
});

Deno.test("plan: the whole version history is searched, newest first, for a compatible set", async () => {
  // Ten newer myplug releases need a denext that doesn't exist; 0.3.0 is the one that fits.
  const myplug: Record<string, string | null> = { "0.2.0": "^3.0.0", "0.3.0": "^3.0.0" };
  for (let minor = 4; minor < 14; minor++) myplug[`0.${minor}.0`] = "^9.0.0";
  const plan = await planUpgrade(
    CONFIG,
    {},
    registry({ "@denext/denext": { "3.0.0": null }, "@denext/myplug": myplug }),
  );
  assert(plan.ok, JSON.stringify(plan));
  assertEquals(plan.steps.map((s) => s.to), ["3.0.0", "0.3.0"]);
  // And denext targets: only the oldest of ten newer denext releases fits the plugin.
  const denext: Record<string, null> = {};
  for (let minor = 0; minor < 10; minor++) denext[`3.${minor}.0`] = null;
  const older = await planUpgrade(
    CONFIG,
    {},
    registry({ "@denext/denext": denext, "@denext/myplug": { "0.2.0": "~3.1.0" } }),
  );
  assert(older.ok, JSON.stringify(older));
  assertEquals(older.steps.map((s) => s.to), ["3.1.0", "0.2.0"]);
});

Deno.test("plan: a JSR read that fails is an error, never an incompatible version", async () => {
  const lookups = registry({
    "@denext/denext": { "3.0.0": null, "3.2.0": null },
    // 0.3.0's deno.json can't be read (`undefined`): the plan must not quietly settle on 0.2.0.
    "@denext/myplug": { "0.2.0": "^3.0.0", "0.3.0": undefined as unknown as null },
  });
  const plan = await planUpgrade(CONFIG, {}, lookups);
  assert(!plan.ok, JSON.stringify(plan));
  assert(
    plan.reason.includes("couldn't reach JSR") && plan.reason.includes("@denext/myplug@0.3.0"),
  );
  const noVersions = await planUpgrade(
    CONFIG,
    {},
    registry({ "@denext/denext": { "3.0.0": null } }),
  );
  assert(
    !noVersions.ok && noVersions.reason.includes("couldn't reach JSR"),
    JSON.stringify(noVersions),
  );
});

Deno.test("plan: --to an older denext is refused unless --allow-downgrade", async () => {
  const config = '{"imports":{"denext":"jsr:@denext/denext@^3.2.0"}}';
  const lookups = registry({ "@denext/denext": { "3.0.0": null, "3.2.0": null } });
  const back = await planUpgrade(config, { to: "3.0.0" }, lookups);
  assert(!back.ok && back.reason.includes("--allow-downgrade"), JSON.stringify(back));
  const allowed = await planUpgrade(config, { to: "3.0.0", allowDowngrade: true }, lookups);
  assert(allowed.ok);
  assertEquals(allowed.steps[0], { name: "@denext/denext", from: "3.2.0", to: "3.0.0" });
});

Deno.test("findPins / applyUpgrade: the jsr:/@denext/denext@…/ import-map prefix form", () => {
  const text = '{"imports":{"denext/":"jsr:/@denext/denext@^3.0.0/"}}';
  assertEquals(findPins(text), [{ name: "@denext/denext", version: "3.0.0" }]);
  assertEquals(
    applyUpgrade(text, [{ name: "@denext/denext", from: "3.0.0", to: "3.2.0" }]),
    '{"imports":{"denext/":"jsr:/@denext/denext@^3.2.0/"}}',
  );
});

Deno.test("denext upgrade: workspace members' deno.json move with the root; a missing one is reported", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_upgrade_ws_" });
  const member = '{"imports":{"denext":"jsr:@denext/denext@^3.0.0"}}\n';
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    '{"workspace":["./apps/*","./gone"],"imports":{"denext":"jsr:@denext/denext@^3.0.0"}}\n',
  );
  await Deno.mkdir(join(dir, "apps/web"), { recursive: true });
  await Deno.writeTextFile(join(dir, "apps/web/deno.json"), member);
  const printed: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.error = console.log;
  try {
    const code = await runUpgrade(
      {
        positionals: [dir],
        flags: {},
        global: { json: false, verbose: false, quiet: false },
        rest: [],
      } as CommandContext,
      registry({ "@denext/denext": { "3.0.0": null, "3.2.0": null } }),
    );
    assertEquals(code, 0, printed.join("\n"));
    assertEquals(
      await Deno.readTextFile(join(dir, "apps/web/deno.json")),
      member.replace("^3.0.0", "^3.2.0"),
    );
    assert(printed.join("\n").includes("workspace member ./gone"), printed.join("\n"));
  } finally {
    [console.log, console.error] = [log, err];
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plan: a catalogued version's range comes from src/plugin/catalog.json, not the network", async () => {
  const entry = (CATALOG.plugins as { name: string; version: string; denext?: string }[])
    .find((p) => p.denext !== undefined)!;
  const denextVersion = entry.denext!.replace(/^[\^~]/, "");
  const config = `{"imports":{"denext":"jsr:@denext/denext@^${denextVersion}",` +
    `"p":"jsr:${entry.name}@^${entry.version}"}}`;
  const lookups = registry({
    "@denext/denext": { [denextVersion]: null },
    [entry.name]: { [entry.version]: "^999.0.0" }, // what the network would (wrongly) say
  });
  const plan = await planUpgrade(config, {}, lookups);
  assert(plan.ok, JSON.stringify(plan));
  assertEquals(plan.steps[1].to, entry.version);
  assertEquals(lookups.rangeCalls, [], "the catalog answered");
});

Deno.test("plan: a prerelease pin may move along its prereleases; a release pin never takes one", async () => {
  const rcConfig = '{"imports":{"denext":"jsr:@denext/denext@^3.3.0-rc.1"}}';
  const lookups = registry({
    "@denext/denext": { "3.2.0": null, "3.3.0-rc.1": null, "3.3.0-rc.2": null },
  });
  const rc = await planUpgrade(rcConfig, {}, lookups);
  assert(rc.ok);
  assertEquals(rc.steps[0].to, "3.3.0-rc.2");
  const release = await planUpgrade(
    '{"imports":{"denext":"jsr:@denext/denext@^3.2.0"}}',
    {},
    lookups,
  );
  assert(release.ok);
  assertEquals(release.steps[0].to, "3.2.0");
});

/** Run the verb in a temp project; returns the exit code, the output and the file after. */
async function runIn(flags: Record<string, string | boolean>, json = false) {
  const dir = await Deno.makeTempDir({ prefix: "denext_upgrade_" });
  await Deno.writeTextFile(join(dir, "deno.json"), CONFIG);
  const printed: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.error = console.log;
  try {
    const code = await runUpgrade(
      {
        positionals: [dir],
        flags,
        global: { json, verbose: false, quiet: false },
        rest: [],
      } as CommandContext,
      registry({
        "@denext/denext": { "3.0.0": null, "3.2.0": null },
        "@denext/myplug": { "0.2.0": "^3.0.0" },
      }),
    );
    return { code, out: printed.join("\n"), file: await Deno.readTextFile(join(dir, "deno.json")) };
  } finally {
    [console.log, console.error] = [log, err];
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("denext upgrade: --dry-run and --check write nothing; --check exits 1 when out of date", async () => {
  const dry = await runIn({ "dry-run": true });
  assertEquals([dry.code, dry.file], [0, CONFIG]);
  assert(dry.out.includes("3.0.0 → 3.2.0"), dry.out);
  const check = await runIn({ check: true });
  assertEquals([check.code, check.file], [1, CONFIG]);
  const json = await runIn({ check: true }, true);
  const doc = JSON.parse(json.out);
  assertEquals([doc.ok, doc.changed, doc.written], [true, true, false]);
});

Deno.test("denext upgrade writes the plan into deno.json", async () => {
  const run = await runIn({});
  assertEquals(run.code, 0);
  assertEquals(
    run.file,
    CONFIG.replaceAll("denext@^3.0.0", "denext@^3.2.0").replace("@3.0.0/", "@3.2.0/"),
  );
  assert(run.out.includes("Updated"), run.out);
});

Deno.test("jsrLookups: versions from meta.json (yanked dropped), the range from <version>/deno.json", async () => {
  const asked: string[] = [];
  const body = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const fakeFetch = ((input: URL) => {
    asked.push(input.href);
    if (input.pathname === "/@denext/myplug/meta.json") {
      return Promise.resolve(body({
        scope: "denext",
        name: "myplug",
        latest: "0.3.0",
        versions: { "0.3.0": {}, "0.2.0": { yanked: true }, "0.1.0": {} },
      }));
    }
    if (input.pathname === "/@denext/myplug/0.3.0/deno.json") {
      return Promise.resolve(body({ imports: { "@denext/denext": "jsr:@denext/denext@^3.2.0" } }));
    }
    if (input.pathname === "/@denext/myplug/0.1.0/deno.json") return Promise.resolve(body({}));
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  const lookups = jsrLookups({ fetch: fakeFetch });
  assertEquals(await lookups.versions("@denext/myplug"), {
    latest: "0.3.0",
    versions: ["0.3.0", "0.1.0"],
  });
  assertEquals(await lookups.denextRange("@denext/myplug", "0.3.0"), "^3.2.0");
  assertEquals(await lookups.denextRange("@denext/myplug", "0.1.0"), null, "no denext import");
  assertEquals(await lookups.denextRange("@denext/myplug", "0.9.0"), undefined, "unreadable");
  assertEquals(await lookups.versions("@denext/missing"), null);
  assert(asked.every((u) => u.startsWith("https://jsr.io/@denext/")), asked.join("\n"));
});

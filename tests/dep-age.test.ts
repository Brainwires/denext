// Deno's minimum dependency age and denext: generated configs no longer exempt `@denext/*` from
// the hold; `create` / `migrate` / `upgrade` pin the newest version the hold lets in instead
// (src/build/dep-age.ts, src/build/eligible-pins.ts, src/build/upgrade.ts). Every registry read
// is a fake JSR meta, so nothing here touches the network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  effectiveRule,
  heldUntil,
  holdMessage,
  isExcluded,
  parseAge,
  stripDenextExclude,
} from "../src/build/dep-age.ts";
import { offlineNote, pinEligible } from "../src/build/eligible-pins.ts";
import { freshDenoJson } from "../src/build/migrate-fresh.ts";
import { denoJson } from "../src/build/scaffold.ts";
import { planUpgrade, type UpgradeLookups } from "../src/build/upgrade.ts";
import { runUpgrade } from "../src/cli/commands/upgrade.ts";
import type { CommandContext } from "../src/cli/command.ts";

const NOW = new Date("2026-10-20T20:00:00Z");
const HOUR = 3_600_000;
/** An ISO time `h` hours before {@link NOW}. */
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
/** Deno's default rule at {@link NOW}. */
const DEFAULT = effectiveRule({ now: NOW });
/** A fixed formatter so the message text is exact. */
const fmt = (d: Date) => d.toISOString();

/** A fake JSR: per package, each version's publish time and the denext range it declares. */
function jsr(
  packages: Record<string, Record<string, { at: string; denext?: string | null }>>,
): UpgradeLookups & { calls: number } {
  const fake = {
    calls: 0,
    versions(name: string) {
      fake.calls++;
      const pkg = packages[name];
      if (!pkg) return Promise.resolve(null);
      const versions = Object.keys(pkg);
      const published = Object.fromEntries(versions.map((v) => [v, pkg[v].at]));
      return Promise.resolve({ latest: versions.at(-1)!, versions, published });
    },
    denextRange(name: string, version: string) {
      const v = packages[name]?.[version];
      return Promise.resolve(v === undefined ? undefined : v.denext ?? null);
    },
  };
  return fake;
}

/** An unreachable JSR. */
const OFFLINE: UpgradeLookups = {
  versions: () => Promise.resolve(null),
  denextRange: () => Promise.resolve(undefined),
};

const GENERATED = `{
  "tasks": { "dev": "deno run -A jsr:@denext/denext@^4.5.2/cli dev ." },
  "imports": {
    "denext": "jsr:@denext/denext@^4.5.2",
    "@denext/effect": "jsr:@denext/effect@^0.3.1"
  }
}
`;

// ── generated configs ────────────────────────────────────────────────────────

Deno.test("create: the generated deno.json carries no minimumDependencyAge (Deno's own hold applies)", () => {
  for (const opts of [{ dir: "/x" }, { dir: "/x", desktop: true, capacitor: true }]) {
    const config = JSON.parse(denoJson(opts));
    assertFalse("minimumDependencyAge" in config, JSON.stringify(config.minimumDependencyAge));
  }
});

Deno.test("migrate (Fresh re-run): the denext exemption goes, the author's own hold stays", () => {
  const input = { marker: "M", imports: {}, tasks: {}, unstable: [] };
  const merged = (age: unknown) => freshDenoJson({ minimumDependencyAge: age }, input);
  assertEquals(merged(undefined).minimumDependencyAge, undefined);
  assertEquals(merged({ exclude: ["jsr:@denext/*"] }).minimumDependencyAge, undefined);
  assertEquals(
    merged({ age: "P2D", exclude: ["jsr:@denext/*", "npm:left-pad"] }).minimumDependencyAge,
    { age: "P2D", exclude: ["npm:left-pad"] },
  );
  assertEquals(merged("P3D").minimumDependencyAge, "P3D");
});

// ── the rule ─────────────────────────────────────────────────────────────────

Deno.test("parseAge reads every form Deno accepts", () => {
  assertEquals(parseAge(0, NOW), null);
  assertEquals(parseAge("0", NOW), null);
  assertEquals(parseAge(false, NOW), null);
  assertEquals(parseAge(60, NOW), new Date(NOW.getTime() - HOUR));
  assertEquals(parseAge("120", NOW), new Date(NOW.getTime() - 2 * HOUR));
  assertEquals(parseAge("P2D", NOW), new Date(NOW.getTime() - 48 * HOUR));
  assertEquals(parseAge("PT36H", NOW), new Date(NOW.getTime() - 36 * HOUR));
  assertEquals(parseAge("P1DT2H30M", NOW), new Date(NOW.getTime() - 26.5 * HOUR));
  assertEquals(parseAge("P1W", NOW), new Date(NOW.getTime() - 168 * HOUR));
  assertEquals(parseAge("2026-09-16", NOW), new Date("2026-09-16T00:00:00Z"));
  assertEquals(parseAge("2026-09-16T12:00:00+00:00", NOW), new Date("2026-09-16T12:00:00Z"));
  for (const bad of ["P", "PT", "P1Y", "nonsense", "", null, true, {}]) {
    assertEquals(parseAge(bad, NOW), undefined, String(bad));
  }
});

Deno.test("effectiveRule: --min-dep-age (env) > deno.json > .npmrc > Deno's default", () => {
  assertEquals(DEFAULT, {
    cutoff: new Date(NOW.getTime() - 48 * HOUR),
    exclude: [],
    source: "default",
  });
  const npmrc = effectiveRule({ npmrcDays: 3, now: NOW });
  assertEquals([npmrc.source, npmrc.cutoff], ["npmrc", new Date(NOW.getTime() - 72 * HOUR)]);
  assertEquals(effectiveRule({ npmrcDays: 0, now: NOW }).cutoff, null);
  const cfg = effectiveRule({ config: { age: "PT2H", exclude: ["jsr:@x/*"] }, now: NOW });
  assertEquals([cfg.source, cfg.cutoff, cfg.exclude], [
    "config",
    new Date(NOW.getTime() - 2 * HOUR),
    ["jsr:@x/*"],
  ]);
  // An exclude-only object keeps the default age (Deno does the same).
  const only = effectiveRule({ config: { exclude: ["jsr:@denext/*"] }, npmrcDays: 2, now: NOW });
  assertEquals(only.source, "npmrc");
  // The env override drops the config's exclude, as `--min-dep-age` does.
  const env = effectiveRule({ env: "0", config: { exclude: ["jsr:@denext/*"] }, now: NOW });
  assertEquals([env.source, env.cutoff, env.exclude], ["env", null, []]);
});

Deno.test("isExcluded: exact and prefix entries, jsr: only", () => {
  const rule = {
    ...DEFAULT,
    exclude: ["jsr:@denext/*", "jsr:@std/path", "npm:@denext/x", "jsr:*"],
  };
  assert(isExcluded(rule, "@denext/denext"));
  assert(isExcluded(rule, "@std/path"));
  assertFalse(isExcluded(rule, "@std/fs"));
  assertFalse(
    isExcluded({ ...DEFAULT, exclude: ["jsr:*"] }, "@std/fs"),
    "an empty prefix is ignored",
  );
});

Deno.test("heldUntil: relative rules end age after publishing; a fixed date never does", () => {
  assertEquals(
    heldUntil(DEFAULT, "@denext/denext", hoursAgo(3), NOW),
    new Date(NOW.getTime() + 45 * HOUR),
  );
  assertEquals(heldUntil(DEFAULT, "@denext/denext", hoursAgo(49), NOW), null);
  assertEquals(heldUntil(DEFAULT, "@denext/denext", undefined, NOW), null);
  const fixed = effectiveRule({ config: "2026-10-01", now: NOW });
  assert(heldUntil(fixed, "@denext/denext", hoursAgo(3), NOW)!.getTime() >= 8.64e15);
});

Deno.test("holdMessage: the exact line create / migrate / upgrade print", () => {
  const held = {
    name: "@denext/denext",
    version: "4.5.2",
    publishedAt: hoursAgo(3),
    until: new Date(NOW.getTime() + 21 * HOUR),
  };
  assertEquals(
    holdMessage(held, "4.5.1", NOW, fmt),
    "denext 4.5.2 was published 3 h ago; your dependency-age rule allows it from " +
      '2026-10-21T17:00:00.000Z. Pinned 4.5.1 for now — run "denext upgrade" after that.',
  );
  assertEquals(
    holdMessage({ ...held, name: "@denext/effect", version: "0.4.0" }, null, NOW, fmt),
    "@denext/effect 0.4.0 was published 3 h ago; your dependency-age rule allows it from " +
      "2026-10-21T17:00:00.000Z. No older @denext/effect version is old enough to pin " +
      "instead — run this again after that.",
  );
});

// ── create / migrate: the eligibility picker ─────────────────────────────────

Deno.test("pinEligible: a CLI release inside the hold pins the previous version and says so", async () => {
  const lookups = jsr({
    "@denext/denext": {
      "4.5.0": { at: hoursAgo(70) },
      "4.5.1": { at: hoursAgo(60) },
      "4.5.2": { at: hoursAgo(3) },
    },
    "@denext/effect": { "0.3.1": { at: hoursAgo(300), denext: "^4.0.0" } },
  });
  const out = await pinEligible(GENERATED, "/nowhere", { lookups, rule: DEFAULT, now: NOW });
  assert(out.ok);
  assertEquals(out.text, GENERATED.replaceAll("4.5.2", "4.5.1"));
  assertEquals(out.notes.length, 1);
  assertStringIncludes(out.notes[0], "denext 4.5.2 was published 3 h ago;");
  assertStringIncludes(out.notes[0], 'Pinned 4.5.1 for now — run "denext upgrade" after that.');
});

Deno.test("pinEligible: a version past the hold pins itself, with nothing to say", async () => {
  const lookups = jsr({
    "@denext/denext": { "4.5.1": { at: hoursAgo(60) }, "4.5.2": { at: hoursAgo(49) } },
    "@denext/effect": { "0.3.1": { at: hoursAgo(300), denext: "^4.0.0" } },
  });
  const out = await pinEligible(GENERATED, "/nowhere", { lookups, rule: DEFAULT, now: NOW });
  assertEquals([out.ok, out.text, out.notes], [true, GENERATED, []]);
});

Deno.test("pinEligible: nothing old enough is a clear error, not a resolver failure", async () => {
  const lookups = jsr({ "@denext/denext": { "4.5.2": { at: hoursAgo(3) } } });
  const out = await pinEligible(GENERATED, "/nowhere", { lookups, rule: DEFAULT, now: NOW });
  assertFalse(out.ok);
  assertStringIncludes(out.error!, "denext 4.5.2 was published 3 h ago;");
  assertStringIncludes(out.error!, "No older denext version is old enough to pin instead");
});

Deno.test("pinEligible: a first-party package moves to a version that is old enough AND fits", async () => {
  const lookups = jsr({
    "@denext/denext": { "4.4.0": { at: hoursAgo(90) }, "4.5.2": { at: hoursAgo(3) } },
    "@denext/effect": {
      "0.3.0": { at: hoursAgo(200), denext: "^4.4.0" },
      "0.3.1": { at: hoursAgo(2), denext: "^4.5.2" },
    },
  });
  const out = await pinEligible(GENERATED, "/nowhere", { lookups, rule: DEFAULT, now: NOW });
  assert(out.ok);
  assertStringIncludes(out.text, "jsr:@denext/denext@^4.4.0");
  assertStringIncludes(out.text, "jsr:@denext/effect@^0.3.0");
  assertEquals(out.notes.length, 2);
});

Deno.test("pinEligible: offline keeps the pins and warns; no hold asks nothing", async () => {
  const out = await pinEligible(GENERATED, "/nowhere", {
    lookups: OFFLINE,
    rule: DEFAULT,
    now: NOW,
  });
  assertEquals([out.ok, out.text], [true, GENERATED]);
  assertEquals(out.notes, [offlineNote("couldn't reach JSR to read @denext/denext's versions")]);
  assertStringIncludes(out.notes[0], "kept them as written");
  const off = jsr({});
  const none = await pinEligible(GENERATED, "/nowhere", {
    lookups: off,
    rule: effectiveRule({ env: "0", now: NOW }),
    now: NOW,
  });
  assertEquals([none.ok, none.text, off.calls], [true, GENERATED, 0]);
});

Deno.test("pinEligible: an unpublished CLI version (a development build) is left alone", async () => {
  const lookups = jsr({ "@denext/denext": { "4.5.1": { at: hoursAgo(3) } } });
  const out = await pinEligible(GENERATED, "/nowhere", { lookups, rule: DEFAULT, now: NOW });
  assertEquals([out.ok, out.text], [true, GENERATED]);
});

// ── upgrade ──────────────────────────────────────────────────────────────────

Deno.test("planUpgrade: the newest release inside the hold is skipped and named", async () => {
  const lookups = jsr({
    "@denext/denext": {
      "4.4.0": { at: hoursAgo(90) },
      "4.5.1": { at: hoursAgo(60) },
      "4.5.2": { at: hoursAgo(3) },
    },
  });
  const text = '{ "imports": { "denext": "jsr:@denext/denext@^4.4.0" } }';
  const plan = await planUpgrade(text, { rule: DEFAULT, now: NOW }, lookups);
  assert(plan.ok);
  assertEquals(plan.steps, [{ name: "@denext/denext", from: "4.4.0", to: "4.5.1" }]);
  assertEquals(plan.held?.map((h) => [h.held.version, h.pinned]), [["4.5.2", "4.5.1"]]);
  const to = await planUpgrade(text, { to: "4.5.2", rule: DEFAULT, now: NOW }, lookups);
  assertFalse(to.ok);
  assertStringIncludes(to.reason, "--to 4.5.2 can't be pinned until then");
});

Deno.test("planUpgrade: a pin the hold still covers moves down so the app resolves today", async () => {
  const lookups = jsr({
    "@denext/denext": { "4.5.0": { at: hoursAgo(70) }, "4.5.1": { at: hoursAgo(3) } },
  });
  const text = '{ "imports": { "denext": "jsr:@denext/denext@^4.5.1" } }';
  const plan = await planUpgrade(text, { rule: DEFAULT, now: NOW }, lookups);
  assert(plan.ok);
  assertEquals(plan.steps, [{ name: "@denext/denext", from: "4.5.1", to: "4.5.0" }]);
  assertEquals(plan.held?.map((h) => [h.held.version, h.pinned]), [["4.5.1", "4.5.0"]]);
});

const EXISTING = `{
  // made by denext create 4.x
  "tasks": { "dev": "deno run -A jsr:@denext/denext@^4.4.0/cli dev ." },
  "minimumDependencyAge": {
    "age": "P2D",
    "exclude": ["npm:left-pad", "jsr:@denext/*", "jsr:@std/path"]
  },
  "imports": { "denext": "jsr:@denext/denext@^4.4.0" }
}
`;

/** Run `denext upgrade` on a temp project holding `config`; the exit code, output and file. */
async function upgradeIn(config: string, flags: Record<string, boolean> = {}) {
  const dir = await Deno.makeTempDir({ prefix: "denext_dep_age_" });
  await Deno.writeTextFile(join(dir, "deno.json"), config);
  const printed: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.error = console.log;
  try {
    const code = await runUpgrade(
      { positionals: [dir], flags, global: { json: false }, rest: [] } as unknown as CommandContext,
      jsr({ "@denext/denext": { "4.4.0": { at: hoursAgo(400) }, "4.5.0": { at: hoursAgo(10) } } }),
      () => Promise.resolve(true),
      { now: NOW },
    );
    return { code, out: printed.join("\n"), file: await Deno.readTextFile(join(dir, "deno.json")) };
  } finally {
    [console.log, console.error] = [log, err];
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("upgrade: removes only the jsr:@denext/* exclude entry, and says why", async () => {
  const { code, out, file } = await upgradeIn(EXISTING);
  assertEquals(code, 0, out);
  assertEquals(
    file,
    // (upgrade also adds runtime 3.0.0-rc.5's `.deno/` exclude to an older project)
    EXISTING.replace('"jsr:@denext/*", ', "").replace(
      /\n}\n$/,
      ',\n  "exclude": [".deno/"]\n}\n',
    ),
    "the other entries, the age, the comment and the pin (4.5.0 is inside P2D) are kept",
  );
  assertStringIncludes(out, 'Removed "jsr:@denext/*" from minimumDependencyAge.exclude');
  assertStringIncludes(out, "If you publish denext yourself, add it back");
  assertStringIncludes(out, "denext 4.5.0 was published 10 h ago");
});

Deno.test("upgrade: an exclude that held only the denext entry goes with it; --check counts it", async () => {
  const only = EXISTING.replace(
    /"minimumDependencyAge": \{[^}]*\},\n/,
    '"minimumDependencyAge": { "exclude": ["jsr:@denext/*"] },\n',
  );
  const checked = await upgradeIn(only, { check: true });
  assertEquals(checked.code, 1, checked.out);
  assertEquals(checked.file, only, "--check writes nothing");
  assertStringIncludes(checked.out, 'Would remove "jsr:@denext/*"');
  const { file } = await upgradeIn(only);
  assertFalse(file.includes("minimumDependencyAge"), file);
  JSON.parse(file.replace(/^\s*\/\/.*$/m, ""));
});

Deno.test("stripDenextExclude: every shape, other entries kept, valid JSON after", () => {
  const cases: [string, string][] = [
    ['{"minimumDependencyAge":{"exclude":["jsr:@denext/*"]},"a":1}', '{"a":1}'],
    ['{"a":1,"minimumDependencyAge":{"exclude":["jsr:@denext/*"]}}', '{"a":1}'],
    [
      '{"minimumDependencyAge":{"exclude":["jsr:@denext/*"],"age":"P1D"}}',
      '{"minimumDependencyAge":{"age":"P1D"}}',
    ],
    [
      '{"minimumDependencyAge":{"age":"P1D","exclude":["jsr:@denext/*"]}}',
      '{"minimumDependencyAge":{"age":"P1D"}}',
    ],
    [
      '{"minimumDependencyAge":{"exclude":["npm:x","jsr:@denext/*"]}}',
      '{"minimumDependencyAge":{"exclude":["npm:x"]}}',
    ],
  ];
  for (const [input, want] of cases) {
    const out = stripDenextExclude(input);
    assert(out.removed, input);
    assertEquals(JSON.parse(out.text), JSON.parse(want), input);
  }
  const pretty =
    '{\n  "tasks": {},\n  "minimumDependencyAge": {\n    "exclude": [\n      "jsr:@denext/*"\n    ]\n  },\n  "unstable": []\n}\n';
  assertEquals(stripDenextExclude(pretty).text, '{\n  "tasks": {},\n  "unstable": []\n}\n');
  for (
    const untouched of ['{"minimumDependencyAge":{"exclude":["jsr:@denext/denext"]}}', "{", "{}"]
  ) {
    assertEquals(stripDenextExclude(untouched), { text: untouched, removed: false });
  }
});

Deno.test("doctor: a deno.json that still exempts jsr:@denext/* gets a fix pointing at upgrade", async () => {
  const { depAgeExemptionCheck } = await import("../src/cli/commands/doctor.ts");
  const dir = await Deno.makeTempDir({ prefix: "denext_dep_age_doctor_" });
  try {
    assertEquals(await depAgeExemptionCheck(dir), null, "no config");
    await Deno.writeTextFile(join(dir, "deno.json"), EXISTING);
    const check = await depAgeExemptionCheck(dir);
    assertEquals([check?.ok, check?.critical], [false, false]);
    assertStringIncludes(check!.detail, "`denext upgrade` removes the entry");
    await Deno.writeTextFile(join(dir, "deno.json"), stripDenextExclude(EXISTING).text);
    assertEquals(await depAgeExemptionCheck(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext create: with the hold off nothing is asked of JSR, and the pin is this release", async () => {
  const { createCommand } = await import("../src/cli/commands/create.ts");
  const { VERSION } = await import("../mod.ts");
  const root = await Deno.makeTempDir({ prefix: "denext_dep_age_create_" });
  const dir = join(root, "app");
  const prior = Deno.env.get("DENEXT_MIN_DEP_AGE");
  const log = console.log;
  console.log = () => {};
  Deno.env.set("DENEXT_MIN_DEP_AGE", "0");
  try {
    await createCommand.run({
      positionals: [dir],
      flags: { yes: true, "no-vscode": true },
      global: { json: false },
      rest: [],
    } as unknown as CommandContext);
    const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertFalse("minimumDependencyAge" in config);
    assertEquals(config.imports.denext, `jsr:@denext/denext@^${VERSION}`);
  } finally {
    console.log = log;
    if (prior === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
    else Deno.env.set("DENEXT_MIN_DEP_AGE", prior);
    await Deno.remove(root, { recursive: true });
  }
});

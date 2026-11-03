// `denext mobile add` pins every npm package to one exact version (never a caret range a package
// manager would resolve to a release published minutes ago), and before installing checks each
// pin's npm publish time against the project's minimum dependency age — the rule `create`,
// `migrate` and `upgrade` apply (src/build/dep-age.ts). The publish times of the current pins are
// recorded in tests/fixtures/npm-pins/publish-times.json: a new pin needs its time recorded, and
// a pin still inside Deno's default hold fails here.

import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { effectiveRule } from "../src/build/dep-age.ts";
import { CAPACITOR_VERSION } from "../src/build/capacitor-pins.ts";
import {
  addMobileCapabilities,
  MOBILE_CAPABILITIES,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import {
  assertPinsEligible,
  checkPinAges,
  EXACT_VERSION,
  type NpmPublishTimes,
  npmRegistryPublishTimes,
  splitSpec,
} from "../src/build/npm-pin-age.ts";

const RECORDED = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/npm-pins/publish-times.json", import.meta.url)),
) as Record<string, Record<string, string>>;

/** Every npm pin denext writes: each plugin, its peers, and the Capacitor packages. */
function allPins(): string[] {
  const specs = new Set<string>();
  for (const cap of Object.values(MOBILE_CAPABILITIES)) {
    if (cap.npm) specs.add(`${cap.npm}@${cap.version}`);
    for (const peer of cap.peers ?? []) specs.add(peer);
  }
  for (const p of ["core", "cli", "ios", "android"]) {
    specs.add(`@capacitor/${p}@${CAPACITOR_VERSION}`);
  }
  return [...specs].sort();
}

const recorded: NpmPublishTimes = (name) =>
  RECORDED[name] ? Promise.resolve(RECORDED[name]) : Promise.reject(new Error(`no ${name}`));

Deno.test("npm pins: every pin is one exact version, none a range", () => {
  assertMatch(CAPACITOR_VERSION, EXACT_VERSION);
  for (const spec of allPins()) assertMatch(splitSpec(spec).version, EXACT_VERSION, spec);
});

Deno.test("npm pins: every exact pin passes Deno's default dependency-age hold", async () => {
  const pins = allPins();
  for (const spec of pins) {
    const { name, version } = splitSpec(spec);
    assert(RECORDED[name]?.[version], `${spec}: record its npm publish time in the fixture`);
  }
  // Deno's default rule (two days), as a project without its own rule has it.
  const report = await checkPinAges(pins, recorded, effectiveRule({}));
  assertEquals(report, { held: [], unknown: [] });
  assertEquals(assertPinsEligible(report), []);
});

Deno.test("checkPinAges: a version inside the hold is held; an npm: exclude lifts it; a range is refused", async () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const fresh: NpmPublishTimes = () =>
    Promise.resolve({ "8.6.0": "2026-10-29T06:00:00Z", "8.5.2": "2026-09-11T15:05:36Z" });
  const rule = effectiveRule({ now });
  const held = await checkPinAges(["@capacitor/core@8.6.0"], fresh, rule, now);
  assertEquals(held.held.map((h) => `${h.name}@${h.version}`), ["@capacitor/core@8.6.0"]);
  assertEquals(held.held[0].until.toISOString(), "2026-10-31T06:00:00.000Z");
  assertThrows(() => assertPinsEligible(held, now), Error, "@capacitor/core 8.6.0 was published");
  assertEquals((await checkPinAges(["@capacitor/core@8.5.2"], fresh, rule, now)).held, []);
  const excluded = effectiveRule({ config: { age: "P2D", exclude: ["npm:@capacitor/*"] }, now });
  assertEquals((await checkPinAges(["@capacitor/core@8.6.0"], fresh, excluded, now)).held, []);
  assertEquals(
    (await checkPinAges(
      ["@capacitor/core@8.6.0"],
      fresh,
      effectiveRule({
        config: false,
        now,
      }),
      now,
    )).held,
    [],
  );
  await assertRejects(
    () => checkPinAges(["@capacitor/core@^8.5.2"], fresh, rule, now),
    Error,
    "is not pinned to an exact version",
  );
});

Deno.test("checkPinAges: an unreachable registry keeps the pins with a note", async () => {
  const offline: NpmPublishTimes = () => Promise.reject(new TypeError("network down"));
  const report = await checkPinAges(["@capacitor/app@8.1.1"], offline, effectiveRule({}));
  assertEquals(report, { held: [], unknown: ["@capacitor/app@8.1.1"] });
  const notes = assertPinsEligible(report);
  assertEquals(notes.length, 1);
  assert(notes[0].includes("could not be read for @capacitor/app@8.1.1"));
});

Deno.test("npmRegistryPublishTimes: the full packument's time map, scoped names escaped", async () => {
  const urls: string[] = [];
  const lookup = npmRegistryPublishTimes({
    fetch: (input) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({ time: { "8.1.1": "2026-07-15T10:23:28.483Z" } }));
    },
  });
  assertEquals(await lookup("@capacitor/app"), { "8.1.1": "2026-07-15T10:23:28.483Z" });
  assertEquals(urls, ["https://registry.npmjs.org/@capacitor%2Fapp"]);
  const missing = npmRegistryPublishTimes({
    fetch: () => Promise.resolve(new Response("not found", { status: 404 })),
  });
  await assertRejects(() => missing("nope"), Error, "answered 404");
});

/** A Capacitor project ready for `mobile add` (its own CLI, an export, a `.git` bound). */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pin_age_" });
  const files: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'dev.example', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "8.5.2" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "node_modules/@capacitor/cli/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    ".git/HEAD": "ref: refs/heads/main\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

Deno.test("mobile add: a pin inside the project's dependency-age hold is refused before the install", async () => {
  const dir = await project();
  try {
    const calls: PlannedCommand[] = [];
    const run = (c: PlannedCommand) => {
      calls.push(c);
      return Promise.resolve({ code: 0 });
    };
    const justPublished: NpmPublishTimes = () =>
      Promise.resolve(new Proxy({}, { get: () => new Date().toISOString() }));
    await assertRejects(
      () =>
        addMobileCapabilities({
          capabilities: ["haptics"],
          cwd: dir,
          run,
          publishTimes: justPublished,
        }),
      Error,
      "@capacitor/haptics 8.0.2 was published",
    );
    assertEquals(calls, [], "nothing installed");
    // The project's own rule decides: with the hold off, the same pin installs.
    const report = await addMobileCapabilities({
      capabilities: ["haptics"],
      cwd: dir,
      run,
      publishTimes: justPublished,
      ageRule: effectiveRule({ config: 0 }),
    });
    assertEquals(calls[0].args, [
      "install",
      "--ignore-scripts",
      "--save-exact",
      "@capacitor/haptics@8.0.2",
    ]);
    assertEquals(report.skipped, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile add: an unreachable registry installs the exact pins and says so", async () => {
  const dir = await project();
  try {
    const calls: PlannedCommand[] = [];
    const report = await addMobileCapabilities({
      capabilities: ["haptics"],
      cwd: dir,
      run: (c) => {
        calls.push(c);
        return Promise.resolve({ code: 0 });
      },
      publishTimes: () => Promise.reject(new TypeError("offline")),
    });
    assertEquals(calls.length, 2);
    assert(
      report.skipped.some((s) => s.includes("could not be read for @capacitor/haptics@8.0.2")),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

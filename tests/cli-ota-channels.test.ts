// `denext ota channel` / `denext ota promote` (src/cli/commands/ota-channels.ts): the verbs over the
// channels file `createOtaHandler({ channels })` serves. The file format and the promotion rules
// are tests/ota-channels.test.ts; here the flags, the working directory, the printed result (text
// and `--json`) and every usage refusal, with Deno.exit stubbed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { otaChannel, otaPromote } from "../src/cli/commands/ota-channels.ts";
import { writeOtaManifest } from "../src/build/ota-manifest.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** An OTA export `name` under `root` (an index, a client chunk and the manifest). */
async function release(root: string, name: string, sequence: number): Promise<void> {
  const dir = join(root, name);
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "index.html"), `<html>${name}</html>`);
  await Deno.writeTextFile(join(dir, "_denext", "client", `${name}.js`), `// ${name}`);
  await writeOtaManifest(dir, { sequence });
}

/** Run `verb` with `positionals` / `flags` in `cwd`; the output and any exit code. */
async function run(
  verb: typeof otaChannel,
  cwd: string,
  positionals: string[],
  flags: Record<string, string | number | boolean> = {},
  json = false,
) {
  const cap = capture();
  const exit = stubExit();
  try {
    await verb(makeCtx({ positionals, flags, global: { cwd, json } }));
  } catch (e) {
    if (!String(e).includes("__exit__")) throw e;
  } finally {
    exit.restore();
    cap.restore();
  }
  return { out: cap.logs.join("\n"), err: cap.errs.join("\n"), exits: exit.calls };
}

async function inTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "denext_cli_ota_" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("ota channel: points a channel at an export, relative to the working directory", async () => {
  await inTemp(async (root) => {
    await release(root, "r1", 1);
    await release(root, "r2", 2);
    const r = await run(otaChannel, root, ["channel", "beta", "r1"]);
    assertEquals(r.exits, []);
    const file = join(root, "ota-channels.json");
    assertStringIncludes(r.out, `wrote ${file}`);
    assertStringIncludes(r.out, "beta (default): r1");
    // --file names another channels file; --json prints the document.
    const json = await run(
      otaChannel,
      root,
      ["channel", "production", "r2"],
      { file: "deploy/channels.json" },
      true,
    );
    assertEquals(json.exits, []);
    const doc = JSON.parse(json.out);
    assertEquals(doc.file, join(root, "deploy", "channels.json"));
    assertEquals(doc.default, "production");
    assertEquals(doc.channels.production, { release: "../r2" });
  });
});

Deno.test("ota channel: a missing channel or export, or a refused one, exits 1", async () => {
  await inTemp(async (root) => {
    const none = await run(otaChannel, root, ["channel", "beta"]);
    assertEquals(none.exits, [1]);
    assertStringIncludes(none.err, "pass the channel and the export");
    const bad = await run(otaChannel, root, ["channel", "beta", "nothing-here"]);
    assertEquals(bad.exits, [1]);
    assertStringIncludes(bad.err, "denext ota channel: ");
    const empty = await run(otaChannel, root, ["channel", "beta", "r1"], { file: "" });
    assertEquals(empty.exits, [1]);
    assertStringIncludes(empty.err, "--file needs a value");
  });
});

Deno.test("ota promote: a staged rollout, a raise to 100%, a halt, from a channel or an export", async () => {
  await inTemp(async (root) => {
    await release(root, "old", 10);
    await release(root, "new", 20);
    await run(otaChannel, root, ["channel", "production", "old"]);
    await run(otaChannel, root, ["channel", "beta", "new"]);
    const staged = await run(otaPromote, root, ["promote"], {
      channel: "beta",
      to: "production",
      percent: 20,
    });
    assertEquals(staged.exits, []);
    assertStringIncludes(staged.out, "production (default): old, rolling out new to 20%");
    const halted = await run(otaPromote, root, ["promote"], { to: "production", halt: true });
    assertStringIncludes(halted.out, "production (default): old");
    assert(!halted.out.includes("rolling out"), halted.out);
    const full = await run(otaPromote, root, ["promote"], { channel: "beta", to: "production" });
    assertStringIncludes(full.out, "production (default): new");
    // From an export directory, onto a new channel, as JSON.
    const fromDir = await run(otaPromote, root, ["promote"], { release: "new", to: "qa" }, true);
    assertEquals(fromDir.exits, []);
    assertEquals(JSON.parse(fromDir.out).channels.qa, { release: "new" });
  });
});

Deno.test("ota promote: the usage refusals exit 1 before touching the file", async () => {
  await inTemp(async (root) => {
    const cases: [Record<string, string | number | boolean>, string][] = [
      [{}, "pass the target channel with --to"],
      [{ to: "production", channel: "beta", release: "out" }, "--channel or --release, not both"],
      [{ to: "production", percent: "lots" }, "--percent takes a number"],
      [{ to: "" }, "--to needs a value"],
    ];
    for (const [flags, message] of cases) {
      const r = await run(otaPromote, root, ["promote"], flags);
      assertEquals(r.exits, [1], message);
      assertStringIncludes(r.err, message);
    }
    // A rule the promotion itself refuses (a staged rollout onto a channel that does not exist).
    await release(root, "new", 20);
    await run(otaChannel, root, ["channel", "beta", "new"]);
    const r = await run(otaPromote, root, ["promote"], {
      channel: "beta",
      to: "nightly",
      percent: 10,
    });
    assertEquals(r.exits, [1]);
    assertStringIncludes(r.err, "denext ota promote: ");
    assertStringIncludes(r.err, "does not exist yet");
    let wrote = true;
    await Deno.stat(join(root, "ota-channels.json")).then(() => {}, () => (wrote = false));
    assert(wrote, "the beta channel file from before stays");
  });
});

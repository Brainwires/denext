// src/ts/lsp-settings.ts + the editors denext sets up: the pinned runtime's `deno lsp` runs its
// TypeScript 7 (tsgo) backend with no setting, so `create` / `init` / `migrate` (ensureVscodeDeno)
// write no `deno.unstable`, and `denext upgrade` removes the `"deno.unstable": ["tsgo-lsp"]` that
// earlier versions wrote — never a `deno.unstable` the project chose.

import { assert, assertEquals } from "@std/assert";
import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import { hasLegacyTsgoLspSetting, removeLegacyTsgoLspSetting } from "../src/ts/lsp-settings.ts";
import { ensureVscodeDeno } from "../src/build/scaffold.ts";
import { editorSettingUpdate } from "../src/cli/commands/upgrade.ts";

Deno.test("hasLegacyTsgoLspSetting: only exactly the entry denext wrote", () => {
  assert(hasLegacyTsgoLspSetting({ "deno.unstable": ["tsgo-lsp"] }));
  assert(!hasLegacyTsgoLspSetting({ "deno.enable": true }));
  assert(!hasLegacyTsgoLspSetting({ "deno.unstable": [] }));
  assert(!hasLegacyTsgoLspSetting({ "deno.unstable": ["tsgo-lsp", "sloppy-imports"] }));
  assert(!hasLegacyTsgoLspSetting({ "deno.unstable": "tsgo-lsp" }));
});

Deno.test("removeLegacyTsgoLspSetting: the spliced entry (upgrade's) goes, comments and bytes kept", () => {
  // What `denext upgrade` spliced in after `{`.
  const before = '{\n  // the project\'s own\n  "deno.enable": true\n}\n';
  const spliced =
    '{\n  "deno.unstable": ["tsgo-lsp"],\n  // the project\'s own\n  "deno.enable": true\n}\n';
  assertEquals(removeLegacyTsgoLspSetting(spliced), before);
  assertEquals(removeLegacyTsgoLspSetting(before), null, "idempotent");
});

Deno.test("removeLegacyTsgoLspSetting: the written file (create's / migrate's) keeps valid JSON", () => {
  const written = JSON.stringify({ "deno.enable": true, "deno.unstable": ["tsgo-lsp"] }, null, 2) +
    "\n";
  assertEquals(removeLegacyTsgoLspSetting(written), '{\n  "deno.enable": true\n}\n');
  // the entry alone, or between two members
  assertEquals(removeLegacyTsgoLspSetting('{\n  "deno.unstable": ["tsgo-lsp"]\n}'), "{\n}");
  const middle = '{ "a": 1, "deno.unstable": [ "tsgo-lsp" ], "b": 2 }';
  assertEquals(parseJsonc(removeLegacyTsgoLspSetting(middle)!), { a: 1, b: 2 });
});

Deno.test("removeLegacyTsgoLspSetting: anything else is left alone", () => {
  for (
    const text of [
      '{ "deno.unstable": [] }',
      '{ "deno.unstable": ["tsgo-lsp", "sloppy-imports"] }',
      '{ "deno.enable": true }',
      // the text only in a comment: the setting itself is not the entry
      '{\n  // "deno.unstable": ["tsgo-lsp"]\n  "deno.unstable": ["kv"]\n}',
      "[]",
      "{ nope",
    ]
  ) assertEquals(removeLegacyTsgoLspSetting(text), null, text);
});

/** A temp dir with `.vscode/settings.json` holding `text` (none when `null`). */
async function project(text: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_tsgo_lsp_" });
  if (text !== null) {
    await Deno.mkdir(join(dir, ".vscode"));
    await Deno.writeTextFile(join(dir, ".vscode", "settings.json"), text);
  }
  return dir;
}

const settingsOf = async (dir: string) =>
  await Deno.readTextFile(join(dir, ".vscode", "settings.json"));

Deno.test("ensureVscodeDeno: a new editor setup turns the Deno LSP on and writes no deno.unstable", async () => {
  const dir = await project(null);
  try {
    const written: string[] = [];
    await ensureVscodeDeno(dir, written);
    assertEquals(JSON.parse(await settingsOf(dir)), { "deno.enable": true });
    // idempotent: a re-run writes nothing
    const again: string[] = [];
    await ensureVscodeDeno(dir, again);
    assertEquals(again, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureVscodeDeno: settings already on the Deno LSP are not rewritten; a user's deno.unstable is kept", async () => {
  const on = '{\n  // mine\n  "deno.enable": true\n}\n';
  const dir = await project(on);
  const theirs = await project('{ "deno.unstable": ["sloppy-imports"] }\n');
  try {
    const written: string[] = [];
    await ensureVscodeDeno(dir, written);
    assertEquals(await settingsOf(dir), on);
    assert(!written.includes(join(dir, ".vscode", "settings.json")), written.join(", "));
    await ensureVscodeDeno(theirs, []);
    assertEquals(JSON.parse(await settingsOf(theirs)), {
      "deno.unstable": ["sloppy-imports"],
      "deno.enable": true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(theirs, { recursive: true });
  }
});

Deno.test("denext upgrade's editor step: removes only the legacy entry", async () => {
  const cases: Array<[string | null, boolean]> = [
    ['{\n  "deno.unstable": ["tsgo-lsp"],\n  "deno.enable": true // on\n}\n', true],
    ['{ "deno.enable": true, "deno.unstable": [] }', false], // the user's own choice
    ['{ "deno.enable": true }', false], // nothing to remove; nothing is added
    [null, false], // no settings at all: nothing is created
    ["{ broken", false],
  ];
  for (const [text, updates] of cases) {
    const dir = await project(text);
    try {
      const update = await editorSettingUpdate(dir);
      assertEquals(update !== null, updates, String(text));
      if (update) assertEquals(update.text, removeLegacyTsgoLspSetting(text!));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

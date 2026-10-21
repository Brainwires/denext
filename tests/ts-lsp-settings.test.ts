// src/ts/lsp-settings.ts + the editors denext sets up: the TypeScript 7 (tsgo) language server
// is the default `deno lsp` backend in `.vscode/settings.json` (`"deno.unstable": ["tsgo-lsp"]`)
// for `create` / `init` / `migrate` (ensureVscodeDeno) and `denext upgrade`, never over a
// `deno.unstable` the project chose, and never with DENEXT_TSGO_LSP=0.

import { assert, assertEquals } from "@std/assert";
import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import {
  addTsgoLspSetting,
  needsTsgoLspSetting,
  TSGO_LSP_FEATURE,
  tsgoLspByDefault,
} from "../src/ts/lsp-settings.ts";
import { ensureVscodeDeno } from "../src/build/scaffold.ts";
import { editorSettingUpdate } from "../src/cli/commands/upgrade.ts";

Deno.test("tsgoLspByDefault: on unless DENEXT_TSGO_LSP is 0 / false / off / no", () => {
  assert(tsgoLspByDefault(() => undefined));
  for (const on of ["1", "true", "", "yes"]) assert(tsgoLspByDefault(() => on), on);
  for (const off of ["0", "false", "OFF", " no "]) assert(!tsgoLspByDefault(() => off), off);
});

Deno.test("needsTsgoLspSetting: any deno.unstable the user set (an empty list too) is their choice", () => {
  assert(needsTsgoLspSetting({ "deno.enable": true }));
  assert(!needsTsgoLspSetting({ "deno.unstable": [] }));
  assert(!needsTsgoLspSetting({ "deno.unstable": ["sloppy-imports"] }));
});

Deno.test("addTsgoLspSetting splices the entry after `{`, keeping comments and formatting", () => {
  const text = '// my settings { not the object }\n{\n  // keep me\n  "deno.enable": true,\n}\n';
  const next = addTsgoLspSetting(text)!;
  assertEquals(
    next,
    '// my settings { not the object }\n{\n  "deno.unstable": ["tsgo-lsp"],\n  // keep me\n' +
      '  "deno.enable": true,\n}\n',
  );
  assertEquals((parseJsonc(next) as Record<string, unknown>)["deno.unstable"], [TSGO_LSP_FEATURE]);
  assertEquals(addTsgoLspSetting(next), null, "idempotent");
  // an empty object takes the entry alone (no dangling comma)
  const empty = addTsgoLspSetting("{ /* nothing */ }")!;
  assertEquals(parseJsonc(empty), { "deno.unstable": ["tsgo-lsp"] });
  // a block comment before the object, with a brace in it
  assertEquals(
    addTsgoLspSetting('/* { */ {"deno.enable": true}'),
    '/* { */ {\n  "deno.unstable": ["tsgo-lsp"],"deno.enable": true}',
  );
  // never rewritten: a deno.unstable of the user's, a non-object, unparseable text
  assertEquals(addTsgoLspSetting('{ "deno.unstable": [] }'), null);
  assertEquals(addTsgoLspSetting("[]"), null);
  assertEquals(addTsgoLspSetting("{ nope"), null);
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

Deno.test("ensureVscodeDeno: a new editor setup runs the TypeScript 7 language server", async () => {
  const dir = await project(null);
  try {
    const written: string[] = [];
    await ensureVscodeDeno(dir, written, { tsgoLsp: true });
    assertEquals(JSON.parse(await settingsOf(dir)), {
      "deno.enable": true,
      "deno.unstable": ["tsgo-lsp"],
    });
    // idempotent: a re-run writes nothing
    const again: string[] = [];
    await ensureVscodeDeno(dir, again, { tsgoLsp: true });
    assertEquals(again, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureVscodeDeno: the opt-out writes no tsgo setting; a user's deno.unstable is kept", async () => {
  const off = await project(null);
  const theirs = await project('{ "deno.unstable": ["sloppy-imports"] }\n');
  try {
    await ensureVscodeDeno(off, [], { tsgoLsp: false });
    assertEquals(JSON.parse(await settingsOf(off)), { "deno.enable": true });
    await ensureVscodeDeno(theirs, [], { tsgoLsp: true });
    assertEquals(JSON.parse(await settingsOf(theirs)), {
      "deno.unstable": ["sloppy-imports"],
      "deno.enable": true,
    });
  } finally {
    await Deno.remove(off, { recursive: true });
    await Deno.remove(theirs, { recursive: true });
  }
});

Deno.test("ensureVscodeDeno: settings already on the Deno LSP get only the entry, comments kept", async () => {
  const text = '{\n  // mine\n  "deno.enable": true\n}\n';
  const dir = await project(text);
  try {
    const written: string[] = [];
    await ensureVscodeDeno(dir, written, { tsgoLsp: true });
    assertEquals(await settingsOf(dir), addTsgoLspSetting(text));
    assertEquals(written[0], join(dir, ".vscode", "settings.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext upgrade's editor step: only Deno-LSP settings with no deno.unstable, never with the opt-out", async () => {
  const cases: Array<[string | null, boolean]> = [
    ['{\n  "deno.enable": true // on\n}\n', true],
    ['{ "deno.enable": true, "deno.unstable": [] }', false], // the user's choice: TS 6
    ['{ "editor.tabSize": 2 }', false], // not a Deno LSP setup
    [null, false], // no settings at all: nothing is created
    ["{ broken", false],
  ];
  for (const [text, updates] of cases) {
    const dir = await project(text);
    try {
      const update = await editorSettingUpdate(dir, () => undefined);
      assertEquals(update !== null, updates, String(text));
      if (update) {
        assertEquals(update.text, addTsgoLspSetting(text!));
        assertEquals(await editorSettingUpdate(dir, () => "0"), null, "DENEXT_TSGO_LSP=0");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

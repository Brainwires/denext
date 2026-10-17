// The Lustre kit modules the Gleam build writes into the app's `.denext/` directory when the
// Gleam project depends on Lustre. Each imports the few Lustre functions denext/gleam needs from
// the app's own build (through the `@gleam/` import map entry, exactly as the app's code reaches
// Lustre, so both see one copy of it) and hands them to denext. App code imports the kit:
//
//   import { lustre } from "../.denext/lustre.ts";              // lustreIsland, lustreElement
//   import { lustreServer } from "../.denext/lustre-server.ts"; // defineLustreView
//
// `.denext/lustre-view.ts` is a `"use client"` module: the browser island of `defineLustreView`,
// bound to Lustre's reconciler, so it is an ordinary island of the app (a file chunk, loaded only on
// pages that render a Lustre view).
//
// Rewritten after every Gleam build (only when the text changes), removed once the project no
// longer depends on Lustre. Never edited by hand: the header marks the file as denext's.

import { join } from "@std/path";

/** The first line of every kit module denext writes (what lets it remove a stale one). */
const HEADER = "// denext generated: the app's Lustre build, for denext/gleam. Do not edit.";

/** The kit modules, by file name under `.denext/`. */
const KITS: Record<string, (version: string) => string> = {
  "lustre.ts": clientKit,
  "lustre-view.ts": viewIsland,
  "lustre-server.ts": serverKit,
};

/**
 * The Lustre version the Gleam project resolved, from the package Gleam downloaded
 * (`build/packages/lustre/gleam.toml`); `null` when it has no Lustre.
 *
 * @param gleamDir The Gleam project directory.
 * @returns The version, `"unknown"` when the package's manifest does not say, or `null`.
 */
export async function lustreVersion(gleamDir: string): Promise<string | null> {
  const js = join(gleamDir, "build", "dev", "javascript", "lustre", "lustre.mjs");
  if (!await Deno.stat(js).then(() => true, () => false)) return null;
  try {
    const toml = await Deno.readTextFile(
      join(gleamDir, "build", "packages", "lustre", "gleam.toml"),
    );
    const version = /^version\s*=\s*"([^"\n]*)"/m.exec(toml)?.[1] ?? "";
    // The kits write it into a doc comment and a string: only a version's characters get there.
    return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** `.denext/lustre.ts`: what the browser-side helpers (`lustreIsland`, `lustreElement`) use. */
function clientKit(version: string): string {
  return `${HEADER}
// Rewritten by every Gleam build (the gleam() plugin, \`denext add gleam:\`).
import { is_browser, register, send, shutdown, start } from "@gleam/lustre/lustre.mjs";
import { attribute } from "@gleam/lustre/lustre/attribute.mjs";
import { prerender } from "@gleam/lustre/lustre/component.mjs";
import { to_string } from "@gleam/lustre/lustre/element.mjs";
import { toList } from "@gleam/lustre/gleam.mjs";
import { lustreKit } from "denext/gleam";

/** Lustre ${version}, as this app's Gleam build compiled it. */
export const lustre = lustreKit({
  version: ${JSON.stringify(version)},
  start,
  register,
  send,
  shutdown,
  is_browser,
  to_string,
  prerender,
  attribute,
  toList,
});
`;
}

/** `.denext/lustre-view.ts`: `defineLustreView`'s browser island, a `"use client"` module. */
function viewIsland(version: string): string {
  return `${HEADER}
"use client";
// Rewritten by every Gleam build. The browser island of this app's defineLustreView views.
import { Reconciler } from "@gleam/lustre/lustre/vdom/reconciler.ffi.mjs";
import { lustreViewIsland } from "denext/gleam";

/** Lustre ${version}'s reconciler, applying a server component's patches over denext Live. */
export const LustreView = lustreViewIsland(Reconciler);
`;
}

/** `.denext/lustre-server.ts`: what `defineLustreView` runs a server component with. */
function serverKit(version: string): string {
  return `${HEADER}
// Rewritten by every Gleam build (the gleam() plugin, \`denext add gleam:\`).
import { Runtime } from "@gleam/lustre/lustre/runtime/server/runtime.ffi.mjs";
import { configure_server_component } from "@gleam/lustre/lustre/runtime/app.mjs";
import {
  client_message_to_json,
  deregister_callback,
  register_callback,
  runtime_message_decoder,
} from "@gleam/lustre/lustre/server_component.mjs";
import { shutdown } from "@gleam/lustre/lustre.mjs";
import { to_string } from "@gleam/lustre/lustre/element.mjs";
import { run } from "@gleam/gleam_stdlib/gleam/dynamic/decode.mjs";
import { lustreServerKit } from "denext/gleam";
import { LustreView } from "./lustre-view.ts";

/** Lustre ${version}'s server-component runtime, as this app's Gleam build compiled it. */
export const lustreServer = lustreServerKit({
  version: ${JSON.stringify(version)},
  Runtime,
  configure_server_component,
  register_callback,
  deregister_callback,
  client_message_to_json,
  runtime_message_decoder,
  run,
  shutdown,
  to_string,
  island: LustreView,
});
`;
}

/**
 * Write (or remove) the app's Lustre kit modules after a Gleam build.
 *
 * @param root The app root (the kits go in its `.denext/`).
 * @param gleamDir The Gleam project directory.
 * @returns The Lustre version the kits were written for, or `null` when the project has none.
 */
export async function writeLustreKits(root: string, gleamDir: string): Promise<string | null> {
  const version = await lustreVersion(gleamDir);
  const dir = join(root, ".denext");
  for (const [name, kit] of Object.entries(KITS)) {
    const path = join(dir, name);
    const current = await Deno.readTextFile(path).catch(() => null);
    if (version === null) {
      if (current?.startsWith(HEADER)) await Deno.remove(path);
      continue;
    }
    const text = kit(version);
    if (current === text) continue;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, text);
  }
  return version;
}

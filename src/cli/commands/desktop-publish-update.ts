// `denext desktop publish-update`: pack a packaged desktop app into a full-app update archive and
// write (or extend) the signed manifest the pinned runtime's `Deno.desktop.updater` checks. See
// `src/build/app-update.ts` for the formats. Signing is mandatory: without `--key` (a PKCS#8 PEM
// from `denext ota keygen`) or `DENEXT_OTA_SIGNING_KEY`, nothing is written.

import { join, resolve } from "@std/path";
import type { CommandContext, FlagSpec } from "../command.ts";
import { loadOtaSigningKey, OTA_SIGNING_KEY_ENV } from "../../build/ota-signing.ts";
import { APP_UPDATE_MANIFEST_FILE, publishAppUpdate } from "../../build/app-update.ts";
import { resolveProject } from "../../build/paths.ts";

/** The flags `desktop publish-update` adds to the `desktop` verb. */
export const PUBLISH_UPDATE_FLAGS: FlagSpec[] = [
  {
    name: "artifact",
    type: "string",
    valueName: "<path>",
    help: "publish-update: the packaged app (.app, app directory or .AppImage)",
  },
  {
    name: "url-base",
    type: "string",
    valueName: "<url>",
    help: "publish-update: the https URL the archives will be served under",
  },
  {
    name: "app-version",
    type: "string",
    valueName: "<semver>",
    help: "publish-update: the version being published (default: deno.json version)",
  },
  {
    name: "app-id",
    type: "string",
    valueName: "<id>",
    help: "publish-update: the app identifier (default: desktop.app.identifier)",
  },
  {
    name: "platform",
    type: "string",
    valueName: "<key>",
    help:
      "publish-update: <rust-target>-<webview|cef>[-appimage] (default: detected for this host)",
  },
  {
    name: "min-version",
    type: "string",
    valueName: "<semver>",
    help: "publish-update: older versions are told the update is required",
  },
  {
    name: "notes",
    type: "string",
    valueName: "<text>",
    help: "publish-update: release notes",
  },
  {
    name: "key",
    type: "string",
    valueName: "<file>",
    help: `publish-update: the signing key PEM (default: ${OTA_SIGNING_KEY_ENV})`,
  },
  {
    name: "out",
    type: "string",
    valueName: "<dir>",
    help: "publish-update: where the archive and app-update.json go (default: dist/updates)",
  },
];

/** deno.json's (or deno.jsonc's) `version`, if any. */
async function denoJsonVersion(dir: string): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const { readJson } = await import("../../build/json-edit.ts");
      const v = (readJson(await Deno.readTextFile(join(dir, name))) as { version?: unknown } | null)
        ?.version;
      return typeof v === "string" ? v : undefined;
    } catch { /* not this one */ }
  }
  return undefined;
}

/**
 * Run `denext desktop publish-update` for the project at `dir`: any problem is printed and exits 1.
 *
 * @param ctx The parsed command line.
 * @param dir The project directory.
 */
export async function desktopPublishUpdate(ctx: CommandContext, dir: string): Promise<void> {
  try {
    await publishFromFlags(ctx.flags as Record<string, unknown>, dir);
  } catch (err) {
    console.error(`denext desktop publish-update: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

async function publishFromFlags(flags: Record<string, unknown>, dir: string): Promise<void> {
  const opt = (name: string): string | undefined =>
    typeof flags[name] === "string" && flags[name] !== "" ? flags[name] as string : undefined;
  const required = (value: string | undefined, hint: string): string => {
    if (value === undefined) throw new Error(hint);
    return value;
  };
  const artifact = required(opt("artifact"), "pass the packaged app with --artifact <path>");
  const urlBase = required(
    opt("url-base"),
    "pass where the archives will be served with --url-base <https url>",
  );
  const { config } = await resolveProject(dir);
  const app = required(
    opt("app-id") ?? config?.desktop?.app?.identifier,
    "no app identifier: set desktop.app.identifier or pass --app-id",
  );
  const version = required(
    opt("app-version") ?? await denoJsonVersion(dir),
    'no version: set deno.json "version" or pass --app-version',
  );
  const key = await loadOtaSigningKey(opt("key"));
  if (!key) {
    throw new Error(
      `a signing key is required (full-app updates are always signed): --key <pem> or ` +
        `${OTA_SIGNING_KEY_ENV}; make one with \`denext ota keygen\``,
    );
  }
  const r = await publishAppUpdate({
    artifact: resolve(dir, artifact),
    app,
    version,
    urlBase,
    outDir: resolve(dir, opt("out") ?? join("dist", "updates")),
    key,
    platform: opt("platform"),
    minVersion: opt("min-version"),
    releaseNotes: opt("notes"),
  });
  console.log(
    `\n  denext desktop — published ${app} ${version} for ${r.platform}\n` +
      `    archive   ${r.archive} (${r.size} bytes, sha256 ${r.sha256})\n` +
      `    manifest  ${r.manifest} (signed; platforms: ${r.platforms.join(", ")})\n\n` +
      `  Upload both, then point desktop.update.manifestUrl at ${APP_UPDATE_MANIFEST_FILE}.\n`,
  );
}

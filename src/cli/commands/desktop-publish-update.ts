// `denext desktop publish-update`: pack a packaged desktop app into a full-app update archive and
// write (or extend) the signed manifest the pinned runtime's `Deno.desktop.updater` checks. See
// `src/build/app-update.ts` for the formats. Signing is mandatory: without `--key` (a PKCS#8 PEM
// from `denext ota keygen`) or `DENEXT_OTA_SIGNING_KEY`, nothing is written. The artifact must have
// been built as the version published (`version_mismatch` otherwise). A macOS `.app` that
// Gatekeeper does not accept as notarized is published with a warning: installed apps refuse it.
// Every manifest expires (`--expires-in`, default 30 days): `--resign` re-signs the published one
// with a fresh expiry, without the artifact, and must run before it passes.

import { join, resolve } from "@std/path";
import type { CommandContext, FlagSpec } from "../command.ts";
import { loadOtaSigningKey, OTA_SIGNING_KEY_ENV } from "../../build/ota-signing.ts";
import {
  APP_UPDATE_DEFAULT_EXPIRY_DAYS,
  APP_UPDATE_MANIFEST_FILE,
  appUpdateExpiryWarning,
  type AppUpdateFreshnessOptions,
  macNotarizationWarning,
  publishAppUpdate,
  resignAppUpdate,
} from "../../build/app-update.ts";
import { desktopAppVersion } from "../../build/desktop-installers.ts";
import { resolveProject } from "../../build/paths.ts";

/** The flags `desktop publish-update` adds to the `desktop` verb. */
export const PUBLISH_UPDATE_FLAGS: FlagSpec[] = [
  {
    name: "artifact",
    type: "string",
    valueName: "<path>",
    help:
      "publish-update: the packaged app (.app, app directory or .AppImage); a macOS .app must be notarized",
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
    help:
      "publish-update: the version being published (default: deno.json version, else package.json's)",
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
  {
    name: "expires-in",
    type: "string",
    valueName: "<days>",
    help:
      `publish-update: days until installed apps refuse the manifest (default ${APP_UPDATE_DEFAULT_EXPIRY_DAYS}); re-sign before`,
  },
  {
    name: "expires-at",
    type: "string",
    valueName: "<rfc3339>",
    help: "publish-update: an explicit expiry time instead of --expires-in",
  },
  {
    name: "sequence",
    type: "string",
    valueName: "<n>",
    help:
      "publish-update: the release counter (default: Unix seconds, never below the existing manifest's)",
  },
  {
    name: "resign",
    type: "boolean",
    help:
      "publish-update: re-sign the existing app-update.json in --out with a fresh expiry (no artifact)",
  },
];

/** The freshness flags (`--expires-in`, `--expires-at`, `--sequence`) as publisher options. */
function freshnessFromFlags(
  opt: (name: string) => string | undefined,
): AppUpdateFreshnessOptions {
  const number = (name: string): number | undefined => {
    const raw = opt(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const expiresInDays = number("expires-in");
  const sequence = number("sequence");
  const expiresAt = opt("expires-at");
  return {
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  };
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
  const fresh = freshnessFromFlags(opt);
  const outDir = resolve(dir, opt("out") ?? join("dist", "updates"));
  if (flags.resign === true) {
    return await resign(join(outDir, APP_UPDATE_MANIFEST_FILE), fresh, opt("key"));
  }
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
    opt("app-version") ?? await desktopAppVersion(dir),
    'no version: set deno.json (or package.json) "version" or pass --app-version',
  );
  const key = await requireKey(opt("key"));
  const r = await publishAppUpdate({
    artifact: resolve(dir, artifact),
    app,
    version,
    urlBase,
    outDir,
    key,
    platform: opt("platform"),
    minVersion: opt("min-version"),
    releaseNotes: opt("notes"),
    ...fresh,
  });
  const notarization = await macNotarizationWarning(resolve(dir, artifact));
  const expiring = r.previousExpiresAt ? appUpdateExpiryWarning(r.previousExpiresAt) : null;
  for (const warning of [notarization, expiring]) {
    if (warning) console.error(`denext desktop publish-update: warning: ${warning}`);
  }
  console.log(
    `\n  denext desktop — published ${app} ${version} for ${r.platform}\n` +
      `    archive   ${r.archive} (${r.size} bytes, sha256 ${r.sha256})\n` +
      `    manifest  ${r.manifest} (signed; platforms: ${r.platforms.join(", ")})\n` +
      `    sequence  ${r.sequence}; expires ${r.expiresAt}\n\n` +
      `  Upload both, then point desktop.update.manifestUrl at ${APP_UPDATE_MANIFEST_FILE}.\n` +
      `  Installed apps refuse the manifest from ${r.expiresAt} on: re-sign it before then with\n` +
      `  \`denext desktop publish-update --resign\` and upload the new ${APP_UPDATE_MANIFEST_FILE}.\n`,
  );
}

/** The signing key from `--key` or the env, else the error that nothing unsigned is written. */
async function requireKey(path: string | undefined): Promise<CryptoKey> {
  const key = await loadOtaSigningKey(path);
  if (!key) {
    throw new Error(
      `a signing key is required (full-app updates are always signed): --key <pem> or ` +
        `${OTA_SIGNING_KEY_ENV}; make one with \`denext ota keygen\``,
    );
  }
  return key;
}

/** `--resign`: a fresh expiry (and a sequence at least the manifest's) for the published one. */
async function resign(
  manifest: string,
  fresh: AppUpdateFreshnessOptions,
  keyPath: string | undefined,
): Promise<void> {
  const key = await requireKey(keyPath);
  const r = await resignAppUpdate({ manifest, key, ...fresh });
  console.log(
    `\n  denext desktop — re-signed ${r.app} ${r.version}\n` +
      `    manifest  ${manifest} (sequence ${r.sequence}; expires ${r.expiresAt})\n\n` +
      `  Upload it in place of the served ${APP_UPDATE_MANIFEST_FILE}.\n`,
  );
}

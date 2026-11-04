// The app id a signed OTA manifest names (`appId`, signed by `appSignature`, payload v5): the
// shell that installs the release must be that app, so a feed for one app cannot serve another
// app that shares the signing key. `spa.ota` (and so `denext mobile build` and the desktop
// packaging scripts, which export through it) and `denext ota manifest --sign` stamp it.
//
// Only a SIGNED manifest gets one automatically: an unsigned (pinned-origin) release keeps the
// shape it always had, and an `appId` needs a `sequence`, which an unsigned export never had.

import { capacitorIdentity } from "./mobile-flavor.ts";
import { isOtaAppId } from "../mobile/ota-manifest.ts";

/**
 * The env var naming the app id outright: `denext mobile build` sets it on its export step (the
 * flavor's id, which the Capacitor config only gets after the export), and CI may set it too.
 */
export const OTA_APP_ID_ENV = "DENEXT_OTA_APP_ID";

/** `desktop.app.identifier` of an untyped config, when it is a valid manifest app id. */
function desktopIdentifier(config: unknown): string | undefined {
  const desktop = (config as { desktop?: { app?: { identifier?: unknown } } } | null | undefined)
    ?.desktop;
  const id = desktop?.app?.identifier;
  return isOtaAppId(id) ? id : undefined;
}

/** The Capacitor `appId` of the project at `dir`, when there is a config naming a valid one. */
async function capacitorAppId(dir: string): Promise<string | undefined> {
  try {
    const { appId } = await capacitorIdentity(dir);
    return isOtaAppId(appId) ? appId : undefined;
  } catch {
    return undefined;
  }
}

/** The {@linkcode OTA_APP_ID_ENV} value, or undefined (unset, or no env permission). */
function envAppId(): string | undefined {
  try {
    return Deno.env.get(OTA_APP_ID_ENV)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The app id a signed manifest for an export of `platform` names, or undefined when none is known:
 *
 * - {@linkcode OTA_APP_ID_ENV}, when set (it must be a valid app id);
 * - an `ios` / `android` export: the Capacitor `appId` of the project at `projectDir`;
 * - a `macos` / `windows` / `linux` export, or an unstamped one (`web`, which only a Deno Desktop
 *   overlay takes signed: an app binary with a public key takes only its own platform's export):
 *   `desktop.app.identifier` from `config`, when given.
 *
 * @param projectDir The project whose Capacitor config names the mobile app id.
 * @param platform The export's target (`null` or `web`: unstamped).
 * @param config The loaded project config, for `desktop.app.identifier` (omit when not loaded).
 * @throws RangeError when {@linkcode OTA_APP_ID_ENV} is set to an invalid app id.
 */
export async function otaAppIdFor(
  projectDir: string,
  platform: string | null,
  config?: unknown,
): Promise<string | undefined> {
  const fromEnv = envAppId();
  if (fromEnv !== undefined) {
    if (!isOtaAppId(fromEnv)) {
      throw new RangeError(
        `${OTA_APP_ID_ENV} must be 1–255 characters of A-Z a-z 0-9 . _ -, not ${
          JSON.stringify(fromEnv)
        }`,
      );
    }
    return fromEnv;
  }
  if (platform === "ios" || platform === "android") return await capacitorAppId(projectDir);
  return desktopIdentifier(config);
}

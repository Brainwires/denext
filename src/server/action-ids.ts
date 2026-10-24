// Salted Server Action ids: an action's wire id is an HMAC of its `module#export` under a secret
// the browser never sees, so an id can't be computed from an app's (often public) source.
//
// The secret, in order:
// - `DENEXT_ACTION_ID_SECRET` when set (at least 16 characters): every build and every instance
//   that serves one app must share it, so set it when one deploy builds more than once (one image
//   per replica, a build per region);
// - else the secret `denext build` generated (a new one per build, recorded in the server-only
//   `manifest.json` as `actionIdSecret`), so the replicas serving one build agree and the next
//   build's ids are new;
// - else one random secret per process (`denext dev`, a server with no build), which mints the
//   client stubs, the inline actions and the registry alike.
// A build from before salted ids recorded none: its server keeps the legacy unsalted ids its
// client bundle carries ({@linkcode setLegacyActionIds}).
//
// The build process installs this module's minter through the modules that mint ids
// (src/build/client-imports.ts, src/build/inline-server-action.ts); the server through
// ./action-bound.ts.

import { createHmac, randomBytes } from "node:crypto";
import { encodeBase64Url } from "@std/encoding/base64url";
import { envGet } from "../runtime/env-safe.ts";
import { processShared } from "../runtime/process-shared.ts";
import { setActionIdMinter } from "../runtime/server-action.ts";

/** The environment variable that sets the action-id secret for every build and instance. */
export const ACTION_ID_SECRET_ENV = "DENEXT_ACTION_ID_SECRET";

/** The shortest secret the environment may set. */
const MIN_SECRET_LENGTH = 16;
/** Base64url characters kept from the HMAC: 27 × 6 = 162 bits. */
const ID_CHARS = 27;

const state = /* @__PURE__ */ processShared("actionIdSecret", () => ({
  build: null as string | null,
  legacy: false,
  process: null as string | null,
}));

/** A fresh random secret, base64url (what `denext build` records). */
export function generateActionIdSecret(): string {
  return encodeBase64Url(randomBytes(32));
}

/**
 * Install the secret `denext build` generated (`manifest.json`'s `actionIdSecret`), used when the
 * environment sets none. `null` forgets it (tests, or a build process starting over).
 *
 * @param secret The secret; null to clear.
 */
export function setBuildActionIdSecret(secret: string | null): void {
  state.build = secret;
  state.legacy = false;
}

/**
 * Serve the legacy unsalted ids: a build from before salted ids recorded no secret, and its
 * client bundle carries the old ids. The environment's secret still wins.
 *
 * @param on True for such a build; false to go back to the per-process secret.
 */
export function setLegacyActionIds(on: boolean): void {
  state.legacy = on;
  if (on) state.build = null;
}

/** Whether `DENEXT_ACTION_ID_SECRET` is set (the build records no secret then). */
export function actionIdSecretFromEnv(): boolean {
  return !!envGet(ACTION_ID_SECRET_ENV)?.trim();
}

/** The secret ids are minted under (see the module comment), or null for the legacy ids. */
function actionIdSecret(): string | null {
  const env = envGet(ACTION_ID_SECRET_ENV)?.trim();
  if (env) {
    if (env.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `denext: ${ACTION_ID_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters; ` +
          "generate one with `openssl rand -base64 32`",
      );
    }
    return env;
  }
  if (state.build) return state.build;
  if (state.legacy) return null;
  return state.process ??= generateActionIdSecret();
}

/**
 * The salted id for a `module#export` key, or null for the legacy id.
 *
 * @param key The action's `module#export` key.
 */
function mintActionId(key: string): string | null {
  const secret = actionIdSecret();
  if (secret === null) return null;
  const mac = createHmac("sha256", secret).update(`denext-action-id:${key}`).digest();
  return `a${encodeBase64Url(mac).slice(0, ID_CHARS)}`;
}

setActionIdMinter(mintActionId);

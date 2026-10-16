// denext.config validation — pure (types only, no build/IO deps) so both the
// server-side `defineConfig` authoring helper and the build-time config loader can
// share one source of truth. `validateDenextConfig` throws a field-scoped error on a
// bad *value*; `warnUnknownConfigKeys` warns (never throws) on an unrecognized *key*,
// with a "did you mean" suggestion — a typo like `basepath` would otherwise be
// silently dropped by the loader's field whitelist.
//
// The field-group validators live in `./config-validate/` (one module per config area); this
// module is the stable import path and runs them in order.

import type { DenextConfig } from "./config.ts";
import type { Fail } from "./config-validate/shared.ts";
import { validateDesktop } from "./config-validate/desktop.ts";
import { validateAllowedDevOrigins } from "./config-validate/dev-origins.ts";
import {
  validateLists,
  validateMobile,
  validateMomentumSafeScroll,
  validatePlatformExtensions,
  validateReactNative,
  validateResolveAlias,
} from "./config-validate/mobile.ts";
import {
  validateCommands,
  validateCompile,
  validateDeploy,
  validateNestedRequired,
} from "./config-validate/project.ts";
import {
  validateCacheAndEnv,
  validateImageAllowlists,
  validateImageNumerics,
  validateJobs,
  validateRouting,
  validateSecurity,
} from "./config-validate/server.ts";
import {
  validateMode,
  validateProxy,
  validateSpaAssetsDir,
  validateSpaOta,
  validateSpaShell,
  validateSpaTanstackRouter,
  validateSpaViteManifest,
} from "./config-validate/spa.ts";

export {
  didYouMean,
  KNOWN_CONFIG_KEYS,
  validateRemovedConfigKeys,
  warnUnknownConfigKeys,
} from "./config-validate/keys.ts";
export { normalizeSpaAssetsDir } from "./config-validate/spa.ts";
export { devOriginError } from "./config-validate/dev-origins.ts";

// --- Value validation ------------------------------------------------------------
// Split into small field-group validators (mode/spa, routing, images, security, cache)
// so each stays readable and independently testable — validation of a 20-field config
// object is inherently branchy, but no single function has to carry all of it.

/** Validate a loaded `denext.config`, throwing a field-scoped error on a bad value. */
export function validateDenextConfig(config: DenextConfig, name = "denext.config"): void {
  const fail: Fail = (field, msg) => {
    throw new Error(`invalid ${name}: \`${field}\` ${msg}`);
  };
  validateMode(config, fail);
  validateProxy(config.spa?.proxy, fail);
  validateSpaOta(config.spa?.ota, fail);
  validateSpaViteManifest(config.spa?.viteManifest, fail);
  validateSpaTanstackRouter(config.spa?.tanstackRouter, fail);
  validateSpaAssetsDir(config.spa?.assetsDir, fail);
  validateSpaShell(config.spa, fail);
  validateMomentumSafeScroll(config.momentumSafeScroll, fail);
  validateLists(config.lists, fail);
  validatePlatformExtensions(config.platformExtensions, fail);
  validateResolveAlias(config.resolveAlias, fail);
  validateMobile(config.mobile, fail);
  validateDesktop(config.desktop, config.spa?.proxy, fail);
  validateAllowedDevOrigins(config.allowedDevOrigins, fail);
  validateReactNative(config, fail);
  validateRouting(config, fail);
  validateImageAllowlists(config.images, fail);
  validateImageNumerics(config.images, fail);
  validateSecurity(config, fail);
  validateCacheAndEnv(config, fail);
  validateJobs(config.jobs, fail);
  validateCommands(config.commands, fail);
  validateCompile(config.compile, fail);
  validateDeploy(config.deploy, fail);
  validateNestedRequired(config, fail);
}

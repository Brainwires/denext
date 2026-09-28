// Drift guard: the `desktop.capabilities` keys the config types know
// (DESKTOP_ADD_CAPABILITY_KEYS in src/desktop/config-types.ts) must equal the capability keys
// `denext desktop add` writes (the `.key` of each entry in the DESKTOP_CAPABILITIES catalog). If
// the catalog gains or renames a capability, this fails until config-types.ts is updated too, so
// the user-facing config type and the add catalog cannot drift apart silently.

import { assertEquals } from "@std/assert";
import { DESKTOP_ADD_CAPABILITY_KEYS } from "../src/desktop/config-types.ts";
import { DESKTOP_CAPABILITIES } from "../src/build/desktop-capabilities.ts";

Deno.test("config-types capability keys match the `desktop add` catalog", () => {
  const catalogKeys = [...new Set(Object.values(DESKTOP_CAPABILITIES).map((c) => c.key))].sort();
  const configKeys = [...DESKTOP_ADD_CAPABILITY_KEYS].sort();
  assertEquals(
    configKeys,
    catalogKeys,
    "DESKTOP_ADD_CAPABILITY_KEYS (config-types.ts) is out of sync with the DESKTOP_CAPABILITIES " +
      "catalog (desktop-capabilities.ts) — update config-types.ts's key list AND its " +
      "DesktopCapabilitiesConfig interface to match.",
  );
});

// `desktop.permissions: "strict"` (src/desktop/permissions-mode.ts, src/build/desktop-capabilities.ts):
// on a runtime that expands $DENO_DESKTOP_DATA / $DENO_DESKTOP_CACHE, an app with
// desktop.app.identifier is baked --allow-read scoped to its folders and declared reads, and
// --allow-env scoped to the variables denext's desktop runtime reads plus the declared ones.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  DESKTOP_CACHE_TOKEN,
  DESKTOP_DATA_TOKEN,
  desktopBuildFlags,
  strictPermissionsNotice,
} from "../src/build/desktop-capabilities.ts";
import { DESKTOP_RUNTIME_ENV } from "../src/build/desktop-runtime-env.ts";
import {
  desktopPermissionsMode,
  desktopPermissionsProblem,
  strictPermissionsSidecarError,
} from "../src/desktop/permissions-mode.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const ID = "com.example.app";
const SCOPE = { dataScope: true, cacheScope: true } as const;

/** A config with `desktop.permissions` and more `desktop` keys. */
function app(
  permissions: unknown,
  more: Record<string, unknown> = {},
  identifier: string | null = ID,
) {
  return {
    desktop: {
      ...(identifier !== null ? { app: { identifier } } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...more,
    },
  };
}

const flagOf = (flags: string[], kind: string) =>
  flags.filter((f) => f === `--allow-${kind}` || f.startsWith(`--allow-${kind}=`));

Deno.test("strict: --allow-read is the app's folders and --allow-env the runtime's variables", () => {
  const flags = desktopBuildFlags(app("strict"), "darwin", SCOPE);
  assertEquals(flagOf(flags, "read"), [
    `--allow-read=${DESKTOP_CACHE_TOKEN},${DESKTOP_DATA_TOKEN}`,
  ]);
  assertEquals(flagOf(flags, "env"), [`--allow-env=${DESKTOP_RUNTIME_ENV.join(",")}`]);
  // The rest is what the default mode bakes.
  const plain = desktopBuildFlags(app(undefined), "darwin", SCOPE);
  assertEquals(
    flags.filter((f) => !/^--allow-(read|env)/.test(f)),
    plain.filter((f) => !/^--allow-(read|env)/.test(f)),
  );
  assertEquals(flagOf(plain, "read"), ["--allow-read"]);
  assertEquals(flagOf(plain, "env"), ["--allow-env"]);
});

Deno.test("strict: the app's declared reads and variables join the lists", () => {
  const flags = desktopBuildFlags(
    app({ mode: "strict", env: ["DATABASE_URL", "PORT"] }, {
      capabilities: { fs: { read: ["$APPDATA", "$CACHE"], write: ["$APPDATA"] } },
      extraPermissions: { read: ["/opt/models", "$APPDATA/imports"], env: ["API_KEY"] },
      sidecars: [{ name: "api", run: { module: "./api.ts" }, permissions: { env: ["API_TOKEN"] } }],
    }),
    "linux",
    SCOPE,
  );
  assertEquals(flagOf(flags, "read"), [
    `--allow-read=${DESKTOP_CACHE_TOKEN},${DESKTOP_DATA_TOKEN},${DESKTOP_DATA_TOKEN}/imports,/opt/models`,
  ]);
  const env = flagOf(flags, "env")[0].slice("--allow-env=".length).split(",");
  for (const name of ["DATABASE_URL", "API_KEY", "API_TOKEN", "HOME", "PORT"]) {
    assert(env.includes(name), name);
  }
  assertEquals(env, [...new Set(env)].sort());
});

Deno.test('strict: a read with no token, or an env entry of "*", keeps that grant unscoped', () => {
  for (
    const more of [
      { capabilities: { dialogs: true } },
      { capabilities: { fs: { read: ["$APPDATA", "$DOCUMENTS"], write: ["$APPDATA"] } } },
      { extraPermissions: { read: ["*"] } },
    ]
  ) {
    assertEquals(flagOf(desktopBuildFlags(app("strict", more), "linux", SCOPE), "read"), [
      "--allow-read",
    ]);
  }
  const env = desktopBuildFlags(
    app("strict", { extraPermissions: { env: ["*"] } }),
    "linux",
    SCOPE,
  );
  assertEquals(flagOf(env, "env"), ["--allow-env"]);
});

Deno.test("strict: an older runtime or no identifier bakes the default, with a notice", () => {
  for (
    const [config, options] of [
      [app("strict"), { dataScope: false }],
      [app("strict", {}, null), SCOPE],
    ] as const
  ) {
    const flags = desktopBuildFlags(config, "linux", options);
    assertEquals(flagOf(flags, "read"), ["--allow-read"]);
    assertEquals(flagOf(flags, "env"), ["--allow-env"]);
    assertStringIncludes(strictPermissionsNotice(config, options) ?? "", "3.0.0-denext.8");
  }
  assertEquals(strictPermissionsNotice(app("strict"), SCOPE), null);
  assertEquals(strictPermissionsNotice(app("default"), { dataScope: false }), null);
  assertEquals(strictPermissionsNotice(undefined), null);
});

Deno.test("strict: a sidecar that hands its child the whole environment is refused", () => {
  for (
    const sidecar of [
      { name: "srv", run: { exec: "./bin/srv" } },
      { name: "agent", run: { module: "./agent.ts" }, loginShellEnv: true },
    ]
  ) {
    const config = app("strict", { sidecars: [sidecar] });
    assertThrows(() => desktopBuildFlags(config, "linux", SCOPE), Error, sidecar.name);
    assertThrows(
      () => validateDenextConfig(config as DenextConfig),
      Error,
      "desktop.permissions",
    );
    // The default mode takes them.
    desktopBuildFlags(app("default", { sidecars: [sidecar] }), "linux", SCOPE);
  }
  assertEquals(strictPermissionsSidecarError(undefined), null);
  assertEquals(strictPermissionsSidecarError([null, { name: "a", loginShellEnv: false }]), null);
});

Deno.test("desktop.permissions: the shapes the validator and the package scripts take", () => {
  for (
    const ok of [undefined, "default", "strict", { mode: "strict" }, { mode: "default", env: [] }]
  ) {
    assertEquals(desktopPermissionsProblem(ok), null, JSON.stringify(ok));
  }
  const bad: [unknown, string][] = [
    ["loose", "permissions"],
    [["strict"], "permissions"],
    [{ mode: "strict", extra: 1 }, "permissions.extra"],
    [{ env: [] }, "permissions.mode"],
    [{ mode: "strict", env: "A" }, "permissions.env"],
    [{ mode: "strict", env: ["A,B"] }, "permissions.env"],
    [{ mode: "strict", env: [1] }, "permissions.env"],
  ];
  for (const [value, field] of bad) {
    assertEquals(desktopPermissionsProblem(value)?.[0], field, JSON.stringify(value));
    assertThrows(() => desktopBuildFlags(app(value), "linux", SCOPE), Error, `desktop.${field}`);
    assertThrows(
      () => validateDenextConfig(app(value) as DenextConfig),
      Error,
      `desktop.${field}`,
    );
  }
  assertEquals(desktopPermissionsMode("strict"), { strict: true, env: [] });
  assertEquals(desktopPermissionsMode({ mode: "strict", env: ["A"] }), {
    strict: true,
    env: ["A"],
  });
  assertEquals(desktopPermissionsMode({ mode: "default", env: ["A"] }), {
    strict: false,
    env: ["A"],
  });
  assertEquals(desktopPermissionsMode("loose"), { strict: false, env: [] });
  assertEquals(desktopPermissionsMode(undefined), { strict: false, env: [] });
});

Deno.test("desktop.permissions: strict needs desktop.app.identifier in the config", () => {
  validateDenextConfig(app("strict") as DenextConfig);
  validateDenextConfig(app({ mode: "default" }, {}, null) as DenextConfig);
  assertThrows(
    () => validateDenextConfig(app("strict", {}, null) as DenextConfig),
    Error,
    "desktop.app.identifier",
  );
});

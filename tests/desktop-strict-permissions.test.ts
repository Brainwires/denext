// `desktop.permissions: "strict"` (src/desktop/permissions-mode.ts, src/build/desktop-capabilities.ts):
// on a runtime that expands $DENO_DESKTOP_DATA / $DENO_DESKTOP_CACHE, an app with
// desktop.app.identifier is baked --allow-read scoped to its folders and declared reads, and
// --allow-env scoped to the variables denext's desktop runtime reads (never a credential or signing
// name) plus the declared ones. Strict mode never falls back to the unscoped grants: a packaging
// build that cannot honour it, or a read / env entry it cannot scope, fails.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  DESKTOP_CACHE_TOKEN,
  DESKTOP_DATA_TOKEN,
  desktopBuildFlags,
  desktopPackageFlags,
  DesktopStrictPermissionsError,
  strictPermissionsProblem,
} from "../src/build/desktop-capabilities.ts";
import { runDesktopPackageMain } from "../src/build/desktop-package-script.ts";
import {
  LINUX_PACKAGE_SCRIPT,
  MACOS_PACKAGE_SCRIPT,
  WINDOWS_PACKAGE_SCRIPT,
} from "../src/build/desktop-package-scripts.ts";
import { desktopDataTokenRuntimeProblem } from "../src/build/desktop-launch-policy.ts";
import {
  DESKTOP_RUNTIME_ENV,
  DESKTOP_STRICT_RUNTIME_ENV,
  isCredentialEnvName,
} from "../src/build/desktop-runtime-env.ts";
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
  assertEquals(flagOf(flags, "env"), [`--allow-env=${DESKTOP_STRICT_RUNTIME_ENV.join(",")}`]);
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

/** The credential and signing variables the packaging helpers read and a packaged app never does. */
const CREDENTIALS = [
  "DENEXT_WINDOWS_CERT",
  "DENEXT_WINDOWS_CERT_PASSWORD",
  "DENEXT_WINDOWS_CERT_THUMBPRINT",
  "DENEXT_OTA_SIGNING_KEY",
  "DENEXT_NOTARY_KEY",
  "DENEXT_NOTARY_KEY_ID",
  "DENEXT_NOTARY_ISSUER",
  "DENEXT_NOTARY_PROFILE",
  "DENEXT_CODESIGN_IDENTITY",
  "DENEXT_SIGN_TIMESTAMP_URL",
];

Deno.test("strict: --allow-env never names a credential or signing variable denext reads", () => {
  const env = flagOf(desktopBuildFlags(app("strict"), "windows", SCOPE), "env")[0]
    .slice("--allow-env=".length).split(",");
  for (const name of CREDENTIALS) assert(!env.includes(name), name);
  const shaped = env.filter((n) =>
    /_(TOKEN|SECRET|PASSWORD|KEY|KEY_ID|CERT)$|CERT_|NOTARY/.test(n)
  );
  // The runtime's own per-launch worker token is the one credential-shaped name it must read.
  assertEquals(shaped, ["DENO_DESKTOP_WORKER_TOKEN"]);
  // The inventory still lists them (the packaging helpers read them); only strict drops them.
  for (const name of CREDENTIALS) assert(DESKTOP_RUNTIME_ENV.includes(name), name);
  for (const name of ["HOME", "PATH", "APPDATA", "DENO_DESKTOP_WS_URL"]) {
    assert(env.includes(name), name);
  }
  assert(isCredentialEnvName("SESSION_SECRET") && isCredentialEnvName("GITHUB_TOKEN"));
  assert(isCredentialEnvName("api_key") && !isCredentialEnvName("DENO_DESKTOP_WORKER_TOKEN"));
  assert(!isCredentialEnvName("DENEXT_REVOCATION_KEYS_FILE") && !isCredentialEnvName("HOME"));
  // A credential the app declares itself is the app's choice, and is kept.
  const declared = flagOf(
    desktopBuildFlags(app({ mode: "strict", env: ["SESSION_SECRET"] }), "linux", SCOPE),
    "env",
  )[0];
  assertStringIncludes(declared, "SESSION_SECRET");
});

Deno.test('strict: a read with no token, or an env entry of "*", fails the build, naming it', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ capabilities: { dialogs: true } }, "desktop.capabilities.dialogs"],
    [
      { capabilities: { fs: { read: ["$APPDATA", "$DOCUMENTS"], write: ["$APPDATA"] } } },
      '"$DOCUMENTS"',
    ],
    [{ extraPermissions: { read: ["*"] } }, "desktop.extraPermissions.read"],
    [{ extraPermissions: { read: ["data/models"] } }, '"data/models"'],
    [{ extraPermissions: { read: ["/opt/x/../etc"] } }, '"/opt/x/../etc"'],
  ];
  for (const [more, named] of cases) {
    assertThrows(
      () => desktopBuildFlags(app("strict", more), "linux", SCOPE),
      Error,
      named,
    );
    // The default mode takes them.
    desktopBuildFlags(app("default", more), "linux", SCOPE);
  }
  assertThrows(
    () => desktopBuildFlags(app("strict", { extraPermissions: { env: ["*"] } }), "linux", SCOPE),
    Error,
    'desktop.extraPermissions.env (or a sidecar\'s permissions.env) has "*"',
  );
  const sidecar = { name: "api", run: { module: "./api.ts" }, permissions: { env: ["*"] } };
  assertThrows(
    () => desktopBuildFlags(app("strict", { sidecars: [sidecar] }), "linux", SCOPE),
    Error,
    "--allow-env",
  );
});

Deno.test("strict: an older runtime or no identifier fails the build, naming the reason and the fix", () => {
  assertThrows(
    () => desktopBuildFlags(app("strict"), "linux", { dataScope: false }),
    Error,
    "3.0.0-denext.8",
  );
  assertThrows(
    () => desktopBuildFlags(app("strict", {}, null), "linux", SCOPE),
    Error,
    "Set desktop.app.identifier",
  );
  for (
    const [config, options, why] of [
      [app("strict"), { dataScope: false }, "3.0.0-denext.8"],
      [app("strict", {}, null), SCOPE, "desktop.app.identifier is not set"],
    ] as const
  ) {
    assertStringIncludes(strictPermissionsProblem(config, options) ?? "", why);
    assertStringIncludes(strictPermissionsProblem(config, options) ?? "", 'permissions: "default"');
    // `denext desktop run` / `dev` only: the default grants (and a warning from the caller).
    const flags = desktopBuildFlags(config, "linux", { ...options, strictFallback: true });
    assertEquals(flagOf(flags, "read"), ["--allow-read"]);
    assertEquals(flagOf(flags, "env"), ["--allow-env"]);
  }
  assertEquals(strictPermissionsProblem(app("strict"), SCOPE), null);
  assertEquals(strictPermissionsProblem(app("default"), { dataScope: false }), null);
  assertEquals(strictPermissionsProblem(undefined), null);
});

Deno.test("strict: why the runtime can't expand the folder tokens, with the fix", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(desktopDataTokenRuntimeProblem(env({}), "3.0.0-denext.8"), null);
  assertEquals(desktopDataTokenRuntimeProblem(env({}), "3.0.0-denext.9"), null);
  assertStringIncludes(
    desktopDataTokenRuntimeProblem(env({}), "3.0.0-denext.7") ?? "",
    "is 3.0.0-denext.7",
  );
  assertStringIncludes(
    desktopDataTokenRuntimeProblem(env({ DENEXT_DESKTOP_RUNTIME: " Stock " }), "3.0.0-denext.8") ??
      "",
    "Unset DENEXT_DESKTOP_RUNTIME",
  );
  assertStringIncludes(
    desktopDataTokenRuntimeProblem(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/rt" }), "3.0.0-denext.8") ??
      "",
    "Unset DENEXT_DESKTOP_RUNTIME_DIR",
  );
});

Deno.test("strict: a package script without desktop.app.identifier fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_strict_pkg_" });
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { desktop: { permissions: "strict" } };\n',
    );
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    await assertRejects(
      () => desktopPackageFlags(entry, "linux", false),
      Error,
      "desktop.app.identifier is not set",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("strict: a refusal is a DesktopStrictPermissionsError, whatever the entry", () => {
  for (
    const config of [
      app("strict", {}, null),
      app("strict", { extraPermissions: { read: ["*"] } }),
      app("strict", { extraPermissions: { env: ["*"] } }),
    ]
  ) {
    assertThrows(() => desktopBuildFlags(config, "linux", SCOPE), DesktopStrictPermissionsError);
  }
});

Deno.test("strict: a package script prints the refusal as one line and exits 1; other errors keep their stack", async () => {
  const realExit = Deno.exit;
  const realError = console.error;
  const lines: unknown[] = [];
  let code: number | undefined;
  console.error = (...a: unknown[]) => void lines.push(...a);
  Deno.exit = ((c?: number) => {
    code = c;
    throw new Error("exit");
  }) as typeof Deno.exit;
  try {
    await assertRejects(
      () =>
        runDesktopPackageMain(() => {
          throw new DesktopStrictPermissionsError("denext: strict refused");
        }),
      Error,
      "exit",
    );
    assertEquals(lines, ["denext: strict refused"]);
    assertEquals(code, 1);
    await assertRejects(
      () =>
        runDesktopPackageMain(() => {
          throw new TypeError("boom");
        }),
      TypeError,
      "boom",
    );
    assertEquals(lines.length, 1);
  } finally {
    Deno.exit = realExit;
    console.error = realError;
  }
});

Deno.test("strict: every package script template runs main through runDesktopPackageMain", () => {
  for (const text of [MACOS_PACKAGE_SCRIPT, LINUX_PACKAGE_SCRIPT, WINDOWS_PACKAGE_SCRIPT]) {
    assertStringIncludes(text, "if (import.meta.main) await runDesktopPackageMain(main);");
    assertStringIncludes(text, "  runDesktopPackageMain,\n");
  }
});

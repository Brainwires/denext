// `desktop.macos` for scripts/package-macos.ts: the provisioning profile is checked against the app
// (App ID, team, platform, expiry, and every restricted entitlement it must grant) before the build,
// and the entitlements the app is signed with are the config's merged over `DENEXT_ENTITLEMENTS`,
// plus the App ID and team entitlements macOS matches the embedded profile by. The profile's CMS
// envelope is decoded by `security` on macOS; these tests hand the decoded XML in directly.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  desktopMacosSigning,
  identityTeamId,
  isRestrictedEntitlement,
  mergeEntitlements,
  parseProvisioningProfile,
  provisioningProfileProblems,
} from "../src/build/desktop-macos-signing.ts";
import { dictGet, parsePlist, type PlistDict, renderPlist } from "../src/build/plist-value.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const TEAM = "ABCDE12345";
const IDENTITY = `Developer ID Application: Test Person (${TEAM})`;

/** A decoded Developer ID profile, shaped like the one the Apple developer portal issues. */
function profileXml(opts: {
  appId?: string;
  team?: string;
  platform?: string;
  expires?: string;
  entitlements?: string;
} = {}): string {
  const team = opts.team ?? TEAM;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>test app</string>
	<key>CreationDate</key>
	<date>2026-01-01T00:00:00Z</date>
	<key>Platform</key>
	<array>
		<string>${opts.platform ?? "OSX"}</string>
	</array>
	<key>DeveloperCertificates</key>
	<array>
		<data>
		MIIFAKE=
		</data>
	</array>
	<key>Entitlements</key>
	<dict>
		<key>com.apple.developer.associated-domains</key>
		<string>*</string>
		<key>com.apple.application-identifier</key>
		<string>${opts.appId ?? `${team}.com.example.app`}</string>
		<key>keychain-access-groups</key>
		<array>
			<string>${team}.*</string>
		</array>
		<key>com.apple.developer.team-identifier</key>
		<string>${team}</string>
		${opts.entitlements ?? ""}
	</dict>
	<key>ExpirationDate</key>
	<date>${opts.expires ?? "2044-01-01T00:00:00Z"}</date>
	<key>Name</key>
	<string>test profile</string>
	<key>TeamIdentifier</key>
	<array>
		<string>${team}</string>
	</array>
	<key>UUID</key>
	<string>00000000-0000-0000-0000-000000000000</string>
</dict>
</plist>
`;
}

const NOW = new Date("2026-10-01T00:00:00Z");
const ASSOCIATED = "com.apple.developer.associated-domains";

/** Entitlements as a plist dict, from plain values. */
const ents = (values: Record<string, string | boolean | string[]>): PlistDict =>
  mergeEntitlements(undefined, values);

/** A temp project: deno.json, denext.config.ts, a fake profile file; returns the script's URL. */
async function project(config: unknown, denoJson: unknown = {}): Promise<{
  dir: string;
  entry: string;
}> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(denoJson));
  await Deno.writeTextFile(join(dir, "app.provisionprofile"), "signed bytes");
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
  );
  return { dir, entry: toFileUrl(join(dir, "scripts", "package-macos.ts")).href };
}

/** The config the passkey build uses: identifier, a profile, the associated-domains entitlement. */
const passkeyConfig = (extra: Record<string, unknown> = {}) => ({
  desktop: {
    app: { identifier: "com.example.app" },
    macos: {
      provisioningProfile: "app.provisionprofile",
      entitlements: { [ASSOCIATED]: ["webcredentials:example.com"] },
      ...extra,
    },
  },
});

const decode = (xml = profileXml()) => () => Promise.resolve(xml);

Deno.test("parseProvisioningProfile reads the team, App ID, platform, expiry and grants", () => {
  const p = parseProvisioningProfile(profileXml());
  assertEquals(p.teamId, TEAM);
  assertEquals(p.applicationIdentifier, `${TEAM}.com.example.app`);
  assertEquals(p.platforms, ["OSX"]);
  assertEquals(p.expires?.toISOString(), "2044-01-01T00:00:00.000Z");
  assertEquals(p.name, "test profile");
  assert(dictGet(p.entitlements, ASSOCIATED));
  assertThrows(
    () => parseProvisioningProfile("<plist><array/></plist>"),
    Error,
    "not a plist dict",
  );
  assertThrows(
    () => parseProvisioningProfile("<plist><dict><key>Name</key><string>x</string></dict></plist>"),
    Error,
    "no Entitlements",
  );
});

Deno.test("provisioningProfileProblems: a matching profile has none", () => {
  const p = parseProvisioningProfile(profileXml());
  assertEquals(
    provisioningProfileProblems(p, {
      identifier: "com.example.app",
      identity: IDENTITY,
      now: NOW,
      entitlements: ents({
        [ASSOCIATED]: ["webcredentials:example.com", "applinks:example.com"],
        "keychain-access-groups": [`${TEAM}.shared`],
        "com.apple.security.cs.allow-jit": true, // not restricted: needs no grant
      }),
    }),
    [],
  );
});

Deno.test("provisioningProfileProblems: names every mismatch", () => {
  const p = parseProvisioningProfile(
    profileXml({
      appId: `${TEAM}.com.example.other`,
      platform: "iOS",
      expires: "2025-01-01T00:00:00Z",
    }),
  );
  const problems = provisioningProfileProblems(p, {
    identifier: "com.example.app",
    identity: "Developer ID Application: Someone Else (ZZZZZ99999)",
    now: NOW,
    entitlements: ents({
      "com.apple.developer.icloud-services": ["CloudKit"],
      "keychain-access-groups": ["OTHERTEAM.shared"],
    }),
  });
  const text = problems.join("\n");
  assertStringIncludes(text, "is for iOS, not macOS");
  assertStringIncludes(text, "expired on 2025-01-01");
  assertStringIncludes(text, `App ID ${TEAM}.com.example.other, not ${TEAM}.com.example.app`);
  assertStringIncludes(text, `belongs to team ${TEAM}, but the identity is team ZZZZZ99999`);
  assertStringIncludes(text, "does not grant the entitlement com.apple.developer.icloud-services");
  assertStringIncludes(text, 'does not grant keychain-access-groups = ["OTHERTEAM.shared"]');
  assertEquals(problems.length, 6);
});

Deno.test("provisioningProfileProblems: wildcard App IDs, exact grants and booleans", () => {
  const wildcard = parseProvisioningProfile(
    profileXml({
      appId: `${TEAM}.com.example.*`,
      entitlements: `<key>com.apple.developer.web-browser</key><false/>
		<key>com.apple.developer.exact</key><array><string>one</string></array>`,
    }),
  );
  const check = (values: Record<string, string | boolean | string[]>) =>
    provisioningProfileProblems(wildcard, {
      identifier: "com.example.app",
      now: NOW,
      entitlements: ents(values),
    });
  assertEquals(check({}), []);
  assertEquals(check({ "com.apple.developer.web-browser": false }), []);
  assertEquals(check({ "com.apple.developer.web-browser": true }).length, 1);
  assertEquals(check({ "com.apple.developer.exact": ["one"] }), []);
  assertEquals(check({ "com.apple.developer.exact": ["two"] }).length, 1);
  assertEquals(check({ "com.apple.developer.exact": "one" }), []);
});

Deno.test("mergeEntitlements: config values override and extend the plist's", () => {
  const base = parsePlist(renderPlist(ents({
    "com.apple.security.cs.allow-jit": true,
    [ASSOCIATED]: ["applinks:old.example"],
  }))) as PlistDict;
  const merged = mergeEntitlements(base, {
    [ASSOCIATED]: ["webcredentials:example.com"],
    "com.example.count": 3,
  } as Record<string, string[] | number>);
  assertEquals(merged.entries.map(([k]) => k), [
    "com.apple.security.cs.allow-jit",
    ASSOCIATED,
    "com.example.count",
  ]);
  assertEquals(dictGet(merged, ASSOCIATED), {
    kind: "array",
    items: [{ kind: "string", text: "webcredentials:example.com" }],
  });
  assertEquals(dictGet(merged, "com.example.count"), { kind: "integer", text: "3" });
  assertEquals(
    dictGet(mergeEntitlements(undefined, { "x.real": 1.5 } as Record<string, number>), "x.real"),
    { kind: "real", text: "1.5" },
  );
});

Deno.test("isRestrictedEntitlement and identityTeamId", () => {
  assert(isRestrictedEntitlement(ASSOCIATED));
  assert(isRestrictedEntitlement("keychain-access-groups"));
  assert(isRestrictedEntitlement("com.apple.application-identifier"));
  assert(!isRestrictedEntitlement("com.apple.security.cs.allow-jit"));
  assertEquals(identityTeamId(IDENTITY), TEAM);
  assertEquals(identityTeamId("ABCDEF0123456789ABCDEF0123456789ABCDEF01"), undefined);
});

Deno.test("desktopMacosSigning: nothing configured passes DENEXT_ENTITLEMENTS through", async () => {
  const { dir, entry } = await project({ desktop: { app: { identifier: "com.example.app" } } });
  try {
    assertEquals(await desktopMacosSigning(entry, {}), { entitlements: undefined });
    assertEquals(
      await desktopMacosSigning(entry, { entitlements: "/some/ents.plist", identity: IDENTITY }),
      { entitlements: "/some/ents.plist" },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopMacosSigning: a profile yields merged entitlements with the App ID and team", async () => {
  const { dir, entry } = await project(passkeyConfig());
  const base = join(dir, "base.plist");
  await Deno.writeTextFile(base, renderPlist(ents({ "com.apple.security.cs.allow-jit": true })));
  try {
    const out = await desktopMacosSigning(entry, {
      identity: IDENTITY,
      entitlements: base,
      decodeProfile: decode(),
      now: NOW,
    });
    assertEquals(out.provisioningProfile, join(dir, "app.provisionprofile"));
    const signed = parsePlist(await Deno.readTextFile(out.entitlements!)) as PlistDict;
    assertEquals(signed.entries.map(([k]) => k), [
      "com.apple.security.cs.allow-jit",
      ASSOCIATED,
      "com.apple.application-identifier",
      "com.apple.developer.team-identifier",
    ]);
    assertEquals(dictGet(signed, "com.apple.application-identifier"), {
      kind: "string",
      text: `${TEAM}.com.example.app`,
    });
    await Deno.remove(out.entitlements!);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopMacosSigning: the profile is checked against the config's identifier, which it returns", async () => {
  // deno.json still names another app (the kitchen sink's identifier in both files, the config's
  // changed): the config wins, as the package scripts mirror it into deno.json for deno desktop.
  const { dir, entry } = await project(passkeyConfig(), {
    desktop: { app: { identifier: "com.example.stale" } },
  });
  try {
    const out = await desktopMacosSigning(entry, {
      identity: IDENTITY,
      decodeProfile: decode(),
      now: NOW,
    });
    assertEquals(out.identifier, "com.example.app");
    await Deno.remove(out.entitlements!);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopMacosSigning: DENEXT_PROVISIONING_PROFILE overrides the config path", async () => {
  const { dir, entry } = await project(passkeyConfig({ provisioningProfile: "missing.profile" }));
  try {
    await assertRejects(
      () => desktopMacosSigning(entry, { identity: IDENTITY, decodeProfile: decode(), now: NOW }),
      Error,
      "no file at",
    );
    const out = await desktopMacosSigning(entry, {
      identity: IDENTITY,
      provisioningProfile: join(dir, "app.provisionprofile"),
      decodeProfile: decode(),
      now: NOW,
    });
    assertEquals(out.provisioningProfile, join(dir, "app.provisionprofile"));
    await Deno.remove(out.entitlements!);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopMacosSigning: refuses what macOS would refuse at launch", async () => {
  const { dir, entry } = await project(passkeyConfig());
  try {
    // An ad-hoc signature cannot carry a profile.
    await assertRejects(
      () => desktopMacosSigning(entry, { decodeProfile: decode(), now: NOW }),
      Error,
      "needs a real signing identity",
    );
    // A profile for another App ID.
    await assertRejects(
      () =>
        desktopMacosSigning(entry, {
          identity: IDENTITY,
          decodeProfile: decode(profileXml({ appId: `${TEAM}.com.example.other` })),
          now: NOW,
        }),
      Error,
      "desktop.macos: the provisioning profile",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // A restricted entitlement with no profile.
  const noProfile = await project({
    desktop: { macos: { entitlements: { [ASSOCIATED]: ["webcredentials:example.com"] } } },
  });
  try {
    await assertRejects(
      () => desktopMacosSigning(noProfile.entry, { identity: IDENTITY }),
      Error,
      "is a restricted entitlement",
    );
  } finally {
    await Deno.remove(noProfile.dir, { recursive: true });
  }
  // A profile with no identifier to match it to.
  const noId = await project({
    desktop: { macos: { provisioningProfile: "app.provisionprofile" } },
  });
  try {
    await assertRejects(
      () => desktopMacosSigning(noId.entry, { identity: IDENTITY, decodeProfile: decode() }),
      Error,
      "needs desktop.app.identifier",
    );
  } finally {
    await Deno.remove(noId.dir, { recursive: true });
  }
});

Deno.test("desktopMacosSigning: unrestricted config entitlements need no profile", async () => {
  const { dir, entry } = await project({
    desktop: { macos: { entitlements: { "com.apple.security.cs.allow-jit": true } } },
  });
  try {
    const out = await desktopMacosSigning(entry, {});
    assertEquals(out.provisioningProfile, undefined);
    const signed = parsePlist(await Deno.readTextFile(out.entitlements!)) as PlistDict;
    assertEquals(dictGet(signed, "com.apple.security.cs.allow-jit"), { kind: "bool", value: true });
    await Deno.remove(out.entitlements!);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("config validation: desktop.macos", () => {
  const check = (macos: unknown) => () =>
    validateDenextConfig({ desktop: { macos } } as unknown as DenextConfig);
  check({
    provisioningProfile: "profiles/app.provisionprofile",
    entitlements: { [ASSOCIATED]: ["webcredentials:example.com"], "a.b": true, "c.d": 2 },
  })();
  assertThrows(check("x"), Error, "desktop.macos");
  assertThrows(check({ provisioningProfile: "" }), Error, "desktop.macos.provisioningProfile");
  assertThrows(check({ entitlements: [] }), Error, "desktop.macos.entitlements");
  assertThrows(check({ entitlements: { "a.b": { nested: 1 } } }), Error, 'entitlements["a.b"]');
  assertThrows(check({ entitlements: { "a.b": [1] } }), Error, 'entitlements["a.b"]');
});

Deno.test("scaffold: the macOS script embeds the checked profile and signs with its entitlements", () => {
  const mac =
    scaffoldFiles({ dir: ".", desktop: true }).find((f) => f.path === "scripts/package-macos.ts")!
      .content;
  assertStringIncludes(mac, "await desktopMacosSigning(import.meta.url, {");
  assertStringIncludes(mac, 'Deno.env.get("DENEXT_PROVISIONING_PROFILE")');
  assertStringIncludes(mac, "`${app}/Contents/embedded.provisionprofile`");
  assertStringIncludes(
    mac,
    "await sign(app, s.identity, s.entitlements, s.provisioningProfile, s.profileIdentifier);",
  );
});

Deno.test("scaffold: the macOS script embeds the profile only in a bundle with the checked identifier", () => {
  const mac =
    scaffoldFiles({ dir: ".", desktop: true }).find((f) => f.path === "scripts/package-macos.ts")!
      .content;
  assertStringIncludes(mac, "profileIdentifier: mac.identifier,");
  const check = mac.indexOf('await infoPlistString(app, "CFBundleIdentifier")');
  const embed = mac.indexOf("`${app}/Contents/embedded.provisionprofile`");
  assert(check > 0 && check < embed, "the bundle id is checked before the profile is embedded");
  assertStringIncludes(mac, "if (bundleId !== profileIdentifier) {");
});

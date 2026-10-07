// `desktop.macos` for the scaffolded `scripts/package-macos.ts`: the provisioning profile it embeds
// as `Contents/embedded.provisionprofile` and the entitlements it signs the app with.
//
// A restricted entitlement (`com.apple.developer.associated-domains` for native passkeys and
// universal links, `keychain-access-groups`, …) is honoured on macOS only when the app carries a
// provisioning profile that grants it, and the app's own signature names the profile's App ID
// (`com.apple.application-identifier`) and team (`com.apple.developer.team-identifier`). Get any of
// that wrong and AMFI refuses to launch the app with an error that names none of it, so the profile
// is checked here, before the build: its App ID against `desktop.app.identifier`, its team against
// the signing identity, its expiry, and that it grants every restricted entitlement asked for.

import { fromFileUrl, isAbsolute, join } from "@std/path";
import {
  dictGet,
  parsePlist,
  type PlistDict,
  type PlistNode,
  renderPlist,
  stringOf,
} from "./plist-value.ts";
import { loadConfigBeside, readDenoJson } from "./desktop-installers.ts";

/** One entitlement's value as `desktop.macos.entitlements` writes it. */
type EntitlementValue = string | number | boolean | string[];

/** The facts of a provisioning profile the signing checks read. */
export interface ProvisioningProfileInfo {
  /** `Name`. */
  readonly name: string;
  /** `UUID`. */
  readonly uuid: string;
  /** The first `TeamIdentifier`. */
  readonly teamId: string;
  /** The `com.apple.application-identifier` entitlement: `<TeamID>.<bundle id>` (or a wildcard). */
  readonly applicationIdentifier: string;
  /** `Platform` (`OSX` for a macOS profile). */
  readonly platforms: readonly string[];
  /** `ExpirationDate`, when it has one. */
  readonly expires?: Date;
  /** The entitlements the profile grants. */
  readonly entitlements: PlistDict;
}

/** What `desktop.macos` resolves to for one packaging run. */
export interface DesktopMacosSigning {
  /** The entitlements plist to sign with (`codesign --entitlements`), if any. */
  readonly entitlements?: string;
  /** The profile to copy to `Contents/embedded.provisionprofile` before signing, if any. */
  readonly provisioningProfile?: string;
  /**
   * With a profile: the bundle identifier it was checked against (`desktop.app.identifier` in
   * `denext.config.ts`, else deno.json's, as the package scripts mirror it for `deno desktop`).
   * The scripts refuse to embed the profile in a bundle whose `CFBundleIdentifier` differs.
   */
  readonly identifier?: string;
}

/** Options for {@linkcode desktopMacosSigning}. */
export interface DesktopMacosSigningOptions {
  /** `DENEXT_CODESIGN_IDENTITY` (undefined: an ad-hoc signature, which cannot carry a profile). */
  readonly identity?: string;
  /** `DENEXT_ENTITLEMENTS`: an entitlements plist the config's entitlements are merged over. */
  readonly entitlements?: string;
  /** `DENEXT_PROVISIONING_PROFILE`: overrides `desktop.macos.provisioningProfile`. */
  readonly provisioningProfile?: string;
  /** Decodes a signed profile to its XML plist (default `security cms -D -i`); tests pass one. */
  readonly decodeProfile?: (path: string) => Promise<string>;
  /** "Now", for the expiry check (tests pass one). */
  readonly now?: Date;
}

/** Entitlements macOS honours only when a provisioning profile grants them. */
export function isRestrictedEntitlement(key: string): boolean {
  return key.startsWith("com.apple.developer.") || key === "com.apple.application-identifier" ||
    key === "keychain-access-groups";
}

/** A dict's string array (or single string) as a list. */
function stringsOf(node: PlistNode | undefined): string[] {
  if (node?.kind === "string") return [node.text];
  if (node?.kind !== "array") return [];
  return node.items.flatMap((n) => n.kind === "string" ? [n.text] : []);
}

/**
 * Read a provisioning profile's decoded XML plist.
 *
 * @param xml The profile's payload (`security cms -D -i <profile>`).
 * @returns Its facts.
 * @throws {Error} When it is not a provisioning profile.
 */
export function parseProvisioningProfile(xml: string): ProvisioningProfileInfo {
  const root = parsePlist(xml);
  if (root.kind !== "dict") throw new Error("the provisioning profile is not a plist dict");
  const ents = dictGet(root, "Entitlements");
  if (ents?.kind !== "dict") throw new Error("the provisioning profile has no Entitlements");
  const teamId = stringsOf(dictGet(root, "TeamIdentifier"))[0] ?? "";
  const expiryNode = dictGet(root, "ExpirationDate");
  const expiry = expiryNode?.kind === "date" || expiryNode?.kind === "string"
    ? expiryNode.text
    : undefined;
  return {
    name: stringOf(dictGet(root, "Name")) ?? "",
    uuid: stringOf(dictGet(root, "UUID")) ?? "",
    teamId,
    applicationIdentifier: stringOf(dictGet(ents, "com.apple.application-identifier")) ?? "",
    platforms: stringsOf(dictGet(root, "Platform")),
    expires: expiry ? new Date(expiry) : undefined,
    entitlements: ents,
  };
}

/** Whether `value` matches a profile pattern (`*` alone: anything; a trailing `*`: a prefix). */
function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
}

/** Whether the profile's grant `granted` allows the requested value `wanted`. */
function grantAllows(granted: PlistNode, wanted: PlistNode): boolean {
  if (wanted.kind === "bool") {
    return !wanted.value || (granted.kind === "bool" && granted.value);
  }
  const patterns = stringsOf(granted);
  if (wanted.kind === "array") {
    return wanted.items.every((item) =>
      item.kind === "string" && patterns.some((p) => matchesPattern(p, item.text))
    );
  }
  if (wanted.kind === "string") return patterns.some((p) => matchesPattern(p, wanted.text));
  return JSON.stringify(granted) === JSON.stringify(wanted);
}

/** The team id in a `"… (TEAMID)"` identity name, if it has one. */
export function identityTeamId(identity: string): string | undefined {
  return /\(([A-Z0-9]{10})\)\s*$/.exec(identity)?.[1];
}

/** Inputs of {@linkcode provisioningProfileProblems}. */
export interface ProfileCheckInput {
  /** The bundle identifier (`desktop.app.identifier`). */
  readonly identifier: string;
  /** The entitlements the app will be signed with. */
  readonly entitlements: PlistDict;
  /** The signing identity. */
  readonly identity?: string;
  /** "Now", for the expiry check. */
  readonly now?: Date;
}

/** The profile's own problems: the platform, the expiry, the App ID and the team. */
function profileIdentityProblems(
  profile: ProvisioningProfileInfo,
  input: ProfileCheckInput,
  label: string,
): string[] {
  const problems: string[] = [];
  if (profile.platforms.length > 0 && !profile.platforms.includes("OSX")) {
    problems.push(`${label} is for ${profile.platforms.join(", ")}, not macOS`);
  }
  if (profile.expires && profile.expires.getTime() <= (input.now ?? new Date()).getTime()) {
    problems.push(`${label} expired on ${profile.expires.toISOString()}`);
  }
  const appId = `${profile.teamId}.${input.identifier}`;
  if (!matchesPattern(profile.applicationIdentifier, appId)) {
    problems.push(
      `${label} is for the App ID ${profile.applicationIdentifier}, not ${appId} ` +
        "(desktop.app.identifier)",
    );
  }
  const team = input.identity ? identityTeamId(input.identity) : undefined;
  if (team && team !== profile.teamId) {
    problems.push(`${label} belongs to team ${profile.teamId}, but the identity is team ${team}`);
  }
  return problems;
}

/** The restricted entitlements asked for that the profile does not grant. */
function grantProblems(
  profile: ProvisioningProfileInfo,
  entitlements: PlistDict,
  label: string,
): string[] {
  const problems: string[] = [];
  for (const [key, wanted] of entitlements.entries) {
    if (!isRestrictedEntitlement(key)) continue;
    const granted = dictGet(profile.entitlements, key);
    if (!granted) problems.push(`${label} does not grant the entitlement ${key}`);
    else if (!grantAllows(granted, wanted)) {
      problems.push(`${label} does not grant ${key} = ${JSON.stringify(plistJson(wanted))}`);
    }
  }
  return problems;
}

/**
 * Why a profile cannot sign this app (empty: it can).
 *
 * @param profile The profile.
 * @param input The app's identifier, entitlements and signing identity.
 * @returns One message per problem.
 */
export function provisioningProfileProblems(
  profile: ProvisioningProfileInfo,
  input: ProfileCheckInput,
): string[] {
  const label = `the provisioning profile "${profile.name || profile.uuid}"`;
  return [
    ...profileIdentityProblems(profile, input, label),
    ...grantProblems(profile, input.entitlements, label),
  ];
}

/** A plist value as plain JSON (for messages). */
function plistJson(node: PlistNode): unknown {
  switch (node.kind) {
    case "bool":
      return node.value;
    case "array":
      return node.items.map(plistJson);
    case "dict":
      return Object.fromEntries(node.entries.map(([k, v]) => [k, plistJson(v)]));
    default:
      return node.text;
  }
}

/** A config entitlement value as a plist node. */
function entitlementNode(value: EntitlementValue): PlistNode {
  if (typeof value === "boolean") return { kind: "bool", value };
  if (typeof value === "number") {
    return { kind: Number.isInteger(value) ? "integer" : "real", text: String(value) };
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map((text) => ({ kind: "string", text })) };
  }
  return { kind: "string", text: value };
}

/**
 * `overlay` merged over `base` (an overlay key replaces the base's), as a new dict.
 *
 * @param base The `DENEXT_ENTITLEMENTS` plist's dict, if any.
 * @param overlay `desktop.macos.entitlements`.
 * @returns The merged entitlements.
 */
export function mergeEntitlements(
  base: PlistDict | undefined,
  overlay: Readonly<Record<string, EntitlementValue>> | undefined,
): PlistDict {
  const entries: Array<[string, PlistNode]> = [...(base?.entries ?? [])];
  for (const [key, value] of Object.entries(overlay ?? {})) {
    const node = entitlementNode(value);
    const at = entries.findIndex(([k]) => k === key);
    if (at >= 0) entries[at] = [key, node];
    else entries.push([key, node]);
  }
  return { kind: "dict", entries };
}

/** `dict` with `key` = `text` added when it has no such key. */
function withDefault(dict: PlistDict, key: string, text: string): PlistDict {
  return dictGet(dict, key)
    ? dict
    : { kind: "dict", entries: [...dict.entries, [key, { kind: "string", text }]] };
}

/** `security cms -D -i <profile>`: a signed profile's XML payload. */
async function securityDecode(path: string): Promise<string> {
  const out = await new Deno.Command("security", {
    args: ["cms", "-D", "-i", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `security cms could not read the provisioning profile ${path}: ` +
        new TextDecoder().decode(out.stderr).trim(),
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/** `desktop.macos` of a parsed config, or `{}`. */
function macosOf(config: unknown): { provisioningProfile?: unknown; entitlements?: unknown } {
  const m = (config as { desktop?: { macos?: unknown } } | null | undefined)?.desktop?.macos;
  return typeof m === "object" && m !== null ? m : {};
}

/** `desktop.app.identifier` of a parsed config / deno.json, if set. */
function identifierOf(value: unknown): string | undefined {
  const id = (value as { desktop?: { app?: { identifier?: unknown } } } | null | undefined)
    ?.desktop?.app?.identifier;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** The `DENEXT_ENTITLEMENTS` plist's dict, if one is set. */
async function readBaseEntitlements(path: string | undefined): Promise<PlistDict | undefined> {
  if (!path) return undefined;
  const base = parsePlist(await Deno.readTextFile(path));
  if (base.kind !== "dict") throw new Error(`${path}: an entitlements plist must be a dict`);
  return base;
}

/** Refuse restricted entitlements when no profile grants them (AMFI would refuse the launch). */
function refuseRestrictedWithoutProfile(entitlements: PlistDict): void {
  const restricted = entitlements.entries.map(([k]) => k).filter(isRestrictedEntitlement);
  if (restricted.length === 0) return;
  const one = restricted.length === 1;
  throw new Error(
    `desktop.macos.entitlements: ${restricted.join(", ")} ${
      one ? "is a restricted entitlement" : "are restricted entitlements"
    }, which macOS honours only with a provisioning profile that grants ${
      one ? "it" : "them"
    } (without one the app does not launch): set desktop.macos.provisioningProfile`,
  );
}

/** The profile file a setting names (relative to the project), checked to exist. */
async function profileFile(root: string, setting: string, identity?: string): Promise<string> {
  if (!identity) {
    throw new Error(
      "desktop.macos.provisioningProfile needs a real signing identity: set " +
        'DENEXT_CODESIGN_IDENTITY to a "Developer ID Application: … (TEAMID)" identity ' +
        "(an ad-hoc signature cannot carry a provisioning profile)",
    );
  }
  const path = isAbsolute(setting) ? setting : join(root, setting);
  if (!(await Deno.stat(path).then((s) => s.isFile, () => false))) {
    throw new Error(`desktop.macos.provisioningProfile: no file at ${path}`);
  }
  return path;
}

/**
 * `entitlements` plus the App ID and team entitlements AMFI matches the profile by, checked
 * against the profile.
 */
async function profileEntitlements(
  path: string,
  identifier: string | undefined,
  entitlements: PlistDict,
  options: DesktopMacosSigningOptions,
): Promise<PlistDict> {
  if (!identifier) {
    throw new Error(
      "desktop.macos.provisioningProfile needs desktop.app.identifier (the bundle id its App ID names)",
    );
  }
  const profile = parseProvisioningProfile(await (options.decodeProfile ?? securityDecode)(path));
  const signed = withDefault(
    withDefault(
      entitlements,
      "com.apple.application-identifier",
      `${profile.teamId}.${identifier}`,
    ),
    "com.apple.developer.team-identifier",
    profile.teamId,
  );
  const problems = provisioningProfileProblems(profile, {
    identifier,
    entitlements: signed,
    identity: options.identity,
    now: options.now,
  });
  if (problems.length > 0) throw new Error(`desktop.macos: ${problems.join("; ")}`);
  return signed;
}

/**
 * Resolve `desktop.macos` for a packaging run: check the provisioning profile against the app and
 * write the entitlements to sign with. With neither a profile nor config entitlements, the
 * `DENEXT_ENTITLEMENTS` plist (if any) is passed through unchanged.
 *
 * @param entryUrl `import.meta.url` of `scripts/package-macos.ts` (the project is its parent).
 * @param options The signing identity, `DENEXT_ENTITLEMENTS`, `DENEXT_PROVISIONING_PROFILE`.
 * @returns The entitlements plist and the profile for the signing step.
 * @throws {Error} When the profile cannot sign this app (each problem named), or a profile is set
 *   without a signing identity, or a restricted entitlement is asked for without a profile.
 */
export async function desktopMacosSigning(
  entryUrl: string,
  options: DesktopMacosSigningOptions = {},
): Promise<DesktopMacosSigning> {
  const root = fromFileUrl(new URL("../", entryUrl));
  const config = await loadConfigBeside(entryUrl);
  const macos = macosOf(config);
  const configured = typeof macos.provisioningProfile === "string"
    ? macos.provisioningProfile
    : undefined;
  const setting = options.provisioningProfile || configured;
  const overlay = macos.entitlements as Record<string, EntitlementValue> | undefined;
  if (!setting && Object.keys(overlay ?? {}).length === 0) {
    return { entitlements: options.entitlements };
  }
  let entitlements = mergeEntitlements(await readBaseEntitlements(options.entitlements), overlay);
  let profilePath: string | undefined;
  let identifier: string | undefined;
  if (setting) {
    profilePath = await profileFile(root, setting, options.identity);
    identifier = identifierOf(config) ?? identifierOf(await readDenoJson(root));
    entitlements = await profileEntitlements(profilePath, identifier, entitlements, options);
  } else {
    refuseRestrictedWithoutProfile(entitlements);
  }
  const file = await Deno.makeTempFile({ prefix: "denext-entitlements-", suffix: ".plist" });
  await Deno.writeTextFile(file, renderPlist(entitlements));
  return {
    entitlements: file,
    provisioningProfile: profilePath,
    ...(identifier ? { identifier } : {}),
  };
}

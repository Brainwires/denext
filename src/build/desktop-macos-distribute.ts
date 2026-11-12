// scripts/package-macos.ts's distribution steps after the .app is signed: the .app and each
// installer beside it (.dmg, .pkg) is notarized and stapled on its own, so each carries its own
// ticket. A .dmg is a separate piece of code to Gatekeeper: one holding a stapled .app is still
// "no usable signature" until the image itself is code-signed, notarized and stapled. The .app
// keeps its own ticket for users who copy it out of the image.
//
// Every step reports what it actually did, and the closing line of the script names exactly
// that per artifact kind, never more.

import { desktopRun } from "./desktop-package-script.ts";
import {
  macosCodesignArgs,
  type NotaryCredentials,
  notaryCredentials,
  notarytoolSubmitArgs,
} from "./code-signing.ts";

/** What a packaged macOS artifact is. */
export type DesktopMacosArtifactKind = "app" | "dmg" | "pkg";

/** How an artifact is signed: a Developer ID identity, ad-hoc (an .app only), or not at all. */
export type DesktopMacosSignature = "developer-id" | "ad-hoc" | "unsigned";

/** A packaged artifact and what was done to it. */
export interface DesktopMacosArtifact {
  /** The artifact's path. */
  readonly path: string;
  /** An `.app`, a `.dmg` or a `.pkg`. */
  readonly kind: DesktopMacosArtifactKind;
  /** How it is signed. */
  readonly signature: DesktopMacosSignature;
  /** Accepted by the notary service. */
  readonly notarized: boolean;
  /** Its ticket stapled (and validated). */
  readonly stapled: boolean;
}

/** What the distribution steps run commands through (tests stub it). */
export interface DesktopMacosDistributeDeps {
  /** Runs a command, throwing on a non-zero exit (default {@linkcode desktopRun}). */
  readonly run?: (cmd: string[]) => Promise<void>;
}

/**
 * The notary credentials in the environment: `DENEXT_NOTARY_PROFILE` (a keychain profile), else
 * an App Store Connect API key (`DENEXT_NOTARY_KEY` + `DENEXT_NOTARY_KEY_ID`, with
 * `DENEXT_NOTARY_ISSUER` for a team key) — what `denext build --compile --sign` reads too.
 *
 * @returns The credentials, or `undefined` when none are set.
 */
export function desktopNotaryCredentials(): NotaryCredentials | undefined {
  return notaryCredentials();
}

/** Whether `identity` is no identity, or the ad-hoc one (`"-"`). */
function adHoc(identity: string | undefined): boolean {
  return identity === undefined || identity === "" || identity === "-";
}

/**
 * A record for an artifact nothing has notarized yet.
 *
 * @param path The artifact.
 * @param kind `app`, `dmg` or `pkg`.
 * @param signature How it is signed.
 * @returns The record.
 */
export function desktopMacosArtifact(
  path: string,
  kind: DesktopMacosArtifactKind,
  signature: DesktopMacosSignature,
): DesktopMacosArtifact {
  return { path, kind, signature, notarized: false, stapled: false };
}

/**
 * Code-sign a .dmg with the Developer ID identity the .app was signed with: a secure timestamp,
 * no Hardened Runtime (that applies to executables), then a strict verify. Without an identity
 * (or the ad-hoc one) the image stays unsigned: an ad-hoc signature on a disk image means nothing
 * to Gatekeeper.
 *
 * @param dmg The disk image.
 * @param identity `DENEXT_CODESIGN_IDENTITY`.
 * @param deps The command runner.
 * @returns The image's record.
 */
export async function desktopSignMacosDmg(
  dmg: string,
  identity: string | undefined,
  deps: DesktopMacosDistributeDeps = {},
): Promise<DesktopMacosArtifact> {
  if (adHoc(identity)) return desktopMacosArtifact(dmg, "dmg", "unsigned");
  const run = deps.run ?? desktopRun;
  await run(macosCodesignArgs(dmg, { identity, hardened: false }));
  await run(["codesign", "--verify", "--strict", dmg]);
  return desktopMacosArtifact(dmg, "dmg", "developer-id");
}

/** Notarize, staple and validate one artifact (an .app goes up as a zip, removed afterwards). */
async function notarizeOne(
  artifact: DesktopMacosArtifact,
  credentials: NotaryCredentials,
  run: (cmd: string[]) => Promise<void>,
): Promise<DesktopMacosArtifact> {
  if (artifact.kind === "app") {
    const zip = `${artifact.path}.zip`;
    try {
      await run(["ditto", "-c", "-k", "--keepParent", artifact.path, zip]);
      await run(notarytoolSubmitArgs(zip, credentials));
    } finally {
      // Remove the submission zip even if notarytool failed.
      await Deno.remove(zip).catch(() => {});
    }
  } else {
    await run(notarytoolSubmitArgs(artifact.path, credentials));
  }
  await run(["xcrun", "stapler", "staple", artifact.path]);
  await run(["xcrun", "stapler", "validate", artifact.path]);
  return { ...artifact, notarized: true, stapled: true };
}

/**
 * Notarize and staple each Developer-ID-signed artifact with `credentials` (a keychain profile or
 * an App Store Connect API key), one submission per artifact, all submitted at once. Without
 * credentials, or for an ad-hoc / unsigned artifact, the record comes back unchanged.
 *
 * Call it for the .app before building its installers, so the .dmg and .pkg hold the stapled .app.
 *
 * @param artifacts The artifacts.
 * @param credentials The notary credentials, or `undefined` for none.
 * @param deps The command runner.
 * @returns The records, in order, with what was done.
 */
export async function desktopNotarizeMacos(
  artifacts: readonly DesktopMacosArtifact[],
  credentials: NotaryCredentials | undefined,
  deps: DesktopMacosDistributeDeps = {},
): Promise<DesktopMacosArtifact[]> {
  const run = deps.run ?? desktopRun;
  return await Promise.all(
    artifacts.map((a) =>
      credentials && a.signature === "developer-id" ? notarizeOne(a, credentials, run) : a
    ),
  );
}

/** One artifact's state, as the closing line names it. */
function describe(a: DesktopMacosArtifact): string {
  if (a.signature === "ad-hoc") return "ad-hoc signed";
  if (a.signature === "unsigned") return "unsigned";
  if (!a.notarized) return "signed, NOT notarized";
  return a.stapled ? "signed + notarized + stapled" : "signed + notarized, NOT stapled";
}

/**
 * The closing line of `scripts/package-macos.ts`: what each kind of artifact is, then whether
 * the set is ready to distribute.
 *
 * @param artifacts What the run produced.
 * @returns The line (indented, in parentheses).
 */
export function desktopMacosDistributionNote(artifacts: readonly DesktopMacosArtifact[]): string {
  const parts: string[] = [];
  for (const kind of ["app", "dmg", "pkg"] as const) {
    const states = [...new Set(artifacts.filter((a) => a.kind === kind).map(describe))];
    for (const state of states) parts.push(`.${kind} ${state}`);
  }
  const ready = artifacts.length > 0 &&
    artifacts.every((a) => a.signature === "developer-id" && a.notarized && a.stapled);
  let advice = "";
  if (ready) advice = " — ready to distribute";
  else if (artifacts.some((a) => a.kind === "app" && a.signature !== "developer-id")) {
    advice = " — not distributable; see the macOS distribution doc";
  } else if (artifacts.some((a) => a.signature === "developer-id" && !a.notarized)) {
    advice =
      " — set DENEXT_NOTARY_PROFILE (or DENEXT_NOTARY_KEY + DENEXT_NOTARY_KEY_ID) to notarize";
  }
  return `  (${parts.join("; ")}${advice})`;
}

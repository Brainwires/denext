// A runtime release's release document (src/build/runtime-channel.ts → `RuntimeReleaseDocument`):
// the two pins a denext release compiles in, built from the GitHub release with every check the
// pin script runs (scripts/desktop-pin-runtime.ts): the manifest against SHA256SUMS for every
// archive, each URL this tag's download URL, then every archive downloaded (or read from a
// directory), hashed and its build provenance checked with `gh attestation verify` (the fork's
// release workflow, this tag), the esbuild and TypeScript trees inside each CLI zip re-hashed.
// Nothing is returned unless all of them pass. `rollback` is never part of a document.
//
// `deno task runtime:channel publish` signs nothing until this passes; `release-doc
// --unverified` (the compat workflow's candidate pin, where the toolchain install re-checks every
// hash) skips only the download + attestation pass.

import {
  attestPin,
  type AttestPinOptions,
  type PinFile,
  releasePins,
  type ToolchainPinFile,
} from "../desktop-pin-runtime.ts";
import type { RuntimeReleaseDocument } from "../../src/build/runtime-channel.ts";
import type { DenoToolchainPin } from "../../src/build/deno-toolchain.ts";
import type { DesktopRuntimePin } from "../../src/build/desktop-runtime.ts";

/** Where a release's files come from (tests pass local files and a fake `gh`). */
export interface ReleaseDocumentOptions {
  /** A local `manifest.json` (default: the release's). */
  readonly manifest?: string;
  /** A local `SHA256SUMS` (default: the release's). */
  readonly sums?: string;
  /** A directory holding the archives by file name (default: each is downloaded). */
  readonly archives?: string;
  /** The archive cross-check (default: {@linkcode attestPin}). */
  readonly attest?: (pin: PinFile, options: AttestPinOptions) => Promise<void>;
  /** Skip the download + attestation pass (the compat workflow only). */
  readonly unverified?: boolean;
}

/**
 * The release document of `tag`, every archive checked first (see the module header).
 *
 * @param tag The release tag (`denext-runtime-v<version>`).
 * @param options Local files and seams.
 * @returns The document.
 * @throws {Error} When the release has no CLI archives or any check fails.
 */
export async function releaseDocument(
  tag: string,
  options: ReleaseDocumentOptions = {},
): Promise<RuntimeReleaseDocument> {
  const flags: Record<string, string | undefined> = {
    "--manifest": options.manifest,
    "--sums": options.sums,
  };
  const { pin, cli } = await releasePins(tag, (name) => flags[name]);
  if (cli === null) {
    throw new Error(
      `${tag} ships no Deno toolchain (no cli section): it can't be a channel release`,
    );
  }
  if (!options.unverified) {
    await (options.attest ?? attestPin)(pin, { archives: options.archives, cli });
  }
  return documentOf(cli, pin);
}

/**
 * The document of a release's two pins: each without `rollback`.
 *
 * @param cli The toolchain pin.
 * @param pin The Deno Desktop runtime pin.
 * @returns The document.
 */
export function documentOf(cli: ToolchainPinFile, pin: PinFile): RuntimeReleaseDocument {
  const { rollback: _t, ...toolchain } = cli;
  const { rollback: _d, ...desktop } = pin;
  return {
    toolchain: toolchain as DenoToolchainPin,
    desktop: desktop as unknown as DesktopRuntimePin,
  };
}

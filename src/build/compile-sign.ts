// `denext build --compile --sign` (and `compile.sign`): code-sign the compiled executable.
//
// - A macOS target (`*-apple-darwin`): `codesign --force --options runtime --timestamp
//   --entitlements <plist> --sign <identity>`, checked with `codesign --verify --strict`, then
//   zipped and submitted to `xcrun notarytool submit --wait` when notary credentials are set. A
//   bare Mach-O cannot be stapled (stapler takes .app / .dmg / .pkg), so Gatekeeper looks the
//   ticket up online the first time the binary runs.
// - A Windows target (`*-pc-windows-msvc`): Authenticode with `signtool` on Windows, else
//   `osslsigncode` (macOS / Linux), SHA-256 and an RFC-3161 timestamp.
// - A Linux target: Linux executables carry no OS signature.
//
// Entitlements under the Hardened Runtime: V8 (denort) needs `com.apple.security.cs.allow-jit`
// on Apple Silicon, where it allocates its code space with MAP_JIT (Chromium's renderer, which
// runs V8, is signed with exactly that key). Intel V8 flips its code pages W^X and needs none.
// A binary allowed `--allow-ffi` (compile.permissions) also gets `disable-library-validation`:
// `Deno.dlopen` and a Node-API addon load libraries no Developer ID of yours signed, which
// library validation would refuse. Nothing else: Deno's own release also grants
// `allow-unsigned-executable-memory`, `allow-dyld-environment-variables` and
// `disable-executable-page-protection`, none of which denort needs.
//
// Credentials come from the environment only (./code-signing.ts lists them) and are never
// printed: a failing command's message has the certificate password redacted, and osslsigncode
// reads it from a 0600 file rather than its command line. A configured `compile.sign` without
// credentials (or the tool) warns and leaves the binary unsigned; an explicit `--sign` fails.

import { dirname, isAbsolute, join } from "@std/path";
import type { CompileSignConfig } from "../server/config.ts";
import {
  DEFAULT_TIMESTAMP_URL,
  macosCodesignArgs,
  type NotaryCredentials,
  notaryCredentials,
  notarytoolSubmitArgs,
  osslsigncodeArgs,
  parseNotaryResult,
  processSigningEnv,
  type SigningEnv,
  signtoolArgs,
  type WindowsCertificate,
  windowsCertificate,
  windowsCertificateSecrets,
  windowsSignTool,
} from "./code-signing.ts";
import { macosSigningEntitlements } from "./desktop-macos-signing.ts";
import { hasCommand } from "../ui/signing.ts";

/** What a signing command printed. */
export interface SignCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command; `secrets` are what a failure message must not show. */
export type SignCommandRunner = (
  cmd: readonly string[],
  secrets: readonly string[],
) => Promise<SignCommandResult>;

/** The entitlements a compiled binary is signed with by default (see the module comment). */
const COMPILE_ENTITLEMENTS: Readonly<Record<string, boolean>> = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
});

/** Added to {@linkcode COMPILE_ENTITLEMENTS} when the binary may load native libraries. */
const FFI_ENTITLEMENTS: Readonly<Record<string, boolean>> = Object.freeze({
  "com.apple.security.cs.disable-library-validation": true,
});

/** What {@linkcode signCompiledBinary} signs and how strictly. */
export interface CompileSignOptions {
  /** `--sign` was given: a missing credential or tool is an error, not a warning. */
  readonly explicit: boolean;
  /** `compile.sign`. */
  readonly config?: boolean | CompileSignConfig;
  /** The `deno compile --target` triple the binary was built for. */
  readonly target: string;
  /** The project (a relative `compile.sign.entitlements` resolves against it). */
  readonly projectDir: string;
  /** Whether the binary may load native libraries (`--allow-ffi` / `--allow-all` baked). */
  readonly ffi?: boolean;
}

/** The seams {@linkcode signCompiledBinary} runs through (tests pass fakes). */
export interface CompileSignDeps {
  readonly env?: SigningEnv;
  readonly run?: SignCommandRunner;
  readonly has?: (cmd: string) => Promise<boolean>;
  /** The host OS (default `Deno.build.os`). */
  readonly os?: string;
  readonly warn?: (message: string) => void;
}

/** What {@linkcode signCompiledBinary} did. */
export interface CompileSignResult {
  /** Whether the binary now carries the signature asked for. */
  readonly signed: boolean;
  /** One line for the build's summary. */
  readonly detail: string;
}

/** The secrets in `text` replaced with `***`. */
function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter((s) => s.length > 0).reduce((t, s) => t.replaceAll(s, "***"), text);
}

/** The default runner: the command with its output captured. */
const defaultRun: SignCommandRunner = async (cmd) => {
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
};

/** Run `cmd`; a non-zero exit throws with the command and its output, secrets redacted. */
async function runOrThrow(
  run: SignCommandRunner,
  cmd: readonly string[],
  secrets: readonly string[] = [],
): Promise<SignCommandResult> {
  const out = await run(cmd, secrets);
  if (out.code === 0) return out;
  const said = (out.stderr || out.stdout).trim().split("\n").slice(-5).join("\n");
  throw new Error(
    redact(
      `${cmd[0]} failed (exit ${out.code}): ${cmd.join(" ")}${said ? `\n${said}` : ""}`,
      secrets,
    ),
  );
}

/** The platform a target triple names, for signing. */
function targetPlatform(target: string): "macos" | "windows" | "linux" {
  if (target.includes("apple-darwin")) return "macos";
  if (target.includes("windows")) return "windows";
  return "linux";
}

/** `config` as options (`true` → defaults; `false` / unset → not configured). */
function configOptions(config: boolean | CompileSignConfig | undefined): CompileSignConfig {
  return typeof config === "object" && config !== null ? config : {};
}

/**
 * Whether signing was asked for: `--sign`, or a `compile.sign` that is not `false`.
 *
 * @param explicit `--sign`.
 * @param config `compile.sign`.
 * @returns Whether to sign.
 */
export function compileSignRequested(
  explicit: boolean,
  config: boolean | CompileSignConfig | undefined,
): boolean {
  return explicit || (config !== undefined && config !== false);
}

/** The context one signing run threads through its steps. */
interface SignRun {
  readonly options: CompileSignOptions;
  readonly config: CompileSignConfig;
  readonly env: SigningEnv;
  readonly run: SignCommandRunner;
  readonly has: (cmd: string) => Promise<boolean>;
  readonly os: string;
  readonly warn: (message: string) => void;
}

/** A missing prerequisite: `--sign` fails, a configured `compile.sign` warns and skips. */
function unmet(ctx: SignRun, why: string): CompileSignResult {
  if (ctx.options.explicit) throw new Error(`denext build --compile --sign: ${why}`);
  ctx.warn(`  compile.sign: ${why} — the binary is left unsigned.`);
  return { signed: false, detail: `unsigned (${why})` };
}

/**
 * Code-sign the compiled binary at `binary` for its target (see the module comment). Returns
 * `undefined` when signing was not asked for.
 *
 * @param binary The executable `deno compile` wrote.
 * @param options `--sign`, `compile.sign`, the target and the project.
 * @param deps Seams.
 * @returns What was done.
 * @throws {Error} With `--sign`, when a credential or tool is missing; always, when a signing
 *   command fails or notarization is rejected.
 */
export async function signCompiledBinary(
  binary: string,
  options: CompileSignOptions,
  deps: CompileSignDeps = {},
): Promise<CompileSignResult | undefined> {
  if (!compileSignRequested(options.explicit, options.config)) return undefined;
  const ctx: SignRun = {
    options,
    config: configOptions(options.config),
    env: deps.env ?? processSigningEnv,
    run: deps.run ?? defaultRun,
    has: deps.has ?? ((cmd) => hasCommand(cmd)),
    os: deps.os ?? Deno.build.os,
    warn: deps.warn ?? ((m) => console.warn(m)),
  };
  const platform = targetPlatform(options.target);
  if (platform === "macos") return await signMacos(binary, ctx);
  if (platform === "windows") return await signWindows(binary, ctx);
  return unmet(
    ctx,
    `${options.target} has no OS code signature (Linux executables are not signed; publish a ` +
      "checksum or a detached signature of the archive instead)",
  );
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

/** The entitlements plist to pass: the configured (or `DENEXT_ENTITLEMENTS`) plist, if any. */
function explicitEntitlements(ctx: SignRun): string | undefined {
  const setting = ctx.config.entitlements ?? ctx.env("DENEXT_ENTITLEMENTS");
  if (!setting) return undefined;
  return isAbsolute(setting) ? setting : join(ctx.options.projectDir, setting);
}

/** Sign a Mach-O, verify it, and notarize it when credentials allow. */
async function signMacos(binary: string, ctx: SignRun): Promise<CompileSignResult> {
  if (ctx.os !== "darwin") {
    return unmet(ctx, "a macOS binary is signed on macOS (codesign); build it on a Mac or in CI");
  }
  const identity = ctx.env("DENEXT_CODESIGN_IDENTITY");
  if (!identity) {
    return unmet(
      ctx,
      'no DENEXT_CODESIGN_IDENTITY (a "Developer ID Application: Name (TEAMID)" identity; ' +
        '"-" signs ad-hoc)',
    );
  }
  if (!(await ctx.has("codesign"))) {
    return unmet(ctx, "codesign is not on PATH (install the Xcode command line tools)");
  }
  const defaults = { ...COMPILE_ENTITLEMENTS, ...(ctx.options.ffi ? FFI_ENTITLEMENTS : {}) };
  const plist = await macosSigningEntitlements(defaults, { explicit: explicitEntitlements(ctx) });
  try {
    await runOrThrow(
      ctx.run,
      macosCodesignArgs(binary, {
        identity,
        hardened: true,
        entitlementArgs: ["--entitlements", plist],
      }),
    );
  } finally {
    await Deno.remove(plist).catch(() => {});
  }
  await runOrThrow(ctx.run, ["codesign", "--verify", "--strict", "--verbose=2", binary]);
  const who = identity === "-" ? "ad-hoc" : identity;
  return {
    signed: true,
    detail: `signed (${who}, Hardened Runtime)${await notarize(binary, identity, ctx)}`,
  };
}

/** Notarize when asked and possible; the summary's suffix. */
async function notarize(binary: string, identity: string, ctx: SignRun): Promise<string> {
  if (ctx.config.notarize === false) return "; not notarized (compile.sign.notarize: false)";
  if (identity === "-") return "; not notarized (an ad-hoc signature cannot be)";
  const credentials = notaryCredentials(ctx.env);
  if (!credentials) {
    const why = "no notary credentials (DENEXT_NOTARY_PROFILE, or DENEXT_NOTARY_KEY + " +
      "DENEXT_NOTARY_KEY_ID [+ DENEXT_NOTARY_ISSUER])";
    if (ctx.config.notarize === true) throw new Error(`compile.sign.notarize: ${why}`);
    ctx.warn(`  ${why} — the binary is signed but not notarized; Gatekeeper blocks a download.`);
    return "; NOT notarized";
  }
  return `; ${await submitForNotarization(binary, credentials, ctx)}`;
}

/** Zip the binary, submit it, wait, and read the verdict. */
async function submitForNotarization(
  binary: string,
  credentials: NotaryCredentials,
  ctx: SignRun,
): Promise<string> {
  const dir = await Deno.makeTempDir({ dir: dirname(binary), prefix: ".denext-notary-" });
  const zip = join(dir, "submission.zip");
  try {
    await runOrThrow(ctx.run, ["ditto", "-c", "-k", "--keepParent", binary, zip]);
    const secrets = credentials.kind === "api-key"
      ? [credentials.keyId, credentials.issuer ?? ""]
      : [];
    const out = await runOrThrow(ctx.run, notarytoolSubmitArgs(zip, credentials, true), secrets);
    const result = parseNotaryResult(out.stdout);
    if (!result) throw new Error(`notarytool printed no result: ${out.stdout.trim()}`);
    if (result.status !== "Accepted") {
      throw new Error(
        `notarization ${result.status} (submission ${result.id}): ${
          result.message.replace(/\.$/, "")
        }. ` +
          `See why with: xcrun notarytool log ${result.id} <the same credentials>`,
      );
    }
    // A bare Mach-O takes no stapled ticket: Gatekeeper checks it online on the first run.
    return `notarized (submission ${result.id}; not stapled — a bare executable cannot be)`;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────

/** Authenticode-sign a PE binary with signtool or osslsigncode. */
async function signWindows(binary: string, ctx: SignRun): Promise<CompileSignResult> {
  const cert = windowsCertificate(ctx.env);
  if (!cert) {
    return unmet(
      ctx,
      "no DENEXT_WINDOWS_CERT (a .pfx) or DENEXT_WINDOWS_CERT_THUMBPRINT (Windows certificate store)",
    );
  }
  const tool = await windowsSignTool(ctx.has, ctx.os);
  if (!tool) {
    return unmet(
      ctx,
      ctx.os === "windows"
        ? "signtool is not on PATH (it ships with the Windows SDK)"
        : "osslsigncode is not on PATH (brew install osslsigncode / apt install osslsigncode)",
    );
  }
  const timestamp = ctx.config.timestampUrl ?? ctx.env("DENEXT_SIGN_TIMESTAMP_URL") ??
    DEFAULT_TIMESTAMP_URL;
  if (tool === "signtool") {
    await runOrThrow(
      ctx.run,
      signtoolArgs([binary], cert, timestamp),
      windowsCertificateSecrets(cert),
    );
  } else {
    if (cert.kind !== "pfx") {
      return unmet(
        ctx,
        "DENEXT_WINDOWS_CERT_THUMBPRINT names a Windows-store certificate, which only signtool " +
          "(on Windows) reaches; set DENEXT_WINDOWS_CERT to a .pfx for osslsigncode",
      );
    }
    await osslsign(binary, cert, timestamp, ctx);
  }
  return { signed: true, detail: `Authenticode-signed (${tool}, timestamp ${timestamp})` };
}

/** osslsigncode writes a signed copy: sign into a sibling, then replace the binary with it. */
async function osslsign(
  binary: string,
  cert: Extract<WindowsCertificate, { kind: "pfx" }>,
  timestamp: string,
  ctx: SignRun,
): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: dirname(binary), prefix: ".denext-sign-" });
  const signed = join(dir, "signed.exe");
  let passFile: string | undefined;
  try {
    if (cert.password) {
      passFile = join(dir, "pass");
      await Deno.writeTextFile(passFile, cert.password, { mode: 0o600 });
    }
    await runOrThrow(
      ctx.run,
      osslsigncodeArgs(binary, signed, cert.path, passFile, timestamp),
      windowsCertificateSecrets(cert),
    );
    await Deno.rename(signed, binary);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

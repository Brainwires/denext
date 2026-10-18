// The code-signing primitives `denext desktop package` (its scaffolded scripts, through
// `denext/desktop`) and `denext build --compile --sign` share: the argv of `codesign`,
// `xcrun notarytool`, `signtool` and `osslsigncode`, the credentials each reads from the
// environment, and the readiness report `denext doctor` and `denext ui` show.
//
// Credentials come from the environment only and are never printed. The variables:
//
//   DENEXT_CODESIGN_IDENTITY        a "Developer ID Application: Name (TEAMID)" identity (macOS)
//   DENEXT_ENTITLEMENTS             an entitlements plist merged under the defaults (macOS)
//   DENEXT_NOTARY_PROFILE           an `xcrun notarytool store-credentials` keychain profile, or
//   DENEXT_NOTARY_KEY               an App Store Connect API key (.p8 path), with
//   DENEXT_NOTARY_KEY_ID            its key id and
//   DENEXT_NOTARY_ISSUER            its issuer id (a team key; an individual key has none)
//   DENEXT_WINDOWS_CERT             a .pfx code-signing certificate (Windows), or
//   DENEXT_WINDOWS_CERT_THUMBPRINT  the SHA-1 thumbprint of one in the Windows certificate store
//                                   (signtool only; `denext build --compile --sign`)
//   DENEXT_WINDOWS_CERT_PASSWORD    the .pfx password
//   DENEXT_SIGN_TIMESTAMP_URL       the RFC-3161 timestamp server (default DigiCert's)

/** Reads one environment variable (tests pass a map). */
export type SigningEnv = (name: string) => string | undefined;

/** `Deno.env.get`, `undefined` for an empty value or without `--allow-env`. */
export function processSigningEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** The RFC-3161 timestamp server used when `DENEXT_SIGN_TIMESTAMP_URL` is unset. */
export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

/** Options for {@linkcode macosCodesignArgs}. */
export interface MacosCodesignOptions {
  /** The identity; `undefined` or `"-"` signs ad-hoc (no secure timestamp). */
  readonly identity?: string;
  /** The Hardened Runtime (`--options runtime`); default: with a real identity. */
  readonly hardened?: boolean;
  /** The entitlement flags (`["--entitlements", plist]`, `["--preserve-metadata=entitlements"]`). */
  readonly entitlementArgs?: readonly string[];
  /** `--identifier` for the code, when it must not be named after the file. */
  readonly identifier?: string;
}

/** Whether `identity` asks for an ad-hoc signature. */
function adHoc(identity: string | undefined): boolean {
  return identity === undefined || identity === "-";
}

/**
 * The `codesign` argv that signs `path`: `--force`, a secure timestamp with a real identity
 * (`--timestamp=none` ad-hoc), the Hardened Runtime, the entitlements, then `-s <identity>`.
 *
 * @param path The code to sign (a Mach-O, or a bundle).
 * @param options The identity, the Hardened Runtime, the entitlements and the identifier.
 * @returns The argv, `codesign` first.
 */
export function macosCodesignArgs(path: string, options: MacosCodesignOptions = {}): string[] {
  const real = !adHoc(options.identity);
  const hardened = options.hardened ?? real;
  return [
    "codesign",
    "--force",
    real ? "--timestamp" : "--timestamp=none",
    ...(hardened ? ["--options", "runtime"] : []),
    ...(options.entitlementArgs ?? []),
    ...(options.identifier ? ["--identifier", options.identifier] : []),
    "-s",
    options.identity ?? "-",
    path,
  ];
}

/** How `xcrun notarytool` authenticates: a keychain profile, or an App Store Connect API key. */
export type NotaryCredentials =
  | { readonly kind: "keychain-profile"; readonly profile: string }
  | {
    readonly kind: "api-key";
    /** The `.p8` key file. */
    readonly key: string;
    readonly keyId: string;
    /** The issuer id (a team key); an individual key has none. */
    readonly issuer?: string;
  };

/**
 * The notary credentials in the environment: `DENEXT_NOTARY_PROFILE`, else the API key
 * (`DENEXT_NOTARY_KEY` + `DENEXT_NOTARY_KEY_ID`, `DENEXT_NOTARY_ISSUER` for a team key).
 *
 * @param env Reads a variable.
 * @returns The credentials, or `undefined` when none are set.
 */
export function notaryCredentials(
  env: SigningEnv = processSigningEnv,
): NotaryCredentials | undefined {
  const profile = env("DENEXT_NOTARY_PROFILE");
  if (profile) return { kind: "keychain-profile", profile };
  const key = env("DENEXT_NOTARY_KEY");
  const keyId = env("DENEXT_NOTARY_KEY_ID");
  if (!key || !keyId) return undefined;
  const issuer = env("DENEXT_NOTARY_ISSUER");
  return { kind: "api-key", key, keyId, ...(issuer ? { issuer } : {}) };
}

/** `notarytool`'s authentication flags for `credentials`. */
function notaryAuthArgs(credentials: NotaryCredentials): string[] {
  if (credentials.kind === "keychain-profile") return ["--keychain-profile", credentials.profile];
  return [
    "--key",
    credentials.key,
    "--key-id",
    credentials.keyId,
    ...(credentials.issuer ? ["--issuer", credentials.issuer] : []),
  ];
}

/**
 * The `xcrun notarytool submit … --wait` argv for `file` (a .zip, .dmg or .pkg).
 *
 * @param file The submission.
 * @param credentials The keychain profile or API key.
 * @param json Ask for the result as JSON (`--output-format json`).
 * @returns The argv, `xcrun` first.
 */
export function notarytoolSubmitArgs(
  file: string,
  credentials: NotaryCredentials,
  json = false,
): string[] {
  return [
    "xcrun",
    "notarytool",
    "submit",
    file,
    ...notaryAuthArgs(credentials),
    "--wait",
    ...(json ? ["--output-format", "json"] : []),
  ];
}

/** What `notarytool submit --output-format json` reported. */
export interface NotaryResult {
  /** The submission id (`notarytool log <id>` explains a rejection). */
  readonly id: string;
  /** `Accepted`, `Invalid`, `Rejected`, … */
  readonly status: string;
  readonly message: string;
}

/**
 * Read `notarytool submit --output-format json`'s output.
 *
 * @param stdout The command's stdout.
 * @returns The result, or `undefined` when it printed no JSON object.
 */
export function parseNotaryResult(stdout: string): NotaryResult | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    const json = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    const str = (k: string) => typeof json[k] === "string" ? json[k] as string : "";
    return str("status")
      ? { id: str("id"), status: str("status"), message: str("message") }
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────

/** An Authenticode certificate: a `.pfx` file, or a thumbprint in the Windows store. */
export type WindowsCertificate =
  | { readonly kind: "pfx"; readonly path: string; readonly password?: string }
  | { readonly kind: "thumbprint"; readonly sha1: string };

/**
 * The Windows certificate in the environment: `DENEXT_WINDOWS_CERT` (+ its password), else,
 * when `thumbprint` allows it, `DENEXT_WINDOWS_CERT_THUMBPRINT`.
 *
 * @param env Reads a variable.
 * @param thumbprint Whether a store thumbprint is accepted (signtool only).
 * @returns The certificate, or `undefined` when none is set.
 */
export function windowsCertificate(
  env: SigningEnv = processSigningEnv,
  thumbprint = true,
): WindowsCertificate | undefined {
  const path = env("DENEXT_WINDOWS_CERT");
  if (path) {
    const password = env("DENEXT_WINDOWS_CERT_PASSWORD");
    return { kind: "pfx", path, ...(password ? { password } : {}) };
  }
  const sha1 = thumbprint ? env("DENEXT_WINDOWS_CERT_THUMBPRINT") : undefined;
  return sha1 ? { kind: "thumbprint", sha1: sha1.replace(/\s+/g, "") } : undefined;
}

/** The secrets a certificate's argv may carry (redacted from a failure message). */
export function windowsCertificateSecrets(cert: WindowsCertificate): string[] {
  return cert.kind === "pfx" && cert.password ? [cert.password] : [];
}

/**
 * The `signtool sign` argv for `files`: SHA-256 digests, an RFC-3161 timestamp, the certificate
 * (`/f <pfx>` [+ `/p <password>`], or `/sha1 <thumbprint>` from the store).
 *
 * @param files The PE files (or .msi) to sign.
 * @param cert The certificate.
 * @param timestamp The timestamp server.
 * @returns The argv, `signtool` first.
 */
export function signtoolArgs(
  files: readonly string[],
  cert: WindowsCertificate,
  timestamp: string = DEFAULT_TIMESTAMP_URL,
): string[] {
  const certArgs = cert.kind === "pfx" ? ["/f", cert.path] : ["/sha1", cert.sha1];
  const args = [
    "signtool",
    "sign",
    ...certArgs,
    "/fd",
    "sha256",
    "/tr",
    timestamp,
    "/td",
    "sha256",
  ];
  if (cert.kind === "pfx" && cert.password) args.push("/p", cert.password);
  return [...args, ...files];
}

/**
 * The `osslsigncode sign` argv (macOS / Linux) that signs `input` into `output`: the `.pfx`, its
 * password READ FROM A FILE (`-readpass`, so it is on no command line), SHA-256, an RFC-3161
 * timestamp (`-ts`).
 *
 * @param input The unsigned PE file.
 * @param output Where the signed copy goes.
 * @param pfx The `.pfx` path.
 * @param passwordFile A file holding the password, or `undefined` for none.
 * @param timestamp The timestamp server.
 * @returns The argv, `osslsigncode` first.
 */
export function osslsigncodeArgs(
  input: string,
  output: string,
  pfx: string,
  passwordFile: string | undefined,
  timestamp: string = DEFAULT_TIMESTAMP_URL,
): string[] {
  return [
    "osslsigncode",
    "sign",
    "-pkcs12",
    pfx,
    ...(passwordFile ? ["-readpass", passwordFile] : []),
    "-h",
    "sha256",
    "-ts",
    timestamp,
    "-in",
    input,
    "-out",
    output,
  ];
}

/** The Authenticode tool for this host: signtool on Windows, osslsigncode elsewhere. */
export type WindowsSignTool = "signtool" | "osslsigncode";

/**
 * Which Authenticode tool signs here: `signtool` on a Windows host that has it, else
 * `osslsigncode` when it is on PATH.
 *
 * @param has Whether a program is on PATH.
 * @param os The host OS.
 * @returns The tool, or `undefined` when neither is available.
 */
export async function windowsSignTool(
  has: (cmd: string) => Promise<boolean>,
  os: string = Deno.build.os,
): Promise<WindowsSignTool | undefined> {
  if (os === "windows" && await has("signtool")) return "signtool";
  return await has("osslsigncode") ? "osslsigncode" : undefined;
}

// ── readiness ────────────────────────────────────────────────────────────────────────────────

/** What this machine has for signing, as `denext doctor` and `denext ui` report it. */
export interface SigningReadiness {
  readonly macos: {
    /** `DENEXT_CODESIGN_IDENTITY` (a name, not a secret), or `null`. */
    readonly identity: string | null;
    /** Whether the keychain holds it: `null` when unknowable (no identity, ad-hoc, not macOS). */
    readonly identityFound: boolean | null;
    /** Which notary credentials are set, or `null`. */
    readonly notary: NotaryCredentials["kind"] | null;
    /** `codesign` on PATH. */
    readonly codesign: boolean;
  };
  readonly windows: {
    /** Which certificate is set, or `null`. */
    readonly certificate: WindowsCertificate["kind"] | null;
    /** `signtool` on PATH. */
    readonly signtool: boolean;
    /** `osslsigncode` on PATH. */
    readonly osslsigncode: boolean;
  };
}

/** The probes {@linkcode signingReadiness} runs (tests pass fakes). */
export interface SigningReadinessDeps {
  readonly env?: SigningEnv;
  readonly has: (cmd: string) => Promise<boolean>;
  /** The keychain's Developer ID identities (names and SHA-1s). */
  readonly identities: () => Promise<
    ReadonlyArray<{ readonly name: string; readonly sha1: string }>
  >;
  readonly os?: string;
}

/**
 * This machine's signing readiness. Reads no secret: a password is only checked for presence by
 * the caller's environment reader, and nothing here returns one.
 *
 * @param deps The environment, PATH and keychain probes.
 * @returns The readiness.
 */
export async function signingReadiness(deps: SigningReadinessDeps): Promise<SigningReadiness> {
  const env = deps.env ?? processSigningEnv;
  const os = deps.os ?? Deno.build.os;
  const identity = env("DENEXT_CODESIGN_IDENTITY") ?? null;
  let identityFound: boolean | null = null;
  if (identity && identity !== "-" && os === "darwin") {
    const ids = await deps.identities();
    const wanted = identity.toUpperCase();
    identityFound = ids.some((id) => id.name === identity || id.sha1.toUpperCase() === wanted);
  }
  return {
    macos: {
      identity,
      identityFound,
      notary: notaryCredentials(env)?.kind ?? null,
      codesign: await deps.has("codesign"),
    },
    windows: {
      certificate: windowsCertificate(env)?.kind ?? null,
      signtool: await deps.has("signtool"),
      osslsigncode: await deps.has("osslsigncode"),
    },
  };
}

/** The macOS identity, as a phrase. */
function identityPhrase(macos: SigningReadiness["macos"]): string {
  if (macos.identity === null) return "no DENEXT_CODESIGN_IDENTITY";
  if (macos.identity === "-") return "ad-hoc identity";
  const where = macos.identityFound === null
    ? ""
    : macos.identityFound
    ? " (in the keychain)"
    : " (NOT in the keychain)";
  return `identity ${JSON.stringify(macos.identity)}${where}`;
}

/** What each certificate / credential kind reads as. */
const KIND_PHRASE: Record<string, string> = {
  "keychain-profile": "notary keychain profile",
  "api-key": "notary API key",
  pfx: "a .pfx certificate",
  thumbprint: "a store thumbprint",
};

/**
 * The readiness as lines (`denext doctor`'s detail).
 *
 * @param r The readiness.
 * @returns One line per platform.
 */
export function signingReadinessLines(r: SigningReadiness): string[] {
  const notary = r.macos.notary === null ? "no notary credentials" : KIND_PHRASE[r.macos.notary];
  const cert = r.windows.certificate === null
    ? "no DENEXT_WINDOWS_CERT"
    : KIND_PHRASE[r.windows.certificate];
  const tools = [r.windows.signtool && "signtool", r.windows.osslsigncode && "osslsigncode"]
    .filter(Boolean).join(" + ") || "no signtool / osslsigncode";
  return [
    `macOS: ${identityPhrase(r.macos)}, ${notary}, codesign ${
      r.macos.codesign ? "found" : "missing"
    }`,
    `Windows: ${cert}, ${tools}`,
  ];
}

/**
 * Whether this host can sign a binary for its own OS (the doctor check's verdict): macOS needs an
 * identity in the keychain (or ad-hoc) and codesign; Windows a certificate and signtool; Linux, a
 * cross-signing host for Windows targets, a `.pfx` and osslsigncode.
 *
 * @param r The readiness.
 * @param os The host OS.
 * @returns Whether it is ready.
 */
export function signingReady(r: SigningReadiness, os: string = Deno.build.os): boolean {
  if (os === "darwin") {
    return r.macos.identity !== null && r.macos.identityFound !== false && r.macos.codesign;
  }
  if (os === "windows") return r.windows.certificate !== null && r.windows.signtool;
  return r.windows.certificate === "pfx" && r.windows.osslsigncode;
}

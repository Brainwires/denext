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
 * (`/f <pfx>`, or `/sha1 <thumbprint>` from the user's store). A password never goes on the
 * command line, where any process listing shows it: a password-protected `.pfx` is signed with
 * through {@linkcode withSigntoolCertificate}, which imports it and hands this a thumbprint.
 *
 * @param files The PE files (or .msi) to sign.
 * @param cert The certificate.
 * @param timestamp The timestamp server.
 * @returns The argv, `signtool` first.
 * @throws {Error} For a `.pfx` with a password (signtool would take it only as `/p`).
 */
export function signtoolArgs(
  files: readonly string[],
  cert: WindowsCertificate,
  timestamp: string = DEFAULT_TIMESTAMP_URL,
): string[] {
  if (cert.kind === "pfx" && cert.password) {
    throw new Error(
      "signtool takes a .pfx password only on its command line: sign through " +
        "withSigntoolCertificate(), which imports the .pfx and signs by thumbprint",
    );
  }
  const certArgs = cert.kind === "pfx" ? ["/f", cert.path] : ["/sha1", cert.sha1];
  return [
    "signtool",
    "sign",
    ...certArgs,
    "/fd",
    "sha256",
    "/tr",
    timestamp,
    "/td",
    "sha256",
    ...files,
  ];
}

/** What a {@linkcode StoreCommandRunner} saw a command do. */
export interface StoreCommandResult {
  /** The exit code. */
  readonly code: number;
  /** What it printed on stdout. */
  readonly stdout: string;
  /** What it printed on stderr. */
  readonly stderr: string;
}

/** Runs `cmd` with `stdin` as its standard input (tests pass a fake). */
export type StoreCommandRunner = (
  cmd: readonly string[],
  stdin: string,
) => Promise<StoreCommandResult>;

/** Runs `cmd` to its exit, synchronously (a signal handler's cleanup; tests pass a fake). */
export type StoreCommandRunnerSync = (cmd: readonly string[]) => void;

/** `powershell.exe -EncodedCommand` for `script` (UTF-16LE base64: no quoting to get wrong). */
export function powershellArgs(script: string): string[] {
  const utf16 = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    utf16[i * 2] = c & 0xff;
    utf16[i * 2 + 1] = c >> 8;
  }
  let binary = "";
  for (const b of utf16) binary += String.fromCharCode(b);
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    btoa(binary),
  ];
}

/** `value` as a single-quoted PowerShell string. */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A PowerShell function that deletes the persisted private key of `$c` (a certificate the store
 * import put there): a CNG key through `CngKey.Delete`, a CryptoAPI one by clearing it with
 * `PersistKeyInCsp` off. .NET only, so it needs no PowerShell module.
 */
const DELETE_KEY_FUNCTION = [
  "function Remove-DenextKey($c) {",
  "  if (-not $c.HasPrivateKey) { return }",
  "  $k = $null",
  "  try { $k = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::" +
  "GetRSAPrivateKey($c) } catch { }",
  "  if ($null -eq $k) { try { $k = [Security.Cryptography.X509Certificates." +
  "ECDsaCertificateExtensions]::GetECDsaPrivateKey($c) } catch { } }",
  "  if ($k -is [Security.Cryptography.RSACryptoServiceProvider]) " +
  "{ $k.PersistKeyInCsp = $false; $k.Clear() }",
  "  elseif ($null -ne $k -and $k.Key -is [Security.Cryptography.CngKey]) { $k.Key.Delete() }",
  "}",
].join("\n");

/**
 * The PowerShell that imports the `.pfx` at `path` into the user's `My` store (its key not
 * exportable), the password read from stdin (base64 of its UTF-8 bytes), never from argv. It
 * prints `{ "sha1": <the signing certificate's thumbprint>, "added": [<thumbprints it added>] }`:
 * a certificate the store already held is left as it is and is not in `added`, so removing those
 * never takes one the user had.
 *
 * The script calls .NET (`X509Certificate2Collection`, `X509Store`) and no cmdlet, so it needs no
 * PowerShell module: Windows PowerShell started from PowerShell 7 inherits 7's `PSModulePath`,
 * and then cannot load its own `Microsoft.PowerShell.Security` (`ConvertTo-SecureString`, the
 * `Cert:` drive) or `PKI` (`Import-PfxCertificate`) modules.
 */
export function storeImportScript(path: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    DELETE_KEY_FUNCTION,
    "$raw = [Console]::In.ReadToEnd().Trim()",
    "$pw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw))",
    `$path = ${psQuote(path)}`,
    "$F = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]",
    "$certs = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()",
    "$certs.Import([IO.File]::ReadAllBytes($path), $pw, ($F::PersistKeySet -bor $F::UserKeySet))",
    "$store = [Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')",
    "$store.Open('ReadWrite')",
    "$before = @{}",
    "foreach ($s in $store.Certificates) { $before[$s.Thumbprint] = $true }",
    "$added = @()",
    "$signer = $null",
    "try {",
    "  foreach ($c in $certs) {",
    "    if ($null -eq $signer -and $c.HasPrivateKey) { $signer = $c.Thumbprint }",
    // A certificate the store already holds keeps its own entry and key; the key this import
    // persisted for it (a fresh container) is deleted.
    "    if ($before.ContainsKey($c.Thumbprint)) { Remove-DenextKey $c }",
    "    else { $store.Add($c); $added += $c.Thumbprint }",
    "  }",
    "  if ($null -eq $signer) { throw 'the .pfx holds no certificate with a private key' }",
    "} catch {",
    "  foreach ($c in $certs) {",
    "    if ($added -contains $c.Thumbprint) { try { $store.Remove($c) } catch { } }",
    "    if (-not $before.ContainsKey($c.Thumbprint)) { try { Remove-DenextKey $c } catch { } }",
    "  }",
    "  throw",
    "} finally { $store.Close() }",
    "$quoted = @()",
    "foreach ($t in $added) { $quoted += '\"' + $t + '\"' }",
    '[Console]::Out.WriteLine(\'{"sha1":"\' + $signer + \'","added":[\' + ' +
    "($quoted -join ',') + ']}')",
  ].join("\n");
}

/**
 * The PowerShell that removes the store certificates (and their keys) `thumbprints` names. .NET
 * only, no cmdlet, like {@linkcode storeImportScript}.
 */
export function storeRemoveScript(thumbprints: readonly string[]): string {
  const list = thumbprints.map(psQuote).join(", ");
  return [
    "$ErrorActionPreference = 'Continue'",
    DELETE_KEY_FUNCTION,
    "$store = [Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')",
    "$store.Open('ReadWrite')",
    "try {",
    `  foreach ($t in @(${list})) {`,
    "    foreach ($c in @($store.Certificates.Find('FindByThumbprint', $t, $false))) {",
    "      try { Remove-DenextKey $c } catch { }",
    "      $store.Remove($c)",
    "    }",
    "  }",
    "} finally { $store.Close() }",
  ].join("\n");
}

/** A certificate thumbprint as signtool and the store spell it (40 hex digits). */
const THUMBPRINT = /^[0-9A-F]{40}$/;

/** Read the import script's answer; throws on anything but thumbprints. */
function parseImport(stdout: string): { sha1: string; added: string[] } {
  const start = stdout.indexOf("{");
  const json = JSON.parse(start < 0 ? stdout : stdout.slice(start)) as {
    sha1?: unknown;
    added?: unknown;
  };
  const sha1 = String(json.sha1 ?? "").toUpperCase();
  const added = (Array.isArray(json.added) ? json.added : json.added ? [json.added] : [])
    .map((t) => String(t).toUpperCase());
  if (!THUMBPRINT.test(sha1) || !added.every((t) => THUMBPRINT.test(t))) {
    throw new Error(`unexpected import result: ${stdout.trim()}`);
  }
  return { sha1, added };
}

/** The default store runner: the command, `stdin` piped in, its output captured. */
const defaultStoreRun: StoreCommandRunner = async (cmd, stdin) => {
  const child = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const out = await child.output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
};

/** The default synchronous runner (output discarded). */
const defaultStoreRunSync: StoreCommandRunnerSync = (cmd) => {
  try {
    new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).outputSync();
  } catch { /* best effort */ }
};

/** The seams of {@linkcode withSigntoolCertificate} (tests pass fakes). */
export interface SigntoolCertificateDeps {
  /** Runs the import / removal (default: the process, stdin piped). */
  readonly run?: StoreCommandRunner;
  /** Runs the removal from a signal handler (default: the process, synchronously). */
  readonly runSync?: StoreCommandRunnerSync;
}

/** The exit code a shell reports for a process ended by `signal`. */
const SIGNAL_EXIT: Partial<Record<Deno.Signal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
};

/**
 * Run `cleanup` (synchronously) and exit when the process is interrupted or terminated, until the
 * returned function removes the listeners: a `finally` does not run when a signal ends the
 * process.
 *
 * @param cleanup What to undo.
 * @returns Removes the listeners.
 */
export function cleanupOnSignal(cleanup: () => void): () => void {
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  const added: [Deno.Signal, () => void][] = [];
  for (const signal of signals) {
    const listener = () => {
      cleanup();
      Deno.exit(SIGNAL_EXIT[signal] ?? 1);
    };
    try {
      Deno.addSignalListener(signal, listener);
      added.push([signal, listener]);
    } catch { /* not a signal this platform delivers */ }
  }
  return () => {
    for (const [signal, listener] of added) Deno.removeSignalListener(signal, listener);
  };
}

/**
 * Sign with `cert` through signtool without its password ever reaching a command line. A
 * password-protected `.pfx` is imported into the user's certificate store (`CurrentUser\My`, key
 * not exportable) by PowerShell (through .NET, no PowerShell module), which reads the password
 * from stdin; `sign` then gets the
 * certificate as a store thumbprint (`/sha1`), and every certificate the import added is removed
 * again, with its key, when `sign` settles, fails, or the process is interrupted. Any other
 * certificate (a `.pfx` with no password, a thumbprint) is handed to `sign` as it is.
 *
 * @param cert The certificate.
 * @param sign Runs signtool with the certificate it is given.
 * @param deps The PowerShell runners.
 * @returns What `sign` returned.
 * @throws {Error} When the import fails (the password is never in the message).
 */
export async function withSigntoolCertificate<T>(
  cert: WindowsCertificate,
  sign: (cert: WindowsCertificate) => Promise<T>,
  deps: SigntoolCertificateDeps = {},
): Promise<T> {
  if (cert.kind !== "pfx" || !cert.password) return await sign(cert);
  const run = deps.run ?? defaultStoreRun;
  const runSync = deps.runSync ?? defaultStoreRunSync;
  const password = btoa(String.fromCharCode(...new TextEncoder().encode(cert.password)));
  const imported = await run(powershellArgs(storeImportScript(cert.path)), password);
  if (imported.code !== 0) {
    const said = (imported.stderr || imported.stdout).trim().split("\n").slice(-5).join("\n");
    throw new Error(
      `could not import ${cert.path} into the user's certificate store for signtool ` +
        `(exit ${imported.code})${said ? `:\n${said.replaceAll(cert.password, "***")}` : ""}`,
    );
  }
  const { sha1, added } = parseImport(imported.stdout);
  const remove = powershellArgs(storeRemoveScript(added));
  const stopCleanup = added.length > 0 ? cleanupOnSignal(() => runSync(remove)) : () => {};
  try {
    return await sign({ kind: "thumbprint", sha1 });
  } finally {
    stopCleanup();
    if (added.length > 0) await run(remove, "");
  }
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

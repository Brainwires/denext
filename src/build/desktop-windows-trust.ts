// Whether Windows trusts a CEF app's Authenticode signature. CEF's bootstrap (the `<App>.exe` of a
// sandboxed Windows CEF app) checks its own signature with WinVerifyTrust before it loads the app,
// and a signature that does not chain to a root the machine trusts ends the process at launch
// with a FATAL error: a CEF build signed with a self-signed or test certificate does not start on
// any machine that does not trust that certificate. An unsigned build starts. The webview backend
// does no such check.
//
// Both probes run PowerShell (Windows only): `Get-AuthenticodeSignature` reads a signed file's
// status through WinVerifyTrust, and an X509Chain build (revocation not checked) says whether a
// certificate chains to a trusted root. The certificate's password reaches PowerShell through the
// child's environment, never its command line.

/** Runs a PowerShell script with extra environment; `null` when PowerShell did not run. */
export type PowerShellRunner = (
  script: string,
  env: Record<string, string>,
) => Promise<{ readonly code: number; readonly stdout: string } | null>;

/** The default runner: `powershell.exe -EncodedCommand`, killed after 20 s. */
const defaultPowerShell: PowerShellRunner = async (script, env) => {
  // -EncodedCommand takes UTF-16LE base64, so the script needs no command-line quoting.
  const utf16 = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    utf16[2 * i] = c & 0xff;
    utf16[2 * i + 1] = c >> 8;
  }
  let binary = "";
  for (const b of utf16) binary += String.fromCharCode(b);
  try {
    const out = await new Deno.Command("powershell.exe", {
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", btoa(binary)],
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(20_000),
    }).output();
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return null;
  }
};

/** A file's Authenticode signature, as `Get-AuthenticodeSignature` reports it. */
export interface AuthenticodeSignature {
  /** `Valid`, `NotSigned`, `UnknownError` (an untrusted root), `NotTrusted`, `HashMismatch`, … */
  readonly status: string;
  readonly message: string;
}

/** Whether a certificate chains to a root this machine trusts. */
export interface CertificateTrust {
  readonly trusted: boolean;
  /** The certificate's subject (`CN=…`). */
  readonly subject: string;
  /** Whether it issued itself (a self-signed certificate). */
  readonly selfSigned: boolean;
  /** The chain's problems (`UntrustedRoot`, `PartialChain`, …), empty when trusted. */
  readonly problems: readonly string[];
}

/** Seams for the probes (tests stub them). */
export interface WindowsTrustDeps {
  /** The host OS (default `Deno.build.os`); the probes run on Windows only. */
  readonly os?: string;
  /** Runs PowerShell (default {@linkcode defaultPowerShell}). */
  readonly powershell?: PowerShellRunner;
  /** Prints a warning (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

const SIGNATURE_SCRIPT = `$s = Get-AuthenticodeSignature -LiteralPath $env:DENEXT_TRUST_FILE
@{ status = $s.Status.ToString(); message = [string]$s.StatusMessage } | ConvertTo-Json -Compress`;

const CERTIFICATE_SCRIPT = `$ErrorActionPreference = 'Stop'
$X = 'System.Security.Cryptography.X509Certificates'
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$c = New-Object "$X.X509Certificate2" -ArgumentList $env:DENEXT_TRUST_CERT, ([string]$env:DENEXT_TRUST_PASSWORD), $flags
$ch = New-Object "$X.X509Chain"
$ch.ChainPolicy.RevocationMode = 'NoCheck'
$ok = $ch.Build($c)
@{ trusted = $ok; subject = $c.Subject; selfSigned = ($c.Subject -eq $c.Issuer); problems = @($ch.ChainStatus | ForEach-Object { $_.Status.ToString() }) } | ConvertTo-Json -Compress`;

/** The JSON object a probe printed, or `null`. */
async function probe(
  script: string,
  env: Record<string, string>,
  deps: WindowsTrustDeps,
): Promise<Record<string, unknown> | null> {
  if ((deps.os ?? Deno.build.os) !== "windows") return null;
  const out = await (deps.powershell ?? defaultPowerShell)(script, env);
  if (!out || out.code !== 0) return null;
  try {
    const json = JSON.parse(out.stdout.trim());
    return typeof json === "object" && json !== null ? json : null;
  } catch {
    return null;
  }
}

/**
 * `file`'s Authenticode signature as Windows sees it.
 *
 * @param file A PE file.
 * @param deps Seams.
 * @returns The status, or `null` off Windows or when the probe failed.
 */
export async function authenticodeSignature(
  file: string,
  deps: WindowsTrustDeps = {},
): Promise<AuthenticodeSignature | null> {
  const json = await probe(SIGNATURE_SCRIPT, { DENEXT_TRUST_FILE: file }, deps);
  if (!json || typeof json.status !== "string") return null;
  return { status: json.status, message: typeof json.message === "string" ? json.message : "" };
}

/**
 * Whether the certificate in `cert` (a `.pfx`) chains to a root this machine trusts.
 *
 * @param cert The `.pfx` path (`DENEXT_WINDOWS_CERT`).
 * @param password Its password (`DENEXT_WINDOWS_CERT_PASSWORD`).
 * @param deps Seams.
 * @returns The answer, or `null` off Windows or when the certificate could not be read.
 */
export async function certificateTrust(
  cert: string,
  password: string | undefined,
  deps: WindowsTrustDeps = {},
): Promise<CertificateTrust | null> {
  const json = await probe(
    CERTIFICATE_SCRIPT,
    { DENEXT_TRUST_CERT: cert, DENEXT_TRUST_PASSWORD: password ?? "" },
    deps,
  );
  if (!json || typeof json.trusted !== "boolean") return null;
  const problems = Array.isArray(json.problems)
    ? json.problems.filter((p): p is string => typeof p === "string")
    : [];
  return {
    trusted: json.trusted,
    subject: typeof json.subject === "string" ? json.subject : "",
    selfSigned: json.selfSigned === true,
    problems,
  };
}

/** What CEF's bootstrap does with an untrusted signature, for the messages. */
const CEF_BOOTSTRAP_DIES = "CEF's bootstrap checks the app's Authenticode signature with " +
  "WinVerifyTrust and exits at launch with a FATAL error when it does not chain to a trusted root";

/** The fix for an untrusted CEF signature. */
export const CEF_SIGNING_FIX = "sign CEF builds with a code-signing certificate from a CA the " +
  "target machines trust; to test locally, package with --no-sign (an unsigned CEF app starts)";

/**
 * Why a CEF app whose `<App>.exe` has `signature` will not start here, or `undefined` when it
 * will (a valid signature, or none).
 *
 * @param signature The executable's signature.
 * @returns The problem, or `undefined`.
 */
export function cefSignatureProblem(signature: AuthenticodeSignature): string | undefined {
  if (signature.status === "Valid" || signature.status === "NotSigned") return undefined;
  const why = signature.message ? `: ${signature.message}` : "";
  return `the CEF app's executable is signed, but Windows does not trust the signature ` +
    `(${signature.status}${why}). ${CEF_BOOTSTRAP_DIES}, so this build will not start on this ` +
    "machine, or on any machine that does not trust the certificate.";
}

/**
 * Why signing a CEF app with `trust`'s certificate makes an app that will not start here, or
 * `undefined` when the certificate is trusted.
 *
 * @param trust The certificate's trust.
 * @returns The problem, or `undefined`.
 */
export function cefCertificateProblem(trust: CertificateTrust): string | undefined {
  if (trust.trusted) return undefined;
  const kind = trust.selfSigned ? "a self-signed certificate" : "a certificate";
  const problems = trust.problems.length ? ` (${trust.problems.join(", ")})` : "";
  return `DENEXT_WINDOWS_CERT is ${kind} this machine does not trust${problems}: ` +
    `${trust.subject || "no subject"}. ${CEF_BOOTSTRAP_DIES}, so a CEF build signed with it ` +
    "will not start here, or on any machine that does not trust it.";
}

/**
 * After signing a CEF app on Windows: warn when the signed `<App>.exe` will not start here
 * ({@linkcode cefSignatureProblem}). Off Windows, or when the probe fails, nothing is said.
 *
 * @param exe The bundle's executable.
 * @param deps Seams.
 * @returns Whether the executable's signature is fine (`true` when it could not be checked).
 */
export async function desktopCheckCefSignature(
  exe: string,
  deps: WindowsTrustDeps = {},
): Promise<boolean> {
  const signature = await authenticodeSignature(exe, deps);
  const problem = signature ? cefSignatureProblem(signature) : undefined;
  if (!problem) return true;
  (deps.warn ?? ((m: string) => console.warn(m)))(`  ⚠ ${problem}\n    fix: ${CEF_SIGNING_FIX}`);
  return false;
}

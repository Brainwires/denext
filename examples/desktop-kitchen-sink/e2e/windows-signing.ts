// Windows Authenticode helpers for the window test's signing phases (`e2e/window-test.ts`): two
// throwaway self-signed code-signing certificates created at test time in CurrentUser\My (exported
// to temporary .pfx files whose random passwords live only in this process and the child
// environments that need them), the signer of each PE file read back with
// `Get-AuthenticodeSignature`, and, on an elevated runner that opted in, the certificates trusted
// machine-wide (LocalMachine\Root + TrustedPublisher) for the trusted-update phases, then removed.
//
// Nothing here touches CurrentUser\Root (adding to it asks the user in a dialog), and every removal
// matches the thumbprints this run created, never anything else in a store.

import { join } from "@std/path";

/** One throwaway code-signing certificate. */
export interface TestCert {
  /** `A` or `B`. */
  readonly label: string;
  /** Its subject, `CN=...`. */
  readonly subject: string;
  readonly thumbprint: string;
  /** The exported .pfx (with its private key). */
  readonly pfx: string;
  /** The .pfx password: random, never printed or put on a command line here. */
  readonly password: string;
  /** The exported public certificate (.cer), for trusting it. */
  readonly cer: string;
}

/** The signature of one file as Windows reads it. */
export interface FileSignature {
  readonly path: string;
  /** `Get-AuthenticodeSignature`'s Status (`Valid`, `UnknownError` for an untrusted root, ...). */
  readonly status: string;
  /** The signer certificate's thumbprint, or `null` when the file is unsigned. */
  readonly thumbprint: string | null;
  /** Whether the signature carries a timestamp countersignature. */
  readonly timestamped: boolean;
}

/** Run a PowerShell script (written to `dir`) with extra environment; its stdout, trimmed. */
async function powershell(
  dir: string,
  name: string,
  script: string,
  env: Record<string, string> = {},
): Promise<string> {
  const file = join(dir, `${name}.ps1`);
  await Deno.writeTextFile(file, `$ErrorActionPreference = 'Stop'\n${script}\n`);
  const out = await new Deno.Command("powershell.exe", {
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout).trim();
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`powershell ${name} failed (${out.code}): ${err || text}`);
  }
  return text;
}

/** A random password (base64url, 32 characters): only this process and its children see it. */
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Create a self-signed code-signing certificate in CurrentUser\My and export it to `dir` as a
 * password-protected .pfx and a .cer.
 *
 * @param dir A private temporary folder.
 * @param label `A` or `B` (part of the subject, so the two certificates differ).
 * @returns The certificate.
 */
export async function createTestCert(dir: string, label: string): Promise<TestCert> {
  const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
  const subject = `CN=denext window test ${label} ${nonce}`;
  const pfx = join(dir, `cert-${label}.pfx`);
  const cer = join(dir, `cert-${label}.cer`);
  const password = randomPassword();
  const thumbprint = await powershell(
    dir,
    `create-${label}`,
    [
      "$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject $env:KS_SUBJECT " +
      "-CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable " +
      "-KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)",
      "$pw = ConvertTo-SecureString -String $env:KS_PFX_PASSWORD -Force -AsPlainText",
      "Export-PfxCertificate -Cert $c -FilePath $env:KS_PFX -Password $pw | Out-Null",
      "Export-Certificate -Cert $c -FilePath $env:KS_CER | Out-Null",
      "Write-Output $c.Thumbprint",
    ].join("\n"),
    { KS_SUBJECT: subject, KS_PFX: pfx, KS_CER: cer, KS_PFX_PASSWORD: password },
  );
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) {
    throw new Error(`New-SelfSignedCertificate returned ${JSON.stringify(thumbprint)}`);
  }
  return { label, subject, thumbprint, pfx, password, cer };
}

/** The thumbprints as one comma-separated environment value (hex only: nothing to escape). */
const thumbList = (certs: readonly TestCert[]) => certs.map((c) => c.thumbprint).join(",");

/**
 * Remove this run's certificates (by thumbprint, with their private keys) from the CurrentUser
 * stores New-SelfSignedCertificate may have written (My, and CA for a self-signed certificate).
 *
 * @param dir A private temporary folder.
 * @param certs The certificates this run created.
 */
export async function removeTestCerts(dir: string, certs: readonly TestCert[]): Promise<void> {
  if (certs.length === 0) return;
  await powershell(
    dir,
    "remove-user",
    [
      "$thumbs = $env:KS_THUMBS -split ','",
      "foreach ($store in 'My', 'CA') {",
      '  Get-ChildItem -Path "Cert:\\CurrentUser\\$store" |',
      "    Where-Object { $thumbs -contains $_.Thumbprint } |",
      "    ForEach-Object { Remove-Item -LiteralPath $_.PSPath -DeleteKey -ErrorAction SilentlyContinue }",
      "}",
    ].join("\n"),
    { KS_THUMBS: thumbList(certs) },
  );
}

/**
 * The Authenticode signature of each file.
 *
 * @param dir A private temporary folder.
 * @param files The files.
 * @returns One signature per file, in order.
 */
export async function fileSignatures(
  dir: string,
  files: readonly string[],
): Promise<FileSignature[]> {
  const list = join(dir, "files.json");
  await Deno.writeTextFile(list, JSON.stringify(files));
  const text = await powershell(
    dir,
    "signatures",
    [
      "$files = Get-Content -Raw -LiteralPath $env:KS_LIST | ConvertFrom-Json",
      "$out = foreach ($f in $files) {",
      "  $s = Get-AuthenticodeSignature -LiteralPath $f",
      "  [pscustomobject]@{",
      "    path = $f",
      '    status = "$($s.Status)"',
      "    thumbprint = $(if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null })",
      "    timestamped = [bool]$s.TimeStamperCertificate",
      "  }",
      "}",
      "ConvertTo-Json -InputObject @($out) -Compress",
    ].join("\n"),
    { KS_LIST: list },
  );
  const parsed = JSON.parse(text) as FileSignature[];
  if (parsed.length !== files.length) {
    throw new Error(`read ${parsed.length} signatures for ${files.length} files`);
  }
  return parsed;
}

/**
 * Whether this process is elevated (an administrator token): only then can it trust a root
 * machine-wide without a dialog.
 *
 * @param dir A private temporary folder.
 * @returns Whether it is elevated.
 */
export async function isElevated(dir: string): Promise<boolean> {
  const text = await powershell(
    dir,
    "elevated",
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  );
  return text === "True";
}

/** The machine stores a trusted test certificate goes into (and comes out of). */
const TRUST_STORES = ["Root", "TrustedPublisher"];

/**
 * Trust the certificates machine-wide (LocalMachine\Root and TrustedPublisher). Elevated only:
 * no dialog. Undo with {@linkcode untrustTestCerts}.
 *
 * @param dir A private temporary folder.
 * @param certs The certificates.
 */
export async function trustTestCerts(dir: string, certs: readonly TestCert[]): Promise<void> {
  await powershell(
    dir,
    "trust",
    [
      "foreach ($cer in ($env:KS_CERS -split ';')) {",
      `  foreach ($store in ${TRUST_STORES.map((s) => `'${s}'`).join(", ")}) {`,
      '    Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\\LocalMachine\\$store" | Out-Null',
      "  }",
      "}",
    ].join("\n"),
    { KS_CERS: certs.map((c) => c.cer).join(";") },
  );
}

/**
 * Remove the certificates from the machine stores {@linkcode trustTestCerts} put them in.
 *
 * @param dir A private temporary folder.
 * @param certs The certificates.
 */
export async function untrustTestCerts(dir: string, certs: readonly TestCert[]): Promise<void> {
  await powershell(
    dir,
    "untrust",
    [
      "$thumbs = $env:KS_THUMBS -split ','",
      `foreach ($store in ${TRUST_STORES.map((s) => `'${s}'`).join(", ")}) {`,
      '  Get-ChildItem -Path "Cert:\\LocalMachine\\$store" |',
      "    Where-Object { $thumbs -contains $_.Thumbprint } |",
      "    ForEach-Object { Remove-Item -LiteralPath $_.PSPath }",
      "}",
    ].join("\n"),
    { KS_THUMBS: thumbList(certs) },
  );
}

/**
 * Put `signtool` on PATH for this process and its children when it is not already: the newest
 * Windows SDK's (GitHub's Windows runners have the SDK but not on PATH).
 *
 * @returns signtool's folder, or `null` when there is no Windows SDK signtool.
 */
export async function ensureSigntool(): Promise<string | null> {
  const where = await new Deno.Command("where.exe", {
    args: ["signtool"],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  if (where?.success) return new TextDecoder().decode(where.stdout).split(/\r?\n/)[0].trim();
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const root = join(
    Deno.env.get("ProgramFiles(x86)") ?? "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  const versions = (await Array.fromAsync(Deno.readDir(root)).catch(() => []))
    .filter((e) => e.isDirectory && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  for (const v of versions) {
    const dir = join(root, v, arch);
    if (await Deno.stat(join(dir, "signtool.exe")).then(() => true, () => false)) {
      Deno.env.set("PATH", `${dir};${Deno.env.get("PATH") ?? ""}`);
      return join(dir, "signtool.exe");
    }
  }
  return null;
}

/**
 * Whether the RFC 3161 timestamp server answers at all (any HTTP response counts).
 *
 * @param url The server.
 * @returns Whether it is reachable within 15 s.
 */
export async function timestampServerReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

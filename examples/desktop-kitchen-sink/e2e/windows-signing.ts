// Windows Authenticode helpers for the window test's signing phases (`e2e/window-test.ts`): two
// throwaway self-signed code-signing certificates created at test time in CurrentUser\My (exported
// to temporary .pfx files whose random passwords live only in this process and the child
// environments that need them), the signer of each PE file read back from its own embedded
// signature, and, on an elevated runner that opted in, the certificates trusted machine-wide
// (LocalMachine\Root + TrustedPublisher) for the trusted-update phases, then removed. A non-admin
// runner can instead hand the test two such certificates it created and trusted for this job
// (`KITCHEN_SINK_TRUSTED_CERTS`, see {@linkcode providedTestCerts}); the test then only reads the
// machine stores.
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
  /**
   * `Get-AuthenticodeSignature` answered from a security catalog, not the file's own signature:
   * it prefers a catalog that lists the file's hash, and the Authenticode hash leaves the
   * signature out, so a re-signed copy of a DLL Windows has a catalog for (the VC++ runtime on a
   * Windows 11 desktop) still reads as Microsoft's. `status` is then the catalog's.
   */
  readonly catalog: boolean;
  /** The embedded signature's signer thumbprint, or `null` when the file carries none. */
  readonly thumbprint: string | null;
  /** Whether the embedded signature carries a timestamp countersignature. */
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
  await Deno.writeTextFile(
    file,
    "$ErrorActionPreference = 'Stop'\n" +
      // The Cert: drive and New-SelfSignedCertificate: loaded explicitly (see PSModulePath below).
      "Import-Module Microsoft.PowerShell.Security, PKI\n" +
      `${script}\n`,
  );
  // Windows PowerShell's own module path: a PSModulePath inherited from PowerShell 7 (a pwsh CI
  // step) points it at modules it cannot load, and the Cert: drive is then missing.
  const windir = Deno.env.get("SystemRoot") ?? "C:\\Windows";
  const programFiles = Deno.env.get("ProgramFiles") ?? "C:\\Program Files";
  const out = await new Deno.Command("powershell.exe", {
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    env: {
      PSModulePath: [
        join(windir, "System32", "WindowsPowerShell", "v1.0", "Modules"),
        join(programFiles, "WindowsPowerShell", "Modules"),
      ].join(";"),
      ...env,
    },
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
 * The Authenticode signature of each file: the signer and timestamp of the signature embedded in
 * the file (its PE certificate table, decoded as PKCS #7), which is what the runtime's update check
 * reads (`WinVerifyTrust` on the file), and `Get-AuthenticodeSignature`'s status.
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
      "Add-Type -AssemblyName System.Security",
      // The PKCS #7 blob of the PE's certificate table (data directory 4, a file offset), or null.
      "function Embedded([string]$path) {",
      "  $fs = [IO.File]::OpenRead($path)",
      "  try {",
      "    $r = New-Object IO.BinaryReader($fs)",
      "    $fs.Position = 0x3c; $pe = $r.ReadInt32()",
      "    $fs.Position = $pe + 24; $magic = $r.ReadUInt16()",
      "    $fs.Position = $pe + 24 + $(if ($magic -eq 0x20b) { 112 } else { 96 }) + 4 * 8",
      "    $at = $r.ReadUInt32(); $size = $r.ReadUInt32()",
      "    if ($at -eq 0 -or $size -le 8) { return $null }",
      "    $fs.Position = $at; $length = $r.ReadUInt32(); $null = $r.ReadUInt32()",
      "    $der = $r.ReadBytes([int]$length - 8)",
      "  } finally { $fs.Dispose() }",
      // The DER's own length: the table entry may be padded past it.
      "  $n = $der[1]; $body = 2",
      "  if ($n -band 0x80) { $k = $n -band 0x7f; $n = 0; for ($i = 0; $i -lt $k; $i++) { $n = $n * 256 + $der[2 + $i] }; $body = 2 + $k }",
      "  $cms = New-Object System.Security.Cryptography.Pkcs.SignedCms",
      "  $cms.Decode([byte[]]$der[0..($body + $n - 1)])",
      "  return $cms",
      "}",
      // RFC 3161 (signtool /tr) or a legacy Authenticode countersignature (/t).
      "$stampOids = '1.3.6.1.4.1.311.3.3.1', '1.2.840.113549.1.9.6'",
      "$files = Get-Content -Raw -LiteralPath $env:KS_LIST | ConvertFrom-Json",
      "$out = foreach ($f in $files) {",
      "  $s = Get-AuthenticodeSignature -LiteralPath $f",
      "  $cms = Embedded $f",
      "  $signer = if ($cms) { $cms.SignerInfos[0] } else { $null }",
      "  [pscustomobject]@{",
      "    path = $f",
      '    status = "$($s.Status)"',
      "    catalog = \"$($s.SignatureType)\" -eq 'Catalog'",
      "    thumbprint = $(if ($signer) { $signer.Certificate.Thumbprint } else { $null })",
      "    timestamped = [bool]($signer -and @($signer.UnsignedAttributes | Where-Object { $stampOids -contains $_.Oid.Value }).Count)",
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

/**
 * The two certificates a non-admin runner created and trusted machine-wide for this job:
 * `<dir>/certs.json` lists `{ label, subject, thumbprint, pfx, password, cer }` for `A` and `B`
 * (the runner's pre-job scrub writes it, readable by the job's account only, and removes the
 * certificates from every store after the job). `null` when `dir` is unset.
 *
 * @param dir `KITCHEN_SINK_TRUSTED_CERTS`.
 * @returns A and B, in that order.
 */
export async function providedTestCerts(dir: string | undefined): Promise<TestCert[] | null> {
  if (!dir) return null;
  const listed = JSON.parse(await Deno.readTextFile(join(dir, "certs.json"))) as TestCert[];
  const certs = ["A", "B"].map((label) => {
    const cert = listed.find((c) => c.label === label);
    if (!cert) throw new Error(`${join(dir, "certs.json")} has no certificate ${label}`);
    for (const key of ["subject", "thumbprint", "pfx", "password", "cer"] as const) {
      if (typeof cert[key] !== "string" || cert[key] === "") {
        throw new Error(`${join(dir, "certs.json")}: certificate ${label} has no ${key}`);
      }
    }
    if (!/^[0-9A-F]{40}$/.test(cert.thumbprint)) {
      throw new Error(`certificate ${label}'s thumbprint ${JSON.stringify(cert.thumbprint)}`);
    }
    return { ...cert, label };
  });
  return certs;
}

/**
 * The thumbprints among `certs` that are NOT in both machine stores a trusted test certificate
 * needs (reading them needs no administrator).
 *
 * @param dir A private temporary folder.
 * @param certs The certificates.
 * @returns `<label> (<store>)` for each one missing.
 */
export async function untrustedTestCerts(
  dir: string,
  certs: readonly TestCert[],
): Promise<string[]> {
  const text = await powershell(
    dir,
    "trusted",
    [
      "$thumbs = $env:KS_THUMBS -split ','",
      `$missing = foreach ($store in ${TRUST_STORES.map((s) => `'${s}'`).join(", ")}) {`,
      '  $have = @(Get-ChildItem -Path "Cert:\\LocalMachine\\$store" | ForEach-Object { $_.Thumbprint })',
      '  foreach ($t in $thumbs) { if ($have -notcontains $t) { "$t $store" } }',
      "}",
      "ConvertTo-Json -InputObject @($missing) -Compress",
    ].join("\n"),
    { KS_THUMBS: thumbList(certs) },
  );
  return (JSON.parse(text) as string[]).map((entry) => {
    const [thumb, store] = entry.split(" ");
    return `${certs.find((c) => c.thumbprint === thumb)?.label ?? thumb} (LocalMachine\\${store})`;
  });
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

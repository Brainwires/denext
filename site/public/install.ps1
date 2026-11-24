# denext installer for Windows - fetches the released `denext.exe` for this machine.
#
#   irm https://denext.dev/install.ps1 | iex
#
# The binary is a CLI, not a second copy of the framework: inside a project it defers to the
# denext version that project pins, so `denext build` builds exactly what `deno task build`
# would. It is all you need - Deno itself is not: after installing the binary the script runs
# `denext runtime upgrade`, which installs the newest denext runtime (denext's own Deno build) this
# denext supports, verified by the binary against the signed runtime channel, and makes it this
# machine's default; every verb runs on it (`denext task dev`, `denext test`, `denext fmt` ...).
# When no `deno` is on your Path it also runs `denext runtime link`, so `deno` is that runtime
# (%USERPROFILE%\.denext\bin\deno.cmd); an existing `deno` is never replaced or shadowed. When
# `runtime upgrade` fails (the channel can't be read) it installs the runtime release this denext
# bundles instead (`denext runtime install`), and links that. A step that still fails (offline,
# say) is one warning, not a failed install: the binary downloads its runtime on first need instead. This script never reads the channel itself. A release from before
# `denext runtime` (DENEXT_VERSION=v4.20.1) gets its own `denext toolchain install` (+ link), and
# one before 4.0 neither.
#
# -RuntimeOnly (DENEXT_RUNTIME_ONLY=1): with denext already installed here, skip the binary and
# run `denext runtime upgrade` only (without one, install both). -Runtime <version>
# (DENEXT_RUNTIME_VERSION): `denext runtime install <version>` + `denext runtime use <version>`.
# With either, the runtime is what was asked for, so its step failing fails the run.
#
# Environment:
#   DENEXT_VERSION   the release tag to install (`v2.5.0`); default: the latest stable release
#   DENEXT_INSTALL   where to install (the binary lands in its `bin\`); default: ~\.denext
#   DENEXT_INSECURE  `1` installs even when no checksum can be fetched, or when the release's
#                    build attestation can't be verified (never on a checksum mismatch, never on
#                    a broken Authenticode signature)
#   DENEXT_REQUIRE_ATTESTATION  `1` refuses to install unless the archive's build attestation is
#                    verified (needs the GitHub CLI, `gh`, signed in)
#   DENEXT_MODIFY_PATH  `0` leaves your user Path alone (the script prints the line to add);
#                    `1` (the default) or `all` adds denext's bin to it. DENEXT_NO_PATH=1 is `0`.
#   DENEXT_NO_RUNTIME  `1` skips `denext runtime upgrade` (and the link): the runtime then
#                    downloads on the first command that needs it
#   DENEXT_RUNTIME_ONLY  `1` is -RuntimeOnly
#   DENEXT_RUNTIME_VERSION  a runtime version (`3.0.0-denext.<n>`) is -Runtime <version>
#   DENEXT_NO_DENO_LINK  `1` skips `denext runtime link` (no `deno` is put on your Path)
#   DENEXT_ARTIFACTS a local directory holding the release files (`denext-<target>.zip` and
#                    `SHA256SUMS` or `<archive>.sha256`) to install from instead of GitHub - for
#                    testing a build; the checksum is still required and checked
#   GITHUB_TOKEN / GH_TOKEN  sent (as a Bearer header, to api.github.com only) for the latest-
#                    version lookup, whose unauthenticated limit is 60 requests an hour per IP.
#                    Without one, or when the API refuses, the version comes from the
#                    github.com/.../releases/latest redirect instead.
#
# Per-user, no administrator rights: the binary goes to %USERPROFILE%\.denext\bin and that
# directory is added to your USER Path (persistently, for new terminals) and to this session's
# $env:Path, so `denext` works in this window right away when the script runs through `iex`.
# -NoModifyPath (or DENEXT_MODIFY_PATH=0) changes neither and prints the line to run instead;
# -ModifyPath says the default explicitly. Flags go through a scriptblock:
#
#   & ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -NoModifyPath
#   & ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -RuntimeOnly
#   & ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -Runtime <version>
#
# To uninstall, run the script with -Uninstall (it removes the Path entry too):
#
#   & ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -Uninstall
#
# (or delete %USERPROFILE%\.denext and remove its bin from Path in "Edit environment variables
# for your account").
#
# Everything runs from Install-Denext, called on the last line, so a download that is cut short
# runs nothing: `iex` parses the whole script first, and a truncated one never reaches the call.

param(
  [switch]$Uninstall,
  [switch]$ModifyPath,
  [switch]$NoModifyPath,
  [switch]$RuntimeOnly,
  [string]$Runtime = ''
)

function Install-Denext {
  param(
    [switch]$Uninstall,
    [switch]$ModifyPath,
    [switch]$NoModifyPath,
    [switch]$RuntimeOnly,
    [string]$Runtime = ''
  )
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest's progress bar is very slow on 5.1
  # Windows PowerShell 5.1 still defaults to TLS 1.0/1.1 on older builds.
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'Brainwires/denext'
  # Release downloads come from GitHub over HTTPS. DENEXT_DOWNLOAD_BASE / DENEXT_API_BASE exist for
  # the installer's own tests, and accept plain http only for a loopback host.
  $downloadBase = if ($env:DENEXT_DOWNLOAD_BASE) { $env:DENEXT_DOWNLOAD_BASE } else {
    "https://github.com/$repo/releases/download"
  }
  $apiBase = if ($env:DENEXT_API_BASE) { $env:DENEXT_API_BASE } else { "https://api.github.com" }
  $webBase = if ($env:DENEXT_WEB_BASE) { $env:DENEXT_WEB_BASE } else { "https://github.com" }
  foreach ($base in @($downloadBase, $apiBase, $webBase)) {
    $uri = [Uri]$base
    if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) {
      Stop-Denext "denext: refusing a non-https download URL ($base)"
    }
  }

  $root = if ($env:DENEXT_INSTALL) { $env:DENEXT_INSTALL } else {
    Join-Path $HOME '.denext'
  }
  $bin = Join-Path $root 'bin'
  $installed = Join-Path $bin 'denext.exe'

  # What the runtime step is asked for: -RuntimeOnly / -Runtime, else their environment forms.
  $script:DenextRuntimeOnly = $RuntimeOnly -or ($env:DENEXT_RUNTIME_ONLY -eq '1')
  $script:DenextRuntimeVersion = if ($Runtime) { $Runtime } else { "$env:DENEXT_RUNTIME_VERSION" }
  if ($script:DenextRuntimeVersion -and $script:DenextRuntimeVersion -notmatch '^[A-Za-z0-9][A-Za-z0-9.+-]*$') {
    Stop-Denext "denext: -Runtime $($script:DenextRuntimeVersion) is not a runtime version (3.0.0-denext.<n>)"
  }
  if (($env:DENEXT_NO_RUNTIME -eq '1') -and ($script:DenextRuntimeOnly -or $script:DenextRuntimeVersion)) {
    Stop-Denext 'denext: DENEXT_NO_RUNTIME=1 skips the runtime, which -RuntimeOnly / -Runtime ask for: nothing to do'
  }

  if ($Uninstall) {
    Assert-SafeInstallRoot $root
    # The `deno` link `runtime link` (or an older release's `toolchain link`) made (only a link of
    # its own; anything else is left).
    if (Test-Path -LiteralPath $installed -PathType Leaf) {
      $verb = Get-RuntimeVerb $installed
      if ($verb -ne 'none') { Invoke-DenextAt $root $installed @($verb, 'unlink') | Out-Null }
    }
    Remove-DenextPath $bin
    Uninstall-DenextFiles $root
    Write-Host "denext: removed denext from $root and its bin from your user Path"
    return
  }

  if ($script:DenextRuntimeOnly) {
    if (Test-Path -LiteralPath $installed -PathType Leaf) {
      if ((Get-RuntimeVerb $installed) -ne 'runtime') {
        Stop-Denext ("denext: $(& $installed --version) at $installed predates ``denext runtime``, so " +
          '-RuntimeOnly can''t move its runtime. Run the installer without -RuntimeOnly to install ' +
          'the latest denext and its runtime.')
      }
      Write-Host "denext: $(& $installed --version) is installed; updating only its runtime"
      Install-DenextRuntime $installed 'x86_64-pc-windows-msvc' $root
      return
    }
    Write-Host "denext: no denext at $installed yet: installing it and its runtime"
  }

  # The binaries for this machine, best first. Windows on Arm gets the native Arm64 build; a
  # release from before it was published (DENEXT_VERSION=v4.1.0, say) has none, and the x64
  # binary, which Windows on Arm runs under emulation, is the fallback.
  $arch = Get-NativeArchitecture
  $targets = switch ($arch) {
    'ARM64' { @('aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc') }
    'AMD64' { @('x86_64-pc-windows-msvc') }
    default {
      Stop-Denext "denext: no prebuilt binary for $arch. Use the CLI from JSR: deno install -A -g -n denext jsr:@denext/denext/cli"
    }
  }

  $version = $env:DENEXT_VERSION
  if (-not $version -and $env:DENEXT_ARTIFACTS) {
    $version = 'local'
  } elseif (-not $version) {
    # `releases/latest` is the newest NON-prerelease: an rc tag never becomes "latest".
    $version = Get-LatestTag $apiBase $webBase $repo
  }
  if (-not $version) { Stop-Denext 'denext: could not determine the latest release; set DENEXT_VERSION.' }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("denext-install-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $fetched = $false
    foreach ($target in $targets) {
      $asset = "denext-$target.zip"
      $zip = Join-Path $tmp $asset
      if (Get-ReleaseAsset $downloadBase $version $asset $target $zip) {
        $fetched = $true
        break
      }
      if ($target -ne $targets[-1]) {
        Write-Host "denext: $version has no $target build; installing the x64 binary (runs under emulation)"
      }
    }
    if (-not $fetched) { Stop-Denext "denext: $version has no $asset" }

    # A binary that will run with your permissions is never installed unverified. A missing
    # checksum is as fatal as a wrong one - whoever can swap the archive can drop the checksum
    # too - unless DENEXT_INSECURE=1 says, loudly, that this is deliberate.
    $expected = Get-PublishedDigest "$downloadBase/$version" $asset $tmp
    if (-not $expected) {
      if ($env:DENEXT_INSECURE -eq '1') {
        Write-DenextWarning "denext: no checksum could be fetched for $asset; installing UNVERIFIED because DENEXT_INSECURE=1 is set."
      } else {
        Stop-Denext "denext: no checksum could be fetched for $asset - not installing. Every release publishes SHA256SUMS; check https://github.com/$repo/releases/tag/$version (DENEXT_INSECURE=1 installs anyway, unverified)."
      }
    } else {
      $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
      if ($actual -ne $expected.ToLowerInvariant()) {
        Stop-Denext @(
          "denext: checksum verification FAILED for $asset - not installing.",
          "  expected $expected",
          "  got      $actual")
      }
      Write-Host 'denext: checksum verified'
    }
    Assert-Attestation $zip $asset $repo

    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
    Assert-Authenticode (Join-Path $tmp 'x\denext.exe')
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Move-Item -Force (Join-Path $tmp 'x\denext.exe') (Join-Path $bin 'denext.exe')
    # What -Uninstall may remove: only the files this script put here.
    Set-Content -Encoding ascii -Path (Join-Path $root $ManifestName) -Value $InstalledFiles
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $exe = Join-Path $bin 'denext.exe'
  Write-Host "denext: installed $(& $exe --version) to $exe"

  Install-DenextRuntime $exe $target $root

  if (-not (Test-ModifyPath -ModifyPath:$ModifyPath -NoModifyPath:$NoModifyPath)) {
    if (-not (Test-PathEntry $env:Path $bin)) {
      Write-Host 'denext: left your Path alone. To use denext in this session, run:'
      Write-Host "  `$env:Path = `"$bin;`$env:Path`""
      Write-Host 'and add that folder to your user Path to keep it (or re-run with -ModifyPath).'
    }
  } else {
    if (Add-DenextPath $bin) { Write-Host "denext: added $bin to your user Path (new terminals have it)" }
    # Through `irm ... | iex` the script runs in your session, so its $env:Path is yours; started
    # as a file (-File, `& .\install.ps1` from another shell) it is a child's, which ends with it.
    if (-not $PSCommandPath) {
      Write-Host 'denext: and to this session''s Path - `denext` works here now'
    } else {
      Write-Host ('denext: this script ran in its own process, so it could not change the Path of ' +
        'the shell you started it from. To use denext there now, run:')
      Write-Host "  `$env:Path = `"$bin;`$env:Path`""
    }
  }
}

# Whether to add denext's bin to the Path: -NoModifyPath / -ModifyPath, else DENEXT_MODIFY_PATH
# (`0` / `1` / `all`), else DENEXT_NO_PATH=1, else yes. An unknown DENEXT_MODIFY_PATH is an error.
function Test-ModifyPath([switch]$ModifyPath, [switch]$NoModifyPath) {
  if ($NoModifyPath) { return $false }
  if ($ModifyPath) { return $true }
  $mode = "$env:DENEXT_MODIFY_PATH".Trim().ToLowerInvariant()
  if ($mode -in @('0', 'no', 'false', 'none')) { return $false }
  if ($mode -in @('1', 'yes', 'true', 'current', 'all')) { return $true }
  if ($mode) { Stop-Denext "denext: DENEXT_MODIFY_PATH=$($env:DENEXT_MODIFY_PATH) is not one of 1, all, 0" }
  return $env:DENEXT_NO_PATH -ne '1'
}

# The machine's own CPU architecture (AMD64, ARM64, x86 ...). A 32-bit PowerShell on 64-bit Windows
# sees x86 in PROCESSOR_ARCHITECTURE and the real one in PROCESSOR_ARCHITEW6432; an x64 PowerShell
# running under emulation on Windows on Arm sees AMD64, so that answer is checked against the
# machine-wide value in the registry, which names the native one.
function Get-NativeArchitecture {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else {
    $env:PROCESSOR_ARCHITECTURE
  }
  if ($arch -eq 'AMD64') {
    try {
      $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
      $native = (Get-ItemProperty -ErrorAction Stop -Path $key).PROCESSOR_ARCHITECTURE
      if ($native -eq 'ARM64') { $arch = $native }
    } catch {
      # No readable machine value: keep the process's answer.
    }
  }
  return "$arch".ToUpperInvariant()
}

# Fetch the release asset $asset into $zip (from DENEXT_ARTIFACTS when set). Returns $false when
# the release has no such asset (an HTTP 404, or no such local file); any other failure throws.
function Get-ReleaseAsset([string]$base, [string]$version, [string]$asset, [string]$target, [string]$zip) {
  if ($env:DENEXT_ARTIFACTS) {
    $local = Join-Path $env:DENEXT_ARTIFACTS $asset
    if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { return $false }
    Write-Host "denext: installing $asset from $($env:DENEXT_ARTIFACTS)"
    Copy-Item -LiteralPath $local -Destination $zip
    return $true
  }
  Write-Host "denext: downloading $version for $target"
  return Save-Download "$base/$version/$asset" $zip
}

# Download $uri to $outFile, streamed through HttpClient rather than Invoke-WebRequest, whose own
# progress UI makes Windows PowerShell 5.1 download many times slower. In an interactive console
# a Write-Progress bar (MB and percent) is redrawn at most every 250 ms; elsewhere (CI, a log)
# nothing is drawn. Returns $false for an HTTP 404; any other failure throws.
function Save-Download([string]$uri, [string]$outFile) {
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  try {
    $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if ([int]$response.StatusCode -eq 404) { return $false }
    $null = $response.EnsureSuccessStatusCode()
    $total = $response.Content.Headers.ContentLength
    $show = Test-InteractiveConsole
    $in = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $out = [IO.File]::Create($outFile)
    try {
      $buffer = New-Object byte[] 1048576
      $done = [long]0
      $timer = [Diagnostics.Stopwatch]::StartNew()
      while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $out.Write($buffer, 0, $n)
        $done += $n
        if ($show -and $timer.ElapsedMilliseconds -ge 250) {
          $timer.Reset()
          $timer.Start()
          Write-DownloadProgress $done $total
        }
      }
    } finally {
      $out.Dispose()
      $in.Dispose()
    }
    if ($show) { Write-DownloadProgress $done $total -Completed }
    return $true
  } finally {
    $client.Dispose()
  }
}

# The checksum proves the archive is the one the release lists, not that the release is
# denext's: whoever can replace a release's files can replace SHA256SUMS too. Every archive also
# carries a build-provenance attestation (Sigstore, signed by GitHub for publish.yml on this
# repository), which the GitHub CLI verifies: with `gh` installed and signed in, the archive must
# pass `gh attestation verify` or nothing is installed. Without it the install goes ahead on the
# checksum and says so, unless DENEXT_REQUIRE_ATTESTATION=1. A local DENEXT_ARTIFACTS build has
# no attestation and skips this.
function Assert-Attestation([string]$zip, [string]$asset, [string]$repo) {
  if ($env:DENEXT_ARTIFACTS) { return }
  # `gh` writes its refusals to stderr; under 'Stop' Windows PowerShell 5.1 turns that into a
  # terminating NativeCommandError (even redirected), so the exit codes below never decide.
  $ErrorActionPreference = 'Continue'
  $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $signedIn = $false
  if ($gh) {
    & $gh.Source auth status *> $null
    $signedIn = $LASTEXITCODE -eq 0
  }
  if (-not $signedIn) {
    if ($env:DENEXT_REQUIRE_ATTESTATION -eq '1') {
      Stop-Denext ('denext: DENEXT_REQUIRE_ATTESTATION=1 needs the GitHub CLI (gh), signed in, to verify ' +
        "the release's build attestation - not installing.")
    }
    Write-Host ('denext: build attestation not checked (install and sign in to the GitHub CLI, gh, ' +
      'to verify it; DENEXT_REQUIRE_ATTESTATION=1 makes it required)')
    return
  }
  # A gh from before `gh attestation` (2.49) can't verify one: as if there were no gh.
  & $gh.Source attestation verify --help *> $null
  if ($LASTEXITCODE -ne 0) {
    if ($env:DENEXT_REQUIRE_ATTESTATION -eq '1') {
      Stop-Denext ('denext: DENEXT_REQUIRE_ATTESTATION=1, but this GitHub CLI has no ' +
        '`gh attestation`; update gh - not installing.')
    }
    Write-Host ('denext: build attestation not checked (this GitHub CLI has no `gh attestation`; ' +
      'update gh to verify it; DENEXT_REQUIRE_ATTESTATION=1 makes it required)')
    return
  }
  $ghOut = (& $gh.Source attestation verify $zip --repo $repo --signer-workflow "$repo/.github/workflows/publish.yml" 2>&1 |
    ForEach-Object { "$_" }) -join "`n"
  if ($LASTEXITCODE -eq 0) {
    Write-Host "denext: build attestation verified (built by $repo's publish workflow)"
    return
  }
  if ($env:DENEXT_INSECURE -eq '1') {
    Write-DenextWarning "denext: the build attestation of $asset could not be verified; installing on the checksum alone because DENEXT_INSECURE=1 is set."
    return
  }
  $said = ($ghOut -split "`n" | ForEach-Object { "    $_" }) -join "`n"
  Stop-Denext @(
    "denext: the build attestation of $asset could not be verified - not installing.",
    "  ``gh attestation verify $asset --repo $repo`` said:",
    $said,
    ('  A network problem (gh reaches GitHub and Sigstore), a gh token without access, or a ' +
    'release with no attestation (denext 4.9.0 and earlier) fails this as well as a tampered ' +
    'archive: retry once the cause is fixed. DENEXT_INSECURE=1 installs on the checksum alone.'))
}

# The extracted denext.exe's Authenticode signature: a signed binary must verify (a signature
# that no longer matches the file, or one that chains to no trusted root, is refused even under
# DENEXT_INSECURE); an unsigned one (a release built without the signing secrets) is installed
# on the checks above, with a note. The signature must be the file's own: Windows also vouches
# for its system files through catalogs, and since Authenticode's hash leaves the embedded
# signature out, any Windows binary - re-signed by anyone, or not at all - still matches its
# catalog. denext.exe is never one of those, so a catalog signature is refused.
# TODO: once releases are signed with denext's own certificate, also require its publisher
# (DENEXT_WINDOWS_PUBLISHER, the certificate's subject) instead of any trusted one.
function Assert-Authenticode([string]$exe) {
  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  $status = "$($sig.Status)"
  if ("$($sig.SignatureType)" -eq 'Catalog' -or $sig.IsOSBinary) {
    Stop-Denext "denext: denext.exe is a Windows system file (vouched for by a Windows catalog, not by a signature of its own) - not installing."
  }
  if ($status -eq 'NotSigned') {
    Write-Host 'denext: denext.exe carries no Authenticode signature (this release was built unsigned)'
    return
  }
  if ($status -ne 'Valid') {
    Stop-Denext "denext: denext.exe's Authenticode signature is $status ($($sig.StatusMessage)) - not installing."
  }
  Write-Host "denext: Authenticode signature verified ($($sig.SignerCertificate.Subject))"
}

# Whether a person is watching this console (a progress bar is worth drawing).
function Test-InteractiveConsole {
  try {
    return [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost' -and
      -not [Console]::IsOutputRedirected
  } catch {
    return $false
  }
}

# The download's progress bar: MB received (of the total, with its percent, when known).
function Write-DownloadProgress([long]$done, $total, [switch]$Completed) {
  $ProgressPreference = 'Continue'
  if ($Completed) {
    Write-Progress -Activity 'denext: downloading' -Completed
    return
  }
  $mb = '{0:N1} MB' -f ($done / 1e6)
  if ($total) {
    $pct = [int][Math]::Floor(100 * $done / $total)
    Write-Progress -Activity 'denext: downloading' -Status ("$mb / {0:N1} MB ($pct%)" -f ($total / 1e6)) -PercentComplete $pct
  } else {
    Write-Progress -Activity 'denext: downloading' -Status $mb
  }
}

# Install the runtime through the binary at $exe: the newest one it supports (`runtime upgrade`,
# which also makes it this machine's default), or the -Runtime version asked for (`runtime install`
# + `runtime use`); then, when this machine has no `deno`, link `deno` to it. Every check is the
# binary's. In a plain install a failed `runtime upgrade` falls back to `runtime install` (the
# release this denext bundles), and a failure of that too is one warning (the binary downloads its
# runtime on first need); with -RuntimeOnly or -Runtime a failure throws. An existing `deno` is never replaced: the link is
# made only when Path has none, and `runtime link` itself refuses to overwrite a file it did not
# create. A release from before `denext runtime` gets its own toolchain step.
function Install-DenextRuntime([string]$exe, [string]$target, [string]$root) {
  if ($env:DENEXT_NO_RUNTIME -eq '1') { return }
  $verb = Get-RuntimeVerb $exe
  $asked = $script:DenextRuntimeVersion
  $strict = $script:DenextRuntimeOnly -or $asked
  if ($verb -ne 'runtime') {
    if ($asked) {
      Stop-Denext ("denext: $(& $exe --version) predates ``denext runtime``, so it can't install runtime " +
        "$asked; install a newer denext (leave DENEXT_VERSION unset).")
    }
    if ($verb -eq 'toolchain') { Install-DenoToolchain $exe $target $root }
    else {
      Write-Host ("denext: $(& $exe --version) predates denext's Deno toolchain (denext 4.0); " +
        'skipping that step - this release runs on the deno on your Path.')
    }
    return
  }
  if ($asked) {
    Write-Host "denext: installing denext runtime $asked"
    $fix = "denext runtime install $asked; denext runtime use $asked"
    $ok = ((Invoke-Denext $exe @('runtime', 'install', $asked)) -eq 0) -and
      ((Invoke-Denext $exe @('runtime', 'use', $asked)) -eq 0)
  } else {
    Write-Host 'denext: installing the newest denext runtime this denext supports'
    $fix = 'denext runtime upgrade'
    $ok = (Invoke-Denext $exe @('runtime', 'upgrade')) -eq 0
    # A plain install falls back to the release this denext bundles (`runtime install` with no
    # version: the selected release, found without the channel), so a channel that can't be read
    # (not published yet, unreachable) still leaves a runtime and the `deno` link. -RuntimeOnly
    # asked for the newest runtime: nothing else stands in for it.
    if (-not $ok -and -not $strict) {
      Write-DenextWarning ('denext: the newest runtime could not be installed (see above); installing ' +
        'the runtime this denext bundles instead')
      $fix = 'denext runtime install'
      $ok = (Invoke-Denext $exe @('runtime', 'install')) -eq 0
    }
  }
  if (-not $ok) {
    if ($strict) {
      Stop-Denext "denext: the runtime could not be installed (see above); nothing else changed. Fix the cause and run ``$fix`` (or this installer again)."
    }
    Write-DenextWarning ('denext: the denext runtime could not be installed now; it downloads on the ' +
      "first command that needs it (or run ``$fix``).")
    return
  }
  Connect-DenoLink $exe $root 'runtime'
}

# With the runtime in place: tell a machine that has its own `deno` that it is left alone, else
# link `deno` to it (`<verb> link`: `runtime`, or an older release's `toolchain`).
function Connect-DenoLink([string]$exe, [string]$root, [string]$verb) {
  $existing = Get-Command deno -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host ("denext: denext uses its own Deno ($(Get-RuntimeVersion $exe $verb)); your deno at " +
      "$($existing.Source) is not changed or used by denext")
    return
  }
  if ($env:DENEXT_NO_DENO_LINK -eq '1') { return }
  if ((Invoke-DenextAt $root $exe @($verb, 'link')) -ne 0) {
    Write-DenextWarning "denext: could not link ``deno`` to the $verb (``denext deno ...`` still runs it)."
  }
}

# A release from denext 4.0 until `denext runtime` (DENEXT_VERSION=v4.20.1): `toolchain install`
# (+ `toolchain link`), never fatal.
function Install-DenoToolchain([string]$exe, [string]$target, [string]$root) {
  Write-Host "denext: installing denext's Deno toolchain"
  if ((Invoke-Denext $exe @('toolchain', 'install')) -ne 0) {
    # A release that pins a toolchain before 2.9.7-denext.21 has no Windows on Arm build: the
    # Arm64 binary runs every verb that needs Deno on the deno on your Path instead.
    if ($target -like 'aarch64-*') {
      Write-Host ("denext: no Windows on Arm Deno toolchain could be installed (releases pinning " +
        'one older than 2.9.7-denext.21 have none); denext runs the deno on your Path until ' +
        '`denext toolchain install` succeeds (install one with: irm https://deno.land/install.ps1 | iex)')
      return
    }
    Write-DenextWarning ('denext: the Deno toolchain could not be installed now; it downloads on the ' +
      'first command that needs it (or run `denext toolchain install`).')
    return
  }
  Connect-DenoLink $exe $root 'toolchain'
}

# The runtime version the binary at $exe runs (`3.0.0-denext.<n>`), or 'the pinned build':
# `runtime version --json` nests it as `runtime.version`; an older release's `toolchain status
# --json` ($verb = 'toolchain') has it at the top.
function Get-RuntimeVersion([string]$exe, [string]$verb = 'runtime') {
  $ErrorActionPreference = 'Continue'
  try {
    if ($verb -eq 'toolchain') {
      $status = (& $exe toolchain status --json 2>$null) -join "`n" | ConvertFrom-Json
      if ($status.version) { return "$($status.version)" }
    } else {
      $status = (& $exe runtime version --json 2>$null) -join "`n" | ConvertFrom-Json
      if ($status.runtime.version) { return "$($status.runtime.version)" }
    }
  } catch {
    # An older binary, or no answer: say it generally.
  }
  return 'the pinned build'
}

# Which runtime verb the binary at $exe has: 'runtime' (`denext runtime ...`), 'toolchain' (denext
# 4.0 up to the runtime channel) or 'none' (before 4.0). Read from its --help, which runs no project
# code and downloads nothing (asking an older binary for `runtime` would forward it to Deno); a
# binary whose help names neither is taken by its version: before 4.0 'none', else 'runtime'.
function Get-RuntimeVerb([string]$exe) {
  $ErrorActionPreference = 'Continue'
  $help = ''
  try { $help = (& $exe --help 2>$null) -join "`n" } catch { $help = '' }
  if ($help -match 'denext runtime ') { return 'runtime' }
  if ($help -match 'denext toolchain ') { return 'toolchain' }
  try { $version = "$(& $exe --version 2>$null)" } catch { $version = '' }
  if ($version -match '^denext (\d+)\.' -and [int]$Matches[1] -lt 4) { return 'none' }
  return 'runtime'
}

# Invoke-Denext with DENEXT_INSTALL set to $root for that one run (and restored after, since the
# script runs in the caller's session): `runtime link` / `unlink` put `deno` in its bin/, beside
# the binary in the bin/ this install put on Path, even when DENEXT_INSTALL was not set and the
# binary would otherwise derive another home (an HOME variable set by Git for Windows or MSYS).
function Invoke-DenextAt([string]$root, [string]$exe, [string[]]$arguments) {
  $previous = $env:DENEXT_INSTALL
  $env:DENEXT_INSTALL = $root
  try {
    return Invoke-Denext $exe $arguments
  } finally {
    $env:DENEXT_INSTALL = $previous
  }
}

# Run the installed binary with $arguments, its output on the console; returns its exit code (1
# when it cannot start). Windows PowerShell 5.1 turns a native command's stderr into error records,
# which ErrorActionPreference 'Stop' would make fatal: a toolchain step must never fail the install.
function Invoke-Denext([string]$exe, [string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  try {
    & $exe @arguments | Out-Host
    return $LASTEXITCODE
  } catch {
    return 1
  }
}

# The latest stable release's tag (`v2.5.0`), or $null. The API first, with GITHUB_TOKEN / GH_TOKEN
# as a Bearer header when one is set (on this api.github.com call only, never on a download, which
# redirects off GitHub; the token is never printed). Then, for a rate-limited API (shared CI
# runners and office NATs exhaust 60/hour), the tag the web page's releases/latest redirect lands on.
function Get-LatestTag([string]$apiBase, [string]$webBase, [string]$repo) {
  $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $tag = $null
  try {
    $tag = (Invoke-RestMethod -UseBasicParsing -Headers $headers "$apiBase/repos/$repo/releases/latest").tag_name
  } catch {
    $tag = $null
  }
  if (-not $tag) {
    try {
      $page = Invoke-WebRequest -UseBasicParsing "$webBase/$repo/releases/latest"
      # Where the redirect landed: ResponseUri on Windows PowerShell, RequestMessage on pwsh.
      $response = $page.BaseResponse
      $final = if ($response.PSObject.Properties['ResponseUri']) { $response.ResponseUri } else {
        $response.RequestMessage.RequestUri
      }
      if ("$final" -match '/releases/tag/([^/?#]+)$') { $tag = $Matches[1] }
    } catch {
      $tag = $null
    }
  }
  # Only ever a version tag: anything else is no answer.
  if ("$tag" -match '^v[0-9][A-Za-z0-9.+-]*$') { return "$tag" }
  return $null
}

# The published checksum for $asset: the release's combined SHA256SUMS first (one file covers
# every platform), else the per-archive `$asset.sha256` - both written by publish.yml. Returns
# the hex digest, or $null when neither can be fetched.
function Get-PublishedDigest([string]$base, [string]$asset, [string]$tmp) {
  foreach ($name in @('SHA256SUMS', "$asset.sha256")) {
    $file = Join-Path $tmp $name
    try {
      if ($env:DENEXT_ARTIFACTS) {
        Copy-Item -LiteralPath (Join-Path $env:DENEXT_ARTIFACTS $name) -Destination $file
      } else {
        Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $file
      }
    } catch {
      continue
    }
    foreach ($line in Get-Content $file) {
      $parts = $line.Trim() -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset -and
        $parts[0] -match '^[0-9a-fA-F]{64}$') {
        return $parts[0]
      }
    }
  }
  return $null
}

# The files the installer writes under DENEXT_INSTALL, recorded in its manifest beside them.
$ManifestName = '.denext-install-manifest'
$InstalledFiles = @('bin\denext.exe')

# Refuse to uninstall from a root that is not a directory of its own: a drive root, the home or
# profile directory (or one of its ancestors), Windows, Program Files, AppData or Temp. Uninstall
# removes only listed files anyway; this stops a mistyped DENEXT_INSTALL before anything happens.
function Assert-SafeInstallRoot([string]$root) {
  $full = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $drive = [IO.Path]::GetPathRoot($full).TrimEnd('\')
  $guarded = @($drive, $HOME, $env:USERPROFILE, $env:SystemRoot, $env:ProgramFiles,
    ${env:ProgramFiles(x86)}, $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP) |
    Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
  foreach ($g in $guarded) {
    if ($full -ieq $g -or $g.StartsWith("$full\", [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Denext "denext: refusing to uninstall from $full (DENEXT_INSTALL points at a shared directory)"
    }
  }
}

# Remove what the installer wrote (its manifest's files, else just bin\denext.exe from an
# install that predates the manifest), then bin and the root only if nothing else is left.
function Uninstall-DenextFiles([string]$root) {
  $manifest = Join-Path $root $ManifestName
  $listed = if (Test-Path -LiteralPath $manifest -PathType Leaf) { Get-Content $manifest } else { @() }
  # Only the names this script ever writes: a manifest edited to name another path is ignored.
  $files = @(@($listed) + $InstalledFiles) | Where-Object { $InstalledFiles -contains $_ } |
    Select-Object -Unique
  foreach ($rel in $files) {
    $path = Join-Path $root $rel
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-SettlingFile $path }
  }
  if (Test-Path -LiteralPath $manifest -PathType Leaf) { Remove-Item -LiteralPath $manifest -Force }
  foreach ($dir in @((Join-Path $root 'bin'), $root)) {
    if ((Test-Path -LiteralPath $dir -PathType Container) -and
      -not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) {
      Remove-Item -LiteralPath $dir -Force
    }
  }
}

# Delete $path, retrying for up to five seconds while Windows holds it. Uninstall runs denext.exe
# (`runtime unlink`) just before it deletes it, and the file can stay held for a moment after that
# process has exited - an antivirus scan of the freshly run binary ("being used by another
# process"), the image of a process still tearing down ("Access ... is denied"). A hold that
# outlasts the retries (denext still running, a real permission problem) still fails the uninstall.
function Remove-SettlingFile([string]$path) {
  for ($attempt = 1; ; $attempt++) {
    try {
      Remove-Item -LiteralPath $path -Force -ErrorAction Stop
      return
    } catch {
      $held = $_.Exception -is [IO.IOException] -or $_.Exception -is [UnauthorizedAccessException]
      if ($attempt -ge 20 -or -not $held) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

# Whether $dir is one of the entries of a `;`-separated Path value.
function Test-PathEntry([string]$path, [string]$dir) {
  return @(($path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count -gt 0
}

# The USER Path as stored (HKCU\Environment), its %VARIABLES% unexpanded, or ''.
# Reading it through [Environment]::GetEnvironmentVariable would expand them, and writing that
# back would replace every %USERPROFILE%-style entry with this machine's expansion for good.
function Get-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if (-not $key) { return '' }
  try {
    return "$($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))"
  } finally {
    $key.Close()
  }
}

# Store $value as the USER Path (REG_EXPAND_SZ, so its %VARIABLES% keep expanding), then tell
# running programs (Explorer, new terminals) that the environment changed: setting a variable
# through [Environment]::SetEnvironmentVariable(..., 'User') broadcasts WM_SETTINGCHANGE.
function Set-UserPath([string]$value) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally {
    $key.Close()
  }
  $marker = 'DENEXT_PATH_UPDATED'
  [Environment]::SetEnvironmentVariable($marker, '1', 'User')
  [Environment]::SetEnvironmentVariable($marker, $null, 'User')
}

# A refusal: its lines written as they are, then a one-line error. PowerShell's error view joins
# a thrown message's lines and re-wraps them at the console width (Write-Warning wraps too), which
# breaks up a hash, a path or a command to copy; Write-Host writes each line whole.
function Stop-Denext([string[]]$lines) {
  foreach ($line in $lines) { Write-Host $line }
  throw 'denext: stopped (the reason is above).'
}

# A warning, written whole (see Stop-Denext).
function Write-DenextWarning([string]$line) {
  Write-Host "WARNING: $line"
}

# Add $dir to the USER Path (first, once) and to this session's; returns whether the user Path
# changed.
function Add-DenextPath([string]$dir) {
  if (-not (Test-PathEntry $env:Path $dir)) { $env:Path = "$dir;$env:Path" }
  $user = Get-UserPath
  if ($user -and (Test-PathEntry $user $dir)) { return $false }
  $next = if ($user) { "$dir;$user" } else { $dir }
  Set-UserPath $next
  return $true
}

# Remove $dir from the USER Path and from this session's.
function Remove-DenextPath([string]$dir) {
  if (Test-PathEntry $env:Path $dir) {
    $env:Path = (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ine $dir.TrimEnd('\') }) -join ';'
  }
  $user = Get-UserPath
  if (-not $user -or -not (Test-PathEntry $user $dir)) { return }
  $kept = ($user -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $dir.TrimEnd('\') }
  Set-UserPath ($kept -join ';')
}

Install-Denext -Uninstall:$Uninstall -ModifyPath:$ModifyPath -NoModifyPath:$NoModifyPath `
  -RuntimeOnly:$RuntimeOnly -Runtime $Runtime

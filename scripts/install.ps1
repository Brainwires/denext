# denext installer for Windows - fetches the released `denext.exe` for this machine.
#
#   irm https://denext.dev/install.ps1 | iex
#
# The binary is a CLI, not a second copy of the framework: inside a project it defers to the
# denext version that project pins, so `denext build` builds exactly what `deno task build`
# would. It is all you need - Deno itself is not: after installing the binary the script runs
# `denext toolchain install`, which downloads denext's own Deno build (SHA-256-verified) into
# Deno's cache, and every verb runs on it (`denext task dev`, `denext test`, `denext fmt` ...).
# When no `deno` is on your Path it also runs `denext toolchain link`, so `deno` is that toolchain
# (%USERPROFILE%\.denext\bin\deno.cmd); an existing `deno` is never replaced or shadowed. Either
# step failing (offline, say) is one warning, not a failed install: the binary downloads the
# toolchain on first need instead.
#
# Environment:
#   DENEXT_VERSION   the release tag to install (`v2.5.0`); default: the latest stable release
#   DENEXT_INSTALL   where to install (the binary lands in its `bin\`); default: ~\.denext
#   DENEXT_INSECURE  `1` installs even when no checksum can be fetched (never on a mismatch)
#   DENEXT_NO_PATH   `1` leaves your user PATH alone (the script prints the line to add)
#   DENEXT_NO_TOOLCHAIN  `1` skips `denext toolchain install` (and the link): the toolchain then
#                    downloads on the first command that needs it
#   DENEXT_NO_DENO_LINK  `1` skips `denext toolchain link` (no `deno` is put on your Path)
#   DENEXT_ARTIFACTS a local directory holding the release files (`denext-<target>.zip` and
#                    `SHA256SUMS` or `<archive>.sha256`) to install from instead of GitHub - for
#                    testing a build; the checksum is still required and checked
#   GITHUB_TOKEN / GH_TOKEN  sent (as a Bearer header, to api.github.com only) for the latest-
#                    version lookup, whose unauthenticated limit is 60 requests an hour per IP.
#                    Without one, or when the API refuses, the version comes from the
#                    github.com/.../releases/latest redirect instead.
#
# Per-user, no administrator rights: the binary goes to %USERPROFILE%\.denext\bin and that
# directory is added to your USER Path. To uninstall, run the script with -Uninstall:
#
#   & ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -Uninstall
#
# (or delete %USERPROFILE%\.denext and remove its bin from Path in "Edit environment variables
# for your account").
#
# Everything runs from Install-Denext, called on the last line, so a download that is cut short
# runs nothing: `iex` parses the whole script first, and a truncated one never reaches the call.

param([switch]$Uninstall)

function Install-Denext {
  param([switch]$Uninstall)
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
      throw "denext: refusing a non-https download URL ($base)"
    }
  }

  $root = if ($env:DENEXT_INSTALL) { $env:DENEXT_INSTALL } else {
    Join-Path $HOME '.denext'
  }
  $bin = Join-Path $root 'bin'

  if ($Uninstall) {
    Assert-SafeInstallRoot $root
    # The `deno` link `toolchain link` made (only a link of its own; anything else is left).
    $installed = Join-Path $bin 'denext.exe'
    if ((Test-Path -LiteralPath $installed -PathType Leaf) -and (Test-ToolchainVerb $installed)) {
      Invoke-Denext $installed @('toolchain', 'unlink') | Out-Null
    }
    Remove-DenextPath $bin
    Uninstall-DenextFiles $root
    Write-Host "denext: removed denext from $root and its bin from your user Path"
    return
  }

  # The binaries for this machine, best first. Windows on Arm gets the native Arm64 build; a
  # release from before it was published (DENEXT_VERSION=v4.1.0, say) has none, and the x64
  # binary, which Windows on Arm runs under emulation, is the fallback.
  $arch = Get-NativeArchitecture
  $targets = switch ($arch) {
    'ARM64' { @('aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc') }
    'AMD64' { @('x86_64-pc-windows-msvc') }
    default {
      throw "denext: no prebuilt binary for $arch. Use the CLI from JSR: deno install -A -g -n denext jsr:@denext/denext/cli"
    }
  }

  $version = $env:DENEXT_VERSION
  if (-not $version -and $env:DENEXT_ARTIFACTS) {
    $version = 'local'
  } elseif (-not $version) {
    # `releases/latest` is the newest NON-prerelease: an rc tag never becomes "latest".
    $version = Get-LatestTag $apiBase $webBase $repo
  }
  if (-not $version) { throw 'denext: could not determine the latest release; set DENEXT_VERSION.' }

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
    if (-not $fetched) { throw "denext: $version has no $asset" }

    # A binary that will run with your permissions is never installed unverified. A missing
    # checksum is as fatal as a wrong one - whoever can swap the archive can drop the checksum
    # too - unless DENEXT_INSECURE=1 says, loudly, that this is deliberate.
    $expected = Get-PublishedDigest "$downloadBase/$version" $asset $tmp
    if (-not $expected) {
      if ($env:DENEXT_INSECURE -eq '1') {
        Write-Warning "denext: no checksum could be fetched for $asset; installing UNVERIFIED because DENEXT_INSECURE=1 is set."
      } else {
        throw "denext: no checksum could be fetched for $asset - not installing. Every release publishes SHA256SUMS; check https://github.com/$repo/releases/tag/$version (DENEXT_INSECURE=1 installs anyway, unverified)."
      }
    } else {
      $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
      if ($actual -ne $expected.ToLowerInvariant()) {
        throw "denext: checksum verification FAILED for $asset - not installing.`n  expected $expected`n  got      $actual"
      }
      Write-Host 'denext: checksum verified'
    }

    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Move-Item -Force (Join-Path $tmp 'x\denext.exe') (Join-Path $bin 'denext.exe')
    # What -Uninstall may remove: only the files this script put here.
    Set-Content -Encoding ascii -Path (Join-Path $root $ManifestName) -Value $InstalledFiles
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $exe = Join-Path $bin 'denext.exe'
  Write-Host "denext: installed $(& $exe --version) to $exe"
  if ($env:DENEXT_NO_PATH -eq '1') {
    Write-Host "Add it to your Path:  `$env:Path = `"$bin;`$env:Path`""
  } elseif (Add-DenextPath $bin) {
    Write-Host "denext: added $bin to your user Path (open a new terminal to pick it up)"
  }

  Install-DenoToolchain $exe $target
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
  try {
    Invoke-WebRequest -UseBasicParsing "$base/$version/$asset" -OutFile $zip
    return $true
  } catch {
    $response = $_.Exception.PSObject.Properties['Response']
    if ($response -and $response.Value -and [int]$response.Value.StatusCode -eq 404) { return $false }
    throw
  }
}

# Install denext's Deno toolchain through the new binary, and - when this machine has no `deno` -
# link `deno` to it. Never fatal: a failure is one warning, and the binary downloads the toolchain
# on the first command that needs it. An existing `deno` is never replaced: the link is made only
# when Path has none, and `toolchain link` itself refuses to overwrite a file it did not create.
function Install-DenoToolchain([string]$exe, [string]$target) {
  if ($env:DENEXT_NO_TOOLCHAIN -eq '1') { return }
  if (-not (Test-ToolchainVerb $exe)) {
    Write-Host ("denext: $(& $exe --version) predates denext's Deno toolchain (denext 4.0); " +
      'skipping that step - this release runs on the deno on your Path.')
    return
  }
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
    Write-Warning ('denext: the Deno toolchain could not be installed now; it downloads on the ' +
      'first command that needs it (or run `denext toolchain install`).')
    return
  }
  $existing = Get-Command deno -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "denext: keeping your deno ($($existing.Source)); denext runs its own toolchain anyway"
    return
  }
  if ($env:DENEXT_NO_DENO_LINK -eq '1') { return }
  if ((Invoke-Denext $exe @('toolchain', 'link')) -ne 0) {
    Write-Warning 'denext: could not link `deno` to the toolchain (`denext deno ...` still runs it).'
  }
}

# Whether the binary at $exe has the `toolchain` verb, which denext 4.0 added: an older release
# (DENEXT_VERSION=v3.x) answers it with `unknown command`. A version it cannot read is assumed new.
function Test-ToolchainVerb([string]$exe) {
  $ErrorActionPreference = 'Continue'
  try {
    $version = "$(& $exe --version 2>$null)"
  } catch {
    return $true
  }
  if ($version -match '^denext (\d+)\.') { return [int]$Matches[1] -ge 4 }
  return $true
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
      throw "denext: refusing to uninstall from $full (DENEXT_INSTALL points at a shared directory)"
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
# (`toolchain unlink`) just before it deletes it, and the file can stay held for a moment after that
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

# Add $dir to the USER Path (and this session's); returns whether the user Path changed.
function Add-DenextPath([string]$dir) {
  if (-not (Test-PathEntry $env:Path $dir)) { $env:Path = "$dir;$env:Path" }
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($user -and (Test-PathEntry $user $dir)) { return $false }
  $next = if ($user) { "$dir;$user" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  return $true
}

# Remove $dir from the USER Path.
function Remove-DenextPath([string]$dir) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $user -or -not (Test-PathEntry $user $dir)) { return }
  $kept = ($user -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $dir.TrimEnd('\') }
  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}

Install-Denext -Uninstall:$Uninstall

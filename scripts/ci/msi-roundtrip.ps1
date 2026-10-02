# Install, check and uninstall a denext desktop .msi - the Windows half of the installers CI job
# (.github/workflows/desktop-ci.yml) and the manual check on a Windows box.
#
#   powershell -ExecutionPolicy Bypass -File scripts/ci/msi-roundtrip.ps1 `
#     -Msi dist\denext-native-x64.msi -AppName "denext native" -Exe denext-native-x64.exe `
#     -Scheme denextnative [-PerMachine] [-Upgrade dist\new.msi -UpgradeVersion 1.0.1]
#
# Per-user (the default) needs no administrator rights: the app lands in
# %LOCALAPPDATA%\Programs\<App>, the scheme under HKCU, the shortcut in the user's Start menu.
# -PerMachine (ALLUSERS=1) needs an elevated shell: Program Files, HKLM, the all-users Start menu.
# -Upgrade installs a second build over the first and checks exactly one product remains.

param(
  [Parameter(Mandatory)] [string]$Msi,
  [Parameter(Mandatory)] [string]$AppName,
  [Parameter(Mandatory)] [string]$Exe,
  [string]$Scheme,
  [switch]$PerMachine,
  [string]$Upgrade,
  [string]$UpgradeVersion
)
$ErrorActionPreference = 'Stop'

function Invoke-Msiexec([string[]]$msiArgs) {
  $log = Join-Path ([IO.Path]::GetTempPath()) ("msi-" + [Guid]::NewGuid() + ".log")
  $p = Start-Process msiexec.exe -ArgumentList ($msiArgs + @('/qn', '/l*v', "`"$log`"")) -Wait -PassThru
  if ($p.ExitCode -ne 0) {
    Get-Content $log -Tail 60 | Write-Host
    throw "msiexec $($msiArgs -join ' ') exited $($p.ExitCode)"
  }
}

function Assert([bool]$ok, [string]$what) {
  if (-not $ok) { throw "FAILED: $what" }
  Write-Host "ok  $what"
}

# The Add/Remove Programs entries of this app in the install's hive.
function Get-Products([string]$hive) {
  $keys = @("${hive}:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*")
  if ($hive -eq 'HKLM') { $keys += 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' }
  @(Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $AppName })
}

$msiPath = (Resolve-Path $Msi).Path
$scope = if ($PerMachine) { @('ALLUSERS=1') } else { @() }
$hive = if ($PerMachine) { 'HKLM' } else { 'HKCU' }
$installDir = if ($PerMachine) { Join-Path $env:ProgramFiles $AppName } else {
  Join-Path $env:LOCALAPPDATA "Programs\$AppName"
}
$startMenu = if ($PerMachine) { Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs' } else {
  Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
}
$shortcut = Join-Path $startMenu "$AppName.lnk"

Write-Host "== install ($hive) $msiPath"
Invoke-Msiexec (@('/i', "`"$msiPath`"") + $scope)
Assert (Test-Path (Join-Path $installDir $Exe)) "the launcher is installed in $installDir"
Assert (Test-Path (Join-Path $installDir 'laufey-launch.json')) 'laufey-launch.json ships in the install'
Assert (Test-Path $shortcut) "the Start-menu shortcut $shortcut exists"
$target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
Assert ($target -ieq (Join-Path $installDir $Exe)) "the shortcut targets the launcher ($target)"
if ($Scheme) {
  $cmdKey = "${hive}:\Software\Classes\$Scheme\shell\open\command"
  Assert (Test-Path $cmdKey) "the ${Scheme}:// scheme is registered under $hive"
  $cmd = (Get-ItemProperty $cmdKey).'(default)'
  Assert ($cmd -like "*$Exe*%1*") "the scheme opens the launcher ($cmd)"
  Assert ((Get-ItemProperty "${hive}:\Software\Classes\$Scheme").'URL Protocol' -eq '') 'URL Protocol is set'
}
Assert ((Get-Products $hive).Count -eq 1) 'one Add/Remove Programs entry'

$product = $msiPath
if ($Upgrade) {
  $upgradePath = (Resolve-Path $Upgrade).Path
  Write-Host "== upgrade ($hive) $upgradePath"
  Invoke-Msiexec (@('/i', "`"$upgradePath`"") + $scope)
  $entries = Get-Products $hive
  Assert ($entries.Count -eq 1) "still one Add/Remove Programs entry after the upgrade (found $($entries.Count))"
  Assert ($entries[0].DisplayVersion -eq $UpgradeVersion) "the entry is version $UpgradeVersion"
  $product = $upgradePath
}

Write-Host "== uninstall ($hive)"
Invoke-Msiexec (@('/x', "`"$product`"") + $scope)
Assert (-not (Test-Path (Join-Path $installDir $Exe))) 'the launcher is removed'
Assert (-not (Test-Path $shortcut)) 'the shortcut is removed'
if ($Scheme) { Assert (-not (Test-Path "${hive}:\Software\Classes\$Scheme")) 'the scheme key is removed' }
Assert ((Get-Products $hive).Count -eq 0) 'no Add/Remove Programs entry remains'
Write-Host "msi round-trip OK ($hive)"

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

# The installed products of this package family (its UpgradeCode), from Windows Installer itself:
# a per-user MSI keeps its Add/Remove Programs data under the installer's per-SID UserData, not
# the HKCU Uninstall key, so asking the installer covers both scopes.
function Get-UpgradeCode([string]$path) {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($path, 0))
  $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db,
    @("SELECT Value FROM Property WHERE Property='UpgradeCode'"))
  $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
  $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
  $code = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, 1)
  $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
  [Runtime.InteropServices.Marshal]::ReleaseComObject($view) | Out-Null
  [Runtime.InteropServices.Marshal]::ReleaseComObject($db) | Out-Null
  return $code
}

function Get-Products([string]$upgradeCode) {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $related = $installer.GetType().InvokeMember('RelatedProducts', 'GetProperty', $null, $installer, @($upgradeCode))
  @($related | ForEach-Object {
      [pscustomobject]@{
        ProductCode = $_
        Version = $installer.GetType().InvokeMember('ProductInfo', 'GetProperty', $null, $installer, @($_, 'VersionString'))
      }
    })
}

$msiPath = (Resolve-Path $Msi).Path
$upgradeCode = Get-UpgradeCode $msiPath
Write-Host "UpgradeCode $upgradeCode"
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
Assert ((Get-Products $upgradeCode).Count -eq 1) 'one installed product'

$product = $msiPath
if ($Upgrade) {
  $upgradePath = (Resolve-Path $Upgrade).Path
  Write-Host "== upgrade ($hive) $upgradePath"
  Invoke-Msiexec (@('/i', "`"$upgradePath`"") + $scope)
  Assert ((Get-UpgradeCode $upgradePath) -eq $upgradeCode) 'the new build keeps the UpgradeCode'
  $entries = Get-Products $upgradeCode
  Assert ($entries.Count -eq 1) "still one installed product after the upgrade (found $($entries.Count))"
  Assert ($entries[0].Version -eq $UpgradeVersion) "the product is version $UpgradeVersion ($($entries[0].Version))"
  $product = $upgradePath
}

Write-Host "== uninstall ($hive)"
Invoke-Msiexec (@('/x', "`"$product`"") + $scope)
Assert (-not (Test-Path (Join-Path $installDir $Exe))) 'the launcher is removed'
Assert (-not (Test-Path $shortcut)) 'the shortcut is removed'
if ($Scheme) { Assert (-not (Test-Path "${hive}:\Software\Classes\$Scheme")) 'the scheme key is removed' }
Assert ((Get-Products $upgradeCode).Count -eq 0) 'no installed product remains'
Write-Host "msi round-trip OK ($hive)"

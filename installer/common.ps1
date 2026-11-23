# Shared constants and helpers for dev-install.ps1 / dev-uninstall.ps1 (dot-sourced).
# Keep these values in sync with installer/OpenTethery.iss (checked by test/static.test.js).

$script:AppName      = 'Open Tethery'
$script:HelperPort   = 47825
$script:HelperExe    = 'OpenTetheryHelper.exe'
$script:RuleName     = 'Open Tethery Helper'
$script:RunKeyPath   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunValueName = 'OpenTetheryHelper'
$script:CepId        = 'com.opentethery.panel'
$script:OldCepId     = 'com.screenlive.video'
$script:PsPluginId   = 'com.opentethery.photoshop'
$script:CsxsVersions = 9..13
$script:OldRulePatterns = @('Live Video Preview*', 'Live Phone Preview*')
$script:InstallDir   = Join-Path $env:LOCALAPPDATA 'OpenTethery'
$script:LogFile      = Join-Path $script:InstallDir 'install.log'
$script:CepRoot      = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$script:MediaCoreName = 'OpenTethery'
$script:UpiaExe      = 'C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
$script:AdobeProcs   = @('Adobe Premiere Pro', 'AfterFX', 'Photoshop')

function Write-Log {
  param([string]$Message, [string]$Color = 'Gray')
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $Message -ForegroundColor $Color
  if (-not $WhatIfPreference) {
    try {
      New-Item -ItemType Directory -Force $script:InstallDir | Out-Null
      Add-Content -Path $script:LogFile -Value $line
    } catch { }
  }
}

# Run an action, or only print it in -WhatIf mode.
function Invoke-Step {
  param([string]$Description, [scriptblock]$Action)
  if ($WhatIfPreference) { Write-Host "WHATIF: $Description" -ForegroundColor Cyan; return }
  Write-Log $Description
  try { & $Action } catch { Write-Log "  FAILED: $($_.Exception.Message)" 'Yellow' }
}

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-launch the calling script elevated (one UAC prompt) with the same switches.
function Invoke-SelfElevate {
  param([string]$ScriptPath, [hashtable]$Bound)
  # -NoExit keeps the admin window open so errors stay readable.
  $a = @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"")
  foreach ($k in $Bound.Keys) {
    $v = $Bound[$k]
    if ($v -is [switch]) { if ($v.IsPresent) { $a += "-$k" } }
    else { $a += @("-$k", "`"$v`"") }
  }
  $p = Start-Process powershell -Verb RunAs -ArgumentList $a -Wait -PassThru
  exit $p.ExitCode
}

function Stop-OpenTetheryHelper {
  Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($script:HelperExe)) -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  # Fallback layout: node.exe running helper\ from the install dir.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$($script:InstallDir)*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Anything else still holding our ports (e.g. the old Live Preview relay on 47825/47826).
  Get-NetTCPConnection -LocalPort $script:HelperPort, ($script:HelperPort + 1) -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -in @('node', $([IO.Path]::GetFileNameWithoutExtension($script:HelperExe))) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

# First existing MediaCore plug-in root (newest version folder), else the default 7.0 path.
function Find-MediaCoreRoot {
  $base = Join-Path $env:ProgramFiles 'Adobe\Common\Plug-ins'
  if (Test-Path $base) {
    $dirs = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'MediaCore') } | Sort-Object Name -Descending
    if ($dirs) { return (Join-Path @($dirs)[0].FullName 'MediaCore') }
  }
  return (Join-Path $base '7.0\MediaCore')
}

function Get-AdobeRunning {
  foreach ($n in $script:AdobeProcs) { Get-Process -Name $n -ErrorAction SilentlyContinue }
}

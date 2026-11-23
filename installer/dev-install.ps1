<#
.SYNOPSIS
  Open Tethery dev install (M0). One UAC prompt, idempotent, logs to %LOCALAPPDATA%\OpenTethery\install.log.

.DESCRIPTION
  Installs helper + viewer, CEP panel, Transmit plug-in, Photoshop plug-in, firewall rule and the
  start-up entry; removes the old com.screenlive.video panel and old "Live Video Preview" rules;
  starts the helper and checks http://127.0.0.1:47825/health.

  powershell -ExecutionPolicy Bypass -File installer\dev-install.ps1
  ... -WhatIf          print every action, change nothing
  ... -Uninstall       same as dev-uninstall.ps1
  ... -SkipNative      do not touch the Transmit plug-in (no Premiere restart needed)
  ... -SkipPhotoshop   do not build/install the Photoshop plug-in
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$Uninstall,
  [switch]$SkipNative,
  [switch]$SkipPhotoshop,
  [switch]$NoStart,
  [string]$PrmPath,
  [string]$CcxPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($Uninstall) {
  & (Join-Path $PSScriptRoot 'dev-uninstall.ps1') -SkipNative:$SkipNative -SkipPhotoshop:$SkipPhotoshop -WhatIf:$WhatIfPreference
  exit $LASTEXITCODE
}

if (-not $WhatIfPreference -and -not (Test-Admin)) {
  Write-Host 'Asking Windows for administrator permission (needed for firewall and Adobe plug-in folder)...'
  Invoke-SelfElevate -ScriptPath $PSCommandPath -Bound $PSBoundParameters
}

$version = (Get-Content (Join-Path $PSScriptRoot 'version.txt') -Raw).Trim()
Write-Log "=== Open Tethery dev install $version ($(Get-Date -Format s)) ==="

# ---- 0. Adobe apps should be closed (panels and the Transmit plug-in load at start-up) ----
$running = @(Get-AdobeRunning)
if ($running.Count -gt 0) {
  Write-Log ('Adobe apps are running: ' + (($running | ForEach-Object { $_.ProcessName }) -join ', ') +
    '. Panel files will be copied, but restart them to load the new version.') 'Yellow'
}

# ---- 1. Helper + viewer ----
Invoke-Step 'Stop running helper' { Stop-OpenTetheryHelper }

$distHelper = Join-Path $PSScriptRoot 'dist\helper'
$exeSrc = Join-Path $distHelper $script:HelperExe
$useExe = Test-Path $exeSrc
$launchTarget = ''

if ($useExe) {
  Invoke-Step "Copy $($script:HelperExe) + viewer + profiles from $distHelper to $($script:InstallDir)" {
    New-Item -ItemType Directory -Force $script:InstallDir | Out-Null
    Copy-Item (Join-Path $distHelper '*') $script:InstallDir -Recurse -Force
  }
  $launchTarget = '"' + (Join-Path $script:InstallDir $script:HelperExe) + '"'
} else {
  Write-Log "No built exe at $exeSrc (run installer\build-helper-exe.ps1). Using node + helper source instead." 'Yellow'
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe -and -not $WhatIfPreference) { throw 'node.exe not found and no built helper exe. Install Node 22 or build the exe.' }
  if (-not $nodeExe) { $nodeExe = 'node.exe' }
  $helperMain = 'src\index.js'
  $pkgPath = Join-Path $repo 'helper\package.json'
  if (Test-Path $pkgPath) {
    $m = (Get-Content $pkgPath -Raw | ConvertFrom-Json).main
    if ($m) { $helperMain = $m -replace '/', '\' }
  }
  Invoke-Step "Copy helper source + viewer to $($script:InstallDir)" {
    New-Item -ItemType Directory -Force $script:InstallDir | Out-Null
    $h = Join-Path $script:InstallDir 'helper'
    if (Test-Path $h) { Remove-Item $h -Recurse -Force }
    Copy-Item (Join-Path $repo 'helper') $h -Recurse -Force
    if (-not (Test-Path (Join-Path $h 'node_modules\ws'))) {
      Push-Location $h; try { & npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }
    }
    Copy-Item $nodeExe (Join-Path $script:InstallDir 'node.exe') -Force
  }
  $launchTarget = '"' + (Join-Path $script:InstallDir 'node.exe') + '" "' +
    (Join-Path $script:InstallDir ('helper\' + $helperMain)) + '"'
}
# Viewer always sits at <install>\viewer (helper reads ..\viewer or OT_VIEWER_DIR).
if (-not (Test-Path (Join-Path $distHelper 'viewer'))) {
  Invoke-Step "Copy viewer\ to $($script:InstallDir)\viewer" {
    $v = Join-Path $script:InstallDir 'viewer'
    if (Test-Path $v) { Remove-Item $v -Recurse -Force }
    Copy-Item (Join-Path $repo 'viewer') $v -Recurse -Force
  }
}

# Hidden launcher: a small .ps1 (antivirus often deletes script-written .vbs files).
# The Run key and this script use it; the panel starts the exe / node.exe directly.
$launchExe = if ($useExe) { Join-Path $script:InstallDir $script:HelperExe } else { Join-Path $script:InstallDir 'node.exe' }
$launchArgs = if ($useExe) { '' } else { '"' + (Join-Path $script:InstallDir ('helper\' + $helperMain)) + '"' }
$launcherPs1 = Join-Path $script:InstallDir 'start-helper.ps1'
Invoke-Step 'Write start-helper.ps1 launcher' {
  $line = "Start-Process -WindowStyle Hidden -WorkingDirectory '$($script:InstallDir)' -FilePath '$launchExe'"
  if ($launchArgs) { $line += " -ArgumentList '$launchArgs'" }
  Set-Content -Path $launcherPs1 -Encoding UTF8 -Value $line
}

# ---- 2. CEP panel (Premiere Pro + After Effects) ----
$cepSrc = Join-Path $repo 'panels\cep'
$cepDst = Join-Path $script:CepRoot $script:CepId
Invoke-Step "Remove old panel $($script:OldCepId)" {
  Remove-Item (Join-Path $script:CepRoot $script:OldCepId) -Recurse -Force -ErrorAction SilentlyContinue
}
Invoke-Step "Copy CEP panel $cepSrc to $cepDst" {
  if (-not (Test-Path $cepSrc)) { throw "Panel source not found: $cepSrc" }
  if (Test-Path $cepDst) { Remove-Item $cepDst -Recurse -Force }
  New-Item -ItemType Directory -Force $script:CepRoot | Out-Null
  Copy-Item $cepSrc $cepDst -Recurse -Force
}
foreach ($v in $script:CsxsVersions) {
  Invoke-Step "Registry HKCU\Software\Adobe\CSXS.$v PlayerDebugMode=1" {
    $k = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
    New-ItemProperty -Path $k -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
  }
}

# ---- 3. Transmit plug-in (needs admin, Premiere closed) ----
if ($SkipNative) {
  Write-Log 'Skipping Transmit plug-in (-SkipNative).'
} else {
  $prm = if ($PrmPath) { $PrmPath } else { Join-Path $repo 'build\native\Release\OpenTetheryTransmit.prm' }
  $mcDest = Join-Path (Find-MediaCoreRoot) $script:MediaCoreName
  if (Test-Path $prm) {
    if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) {
      Write-Log 'Premiere Pro is open: the Transmit plug-in file is locked and the copy may fail. Close it and re-run.' 'Yellow'
    }
    Invoke-Step "Copy $prm to $mcDest" {
      New-Item -ItemType Directory -Force $mcDest | Out-Null
      Copy-Item $prm $mcDest -Force
      $aex = [IO.Path]::ChangeExtension($prm, '.aex')
      if (Test-Path $aex) { Copy-Item $aex $mcDest -Force }
    }
  } else {
    Write-Log "Transmit plug-in not built ($prm). Build it (native\transmit\README.md) or pass -PrmPath; continuing." 'Yellow'
    if ($WhatIfPreference) { Write-Host "WHATIF: would copy OpenTetheryTransmit.prm to $mcDest" -ForegroundColor Cyan }
  }
}

# ---- 4. Photoshop UXP plug-in ----
if ($SkipPhotoshop) {
  Write-Log 'Skipping Photoshop plug-in (-SkipPhotoshop).'
} else {
  $psSrc = Join-Path $repo 'panels\uxp-photoshop'
  $ccx = if ($CcxPath) { $CcxPath } else { Join-Path $PSScriptRoot 'dist\OpenTetheryPhotoshop.ccx' }
  if (-not $CcxPath) {
    Invoke-Step "Build $ccx from $psSrc (zip, id $($script:PsPluginId))" {
      if (-not (Test-Path $psSrc)) { throw "Photoshop plug-in source not found: $psSrc" }
      New-Item -ItemType Directory -Force (Split-Path $ccx) | Out-Null
      $zip = [IO.Path]::ChangeExtension($ccx, '.zip')
      Remove-Item $zip, $ccx -Force -ErrorAction SilentlyContinue
      Compress-Archive -Path (Join-Path $psSrc '*') -DestinationPath $zip -Force
      Move-Item $zip $ccx -Force
    }
  }
  if (Test-Path $script:UpiaExe) {
    Invoke-Step "Install Photoshop plug-in via UnifiedPluginInstallerAgent: $ccx" {
      & $script:UpiaExe /install $ccx
      Write-Log "  UPIA exit code $LASTEXITCODE (restart Photoshop; Plugins > Open Tethery)"
    }
  } else {
    Write-Log "UnifiedPluginInstallerAgent not found. Double-click $ccx to install via Creative Cloud, or load" 'Yellow'
    Write-Log "  panels\uxp-photoshop\manifest.json in UXP Developer Tool (Add Plugin, then Load). Then Plugins > Open Tethery." 'Yellow'
    if ($WhatIfPreference) { Write-Host "WHATIF: would run UPIA /install $ccx (if present) else print manual steps" -ForegroundColor Cyan }
  }
}

# ---- 5. Firewall: inbound TCP 47825, private profile; drop old rules ----
Invoke-Step "Firewall rule '$($script:RuleName)' inbound TCP $($script:HelperPort) Private" {
  Remove-NetFirewallRule -DisplayName $script:RuleName -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $script:RuleName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $script:HelperPort -Profile Private `
    -Description 'Lets phones on your private Wi-Fi open the Open Tethery preview.' | Out-Null
}
foreach ($p in $script:OldRulePatterns) {
  Invoke-Step "Remove old firewall rules '$p'" {
    Get-NetFirewallRule -DisplayName $p -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  }
}

# ---- 6. Start with Windows ----
Invoke-Step "Run entry $($script:RunKeyPath)\$($script:RunValueName)" {
  $cmd = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPs1 + '"'
  New-ItemProperty -Path $script:RunKeyPath -Name $script:RunValueName -Value $cmd -PropertyType String -Force | Out-Null
}

# ---- 7. Start helper and check /health ----
if ($NoStart) {
  Write-Log 'Not starting helper (-NoStart).'
} else {
  Invoke-Step 'Start helper (hidden)' {
    if ($launchArgs) { Start-Process -WindowStyle Hidden -WorkingDirectory $script:InstallDir -FilePath $launchExe -ArgumentList $launchArgs }
    else { Start-Process -WindowStyle Hidden -WorkingDirectory $script:InstallDir -FilePath $launchExe }
  }
  if ($WhatIfPreference) {
    Write-Host "WHATIF: GET http://127.0.0.1:$($script:HelperPort)/health expecting ok=true" -ForegroundColor Cyan
  } else {
    $ok = $false
    for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
      Start-Sleep -Seconds 1
      try {
        $h = Invoke-RestMethod "http://127.0.0.1:$($script:HelperPort)/health" -TimeoutSec 2
        if ($h.ok -and $h.name -eq 'open-tethery') { $ok = $true; Write-Log "Helper OK: $($h.name) $($h.version) protocol $($h.protocol)" 'Green' }
      } catch { }
    }
    if (-not $ok) { Write-Log "Helper did not answer on port $($script:HelperPort). See $($script:LogFile)." 'Red'; exit 1 }
  }
}

Write-Log 'Done. Restart Premiere Pro / After Effects / Photoshop, then Window > Extensions > Open Tethery.' 'Green'

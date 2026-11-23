<#
.SYNOPSIS
  Removes everything dev-install.ps1 put on the PC. -WhatIf prints actions only.
  Also removes the old com.screenlive.video panel and old firewall rules if still present.
  The CSXS PlayerDebugMode flags are left on (other CEP panels may need them) unless -RemoveDebugMode.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$SkipNative,
  [switch]$SkipPhotoshop,
  [switch]$RemoveDebugMode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $WhatIfPreference -and -not (Test-Admin)) {
  Write-Host 'Asking Windows for administrator permission...'
  Invoke-SelfElevate -ScriptPath $PSCommandPath -Bound $PSBoundParameters
}

Write-Log '=== Open Tethery uninstall ==='

Invoke-Step 'Stop running helper' { Stop-OpenTetheryHelper }
Invoke-Step "Remove Run entry $($script:RunValueName)" {
  Remove-ItemProperty -Path $script:RunKeyPath -Name $script:RunValueName -ErrorAction SilentlyContinue
}
Invoke-Step "Remove firewall rule '$($script:RuleName)'" {
  Remove-NetFirewallRule -DisplayName $script:RuleName -ErrorAction SilentlyContinue
}
foreach ($p in $script:OldRulePatterns) {
  Invoke-Step "Remove old firewall rules '$p'" {
    Get-NetFirewallRule -DisplayName $p -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  }
}
foreach ($id in @($script:CepId, $script:OldCepId)) {
  Invoke-Step "Remove CEP panel $id" {
    Remove-Item (Join-Path $script:CepRoot $id) -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if ($RemoveDebugMode) {
  foreach ($v in $script:CsxsVersions) {
    Invoke-Step "Remove PlayerDebugMode CSXS.$v" {
      Remove-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.$v" -Name PlayerDebugMode -ErrorAction SilentlyContinue
    }
  }
}

if (-not $SkipNative) {
  $mc = Join-Path (Find-MediaCoreRoot) $script:MediaCoreName
  if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) {
    Write-Log 'Premiere Pro is open: the plug-in file may be locked. Close it and re-run if removal fails.' 'Yellow'
  }
  Invoke-Step "Remove Transmit plug-in $mc" { Remove-Item $mc -Recurse -Force -ErrorAction SilentlyContinue }
}

if (-not $SkipPhotoshop) {
  if (Test-Path $script:UpiaExe) {
    Invoke-Step "Uninstall Photoshop plug-in $($script:PsPluginId) via UPIA" {
      & $script:UpiaExe /remove $script:PsPluginId
    }
  } else {
    Write-Log "Remove the Photoshop plug-in $($script:PsPluginId) in Creative Cloud Desktop > Stock & Marketplace > Plugins > Manage plugins (or UXP Developer Tool > Remove)." 'Yellow'
  }
}

# Last: the install dir itself. The log lives in it, so copy nothing; it goes too.
if ($WhatIfPreference) {
  Write-Host "WHATIF: Remove $($script:InstallDir) (helper, viewer, install.log)" -ForegroundColor Cyan
} else {
  Write-Host "Removing $($script:InstallDir)"
  Remove-Item $script:InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Uninstalled.' -ForegroundColor Green

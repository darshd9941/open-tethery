# Open Tethery: copy a built .prm into Adobe's shared MediaCore plug-in folder.
# Asks for admin rights (Windows will show a prompt). Close Premiere first.
#
#   powershell -ExecutionPolicy Bypass -File native\transmit\install.ps1            # our plugin (Release)
#   powershell -ExecutionPolicy Bypass -File native\transmit\install.ps1 -Path X.prm
#   powershell -ExecutionPolicy Bypass -File native\transmit\install.ps1 -Uninstall
param(
  [string]$Path = (Join-Path $PSScriptRoot "..\..\build\native\Release\OpenTetheryTransmit.prm"),
  [switch]$Uninstall
)

$dest = "C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\OpenTethery"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $args2 = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  if ($Uninstall) { $args2 += "-Uninstall" } else { $args2 += @("-Path", "`"$((Resolve-Path $Path).Path)`"") }
  Start-Process powershell -Verb RunAs -ArgumentList $args2 -Wait
  exit
}

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  Write-Host "Premiere Pro is open. Close it, then run this again." -ForegroundColor Yellow
  Start-Sleep 5; exit 1
}

if ($Uninstall) {
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Removed $dest"
} else {
  if (-not (Test-Path $Path)) { Write-Host "Not found: $Path (build it first)" -ForegroundColor Red; Start-Sleep 5; exit 1 }
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item $Path $dest -Force
  Write-Host "Installed $(Split-Path $Path -Leaf) to $dest" -ForegroundColor Green
}
Start-Sleep 3

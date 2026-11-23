$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root "config.json"
$port = 47823
if (Test-Path $configPath) {
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.port) { $port = [int]$config.port }
  } catch {
    Write-Host "Could not read config.json; using port 47823."
  }
}

$name = "Live Phone Preview (TCP $port)"

$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Firewall rule already exists: $name"
  exit 0
}

New-NetFirewallRule `
  -DisplayName $name `
  -Description "Allows phones on the local network to open the Photoshop live preview." `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $port `
  -Profile Any | Out-Null

Write-Host "Firewall rule created for inbound TCP port $port (all network profiles)."
Write-Host "Only this port is opened. Remove the rule from Windows Firewall when you no longer need it."
Write-Host "If you change the port in config.json, run this file again."

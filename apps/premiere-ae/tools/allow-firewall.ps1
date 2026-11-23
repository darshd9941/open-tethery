$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root "config.json"
$port = 47825
if (Test-Path $configPath) {
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.port) { $port = [int]$config.port }
  } catch {
    Write-Host "Could not read config.json; using port 47825."
  }
}

$name = "Live Video Preview (TCP $port)"

$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Firewall rule already exists: $name"
  exit 0
}

New-NetFirewallRule `
  -DisplayName $name `
  -Description "Allows phones on the local network to open the Premiere Pro & After Effects live video preview." `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $port `
  -Profile Any | Out-Null

Write-Host "Firewall rule created for inbound TCP port $port (all network profiles)."
Write-Host "Only this port is opened."

# Builds installer\dist\helper\OpenTetheryHelper.exe (+ viewer\, profiles\) from helper\ and viewer\.
# Needs Node 22+ on the PATH and internet once (npm install for esbuild/ws, npx postject).
#   powershell -ExecutionPolicy Bypass -File installer\build-helper-exe.ps1
param([switch]$BundleOnly)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$nodeVer = (& node --version) -replace '^v', ''
if ([int]($nodeVer.Split('.')[0]) -lt 22) { throw "Node 22+ required (found $nodeVer)" }

# helper runtime deps (ws) must be present to be bundled
if (-not (Test-Path (Join-Path $repo 'helper\node_modules\ws'))) {
  Push-Location (Join-Path $repo 'helper'); try { & npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }
}
# esbuild is a dev dependency of the installer; the JS falls back to a tiny bundler without it
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules\esbuild'))) {
  Push-Location $PSScriptRoot; try { & npm install --no-audit --no-fund } finally { Pop-Location }
}

$args2 = @((Join-Path $PSScriptRoot 'build-helper-exe.js'))
if ($BundleOnly) { $args2 += '--bundle-only' }
& node @args2
if ($LASTEXITCODE -ne 0) { throw "build-helper-exe.js failed ($LASTEXITCODE)" }
Write-Host 'Done. Next: installer\dev-install.ps1' -ForegroundColor Green

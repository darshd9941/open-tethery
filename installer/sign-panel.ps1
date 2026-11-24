# Signs the CEP panel into a .zxp so Premiere Pro / After Effects load it WITHOUT PlayerDebugMode.
#   First time (once per developer PC):  installer\sign-panel.ps1 -CreateCert
#   Every release:                       installer\sign-panel.ps1
# Output: installer\dist\PocketMonitorPanel.zxp   and the unpacked signed folder installer\dist\panel\ (what the setup installs).
#
# Needs Adobe's ZXPSignCmd.exe (free, from https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD).
# Put it in %USERPROFILE%\.pocketmonitor\ZXPSignCmd.exe, or on PATH, or set PM_ZXPSIGNCMD to its full path,
# or set PM_ZXPSIGNCMD_URL to a direct download link and this script fetches it once.
#
# The certificate is SELF-SIGNED and lives OUTSIDE the repo: %USERPROFILE%\.pocketmonitor\panel-cert.p12
# (override: PM_PANEL_CERT). Password: env PM_PANEL_CERT_PASS, else you are asked. Never commit the .p12.
# Adobe accepts self-signed .zxp files, so users need no developer settings.
param(
  [switch]$CreateCert,
  [string]$CertPath = $(if ($env:PM_PANEL_CERT) { $env:PM_PANEL_CERT } else { Join-Path $env:USERPROFILE '.pocketmonitor\panel-cert.p12' }),
  [string]$TimestampUrl = $(if ($env:PM_TIMESTAMP_URL) { $env:PM_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }),
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'dist' }
$product = Get-Content (Join-Path $repo 'product.json') -Raw | ConvertFrom-Json
$zxpName = ($product.ids.installDir) + 'Panel.zxp'
$toolDir = Join-Path $env:USERPROFILE '.pocketmonitor'

function Find-ZxpSignCmd {
  if ($env:PM_ZXPSIGNCMD -and (Test-Path $env:PM_ZXPSIGNCMD)) { return $env:PM_ZXPSIGNCMD }
  $local = Join-Path $toolDir 'ZXPSignCmd.exe'
  if (Test-Path $local) { return $local }
  $cmd = Get-Command 'ZXPSignCmd.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if ($env:PM_ZXPSIGNCMD_URL) {
    Write-Host "Downloading ZXPSignCmd from $($env:PM_ZXPSIGNCMD_URL) ..."
    New-Item -ItemType Directory -Force $toolDir | Out-Null
    Invoke-WebRequest -Uri $env:PM_ZXPSIGNCMD_URL -OutFile $local -UseBasicParsing
    return $local
  }
  throw ("ZXPSignCmd.exe was not found. Download it from https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD " +
    "(pick the win64 build), save it as $local, or set PM_ZXPSIGNCMD to its path (or PM_ZXPSIGNCMD_URL to a download link).")
}

function Get-CertPassword {
  if ($env:PM_PANEL_CERT_PASS) { return $env:PM_PANEL_CERT_PASS }
  $s = Read-Host 'Panel certificate password' -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$zxpSign = Find-ZxpSignCmd

if ($CreateCert) {
  if (Test-Path $CertPath) { throw "A certificate already exists at $CertPath. Delete it first if you really want a new one (users would need the panel re-signed with it)." }
  $pass = Get-CertPassword
  New-Item -ItemType Directory -Force (Split-Path $CertPath) | Out-Null
  & $zxpSign -selfSignedCert US NA $product.vendor $product.name $pass $CertPath -validityDays 7300
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $CertPath)) { throw "ZXPSignCmd could not create the certificate (exit $LASTEXITCODE)." }
  Write-Host "Certificate created: $CertPath  (back it up; keep it private)" -ForegroundColor Green
  return
}

if (-not (Test-Path $CertPath)) { throw "No panel certificate at $CertPath. Run once: installer\sign-panel.ps1 -CreateCert" }
$pass = Get-CertPassword

# 1. Clean copy of the panel: no tests, node_modules, package files, screenshots, dev-only .debug.
$src = Join-Path $repo 'panels\cep'
if (-not (Test-Path (Join-Path $src 'CSXS\manifest.xml'))) { throw "Panel source not found: $src" }
$stage = Join-Path $OutDir 'panel-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
& robocopy $src $stage /E /NFL /NDL /NJH /NJS /NP /XD test node_modules screenshots /XF package.json package-lock.json .debug *.md | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the panel failed (robocopy exit $LASTEXITCODE)." }

# 2. Sign with a timestamp (so the signature stays valid after the certificate expires).
$zxp = Join-Path $OutDir $zxpName
Remove-Item $zxp -Force -ErrorAction SilentlyContinue
# ZXPSignCmd 4.1.1 can crash (0xC0000005) when a timestamp server misbehaves, so try a second server and
# finally sign without a timestamp (fine for our 20-year self-signed certificate).
$attempts = @($TimestampUrl, 'http://timestamp.sectigo.com', '')
$codes = @()
foreach ($tsa in $attempts) {
  Remove-Item $zxp -Force -ErrorAction SilentlyContinue
  if ($tsa) { & $zxpSign -sign $stage $zxp $CertPath $pass -tsa $tsa } else { & $zxpSign -sign $stage $zxp $CertPath $pass }
  $codes += $LASTEXITCODE
  if ($LASTEXITCODE -eq 0 -and (Test-Path $zxp)) { break }
  Write-Warning "ZXPSignCmd failed (exit $LASTEXITCODE) with timestamp server '$tsa'; trying the next option."
}
if (-not (Test-Path $zxp)) { throw "Signing failed (ZXPSignCmd exit codes: $($codes -join ', ')). Check the certificate password." }
if (-not $tsa) { Write-Warning 'Signed WITHOUT a timestamp (no timestamp server worked).' }
& $zxpSign -verify $zxp -certInfo | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The signed .zxp did not verify.' }

# 3. Unpack the SIGNED package (a .zxp is a zip); the setup installs this folder, signature files included.
$panel = Join-Path $OutDir 'panel'
if (Test-Path $panel) { Remove-Item $panel -Recurse -Force }
$tmpZip = [IO.Path]::ChangeExtension($zxp, '.unpack.zip')
Copy-Item $zxp $tmpZip -Force
Expand-Archive -Path $tmpZip -DestinationPath $panel -Force
Remove-Item $tmpZip, $stage -Recurse -Force
if (-not (Test-Path (Join-Path $panel 'META-INF\signatures.xml'))) { throw 'Unpacked panel has no META-INF\signatures.xml: it is not signed.' }
Write-Host "Signed panel: $zxp" -ForegroundColor Green

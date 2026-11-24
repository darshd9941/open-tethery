# ONE command that builds the real installer:   powershell -ExecutionPolicy Bypass -File installer\build-release.ps1
# Result: installer\dist\PocketMonitorSetup-<version>.exe  +  .sha256
# Prerequisites (see installer\README.md "Make a release"): Node 22, Visual Studio 2022 with "Desktop development with C++",
# Inno Setup 6, ZXPSignCmd + panel certificate (installer\sign-panel.ps1 -CreateCert once), Adobe Premiere SDK in sdk\.
# Optional Authenticode signing of the setup and exe: set PM_SIGN_CERT (path to .pfx) and PM_SIGN_PASS.

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $PSScriptRoot 'dist'
$total = 8
$n = 0
function Step([string]$msg) { $script:n++; Write-Host ''; Write-Host "[$script:n/$total] $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host ''; Write-Host "BUILD STOPPED: $msg" -ForegroundColor Red; exit 1 }
function Run([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). Read the messages above this line." }
}

Write-Host 'Pocket Monitor release build' -ForegroundColor Green
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Install Node 22: winget install OpenJS.NodeJS.LTS' }
$nodeMajor = [int]((& node --version) -replace '^v', '').Split('.')[0]
if ($nodeMajor -lt 22) { Fail "Node 22 or newer is needed (found $nodeMajor). Update: winget install OpenJS.NodeJS.LTS" }
$version = (Get-Content (Join-Path $repo 'product.json') -Raw | ConvertFrom-Json).version
Write-Host "Version $version"
New-Item -ItemType Directory -Force $dist | Out-Null

# Optional Authenticode signing
$signtool = $null
$canSign = [bool]($env:PM_SIGN_CERT -and $env:PM_SIGN_PASS)
function Find-SignTool {
  $c = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path $kits) {
    $f = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($f) { return $f.FullName }
  }
  return $null
}
function Sign-File([string]$file) {
  if (-not $canSign -or -not $signtool) { return }
  & $signtool sign /f $env:PM_SIGN_CERT /p $env:PM_SIGN_PASS /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $file
  if ($LASTEXITCODE -ne 0) { Fail "Code signing failed for $file. Check PM_SIGN_CERT / PM_SIGN_PASS." }
}
if ($canSign) {
  $signtool = Find-SignTool
  if (-not $signtool) { Fail 'PM_SIGN_CERT is set but signtool.exe was not found. Install the Windows SDK (winget install Microsoft.WindowsSDK.10.0.22621) or unset PM_SIGN_CERT.' }
}

Step 'Checking product name and ids are in sync (apply-branding --check)'
Run 'Branding check' { & node (Join-Path $repo 'tools\apply-branding.js') --check }

Step 'Installing build dependencies (npm ci)'
foreach ($d in @('helper', 'installer')) {
  Push-Location (Join-Path $repo $d)
  try { Run "npm ci in $d" { & npm ci --no-audit --no-fund } } finally { Pop-Location }
}

Step 'Building the helper exe (Node single-executable)'
Run 'Helper exe build' { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-helper-exe.ps1') }
$helperExe = Join-Path $dist 'helper\PocketMonitorHelper.exe'
if (-not (Test-Path $helperExe)) { Fail "The helper exe was not produced at $helperExe." }
Sign-File $helperExe

Step 'Building the Premiere Transmit plug-in (MSBuild)'
$sdk = if ($env:PREMIERE_SDK) { $env:PREMIERE_SDK } else { Join-Path $repo 'sdk' }
if (-not (Test-Path $sdk)) { Fail "The Adobe Premiere Pro C++ SDK is missing. It is licensed and not in git: download it from Adobe and unzip it into $sdk (or set PREMIERE_SDK to its Examples folder)." }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { Fail 'Visual Studio is not installed. Install Visual Studio 2022 (Community is free) with "Desktop development with C++".' }
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
if (-not $msbuild) { Fail 'MSBuild was not found. In the Visual Studio Installer add "Desktop development with C++".' }
Run 'MSBuild' { & $msbuild (Join-Path $repo 'native\transmit\PocketMonitorTransmit.vcxproj') /p:Configuration=Release /p:Platform=x64 /m /nologo /v:minimal }
$prm = Join-Path $repo 'build\native\Release\PocketMonitorTransmit.prm'
if (-not (Test-Path $prm)) { Fail "MSBuild finished but $prm is missing." }
Sign-File $prm

Step 'Signing the Premiere / After Effects panel (.zxp)'
Run 'Panel signing' { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'sign-panel.ps1') -OutDir $dist }

Step 'Packing the Photoshop plug-in (.ccx)'
$ccx = Join-Path $dist 'PocketMonitorPhotoshop.ccx'
Remove-Item $ccx -Force -ErrorAction SilentlyContinue
$psStage = Join-Path $dist 'ps-stage'
if (Test-Path $psStage) { Remove-Item $psStage -Recurse -Force }
& robocopy (Join-Path $repo 'panels\uxp-photoshop') $psStage /E /NFL /NDL /NJH /NJS /NP /XD test tools node_modules /XF package.json package-lock.json *.md | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copying the Photoshop plug-in failed (robocopy exit $LASTEXITCODE)." }
$psZip = [IO.Path]::ChangeExtension($ccx, '.zip')
Compress-Archive -Path (Join-Path $psStage '*') -DestinationPath $psZip -Force
Move-Item $psZip $ccx -Force
Remove-Item $psStage -Recurse -Force

Step 'Compiling the installer (Inno Setup)'
$iscc = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { Fail 'Inno Setup 6 is not installed. Install it with:  winget install JRSoftware.InnoSetup' }
Run 'Inno Setup' { & $iscc (Join-Path $PSScriptRoot 'PocketMonitor.iss') }
$setup = Join-Path $dist "PocketMonitorSetup-$version.exe"
if (-not (Test-Path $setup)) { Fail "Inno Setup finished but $setup is missing." }

Step 'Signing the setup and writing the checksum'
if ($canSign) { Sign-File $setup; Write-Host 'Setup signed (Authenticode).' }
else { Write-Host 'NOTE: PM_SIGN_CERT / PM_SIGN_PASS not set, so the exe and setup are NOT code-signed. Windows SmartScreen will warn users.' -ForegroundColor Yellow }
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $setup -Leaf)" | Set-Content -Path "$setup.sha256" -Encoding ascii

Write-Host ''
Write-Host "DONE: $setup" -ForegroundColor Green
Write-Host "SHA256: $hash"

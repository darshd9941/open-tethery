# Packs apps\photoshop\plugin into build\photoshop\com.opentethery.photoshop.ccx
# (a .ccx is a zip with manifest.json at the root). Overwrites any old file.
#
#   powershell -ExecutionPolicy Bypass -File apps\photoshop\tools\pack-ccx.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$pluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..\plugin')).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$outDir = Join-Path $repoRoot 'build\photoshop'
$outFile = Join-Path $outDir 'com.opentethery.photoshop.ccx'

if (-not (Test-Path (Join-Path $pluginDir 'manifest.json'))) {
  throw "manifest.json not found in $pluginDir"
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path $outFile) { Remove-Item -Force $outFile }

$zip = [System.IO.Compression.ZipFile]::Open($outFile, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $pluginDir -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($pluginDir.Length).TrimStart([char]92, [char]47).Replace([string][char]92, '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $_.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
}

$check = [System.IO.Compression.ZipFile]::OpenRead($outFile)
try {
  $names = $check.Entries | ForEach-Object { $_.FullName }
  if ($names -notcontains 'manifest.json') { throw 'manifest.json is not at the root of the .ccx' }
  Write-Host "Created $outFile ($($names.Count) files)"
} finally {
  $check.Dispose()
}

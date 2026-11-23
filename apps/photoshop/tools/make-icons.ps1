# Generates PNG icons for the viewer and the UXP plugin.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$viewerDir = Join-Path $root "viewer"
$pluginIcons = Join-Path $root "plugin\icons"

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-LivePreviewIcon([int]$size, [string]$outPath, [bool]$fullBleed) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [float]$size
  $pad = if ($fullBleed) { 0 } else { $s * 0.055 }
  $bg = New-RoundedPath $pad $pad ($s - 2 * $pad) ($s - 2 * $pad) ($s * 0.22)
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#1b1b1b"))
  $g.FillPath($bgBrush, $bg)

  # Screen
  $sx = $s * 0.20
  $sy = $s * 0.17
  $sw = $s * 0.60
  $sh = $s * 0.66
  $screen = New-RoundedPath $sx $sy $sw $sh ($s * 0.045)
  $screenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#e9e9e9"))
  $g.FillPath($screenBrush, $screen)

  # Colour swatches on the screen
  $colors = @("#e45757", "#e8b84b", "#4fbf7a", "#4a90e2")
  $barY = $sy + $sh * 0.55
  $barH = $sh * 0.34
  $gap = $sw * 0.04
  $barW = ($sw - 5 * $gap) / 4
  for ($i = 0; $i -lt 4; $i++) {
    $x = $sx + $gap + $i * ($barW + $gap)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($colors[$i]))
    $rect = New-RoundedPath $x $barY $barW $barH ($s * 0.018)
    $g.FillPath($brush, $rect)
    $brush.Dispose()
    $rect.Dispose()
  }

  # Small live dot
  $dotR = $s * 0.045
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#45d483"))
  $g.FillEllipse($dotBrush, ($s * 0.79), ($s * 0.78), $dotR * 2, $dotR * 2)

  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $bg.Dispose()
  $bgBrush.Dispose()
  $screen.Dispose()
  $screenBrush.Dispose()
  $dotBrush.Dispose()
}

New-LivePreviewIcon 512 (Join-Path $viewerDir "icon-512.png") $false
New-LivePreviewIcon 192 (Join-Path $viewerDir "icon-192.png") $false
New-LivePreviewIcon 180 (Join-Path $viewerDir "apple-touch-icon.png") $true

New-LivePreviewIcon 96 (Join-Path $pluginIcons "plugin@2x.png") $false
New-LivePreviewIcon 48 (Join-Path $pluginIcons "plugin@1x.png") $false
New-LivePreviewIcon 46 (Join-Path $pluginIcons "panel@2x.png") $false
New-LivePreviewIcon 23 (Join-Path $pluginIcons "panel@1x.png") $false

Write-Host "Icons written."

# Creates build\test-frame.jpg: a quick visual/colour sanity check for the viewer.
# For the real acceptance test, use the test PSD described in README.md.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root "build"
New-Item -ItemType Directory -Force -Path $build | Out-Null

$width = 1400
$height = 900
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)

$titleFont = New-Object System.Drawing.Font("Segoe UI", 24, [System.Drawing.FontStyle]::Bold)
$labelFont = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Regular)
$smallFont = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
$black = [System.Drawing.Brushes]::Black
$grey = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 90, 90))

$g.DrawString("LIVE PREVIEW - COLOUR CHECK", $titleFont, $black, 52, 26)
$g.DrawString("Compare this frame in the phone browser with the same file opened in Photos. They should match.", $labelFont, $grey, 54, 66)

# Grey ramp
$rampRect = New-Object System.Drawing.Rectangle(60, 106, 1280, 110)
$ramp = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rampRect, [System.Drawing.Color]::Black, [System.Drawing.Color]::White, [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$g.FillRectangle($ramp, $rampRect)
$g.DrawString("Grey ramp (banding check)", $smallFont, $black, 64, 220)

# Saturated primaries and secondaries
$colors = @(
  @{ Name = "Red";     Hex = "#FF0000" },
  @{ Name = "Green";   Hex = "#00FF00" },
  @{ Name = "Blue";    Hex = "#0000FF" },
  @{ Name = "Cyan";    Hex = "#00FFFF" },
  @{ Name = "Magenta"; Hex = "#FF00FF" },
  @{ Name = "Yellow";  Hex = "#FFFF00" }
)
$patchY = 264
$patchH = 150
$patchW = 200
$gap = 16
$startX = 60
for ($i = 0; $i -lt $colors.Count; $i++) {
  $x = $startX + $i * ($patchW + $gap)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($colors[$i].Hex))
  $g.FillRectangle($brush, $x, $patchY, $patchW, $patchH)
  $brush.Dispose()
  $g.DrawString($colors[$i].Name, $smallFont, $black, ($x + 6), ($patchY + $patchH + 5))
}

# Skin tones
$skin = @("#F6D7C3", "#E8B99A", "#D29A72", "#A9714B", "#7A4A2E", "#4A2C1B")
$skinY = 452
$skinH = 110
$skinW = 200
for ($i = 0; $i -lt $skin.Count; $i++) {
  $x = $startX + $i * ($skinW + $gap)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($skin[$i]))
  $g.FillRectangle($brush, $x, $skinY, $skinW, $skinH)
  $brush.Dispose()
}
$g.DrawString("Skin tones", $smallFont, $black, 64, 568)

# Smooth red-to-blue gradient (banding)
$gradRect = New-Object System.Drawing.Rectangle(60, 596, 840, 120)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gradRect, [System.Drawing.Color]::FromArgb(210, 20, 30), [System.Drawing.Color]::FromArgb(20, 40, 160), [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$g.FillRectangle($grad, $gradRect)
$g.DrawString("Smooth gradient", $smallFont, $black, 64, 722)

# Deep and pastel textile-like blocks
$textile = @("#B3122E", "#7A0E4A", "#123B7A", "#0E6B5A", "#E8C7CF", "#C9D8E8", "#D9E8C9", "#F0E2B8")
$tx = 940
$ty = 596
$tw = 190
$th = 55
for ($i = 0; $i -lt $textile.Count; $i++) {
  $col = $i % 2
  $row = [Math]::Floor($i / 2)
  $x = $tx + $col * ($tw + 10)
  $y = $ty + $row * ($th + 8)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($textile[$i]))
  $g.FillRectangle($brush, $x, $y, $tw, $th)
  $brush.Dispose()
}

# Footer
$g.DrawString("Phone screen is a better reference than an uncalibrated monitor - but it is not a print proof.", $smallFont, $grey, 60, 842)
$g.DrawString("Generated test frame - no AI, no screen capture.", $smallFont, $grey, 1110, 842)

$g.Dispose()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)
$out = Join-Path $build "test-frame.jpg"
$bmp.Save($out, $codec, $params)
$bmp.Dispose()

Write-Host "Wrote $out"

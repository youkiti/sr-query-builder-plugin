# 拡張機能アイコンの生成スクリプト
#
# シリーズ意匠（sr-data-extraction-plugin = ピンクの「DE」/ tiab-review-plugin = グリーンの「Ti」）に
# 合わせた「角丸スクエア + 白の 2 文字略号」を生成する。本拡張は #54B7D1 の「QB」。
#
# 使い方: pwsh -File tools/icons/generate-icons.ps1
# 出力先: src/icons/icon16.png / icon48.png / icon128.png
#
# 小サイズでも輪郭が滑らかになるよう、8 倍で描画してから高品質縮小する（スーパーサンプリング）。

param(
    [string]$OutDir = (Join-Path $PSScriptRoot '../../src/icons'),
    [string]$Text = 'QB',
    [string]$BaseColor = '#54B7D1',
    [int[]]$Sizes = @(16, 48, 128)
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}
$OutDir = (Resolve-Path $OutDir).Path

# #RRGGBB → Color。上下のグラデーションは基準色から ±12% の明度で作る（見た目の色は基準色のまま）
function ConvertTo-Color([string]$hex) {
    $h = $hex.TrimStart('#')
    return [System.Drawing.Color]::FromArgb(
        255,
        [Convert]::ToInt32($h.Substring(0, 2), 16),
        [Convert]::ToInt32($h.Substring(2, 2), 16),
        [Convert]::ToInt32($h.Substring(4, 2), 16))
}

function Get-Shade([System.Drawing.Color]$c, [double]$factor) {
    $clamp = { param($v) [Math]::Max(0, [Math]::Min(255, [int][Math]::Round($v))) }
    return [System.Drawing.Color]::FromArgb(
        255,
        (& $clamp ($c.R * $factor)),
        (& $clamp ($c.G * $factor)),
        (& $clamp ($c.B * $factor)))
}

# 角丸矩形のパス
function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# 利用可能な太字サンセリフを選ぶ（Arial → Segoe UI → 総称 SansSerif）
function Get-FontFamily {
    foreach ($name in @('Arial', 'Segoe UI', 'Helvetica')) {
        try { return New-Object System.Drawing.FontFamily($name) } catch { }
    }
    return [System.Drawing.FontFamily]::GenericSansSerif
}

$base = ConvertTo-Color $BaseColor
$top = Get-Shade $base 1.12
$bottom = Get-Shade $base 0.88
$family = Get-FontFamily

foreach ($size in $Sizes) {
    $ss = 8                      # スーパーサンプリング倍率
    $n = $size * $ss
    $bmp = New-Object System.Drawing.Bitmap($n, $n, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # 背景: 角丸スクエア + 縦方向グラデーション
    $radius = [float]($n * 0.20)
    $rect = New-RoundedRectPath 0 0 ([float]$n) ([float]$n) $radius
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point(0, $n)),
        $top, $bottom)
    $g.FillPath($brush, $rect)
    $brush.Dispose()

    # 文字: 白・太字。パス化して実バウンディングボックスで中央に置く（光学的中央合わせ）
    $emSize = [float]($n * 0.52)
    $textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $format = [System.Drawing.StringFormat]::GenericTypographic
    $textPath.AddString(
        $Text, $family, [int][System.Drawing.FontStyle]::Bold, $emSize,
        (New-Object System.Drawing.PointF(0, 0)), $format)

    $bounds = $textPath.GetBounds()
    # 文字幅がアイコン幅の 62% になるよう拡大縮小してから中央へ移動
    $targetWidth = [float]($n * 0.62)
    $scale = $targetWidth / $bounds.Width
    $mx = New-Object System.Drawing.Drawing2D.Matrix
    $mx.Scale($scale, $scale)
    $textPath.Transform($mx)

    $bounds = $textPath.GetBounds()
    $mx2 = New-Object System.Drawing.Drawing2D.Matrix
    $mx2.Translate(
        [float](($n - $bounds.Width) / 2 - $bounds.X),
        [float](($n - $bounds.Height) / 2 - $bounds.Y))
    $textPath.Transform($mx2)

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPath($white, $textPath)
    $white.Dispose()
    $textPath.Dispose()
    $rect.Dispose()
    $g.Dispose()

    # 目標サイズへ高品質縮小
    $out = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $og = [System.Drawing.Graphics]::FromImage($out)
    $og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $og.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $og.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $og.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $og.Clear([System.Drawing.Color]::Transparent)
    $og.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    $og.Dispose()
    $bmp.Dispose()

    $path = Join-Path $OutDir ("icon{0}.png" -f $size)
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
    Write-Output ("生成: {0} ({1}x{1})" -f $path, $size)
}

$family.Dispose()

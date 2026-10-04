<#
  Generate a multi-resolution Windows ICO from a high-resolution PNG master.

  Why this exists: a single-frame 256x256 .ico makes Windows downscale one large
  bitmap for every small slot (taskbar 32, Explorer 16, Alt-Tab 48), so each of
  those renders soft. An .ico carrying a real frame per size is what makes every
  slot crisp. `app-builder icon` (the tool electron-builder drives) emits only a
  single 256px frame, which is why this repo generates the ICO itself.

  Usage: pwsh -File scripts/make-icon.ps1
    source : assets/icon/icon.png   (high-resolution master, 32bpp with alpha)
    output : assets/icon/icon.ico   (multi-size; used for the exe AND resources)

  The script asserts the assembled byte count before writing, so a truncated
  container fails loudly instead of shipping a broken icon.
#>
[CmdletBinding()]
param(
  [string]$Source = 'assets/icon/icon.png',
  [string]$Output = 'assets/icon/icon.ico'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# The sizes Windows actually requests. 256 is the shell/large slot; 16 and 20 are
# the list/taskbar slots; 24/32/48/64/128 cover the rest.
$sizes = @(256, 128, 64, 48, 32, 24, 20, 16)

$srcPath = (Resolve-Path -LiteralPath $Source).Path
$outPath = Join-Path (Get-Location) $Output

$src = [System.Drawing.Bitmap]::new($srcPath)
# Both 32-bit ARGB and explicit Alpha formats carry transparency; anything else
# (24bppRgb, indexed) would silently flatten the icon onto a solid background.
$srcFormat = $src.PixelFormat.ToString()
if ($srcFormat -notmatch 'Argb|Alpha') {
  Write-Warning "source is $srcFormat, which has no alpha channel; transparency may be lost"
}

# --- 1. Render one PNG per size ----------------------------------------------
$frames = @()
foreach ($size in $sizes) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Preserve aspect ratio and centre, so a non-square master is never stretched.
  $scale = [Math]::Min($size / $src.Width, $size / $src.Height)
  $w = [int][Math]::Round($src.Width * $scale)
  $h = [int][Math]::Round($src.Height * $scale)
  $x = [int][Math]::Floor(($size - $w) / 2)
  $y = [int][Math]::Floor(($size - $h) / 2)
  $g.DrawImage($src, $x, $y, $w, $h)
  $g.Dispose()

  $ms = [System.IO.MemoryStream]::new()
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()

  $frames += [pscustomobject]@{ Size = $size; Bytes = $bytes }
  Write-Host ("  {0,3}x{0,-3}  {1,7:N1} KB" -f $size, ($bytes.Length / 1KB))
}

$payloadBytes = 0
foreach ($f in $frames) { $payloadBytes += $f.Bytes.Length }
$expectedTotal = 6 + (16 * $frames.Count) + $payloadBytes

# --- 2. Assemble the ICO container -------------------------------------------
# ICONDIR(6) + ICONDIRENTRY(16 each) + payloads. PNG-compressed frames are legal
# for .ico and are what Windows Vista+ expects. A 256px dimension is encoded as
# 0 in the directory entry, by format definition.
$stream = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($stream)

$bw.Write([uint16]0)             # reserved
$bw.Write([uint16]1)             # type: 1 = icon
$bw.Write([uint16]$frames.Count) # image count

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  $dim = $f.Size
  if ($f.Size -ge 256) { $dim = 0 }
  $bw.Write([byte]$dim)             # width  (0 => 256)
  $bw.Write([byte]$dim)             # height (0 => 256)
  $bw.Write([byte]0)                # palette colours
  $bw.Write([byte]0)                # reserved
  $bw.Write([uint16]1)              # colour planes
  $bw.Write([uint16]32)             # bits per pixel
  $bw.Write([uint32]$f.Bytes.Length) # payload size
  $bw.Write([uint32]$offset)        # payload offset
  $offset += $f.Bytes.Length
}
foreach ($f in $frames) { $bw.Write($f.Bytes) }

$bw.Flush()
$icon = $stream.ToArray()
$bw.Dispose()
$stream.Dispose()
$src.Dispose()

if ($icon.Length -ne $expectedTotal) {
  throw "ICO assembly is short: wrote $($icon.Length) bytes, expected $expectedTotal"
}

[System.IO.File]::WriteAllBytes($outPath, $icon)
Write-Host ("`nwrote {0} - {1:N1} KB, {2} frames (asserted {3} bytes)" -f $Output, ($icon.Length / 1KB), $frames.Count, $expectedTotal)

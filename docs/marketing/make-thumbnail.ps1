# Composes a 1280x720 YouTube thumbnail for Scripture Voice.
param(
  [string]$Out = "$PSScriptRoot\thumbnail.png",
  [string]$Badge = 'LAUNCHING NEXT WEEK'
)

Add-Type -AssemblyName System.Drawing

$W = 1280; $H = 720

$BG        = [System.Drawing.ColorTranslator]::FromHtml('#0a0d14')
$CARD      = [System.Drawing.ColorTranslator]::FromHtml('#161b26')
$GOLD      = [System.Drawing.ColorTranslator]::FromHtml('#f59e0b')
$GOLDLIGHT = [System.Drawing.ColorTranslator]::FromHtml('#fbbf24')
$WHITE     = [System.Drawing.ColorTranslator]::FromHtml('#f8fafc')
$MUTED     = [System.Drawing.ColorTranslator]::FromHtml('#9ca3af')
$LINE      = [System.Drawing.ColorTranslator]::FromHtml('#374151')
$RED       = [System.Drawing.ColorTranslator]::FromHtml('#f87171')

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Fnt([string]$family, [double]$size, [System.Drawing.FontStyle]$style) {
  return New-Object System.Drawing.Font($family, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

# ---- background ------------------------------------------------------
$g.Clear($BG)

# warm glow behind the headline, so the gold type has something to sit on
$glow = New-RoundedPath -x -260 -y -320 -w 1100 -h 900 -r 449
$pg = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
$pg.CenterColor = [System.Drawing.Color]::FromArgb(46, 245, 158, 11)
$pg.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 245, 158, 11))
$g.FillPath($pg, $glow)
$pg.Dispose(); $glow.Dispose()

# ---- badge -----------------------------------------------------------
$badgeFont = New-Fnt 'Segoe UI' 27 ([System.Drawing.FontStyle]::Bold)
$badgeSize = $g.MeasureString($Badge, $badgeFont)
$bw = [double]$badgeSize.Width + 44
$bh = 56.0
$bp = New-RoundedPath -x 64 -y 66 -w $bw -h $bh -r 12
$g.FillPath((New-Object System.Drawing.SolidBrush($GOLD)), $bp)
$bp.Dispose()
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString($Badge, $badgeFont, (New-Object System.Drawing.SolidBrush($BG)),
  (New-Object System.Drawing.RectangleF(64, 66, $bw, $bh)), $sf)

# ---- headline --------------------------------------------------------
$h1 = New-Fnt 'Arial Black' 92 ([System.Drawing.FontStyle]::Bold)
$h2 = New-Fnt 'Arial Black' 122 ([System.Drawing.FontStyle]::Bold)

# drop shadow keeps the white readable if the glow lands behind it
$shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
$g.DrawString('THE BIBLE,', $h1, $shadow, 60, 170)
$g.DrawString('READ ALOUD', $h1, $shadow, 60, 264)
$g.DrawString('OFFLINE', $h2, $shadow, 60, 366)

$g.DrawString('THE BIBLE,', $h1, (New-Object System.Drawing.SolidBrush($WHITE)), 56, 166)
$g.DrawString('READ ALOUD', $h1, (New-Object System.Drawing.SolidBrush($WHITE)), 56, 260)
$g.DrawString('OFFLINE', $h2, (New-Object System.Drawing.SolidBrush($GOLD)), 56, 362)

# ---- sub line --------------------------------------------------------
$sub = New-Fnt 'Segoe UI' 30 ([System.Drawing.FontStyle]::Bold)
# built from a code point, not a literal: PS 5.1 reads this .ps1 as ANSI and
# would mangle a pasted U+00B7 into "Â·"
$dot = [string][char]0x00B7
$subText = "no wi-fi  $dot  no account  $dot  no server"
$g.DrawString($subText, $sub, (New-Object System.Drawing.SolidBrush($MUTED)), 62, 516)

$brand = New-Fnt 'Segoe UI' 26 ([System.Drawing.FontStyle]::Bold)
$g.DrawString('SCRIPTURE VOICE', $brand, (New-Object System.Drawing.SolidBrush($GOLDLIGHT)), 62, 630)

# ---- phone -----------------------------------------------------------
$px = 892.0; $py = 96.0; $pw = 300.0; $ph = 528.0
$phone = New-RoundedPath -x $px -y $py -w $pw -h $ph -r 38
$g.FillPath((New-Object System.Drawing.SolidBrush($CARD)), $phone)
$penGold = New-Object System.Drawing.Pen($GOLD, 4)
$g.DrawPath($penGold, $phone)
$phone.Dispose()

$ref = New-Fnt 'Segoe UI' 23 ([System.Drawing.FontStyle]::Bold)
$sfc = New-Object System.Drawing.StringFormat
$sfc.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('John 1', $ref, (New-Object System.Drawing.SolidBrush($GOLDLIGHT)),
  (New-Object System.Drawing.RectangleF($px, ($py + 30), $pw, 34)), $sfc)

$widths = @(228, 202, 228, 168, 220, 228, 188)
$ly = $py + 92
for ($i = 0; $i -lt $widths.Count; $i++) {
  $active = ($i -eq 3)
  if ($active) { $c = $GOLD } else { $c = $LINE }
  $bar = New-RoundedPath -x ($px + 34) -y $ly -w $widths[$i] -h 15 -r 7
  $g.FillPath((New-Object System.Drawing.SolidBrush($c)), $bar)
  $bar.Dispose()
  $ly += 33
}

# play button
$cx = $px + $pw / 2; $cy = $py + 400
$g.FillEllipse((New-Object System.Drawing.SolidBrush($GOLD)), ($cx - 54), ($cy - 54), 108, 108)
$tri = New-Object System.Drawing.Drawing2D.GraphicsPath
$tri.AddPolygon(@(
  (New-Object System.Drawing.PointF(($cx - 17), ($cy - 28))),
  (New-Object System.Drawing.PointF(($cx + 30), $cy)),
  (New-Object System.Drawing.PointF(($cx - 17), ($cy + 28)))
))
$g.FillPath((New-Object System.Drawing.SolidBrush($BG)), $tri)
$tri.Dispose()

# progress bar
$track = New-RoundedPath -x ($px + 34) -y ($py + 470) -w 232 -h 10 -r 5
$g.FillPath((New-Object System.Drawing.SolidBrush($LINE)), $track); $track.Dispose()
$fill = New-RoundedPath -x ($px + 34) -y ($py + 470) -w 134 -h 10 -r 5
$g.FillPath((New-Object System.Drawing.SolidBrush($GOLD)), $fill); $fill.Dispose()

# ---- struck-through wi-fi mark, overlapping the phone corner ---------
$wx = 892.0; $wy = 132.0
$g.FillEllipse((New-Object System.Drawing.SolidBrush($BG)), ($wx - 62), ($wy - 62), 124, 124)
$penEdge = New-Object System.Drawing.Pen($LINE, 3)
$g.DrawEllipse($penEdge, ($wx - 62), ($wy - 62), 124, 124)

$penWifi = New-Object System.Drawing.Pen($MUTED, 8)
$penWifi.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$penWifi.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
foreach ($r in @(34, 23, 12)) {
  $g.DrawArc($penWifi, ($wx - $r), ($wy - $r + 6), ($r * 2), ($r * 2), 205, 130)
}
$g.FillEllipse((New-Object System.Drawing.SolidBrush($MUTED)), ($wx - 6), ($wy + 12), 12, 12)

# slash: dark backing first so it separates from the arcs
$penBack = New-Object System.Drawing.Pen($BG, 18)
$penBack.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$penBack.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($penBack, ($wx - 40), ($wy + 36), ($wx + 40), ($wy - 40))
$penSlash = New-Object System.Drawing.Pen($RED, 9)
$penSlash.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$penSlash.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($penSlash, ($wx - 40), ($wy + 36), ($wx + 40), ($wy - 40))

# ---- save ------------------------------------------------------------
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

# feed-size proof: if it does not read at 360px wide, it does not work
$small = New-Object System.Drawing.Bitmap(360, 203)
$gs = [System.Drawing.Graphics]::FromImage($small)
$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gs.DrawImage($bmp, 0, 0, 360, 203)
$gs.Dispose()
$small.Save([System.IO.Path]::ChangeExtension($Out, $null) + 'small.png',
  [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()

$bmp.Dispose()
Write-Output "wrote $Out"

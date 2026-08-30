param()

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$iconDirectory = Join-Path $projectRoot "public\icons"
New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null

function New-AppIcon {
  param(
    [Parameter(Mandatory = $true)][int]$Size,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#146B55"))
  $scale = $Size / 512.0
  $graphics.ScaleTransform($scale, $scale)

  $flask = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $flask.StartFigure()
  $flask.AddLine(218, 112, 294, 112)
  $flask.AddLine(294, 112, 294, 205)
  $flask.AddLine(294, 205, 382, 367)
  $flask.AddBezier(382, 367, 410, 419, 367, 438, 329, 438)
  $flask.AddLine(329, 438, 183, 438)
  $flask.AddBezier(183, 438, 145, 438, 102, 419, 130, 367)
  $flask.AddLine(130, 367, 218, 205)
  $flask.CloseFigure()

  $flaskFill = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#E7F5EE"))
  $liquid = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#F2B84B"))
  $outline = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 20)
  $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $cap = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 22)
  $cap.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cap.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  $graphics.FillPath($flaskFill, $flask)
  $savedState = $graphics.Save()
  $graphics.SetClip($flask)
  $graphics.FillRectangle($liquid, 105, 335, 305, 120)
  $graphics.Restore($savedState)
  $graphics.DrawPath($outline, $flask)
  $graphics.DrawLine($cap, 203, 112, 309, 112)

  $bubbleWhite = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $bubbleYellow = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#F2B84B"))
  $graphics.FillEllipse($bubbleWhite, 331, 132, 42, 42)
  $graphics.FillEllipse($bubbleYellow, 357, 194, 28, 28)
  $graphics.FillEllipse($bubbleWhite, 155, 197, 30, 30)

  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $bubbleWhite.Dispose()
  $bubbleYellow.Dispose()
  $cap.Dispose()
  $outline.Dispose()
  $liquid.Dispose()
  $flaskFill.Dispose()
  $flask.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

New-AppIcon -Size 192 -OutputPath (Join-Path $iconDirectory "icon-192.png")
New-AppIcon -Size 512 -OutputPath (Join-Path $iconDirectory "icon-512.png")
New-AppIcon -Size 512 -OutputPath (Join-Path $iconDirectory "icon-maskable-512.png")
New-AppIcon -Size 180 -OutputPath (Join-Path $iconDirectory "apple-touch-icon.png")

Write-Output "Generated install icons in $iconDirectory"

$Port = if ($env:PORT) { [int]$env:PORT } else { 8765 }
$Root = $PSScriptRoot
$Prefix = "http://127.0.0.1:${Port}/"

$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/markdown; charset=utf-8'
  '.ttf'  = 'font/ttf'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
}

$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add($Prefix)
$Listener.Start()
Write-Host "Serving $Root on $Prefix"

try {
  while ($Listener.IsListening) {
    $Ctx = $Listener.GetContext()
    $Req = $Ctx.Request
    $Res = $Ctx.Response

    $UrlPath = [System.Uri]::UnescapeDataString($Req.Url.AbsolutePath)
    if ($UrlPath -eq '/') { $UrlPath = '/index.html' }

    $FilePath = Join-Path $Root ($UrlPath -replace '/', '\')

    if (Test-Path $FilePath -PathType Container) {
      $FilePath = Join-Path $FilePath 'index.html'
    }
    elseif (-not (Test-Path $FilePath -PathType Leaf)) {
      $TryIndex = Join-Path $FilePath 'index.html'
      if (Test-Path $TryIndex -PathType Leaf) { $FilePath = $TryIndex }
    }

    if (Test-Path $FilePath -PathType Leaf) {
      $Ext = [System.IO.Path]::GetExtension($FilePath).ToLower()
      $ContentType = if ($Mime.ContainsKey($Ext)) { $Mime[$Ext] } else { 'application/octet-stream' }
      $Bytes = [System.IO.File]::ReadAllBytes($FilePath)

      $Res.StatusCode = 200
      $Res.ContentType = $ContentType
      $Res.AddHeader('Cache-Control', 'no-store')
      $Res.ContentLength64 = $Bytes.Length
      $Res.OutputStream.Write($Bytes, 0, $Bytes.Length)
    }
    else {
      $Body = [System.Text.Encoding]::UTF8.GetBytes("Not found: $UrlPath")
      $Res.StatusCode = 404
      $Res.ContentType = 'text/plain; charset=utf-8'
      $Res.ContentLength64 = $Body.Length
      $Res.OutputStream.Write($Body, 0, $Body.Length)
    }

    $Res.Close()
  }
}
finally {
  $Listener.Stop()
}

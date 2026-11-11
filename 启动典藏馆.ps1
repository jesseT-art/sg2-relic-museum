$ErrorActionPreference = "Stop"
$project = $PSScriptRoot
$url = "http://127.0.0.1:4173/?demo=1"

try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:4173/" -UseBasicParsing -TimeoutSec 1
} catch {
    Start-Process -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory $project -WindowStyle Hidden
    Start-Sleep -Milliseconds 700
}

Start-Process $url
Write-Host "像素典藏馆已在浏览器打开：$url"
Write-Host "如未自动打开，请手动访问 http://127.0.0.1:4173/"

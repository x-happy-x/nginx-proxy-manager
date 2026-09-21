param([switch]$SkipFrontend)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $projectRoot 'backend')
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
try {
    go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    $env:CGO_ENABLED = '0'
    foreach ($target in @(@('linux','arm64'), @('windows','amd64'))) {
        $env:GOOS = $target[0]
        $env:GOARCH = $target[1]
        $suffix = if ($target[0] -eq 'windows') { '.exe' } else { '' }
        $outputRoot = Join-Path $projectRoot "bin/$($target[0])-$($target[1])"
        New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
        foreach ($pair in @(@('manager','manager'), @('nginx','nginx'), @('ctl','homenet'))) {
            go build -trimpath -ldflags '-s -w' -o (Join-Path $outputRoot ($pair[1]+$suffix)) "./$($pair[0])"
            if ($LASTEXITCODE -ne 0) { throw "Build failed: $($pair[0])" }
        }
    }
} finally {
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
    $env:CGO_ENABLED = $previousCGO
    Pop-Location
}
if (!$SkipFrontend) {
    Push-Location (Join-Path $projectRoot 'frontend')
    try {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    } finally { Pop-Location }
}
Write-Host 'Built and tested Windows manager and Linux arm64 router runtime.'

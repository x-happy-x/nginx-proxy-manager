param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$backend = Join-Path $PSScriptRoot '../backend'
$savedOS, $savedArch, $savedCGO = $env:GOOS, $env:GOARCH, $env:CGO_ENABLED
Push-Location $backend
try {
    $env:CGO_ENABLED = '0'
    foreach ($target in @(@{OS='windows'; Arch='amd64'; Extension='.exe'; Installer='install.ps1'}, @{OS='windows'; Arch='arm64'; Extension='.exe'; Installer='install.ps1'}, @{OS='linux'; Arch='amd64'; Extension=''; Installer='install.sh'}, @{OS='linux'; Arch='arm64'; Extension=''; Installer='install.sh'})) {
        $env:GOOS, $env:GOARCH = $target.OS, $target.Arch
        $directory = Join-Path $OutputDirectory ($target.OS + '-' + $target.Arch)
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        & go build -buildvcs=false -trimpath -ldflags '-s -w' -o (Join-Path $directory ('homenet-pc-agent' + $target.Extension)) ./pcagent
        if ($LASTEXITCODE -ne 0) { throw "Build failed: $($target.OS)/$($target.Arch)" }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $target.Installer) -Destination $directory -Force
    }
} finally {
    $env:GOOS, $env:GOARCH, $env:CGO_ENABLED = $savedOS, $savedArch, $savedCGO
    Pop-Location
}

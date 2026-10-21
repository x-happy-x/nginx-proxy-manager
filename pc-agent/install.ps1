param(
    [Parameter(Mandatory=$true)][string]$PublicKey,
    [string]$Binary = (Join-Path $PSScriptRoot 'homenet-pc-agent.exe'),
    [switch]$AllowDockerActions,
    [switch]$AllowWSLActions,
    [switch]$AdministratorKeyFile
)
$ErrorActionPreference = 'Stop'
if ($PublicKey -match '[\r\n]') { throw 'Public key must be one line' }
$keyParts = $PublicKey.Trim() -split '\s+'
if ($keyParts.Count -lt 2 -or $keyParts[0] -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$') { throw 'Plain OpenSSH public key required' }
try { $keyBytes = [Convert]::FromBase64String($keyParts[1]) } catch { throw 'Invalid public key data' }
if ($keyBytes.Length -lt 12) { throw 'Invalid public key data' }
$typeLength = ([int]$keyBytes[0] -shl 24) -bor ([int]$keyBytes[1] -shl 16) -bor ([int]$keyBytes[2] -shl 8) -bor [int]$keyBytes[3]
if ($typeLength -lt 1 -or $typeLength -gt ($keyBytes.Length - 4) -or [Text.Encoding]::ASCII.GetString($keyBytes, 4, $typeLength) -ne $keyParts[0]) { throw 'Invalid public key type' }
if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw "Binary missing: $Binary" }
$installDirectory = Join-Path $env:LOCALAPPDATA 'HomeNet'
$target = Join-Path $installDirectory 'pc-agent.exe'
# cmd.exe expands percent variables even in quotes. Never construct a forced
# command from a path containing quoting/expansion characters.
if ($target -match '["%\r\n]') { throw 'Unsupported profile path for the forced command' }
$flags = ''
if ($AllowDockerActions) { $flags += ' --allow-docker-actions' }
if ($AllowWSLActions) { $flags += ' --allow-wsl-actions' }
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Copy-Item -LiteralPath $Binary -Destination $target -Force
$sshDirectory = Join-Path $env:USERPROFILE '.ssh'
if ($AdministratorKeyFile) {
    $auth = Join-Path $env:ProgramData 'ssh/administrators_authorized_keys'
} else {
    New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
    $auth = Join-Path $sshDirectory 'authorized_keys'
}
$body = $keyParts[1]
$lines = @()
if (Test-Path -LiteralPath $auth) {
    $lines = @(Get-Content -LiteralPath $auth | Where-Object { -not (($_ -split '\s+') -contains $body) })
}
$commandPath = $target.Replace('\', '/')
$forced = '\"' + $commandPath + '\" serve' + $flags
$lines += 'restrict,command="' + $forced + '" ' + $PublicKey.Trim()
[IO.File]::WriteAllLines($auth, [string[]]$lines, [Text.UTF8Encoding]::new($false))
if ($AdministratorKeyFile) {
    # Use SIDs so this works on non-English Windows installations.
    & icacls.exe $auth /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not secure administrators_authorized_keys' }
}
& $target serve ping
if ($LASTEXITCODE -ne 0) { throw 'Agent self-test failed' }

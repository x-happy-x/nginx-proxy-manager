param([Parameter(Mandatory=$true)][string]$PublicKey)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this local PC-X installer in an administrator PowerShell window.'
}
if ($env:COMPUTERNAME -ne 'PC-X') { throw 'This local installation is only for PC-X.' }
$auth = Join-Path $env:ProgramData 'ssh/administrators_authorized_keys'
$old = @(Get-Content -LiteralPath $auth | Where-Object { $_ -match 'homenet-pc@router' })
$backup = Join-Path $env:ProgramData ('HomeNet/backups/NPM-105-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $auth -Destination (Join-Path $backup 'authorized_keys')
Copy-Item -LiteralPath (Join-Path $env:ProgramData 'HomeNet/pc-agent.exe') -Destination (Join-Path $backup 'pc-agent.exe')
$options = @{PublicKey=$PublicKey; AllowPowerActions=$true; AdministratorKeyFile=$true;
             Binary=(Join-Path $root 'pc-agent/dist/windows-amd64/homenet-pc-agent.exe')}
if ($old -match 'allow-docker-actions') { $options.AllowDockerActions=$true }
if ($old -match 'allow-wsl-actions') { $options.AllowWSLActions=$true }
& (Join-Path $root 'pc-agent/install.ps1') @options
if ($LASTEXITCODE -ne 0) { throw 'Agent self-test failed.' }
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
'{"ok":true,"agent":"1.3.0"}' | Set-Content -LiteralPath (Join-Path $runtime 'pcx-power-status.json') -Encoding UTF8

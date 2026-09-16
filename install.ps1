<#
.SYNOPSIS
  MySagra — stack configurator (ephemeral container).

.EXAMPLE
  .\install.ps1
  .\install.ps1 --non-interactive --mode lan --server-ip 192.168.1.10 --base-domain mysagra.local --services all
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$InstallerArgs
)

$ErrorActionPreference = "Stop"

$image = if ($env:MYWIZARD_IMAGE) { $env:MYWIZARD_IMAGE } else { "ghcr.io/mysagra/mywizard:latest" }
$targetDir = if ($env:MYSAGRA_DIR) { $env:MYSAGRA_DIR } else { (Get-Location).Path }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker not found: install it from https://docs.docker.com/get-docker/"
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

docker pull $image

$dockerArgs = @("run", "--rm", "-it", "-v", "$($targetDir):/out")

# Docker Desktop exposes the socket at //var/run/docker.sock
$dockerArgs += @("-v", "//var/run/docker.sock://var/run/docker.sock")
$dockerArgs += $image
if ($InstallerArgs) { $dockerArgs += $InstallerArgs }

& docker @dockerArgs
exit $LASTEXITCODE

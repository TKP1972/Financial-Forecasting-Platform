<#
.SYNOPSIS
    Stop the Financial Forecasting Platform.

.DESCRIPTION
    `docker compose down`, with the containers named so it is obvious what
    stopped. **Volumes are kept**: the database survives, so restarting picks
    up exactly where the demonstration left off.

    Removing the data is a separate, deliberate act - `npm run stack:nuke`, or
    a reset - because "stop" and "throw away everything I entered" should never
    be the same button.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

Write-Host ''
Write-Host '  Stopping the Financial Forecasting Platform' -ForegroundColor White
Write-Host ''

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host '  Docker is not on PATH; nothing to stop.' -ForegroundColor Yellow
    Start-Sleep -Seconds 2
    exit 0
}

# Continue, not Stop: docker compose reports progress on stderr, and under
# Windows PowerShell 5.1 a Stop preference turns the first such line into a
# terminating error. See the note in Start-FFP.ps1.
$ErrorActionPreference = 'Continue'
& docker compose down 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '  Stopped. Your data is still there - starting it again resumes where you left off.' -ForegroundColor Green
Write-Host ''
Start-Sleep -Seconds 3

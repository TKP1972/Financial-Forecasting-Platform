<#
.SYNOPSIS
    Start the Financial Forecasting Platform and open it in a browser.

.DESCRIPTION
    Written for the moment before a demonstration, which is the only moment
    that matters: someone is watching, and the failure modes are all
    environmental rather than interesting. Docker Desktop is not running. The
    stack is half up from yesterday. The port is taken. The API is up but the
    database is still applying migrations, so the first page load 500s.

    So this does the waiting, says what it is waiting for, and only opens the
    browser once the API reports itself ready. Nothing here is clever; it is
    the sequence somebody would type, with the pauses handled.

    Safe to run when the stack is already up - `docker compose up -d` is
    idempotent, and the readiness poll simply returns at once.

.PARAMETER Rebuild
    Rebuild the images before starting. Needed after changing source, and
    deliberately not the default: a rebuild takes minutes and the usual reason
    to run this is to show somebody the product, not to test a change.

.PARAMETER NoBrowser
    Start the stack without opening a browser.
#>
[CmdletBinding()]
param(
    [switch]$Rebuild,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# The repository root, two levels up from this file. Resolved rather than
# assumed, so the shortcut works regardless of where it is invoked from -
# `docker compose` needs the compose file in the working directory.
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Write-Step {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor Green
}

function Write-Problem {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor Yellow
}

<#
    Run docker and echo its output without dying on it.

    `docker compose` writes its progress ("Network ffp_default Creating") to
    **stderr**, not stdout. Under Windows PowerShell 5.1 with
    $ErrorActionPreference = 'Stop', redirecting a native command's stderr with
    2>&1 turns each of those lines into a NativeCommandError record, and Stop
    makes the first one terminate the script.

    The result is a launcher that reports a failure while the stack starts
    perfectly well behind it. Found by running this from a cold stop rather
    than by reading it.

    So: Continue inside this function, and judge success by $LASTEXITCODE,
    which is what actually reports whether docker succeeded.
#>
function Invoke-Docker {
    param([string[]]$DockerArgs)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @DockerArgs 2>&1 | ForEach-Object {
            Write-Host "    $_" -ForegroundColor DarkGray
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

Write-Host ''
Write-Host '  Financial Forecasting Platform' -ForegroundColor White
Write-Host '  ------------------------------' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------------------
# 1. Docker
# ---------------------------------------------------------------------------

function Test-DockerRunning {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $previous
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Problem 'Docker is not installed, or is not on PATH.'
    Write-Host ''
    Write-Host '  Install Docker Desktop from https://www.docker.com/products/docker-desktop'
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

if (-not (Test-DockerRunning)) {
    Write-Step 'Docker Desktop is not running. Starting it...'

    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $desktop) {
        Start-Process $desktop | Out-Null
    } else {
        Write-Problem 'Could not find Docker Desktop to start it. Start it yourself, then run this again.'
        Read-Host '  Press Enter to close'
        exit 1
    }

    # Docker Desktop takes a while on a cold start, and reports a socket before
    # the daemon answers. Poll the daemon rather than the process.
    $waited = 0
    while (-not (Test-DockerRunning)) {
        if ($waited -ge 180) {
            Write-Problem 'Docker Desktop did not become ready within three minutes.'
            Read-Host '  Press Enter to close'
            exit 1
        }
        Start-Sleep -Seconds 3
        $waited += 3
        Write-Host "`r  Waiting for Docker Desktop... ${waited}s" -NoNewline -ForegroundColor DarkGray
    }
    Write-Host "`r                                             `r" -NoNewline
}

Write-Ok 'Docker is running.'

# ---------------------------------------------------------------------------
# 2. The stack
# ---------------------------------------------------------------------------

if ($Rebuild) {
    Write-Step 'Rebuilding images (this takes a few minutes)...'
    $exitCode = Invoke-Docker @('compose', 'up', '-d', '--build')
} else {
    Write-Step 'Starting the stack...'
    $exitCode = Invoke-Docker @('compose', 'up', '-d')
}

if ($exitCode -ne 0) {
    Write-Problem 'The stack did not start. The output above says why.'
    Write-Host ''
    Write-Host '  A port already in use is the usual cause. Stop whatever holds it,'
    Write-Host '  or set WEB_PORT / API_PORT / POSTGRES_PORT in .env'
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Readiness
# ---------------------------------------------------------------------------
#
# The API answers /health/ready only once it can reach the database, so this
# also covers the migration container finishing. Opening the browser before
# then shows a login page whose first request fails, which looks like a broken
# product rather than a slow start.

$apiPort = if ($env:API_PORT) { $env:API_PORT } else { '4000' }
$webPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '8080' }
$readyUrl = "http://localhost:$apiPort/health/ready"

Write-Step 'Waiting for the API to be ready...'
$waited = 0
$ready = $false
while (-not $ready) {
    try {
        $response = Invoke-WebRequest -Uri $readyUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # 503 while the database is still coming up is expected, not an error.
    }

    if ($waited -ge 120) {
        Write-Host ''
        Write-Problem 'The API did not become ready within two minutes.'
        Write-Host ''
        Write-Host "  Check the logs:  docker compose logs api"
        Write-Host ''
        Read-Host '  Press Enter to close'
        exit 1
    }
    Start-Sleep -Seconds 2
    $waited += 2
    Write-Host "`r  Waiting for the API... ${waited}s" -NoNewline -ForegroundColor DarkGray
}
Write-Host "`r                                   `r" -NoNewline

Write-Ok 'The platform is ready.'
Write-Host ''
Write-Host "  Open       http://localhost:$webPort" -ForegroundColor White
Write-Host "  Sign in    cfo@ffp.local  /  Cfo!Local2026x" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Stop it from the Start Menu, or with:  docker compose down' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) {
    Start-Process "http://localhost:$webPort"
}

# Close on its own once the browser is open. A window left behind is one more
# thing to explain to whoever is watching.
Start-Sleep -Seconds 2

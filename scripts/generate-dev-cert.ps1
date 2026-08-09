<#
.SYNOPSIS
  Generate a self-signed TLS certificate for the local web container.

.DESCRIPTION
  Writes docker/tls/server.crt and docker/tls/server.key. The web container
  detects them on boot and switches from HTTP to HTTPS - see
  packages/web/docker-entrypoint.sh.

  This certificate is for local development only. It is self-signed, so browsers
  will warn, and that warning is correct: nothing has vouched for this key. For
  a real deployment, obtain a certificate from your organisation's CA or from
  Let's Encrypt and drop it in the same two filenames.

  Never commit the key. docker/tls/ is gitignored.

.PARAMETER Hostname
  Subject and SAN entry. Defaults to localhost.

.PARAMETER Days
  Validity in days. Defaults to 365.

.PARAMETER Force
  Overwrite an existing certificate. Without it the script refuses, so a rerun
  cannot silently invalidate a certificate someone has already trusted.
#>
[CmdletBinding()]
param(
  [string]$Hostname = 'localhost',
  [int]$Days = 365,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repoRoot 'docker/tls'
$crt = Join-Path $outDir 'server.crt'
$key = Join-Path $outDir 'server.key'

if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

if ((Test-Path $crt) -and -not $Force) {
  Write-Host "A certificate already exists at $crt" -ForegroundColor Yellow
  Write-Host 'Re-run with -Force to replace it.' -ForegroundColor Yellow
  exit 0
}

# Prefer a local openssl; fall back to running it inside the nginx image, which
# is already pulled. That keeps the script working on a machine with no
# OpenSSL installed - which is most Windows machines.
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue)

$subject = "/CN=$Hostname/O=Financial Forecasting Platform (development)"
$ext = "subjectAltName=DNS:$Hostname,DNS:localhost,IP:127.0.0.1"

if ($openssl) {
  Write-Host "Generating a $Days-day self-signed certificate for $Hostname using local openssl..."
  & openssl req -x509 -newkey rsa:2048 -nodes `
    -keyout $key -out $crt -days $Days `
    -subj $subject -addext $ext | Out-Null
}
else {
  Write-Host 'openssl not found locally; generating inside the nginx container image...'
  $mount = ($outDir -replace '\\', '/')
  docker run --rm -v "${mount}:/out" nginx:1.27-alpine `
    sh -c "apk add --no-cache openssl >/dev/null 2>&1 || true; openssl req -x509 -newkey rsa:2048 -nodes -keyout /out/server.key -out /out/server.crt -days $Days -subj '$subject' -addext '$ext'"
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Container fallback failed. This machine may sit behind a TLS-intercepting' -ForegroundColor Red
    Write-Host 'proxy that blocks the Alpine package CDN - see docker/certs/README.md.' -ForegroundColor Red
    Write-Host 'Install OpenSSL locally (winget install ShiningLight.OpenSSL.Light) and re-run.' -ForegroundColor Red
    exit 1
  }
}

if (-not (Test-Path $crt) -or -not (Test-Path $key)) {
  Write-Host 'Certificate generation did not produce both files.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Wrote:' -ForegroundColor Green
Write-Host "  $crt"
Write-Host "  $key"
Write-Host ''
Write-Host 'Restart the web container to pick it up:' -ForegroundColor Cyan
Write-Host '  docker compose up -d --force-recreate web'
Write-Host ''
Write-Host "Then open https://${Hostname}:8443 - your browser will warn about the"
Write-Host 'self-signed certificate, which is expected for a development pair.'

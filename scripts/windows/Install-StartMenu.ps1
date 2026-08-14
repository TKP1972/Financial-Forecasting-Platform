<#
.SYNOPSIS
    Add (or remove) Start Menu shortcuts for the Financial Forecasting Platform.

.DESCRIPTION
    Creates a "Financial Forecasting Platform" folder in the **current user's**
    Start Menu with two entries:

        Financial Forecasting Platform   - start the stack and open it
        Stop Financial Forecasting       - stop it, keeping the data

    Per-user rather than machine-wide on purpose: it needs no administrator,
    it writes nothing outside the user's own profile, and uninstalling is
    deleting a folder. A demonstration convenience should not require elevation.

    The shortcuts point at this repository by absolute path, so moving the
    repository means running this again. That is stated in the summary rather
    than worked around, because a shortcut that silently points at a path that
    no longer exists is worse than one that is obviously stale.

.PARAMETER Uninstall
    Remove the shortcuts.

.EXAMPLE
    npm run start-menu:install
    npm run start-menu:uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$folder = Join-Path $startMenu 'Financial Forecasting Platform'

# ---------------------------------------------------------------------------

if ($Uninstall) {
    if (Test-Path $folder) {
        Remove-Item $folder -Recurse -Force
        Write-Host ''
        Write-Host "  Removed: $folder" -ForegroundColor Green
        Write-Host ''
    } else {
        Write-Host ''
        Write-Host '  Nothing to remove - the shortcuts are not installed.' -ForegroundColor Yellow
        Write-Host ''
    }
    exit 0
}

New-Item -ItemType Directory -Path $folder -Force | Out-Null

<#
    Launched through powershell.exe rather than pwsh: Windows PowerShell 5.1 is
    present on every Windows machine, and PowerShell 7 is not. These two scripts
    use nothing that needs 7.

    -ExecutionPolicy Bypass because the default policy blocks unsigned local
    scripts, and the alternative - asking someone to change their machine's
    execution policy to open an app - is worse. The scope is this one process.
#>
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function New-Shortcut {
    param(
        [string]$Path,
        [string]$Script,
        [string]$Description,
        [int]$IconIndex
    )

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments =
        "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot $Script)`""
    # The working directory has to be the repository: `docker compose` resolves
    # its file relative to the current directory, and the scripts set-location
    # anyway, but a shortcut that starts somewhere sensible is easier to debug.
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = $Description
    $shortcut.WindowStyle = 1
    # Shell32 has a serviceable stock set; shipping an .ico for a demo
    # convenience is more maintenance than it earns.
    $shortcut.IconLocation = "$(Join-Path $env:SystemRoot 'System32\shell32.dll'),$IconIndex"
    $shortcut.Save()

    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}

New-Shortcut `
    -Path (Join-Path $folder 'Financial Forecasting Platform.lnk') `
    -Script 'Start-FFP.ps1' `
    -Description 'Start the platform and open it in a browser' `
    -IconIndex 137

New-Shortcut `
    -Path (Join-Path $folder 'Stop Financial Forecasting.lnk') `
    -Script 'Stop-FFP.ps1' `
    -Description 'Stop the platform. Your data is kept.' `
    -IconIndex 27

Write-Host ''
Write-Host '  Installed to the Start Menu' -ForegroundColor Green
Write-Host ''
Write-Host "    $folder"
Write-Host ''
Write-Host '    Financial Forecasting Platform   start it and open a browser'
Write-Host '    Stop Financial Forecasting       stop it, keeping the data'
Write-Host ''
Write-Host '  Press the Windows key and type "Financial" to find it.' -ForegroundColor DarkGray
Write-Host ''
Write-Host "  The shortcuts point at $repoRoot" -ForegroundColor DarkGray
Write-Host '  If the repository moves, run this again.' -ForegroundColor DarkGray
Write-Host ''

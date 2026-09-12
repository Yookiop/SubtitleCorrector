# Subtitle Corrector - bridge automatisch starten ONGEDAAN maken.
$ErrorActionPreference = "Stop"
$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "Subtitle Corrector bridge.lnk"

if (Test-Path $link) {
    Remove-Item -Force $link
    Write-Host "Snelkoppeling verwijderd: $link" -ForegroundColor Green
} else {
    Write-Host "Geen snelkoppeling gevonden in $startup"
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here "run_bridge_hidden.vbs"
if (Test-Path $vbs) {
    Remove-Item -Force $vbs
    Write-Host "Launcher verwijderd: $vbs"
}

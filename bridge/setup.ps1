<#
    Subtitle Corrector - bridge setup (Windows / PowerShell)

    Maakt een venv in bridge\.venv, installeert de afhankelijkheden en
    downloadt het taalmodel. Daarna kun je run_bridge.bat gebruiken.

    Gebruik:  powershell -ExecutionPolicy Bypass -File bridge\setup.ps1
              powershell -ExecutionPolicy Bypass -File bridge\setup.ps1 -Model tiny
#>
param(
    [string]$Model = "base",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host "=== Subtitle Corrector - bridge setup ===" -ForegroundColor Cyan
Write-Host "Map: $here"

$venv = Join-Path $here ".venv"
if ($Force -and (Test-Path $venv)) {
    Write-Host "Bestaande venv verwijderen (-Force)..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $venv
}

if (-not (Test-Path $venv)) {
    Write-Host "Venv aanmaken..." -ForegroundColor Cyan
    python -m venv $venv
}

$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) { throw "Kon $py niet vinden. Is Python 3.9+ geinstalleerd en op PATH?" }

Write-Host "Afhankelijkheden installeren (dit kan een paar minuten duren)..." -ForegroundColor Cyan
& $py -m pip install --upgrade pip
& $py -m pip install -r (Join-Path $here "requirements.txt")

Write-Host "Model '$Model' downloaden..." -ForegroundColor Cyan
& $py (Join-Path $here "bridge_server.py") --model $Model --warmup

Write-Host ""
Write-Host "Klaar. Start de bridge met: bridge\run_bridge.bat" -ForegroundColor Green
Write-Host "Optioneel: automatisch starten bij inloggen -> bridge\install_autostart.ps1"

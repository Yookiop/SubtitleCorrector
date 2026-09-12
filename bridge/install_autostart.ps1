<#
    Subtitle Corrector - bridge automatisch starten bij inloggen (optioneel).

    Zet een snelkoppeling in de Startup-map van de gebruiker die de bridge
    onzichtbaar start (via een .vbs launcher, dus geen consolevenster).

    Verwijderen:  powershell -ExecutionPolicy Bypass -File bridge\uninstall_autostart.ps1
#>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$py = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw "Geen venv gevonden. Draai eerst setup.ps1." }

$vbs = Join-Path $here "run_bridge_hidden.vbs"
$pyQuoted = '""' + $py + '""'
$content = @"
' Automatisch gegenereerd door install_autostart.ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir
sh.Run $pyQuoted & " bridge_server.py", 0, False
"@
Set-Content -Path $vbs -Value $content -Encoding ASCII

$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "Subtitle Corrector bridge.lnk"

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $here
$sc.Description = "Subtitle Corrector bridge (lokale taalherkenning)"
$sc.Save()

Write-Host "Snelkoppeling aangemaakt: $link" -ForegroundColor Green
Write-Host "De bridge start nu automatisch bij het inloggen (zonder venster)."
Write-Host "Testen zonder reboot: dubbelklik $vbs"

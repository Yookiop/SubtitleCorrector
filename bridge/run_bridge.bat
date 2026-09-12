@echo off
rem Subtitle Corrector - bridge starten (dubbelklik of vanuit een terminal).
rem Draai eerst eenmalig: powershell -ExecutionPolicy Bypass -File setup.ps1
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo Geen .venv gevonden in %~dp0
  echo Draai eerst:  powershell -ExecutionPolicy Bypass -File setup.ps1
  echo.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" bridge_server.py %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Bridge gestopt met code %EXITCODE%.
  pause
)
endlocal

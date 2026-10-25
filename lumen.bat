@echo off
setlocal
chcp 65001 >nul
set "LUMEN_CLI_PYTHON="
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Resolve-LumenPython.ps1"`) do set "LUMEN_CLI_PYTHON=%%P"
if not defined LUMEN_CLI_PYTHON exit /b 4
"%LUMEN_CLI_PYTHON%" "%~dp0lumen.py" %*
set "LUMEN_CLI_EXIT=%errorlevel%"
endlocal & exit /b %LUMEN_CLI_EXIT%

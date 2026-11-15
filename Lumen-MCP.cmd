@echo off
setlocal
chcp 65001 >nul
set "LUMEN_MCP_PYTHON="
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Resolve-LumenPython.ps1"`) do set "LUMEN_MCP_PYTHON=%%P"
if not defined LUMEN_MCP_PYTHON exit /b 4
"%LUMEN_MCP_PYTHON%" -u "%~dp0lumen_mcp.py" %*
set "LUMEN_MCP_EXIT=%errorlevel%"
endlocal & exit /b %LUMEN_MCP_EXIT%

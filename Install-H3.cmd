@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_models.ps1" %*
pause

param([switch]$Close)
$ErrorActionPreference = 'Stop'
$python = & (Join-Path $PSScriptRoot 'Resolve-LumenPython.ps1')
$pythonWindow = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonWindow)) { throw 'pythonw.exe is missing. Run Setup-Lumen.cmd first.' }
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $pythonWindow
$startInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'desktop.py') + '"'
if ($Close) { $startInfo.Arguments += ' --close' }
$startInfo.WorkingDirectory = $PSScriptRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
[System.Diagnostics.Process]::Start($startInfo) | Out-Null

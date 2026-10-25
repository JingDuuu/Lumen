$ErrorActionPreference = 'Stop'
$candidates = @((Join-Path $PSScriptRoot '.venv\Scripts\python.exe'))
if ($env:LUMEN_ENGINE_PYTHON) { $candidates += $env:LUMEN_ENGINE_PYTHON }
$configFile = if ($env:LUMEN_CONFIG) { $env:LUMEN_CONFIG } else { Join-Path $PSScriptRoot 'lumen.local.json' }
if (Test-Path -LiteralPath $configFile) {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($config.engine_python) {
        $configured = [string]$config.engine_python
        if (-not [IO.Path]::IsPathRooted($configured)) { $configured = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($configFile))) $configured }
        $candidates += $configured
    }
}
$parent = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $parent 'main.py')) { $candidates += (Join-Path $parent 'venv\Scripts\python.exe') }
foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) } }
throw 'Lumen Python environment is missing. Run Setup-Lumen.cmd first.'

param([ValidateSet('fl2va','ref2va','all')][string]$Pack = 'all', [switch]$AcceptLicense)
$ErrorActionPreference = 'Stop'
$python = & (Join-Path $PSScriptRoot 'Resolve-LumenPython.ps1')
if (-not $AcceptLicense) {
    Write-Host 'H3 is governed by its own Community License (territory and commercial conditions apply):'
    Write-Host 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE'
    $answer = Read-Host 'Type YES to confirm you have read and accept the applicable license and start downloading'
    if ($answer -cne 'YES') { Write-Host 'No download started.'; exit 0 }
}
& $python (Join-Path $PSScriptRoot 'model_manager.py') install $Pack --accept-license
if ($LASTEXITCODE -ne 0) { throw 'Model installation did not complete. Existing partial files were retained.' }

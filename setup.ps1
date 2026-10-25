param([switch]$EditorOnly, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$engineRoot = Join-Path $root 'runtime\ComfyUI'
$python = Join-Path $root '.venv\Scripts\python.exe'
$revision = '7597a5a0d59ee251674e6c1270049909c63e7ede'
if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $root) 'main.py')) {
    throw 'This is an existing ComfyUI/studio deployment. It is already configured; setup does not modify that environment. Use a separate extracted Lumen folder for a clean install.'
}
if (-not (Test-Path -LiteralPath $python)) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if (-not $launcher) { throw 'Install Python 3.12 (64-bit) from https://www.python.org/downloads/windows/ with the Python launcher, then run setup again.' }
    & $launcher.Source -3.12 -m venv (Join-Path $root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 could not create the local environment.' }
}
& $python -m pip install -r (Join-Path $root 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Lumen dependencies failed to install. Rerun setup to continue.' }
if (-not $EditorOnly) {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { throw 'Install Git for Windows from https://git-scm.com/download/win, then run setup again (or use -EditorOnly).' }
    if (-not (Test-Path -LiteralPath $engineRoot)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $engineRoot) -Force | Out-Null
        & $git.Source clone --no-checkout --filter=blob:none 'https://github.com/Comfy-Org/ComfyUI.git' $engineRoot
        if ($LASTEXITCODE -ne 0) { throw 'ComfyUI source download failed.' }
        & $git.Source -C $engineRoot checkout --detach $revision
        if ($LASTEXITCODE -ne 0) { throw 'The pinned ComfyUI revision could not be checked out.' }
    }
    $actual = & $git.Source -C $engineRoot rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $actual.Trim() -ne $revision) { throw 'Existing runtime/ComfyUI is not the pinned revision. It was not overwritten; use a new Lumen folder or configure an existing engine.' }
    Write-Host 'Installing CUDA 13.0 PyTorch packages from the official index. H3 model weights are NOT downloaded.'
    & $python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
    if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed. Check supported NVIDIA drivers and the official PyTorch install guide.' }
    & $python -m pip install -r (Join-Path $engineRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI dependencies failed to install.' }
}
$localConfig = Join-Path $root 'lumen.local.json'
if (-not (Test-Path -LiteralPath $localConfig)) { Copy-Item -LiteralPath (Join-Path $root 'lumen.example.json') -Destination $localConfig }
if (-not $NoShortcut) { & (Join-Path $root 'install_desktop.ps1') }
Write-Host 'Lumen is ready. Open the desktop icon. H3 weights install only when you choose Models and Installation, or Install-H3.cmd.'

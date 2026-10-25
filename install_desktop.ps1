# Run once after the legacy Lumen service has been stopped.
$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$python = & (Join-Path $studioRoot 'Resolve-LumenPython.ps1')
$pythonWindow = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
$desktopEntry = Join-Path $studioRoot 'desktop.py'
$iconFile = Join-Path $studioRoot 'static\lumen-v3.ico'
foreach ($requiredFile in @($pythonWindow, $desktopEntry, $iconFile)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Missing file: $requiredFile" }
}
$shell = New-Object -ComObject WScript.Shell
$desktopFolders = @([Environment]::GetFolderPath('Desktop'))
$backupFolder = Join-Path $studioRoot ('shortcut-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($desktopFolder in $desktopFolders) {
    if (-not (Test-Path -LiteralPath $desktopFolder)) { continue }
    foreach ($oldLink in (Get-ChildItem -LiteralPath $desktopFolder -Filter '*Lumen*.lnk')) {
        $linkData = $shell.CreateShortcut($oldLink.FullName)
        if ($oldLink.Name -eq 'Lumen.lnk' -or $linkData.Arguments.Contains($desktopEntry)) {
            New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
            Copy-Item -LiteralPath $oldLink.FullName -Destination (Join-Path $backupFolder $oldLink.Name)
            Remove-Item -LiteralPath $oldLink.FullName
        }
    }
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lumen.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonWindow
$shortcut.Arguments = '"' + $desktopEntry + '"'
$shortcut.WorkingDirectory = $studioRoot
$shortcut.IconLocation = $iconFile + ',0'
$shortcut.Description = 'Lumen 视频创作台 — 关闭窗口即结束运行'
$shortcut.WindowStyle = 1
$shortcut.Save()
Write-Output "Installed: $shortcutPath"
Write-Output "Target: $pythonWindow $($shortcut.Arguments)"
Write-Output "Previous shortcuts: $backupFolder"

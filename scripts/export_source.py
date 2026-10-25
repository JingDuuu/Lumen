"""Export reviewed source from a live install without copying personal data."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    '.gitignore', '.gitattributes', 'LICENSE', 'README.md', 'CHANGELOG.md', 'PORTABLE_INSTALL.md',
    'app.py', 'desktop.py', 'engine_runtime.py', 'runtime_config.py', 'lumen_core.py',
    'tasks.py', 'reference_inputs.py', 'asset_presets.py', 'agent_api.py', 'model_manager.py',
    'previs_store.py', 'previs_render.py', 'format_bridge.py', 'blender_bridge.py',
    'lumen.py', 'lumen.bat', 'download_ref2va.py', 'install_desktop.ps1',
    'setup.ps1', 'Setup-Lumen.cmd', 'Start-Lumen.cmd', 'Install-H3.cmd',
    'install_models.ps1', 'Resolve-LumenPython.ps1', 'start_studio.ps1',
    'start_studio.bat', 'stop_studio.bat', 'lumen.example.json', 'models-manifest.json',
    'requirements.txt', 'requirements-desktop.txt', 'package.json', 'package-lock.json',
    'agent-catalog.json', 'agent-schema.json',
}
DIRECTORIES = {'static', 'templates', 'tests', 'docs', 'examples', 'schemas', 'scripts', '.github'}
FORBIDDEN = {'__pycache__', '.git', 'node_modules', '.venv', 'data', 'library', 'input',
             'output', 'models', 'runtime', 'diagnostics', 'desktop-data', 'shortcut-backups'}


def source_files():
    for name in sorted(FILES):
        file = ROOT / name
        if file.is_file():
            yield file
    for name in sorted(DIRECTORIES):
        for file in sorted((ROOT / name).rglob('*')):
            if file.is_file() and not FORBIDDEN.intersection(file.relative_to(ROOT).parts):
                if file.suffix.lower() not in {'.pyc', '.log', '.tmp', '.part'}:
                    yield file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination.exists():
        parser.error('Destination must be a new directory; existing checkouts are never overwritten.')
    files = list(source_files())
    for file in files:
        if file.is_symlink() or not file.resolve().is_relative_to(ROOT):
            parser.error('Source symlinks are not exported: ' + str(file.relative_to(ROOT)))
        if file.stat().st_size > 20 * 1024 * 1024:
            parser.error('Unexpected large source file: ' + str(file.relative_to(ROOT)))
    destination.mkdir(parents=True)
    for file in files:
        target = destination / file.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
    print(f'Exported {len(files)} source files to {destination}')


if __name__ == '__main__':
    main()

# Standalone Windows installation

The repository contains Lumen source, original interface/3D assets and vendored Three.js/HDR assets with their own notices. It does **not** contain H3 weights, ComfyUI, Python environments, private boards, media libraries or output videos.

## Start from a source ZIP

1. Extract to a writable folder such as `D:\Apps\Lumen`. Avoid `Program Files` because the default runtime/data folders are local to the project.
2. Install [Python 3.12 64-bit](https://www.python.org/downloads/windows/) with its launcher and [Git for Windows](https://git-scm.com/download/win). The native window also needs [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
3. Double-click **Setup-Lumen.cmd**. It creates this folder's `.venv`, installs the application dependencies, checks out official ComfyUI commit `7597a5a0d59ee251674e6c1270049909c63e7ede` into `runtime/ComfyUI`, installs CUDA 13.0 PyTorch from its official package index and the pinned ComfyUI revision's dependencies, and creates one desktop shortcut. It does not install model weights. This inference setup targets Windows with a compatible NVIDIA GPU/driver; other GPU backends are not covered by the one-click setup.
4. Open the desktop **Lumen** icon or **Start-Lumen.cmd**. Choose **模型与安装**, read the linked model license, select files and start installation. The full five-file pack is approximately 63.4 GB (59.1 GiB), plus Python/inference dependencies and working space. Downloads use fixed official artifact revisions and byte counts, then verify SHA-256 before activation. Pause retains a `.part` file; starting again resumes it. An existing incorrect model is preserved, never overwritten.

For the editor without video inference, run `Setup-Lumen.cmd -EditorOnly`. The board, library and 3D scene tools work without H3. GLB/OBJ/FBX/Alembic interchange requires a separately installed Blender, as described in the main README.

For a separate test installation, add `-NoShortcut` to keep the current desktop shortcut unchanged. Start that copy with its own `Start-Lumen.cmd` after closing another running Lumen window.

The UI and model status checks are local. There are no automatic model downloads, telemetry or remote background checks. Running setup explicitly downloads software dependencies; clicking model installation explicitly downloads only the chosen model artifacts. The models use the **MiniMax H3 Community License**, independently of Lumen's source license. Its applicable-territory and commercial-use conditions must be checked before use.

## Existing engine / custom storage

Copy `lumen.example.json` to `lumen.local.json` and set:

```json
{
  "comfy_dir": "D:/AI/ComfyUI",
  "engine_python": "D:/AI/ComfyUI/venv/Scripts/python.exe",
  "data_dir": "D:/LumenData",
  "input_dir": "D:/LumenData/input",
  "output_dir": "D:/LumenData/output"
}
```

Relative paths resolve against the configuration file's directory. Environment variables `LUMEN_COMFY_DIR`, `LUMEN_ENGINE_PYTHON`, `LUMEN_DATA_DIR`, `LUMEN_INPUT_DIR` and `LUMEN_OUTPUT_DIR` override those keys; `LUMEN_CONFIG` selects another local JSON file. Restart Lumen after changing paths. `python runtime_config.py` prints the resolved paths without creating files or contacting the network.

An existing `ComfyUI/studio` checkout is detected from its parent `main.py` and `comfy/` folder. Its engine, `input/`, `output/`, `studio/library`, presets and memory retain the legacy locations. Setup refuses to reinstall this existing deployment. A standalone checkout defaults to `.venv`, `runtime/ComfyUI` and `data` inside its own folder. No copy or migration of personal media is automatic.

CLI installation is also available: `Install-H3.cmd -Pack fl2va`, `-Pack ref2va` or `-Pack all`. Each generation pack includes the shared text/video/audio encoders. The script shows the license before requesting `YES`; automation can explicitly supply `-AcceptLicense`. `python model_manager.py list` inspects local files without downloading or hashing tens of gigabytes on startup.

Back up the configured data directory and input/output media. Models can stay separate. To move a portable install, update absolute paths or use the relative example, then rerun `install_desktop.ps1` to point the shortcut at the new folder.

## Dependency and license provenance

- [ComfyUI source at the pinned revision](https://github.com/Comfy-Org/ComfyUI/tree/7597a5a0d59ee251674e6c1270049909c63e7ede) is installed as a separate engine and retains its GPL-3.0 license. Lumen communicates with its local HTTP API; this repository does not relicense or redistribute its weights/environment.
- [Official H3 packaging metadata](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/e5eb578a89295337b8ff433a035929ce0279e0b6) supplies the pinned artifact sizes and SHA-256 values in `models-manifest.json`. The original [H3 license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) remains authoritative; models are not covered by GPL or Lumen's source license.
- CUDA-enabled PyTorch comes from `https://download.pytorch.org/whl/cu130`. The package resolver selects mutually compatible published torch/torchvision/torchaudio versions; this is not a byte-for-byte environment lock. The model manifest and ComfyUI source revision are fixed. Installations on hardware other than the development machine require their own inference validation.
- Python packages retain their upstream licenses. Vendored Three.js and CC0 HDR provenance are recorded beside the assets and in the repository third-party notices.

This release was tested against isolated temporary data and mocked small model transfers. Publishing the source does not mean a fresh 60+ GB download or inference run was performed on every supported machine.

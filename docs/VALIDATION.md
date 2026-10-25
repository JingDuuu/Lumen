# 4.1.0 validation — 2026-10-26

Evidence below distinguishes measured behavior from untested combinations. Tests use temporary data and synthetic references. The public repository does not contain private boards, output videos or raw local diagnostic logs.

## Checked locally

- Python regression suite: 131 tests passed on Windows x64 / Python 3.10. This includes actual Blender format conversion when Blender is installed.
- Scene/model/rail math: 38 Node tests passed.
- Real Edge browser checks: 14 board interaction groups, 16 reference-space groups, 12 Previs groups, 5 file-workflow groups, 9 preset-library groups and 5 model-onboarding groups passed.
- Real CLI → isolated HTTP: 10 groups passed, including multipart upload, preset ZIP roundtrip, version conflict/idempotency, animated Prefab, Unicode/BOM stdin, Chinese filenames, binary downloads and the ordinary Windows batch entry point. No GPU generation is triggered by these tests.
- A separate source directory with a new virtual environment installed `requirements.txt` successfully. App import and system/model/discovery/board endpoints returned HTTP 200 without an engine or weights. `setup.ps1 -EditorOnly -NoShortcut` completed successfully with that environment.
- The existing normal desktop shortcut opened version 4.1.0 with an owned ComfyUI process. A generation completed, and normal CLI close stopped the desktop and its owned engine. The original board's 8 cards, 1 connection, 6 zones and generation settings were unchanged.

## Actual video check

On an AMD Ryzen 9 5950X / 128 GB RAM / NVIDIA RTX 3080 10 GB host, a text-driven H3 FL2VA trial at 608 × 352, 8 sampling steps and seed 0 completed in **60 seconds** of application-reported task time. The output was independently decoded: **56 frames, 24 fps, 2.333333 seconds**, 608 × 352.

This is a small workflow acceptance test, not a quality benchmark or a promise for longer clips. It does not establish a speed ratio against RTX Spark, and it does not include a matched second-machine energy measurement.

## Limits of this release's validation

- The full 63.44 GB model pack was not downloaded again. Resume, cancellation, corruption handling, hashes and file locking were exercised with small test artifacts. Existing local H3 weights produced the actual trial above.
- A fresh complete ComfyUI/CUDA installation was not repeated. The pinned engine revision is the revision used by the existing working installation. Fresh editor dependencies were installed separately.
- Python 3.12 is the setup target and CI configuration; local acceptance used Python 3.10. Check the repository Actions result for the current CI outcome.
- The first fresh-copy desktop attempt ran its local service but the status probe timed out before obtaining its complete response; it was then closed. A second fresh-copy native-window verification was blocked by automatic execution approval, with no specific reason provided. Full fresh-copy native-window acceptance is therefore not claimed.
- Windows on Arm / RTX Spark, other GPU configurations, and every third-party FBX/ABC extension have not been tested on physical hardware.

See [development instructions](DEVELOPMENT.md) to reproduce the isolated checks and [installation notes](../PORTABLE_INSTALL.md) for dependency boundaries.

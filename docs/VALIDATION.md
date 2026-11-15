# Lumen 4.3.0 validation

Evidence distinguishes isolated editor/API checks from real local inference. Screenshots in
this repository use synthetic fixtures. Personal references, videos and diagnostics are excluded.

## Local verification

- Standalone source checkout on Windows x64 / Python 3.10: 185 Python tests completed with no failures (one optional pre-generated export fixture was unavailable). This includes
  agent request idempotency, preset masks, file verification, real stdio MCP and CLI transport,
  plus local Blender conversions when Blender is available.
- The complete Node scene/rig/rail/curve suite passed 50 checks. Real Edge: 17 gallery, 6 agent-board, 12 Previs, 8 direct-control, 9 curve/timeline,
  5 file-workflow and 5 onboarding groups passed. Fixtures use temporary data and mocked
  inference, never the user's board or GPU queue.
- Weighted curves participate in playback and GLB export; a modified sample of 2.416517970
  decoded from GLB as 2.416517973, within Float32 precision. Alt-wheel zoom preserved the time
  under the cursor.
- The normal desktop entry, CLI from another working directory, live engine readiness and
  native “Connect Agent” panel were checked on the development machine.

## Real generation

On Ryzen 9 5950X / 128 GB RAM / RTX 3080 10 GB, an agent request with an existing character
reference completed in **84 seconds**: 608×352, 8 steps, **124 decoded frames at 24 fps
(5.167 seconds)** and one audio track. The result entered the ordinary Lumen library.
A downloaded result matched the original file's SHA-256. Retrying the same request ID returned
the original completed task; a real MCP connection returned its verified file resource.
This is pipeline acceptance, not a quality guarantee or a performance promise for other GPUs.

## Other computers

Standalone defaults resolve the application environment, engine, data and output folders
relative to that installation. Bootstrap prompts and MCP configuration are generated from
that computer's paths. Company installations must install their own runtime and weights or
configure an existing compatible ComfyUI; private assets and results are not part of the source.

The setup target and Windows CI use Python 3.12; local development uses Python 3.10. The complete
60+ GB model download and fresh CUDA engine installation were not repeated for this release.
File-size checks confirmed the existing five pinned models; full hash verification remains
part of the explicit model installation flow. Windows on Arm / RTX Spark and other physical
GPU configurations have not been tested here. Pure cloud chats still require a local bridge;
video attachment support depends on the chat host.

See [development checks](DEVELOPMENT.md), [installation](../PORTABLE_INSTALL.md) and
[chat integration](AGENT_QUICKSTART.md) for reproduction and setup.

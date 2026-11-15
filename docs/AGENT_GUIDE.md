# Lumen agent interface

Lumen accepts local HTTP requests and structured CLI commands. An external model can inspect capabilities, upload references, edit the board, create reusable presets, author animated 3D scenes/prefabs, request format conversion, and submit video generation. These are the same application services used by the desktop UI.

All examples use synthetic content. Start Lumen normally, then run commands from the Lumen folder. The CLI reads the portable runtime configuration; it does not assume a particular Windows username or installation drive.

## Chat entry point

Read `GET /api/agent/bootstrap` for this installation's ready-to-copy Chinese prompt and MCP
stdio configuration. With terminal tools, use `lumen.bat doctor --json`, then
`ensure --timeout 180 --json`. `chat --prompt "..." --request-id UUID --wait --json` is the
recommended one-command local workflow. See [quick start](AGENT_QUICKSTART.md).

`POST /api/agent/generate` requires a stable `request_id` and one of: `board`,
`use_current_board:true` with `expected_revision`, or `prompt` with optional `preset_ids` and
`params`. Optional `client_name` and `title` label the job in the human board. A plain prompt
creates an independent shot and leaves the current board intact. Defaults are 608×352, 5 seconds
on the model's frame grid, and 8 steps for a quick preview. Raise steps explicitly for refinement.
Preset member masks are preserved and preset generation parameters do not replace shot params.

The record and request identity are persisted before the engine receives the job. An identical
request replays its existing record; reusing an ID for another payload returns HTTP 409.
An uncertain response is a reason to inspect/retry the same ID, never to submit a new random ID.

Poll `GET /api/agent/jobs/RECORD_ID`, then fetch `/api/agent/jobs/RECORD_ID/result`.
Only `ready:true` confirms that a completed job has its real nonempty output files.
`files` provides absolute `local_path`, loopback playback `url`, attachment `download_url`,
MIME type and size. The `/files/INDEX` route serves the original verified file as an attachment.
A missing/moved output yields `ready:false` and `OUTPUT_MISSING` even if the historic task says done.
Show or attach the local file with the chat host's actual capabilities. No video is uploaded to
an external service; pure cloud chats need a local connection and cannot access these files by prompt alone.

## Discover first

```powershell
.\lumen.bat discover --json
.\lumen.bat schema --json
.\lumen.bat catalog --json
.\lumen.bat status --json
```

`GET /api/agent/discover` lists the routes actually registered by this installation. `GET /api/agent/schema` returns JSON Schema 2020-12 with named definitions for Board, BoardOperations, AssetPreset, Scene, Document and DocumentWrite. `GET /api/agent/catalog` returns the local asset IDs, complete pose values, joint/body/face parameters, expression presets, HDRI IDs and timeline property roots. It includes 40 procedural blocking assets and 71 original poses at this release. Prefer the current catalog over hard-coded lists.

The HTTP server listens on `http://127.0.0.1:8088`. The CLI accepts `--url http://127.0.0.1:PORT` for isolated development instances; external hosts are rejected. This is a local integration interface, not a remote multi-user service. Do not expose the port on a public network.

## JSON transport and errors

```powershell
.\lumen.bat api GET /api/previs/capabilities --json
.\lumen.bat api POST /api/estimate --input examples/agent/board.json --json
.\lumen.bat api GET /api/previs/documents/DOCUMENT_ID/package --output scene.zip --json
.\lumen.bat upload reference.png --json
.\lumen.bat upload model.glb --path /api/previs/export --field format=fbx --field fps=24 --json
```

`api METHOD PATH` supports GET, POST, PUT, PATCH and DELETE. Use `--input file.json` or `--input -` for UTF-8 JSON on stdin (an optional UTF-8 BOM is accepted). `--json` can appear before or after the command. It writes exactly one JSON object to stdout; progress messages go to stderr. Streams are explicitly UTF-8; machine JSON escapes non-ASCII characters as `\uXXXX` so older Windows/PowerShell code pages cannot corrupt redirected output. JSON parsers recover the original Chinese/emoji. A successful response is `{"ok":true,"code":"OK","result":...}`. `result` is the unmodified HTTP JSON body, so an API's own `ok` field can also appear inside it.

Binary responses require `--output`. Existing files are protected unless `--overwrite` is supplied. `upload FILE --path ENDPOINT --field key=value` sends multipart form data with one file field named `file`. It supports media, reference preset ZIPs, 3D document ZIPs and model conversion. Frame-sequence rendering uses repeated `frames` fields; use HTTP directly for that endpoint.

Failures are `{"ok":false,"code":"...","error":"...","http_status":409,"detail":...}`. A socket timeout is an unknown request outcome: inspect the board, task or job before resubmitting. Do not assume a failed connection means a generation was never accepted.

| Exit | Meaning |
| --- | --- |
| 0 | Command succeeded |
| 2 | Invalid CLI/JSON input |
| 3 | Local service unavailable or connection failed |
| 4 | HTTP or local file error; inspect `http_status` and `detail` |
| 5 | Revision/idempotency conflict, missing precondition, or expensive-job confirmation required |
| 6 | A waited generation ended without usable output |
| 7 | Waiting timed out; the task was **not cancelled** |
| 130 | The caller interrupted waiting; the task was **not cancelled** |

## Preview before generation

```powershell
.\lumen.bat preview --input examples/agent/board.json --json
.\lumen.bat generate --input examples/agent/board.json --wait --timeout 600 --json
```

`preview` calls `/api/agent/preview`, validates the complete draft, and returns `board` plus `estimate`. Inspect `compiled_prompt`, `input_manifest`, `connection_manifest`, `model_mode`, `model_available`, `warnings`, actual frame count/duration and non-blocking workload information. It can probe/cache local media, but never writes the board or submits generation. `POST /api/estimate` remains available for a raw board snapshot. `generate --input` treats that JSON as the full generation configuration and always estimates it before submission. Use this only when the user has asked to generate. Valid jobs no longer need an expensive-job checkbox or a CLI confirmation flag; `requires_confirmation` is false. The legacy CLI flag remains accepted for older servers.

Media cards use the server-owned `name` returned by `/api/upload` as `file`. Do not send a filesystem path or external URL. Use `enabled:false` to retain a card while excluding it from model inputs. Ref2VA supports actual image/video/audio references; FL2VA supports first/last/middle frame guides. A mixed incompatible configuration is rejected rather than silently dropping inputs. Video sampling is bounded by the model: the manifest, rather than the original upload duration, is authoritative.

Poll `/api/status/PROMPT_ID`, or use `generate --wait`. A task succeeds only when `status` is `done` and outputs exist. Cancel intentionally with `lumen cancel RECORD_ID --json`. Closing a CLI process does not cancel a task. `list`, `info`, `refill`, `presets`, `start` and `stop` retain their basic commands. `start`/`stop` manage the desktop's own lifecycle, so they have broader effects than an HTTP read.

## Safe board edits

```powershell
.\lumen.bat board get --json
.\lumen.bat preview --input operations.json --json
.\lumen.bat board apply --input operations.json --json
```

1. Read `/api/agent/board`, obtaining `{board,revision}`.
2. Construct `{expected_revision,request_id,operations}` using that revision.
3. Preview the same operations, then apply them once they match the intended edit.
4. If HTTP 409/428 is returned, reread and merge deliberately. Never replace the expected revision automatically while replaying a stale whole-board snapshot.

An example operations file is in `examples/agent/board-operations.json`; replace its revision placeholder first. `examples/agent/preview_add_card.py` performs a read plus preview by default, and requires `--apply` to persist the synthetic edit.

Supported operations are `add_item`, `update_item`, `remove_item`, the corresponding zone/connection operations, `set_params`, and `set_viewport`. Adds use `value.id`; updates use `id` plus a shallow `value` merge; removals use `id`. A batch is atomic: any invalid operation rejects the entire edit. Removing a card removes its connected edges. Removing a zone unassigns its cards without deleting them. Adding invalid edges or duplicate IDs is an error. For replacement use `board put` with `{expected_revision,request_id,board}`. Existing IDs, content, layout metadata and extensions survive updates unless explicitly changed.

`If-Match: REVISION` and `Idempotency-Key: REQUEST_ID` may replace the respective JSON fields; generic `api` exposes them as `--if-match` and `--request-id`. Board revisions are opaque SHA-256 values. Reusing a request ID with the same body returns `replayed:true`, the original `applied_revision`, and the **current** board/revision. A different body with the same ID is rejected. The last 128 board receipts are retained in the board file; an older retry still cannot overwrite a changed revision. The legacy `/api/boards/default` route is retained for compatibility, but agent clients must use the version-checked route.

The desktop board uses the same versioned interface. An unsaved local edit and a remote edit must be resolved explicitly; successful external changes are not permission to overwrite an unsaved desktop draft.

## Reference presets and portable media

| Operation | Endpoint / payload |
| --- | --- |
| Search | `GET /api/asset-presets?q=...&category=scene` |
| Create | `POST /api/asset-presets` with `{name,category,description,items,connections,zones?,params?}` |
| Read | `GET /api/asset-presets/ID` |
| Rename/describe | `PATCH /api/asset-presets/ID` with `{name?,category?,description?}` |
| Delete | `DELETE /api/asset-presets/ID` (library entry only) |
| Instantiate | `POST /api/asset-presets/ID/instantiate` with `{}` |
| Package | `GET /api/asset-presets/ID/package` to `--output preset.zip` |
| Import package | `upload preset.zip --path /api/asset-presets/import` |

Categories are `character`, `scene`, `action`, `camera`, `style`, `general`. Instantiation creates fresh card/zone/edge IDs, remaps relationships, and restores media into the input folder. **It does not modify the default board.** Append the returned zones/items/connections using one versioned board operation batch. Its returned generation params are optional; do not overwrite the current params without intent. Preset mutations use the normal API and do not have agent revision or idempotency guarantees; inspect the list after an ambiguous create/import response before retrying.

## Animated 3D documents, prefabs and conversions

Use `/api/agent/documents` for safe JSON writes. The example `examples/agent/animated-prefab.json` is a complete create request. It contains a version 3 scene, a synthetic actor, a prop and an animation track.

```powershell
.\lumen.bat api POST /api/agent/documents --input examples/agent/animated-prefab.json --json
.\lumen.bat api GET /api/previs/documents --json
.\lumen.bat api GET /api/agent/documents/DOCUMENT_ID --json
```

Create requests are `{request_id,document:{name,kind,scene}}`; `kind` is `scene`, `template` or `prefab`. The result returns `id` and `revision`. Read the document with `GET /api/agent/documents/ID`. Update with `PUT` and `{request_id,expected_revision,document}`; delete with `DELETE` and `{request_id,expected_revision}`. All document mutations require a request ID. Repeated identical writes return the committed receipt rather than creating a duplicate document. Receipt files persist. If a crash occurs between writing and confirming, the API returns `OUTCOME_UNKNOWN` and never automatically repeats the operation; inspect document IDs/names/content before taking further action.

Scene positions are metres, rotations are XYZ Euler degrees, quaternions are `[x,y,z,w]`, time is seconds, +Y is up and +Z is forward. Scene JSON preserves `objects`, camera/rail, environment, viewport and `sequence.tracks`. Maximums are 200 objects, 10,000 keys and 300 seconds. Runtime validation rejects duplicate IDs, invalid parents, parent cycles, missing track targets and unsupported property paths. The catalog supplies complete `pose`, `hands`, `body`, `face`, `ik`, material and HDR values. Most numeric tracks interpolate; parent changes are discrete. Whole-container tracks evaluate before child property tracks. The renderer still applies its own normalization and rendering limits.

Saving a document does not manipulate an already-open editor tab or produce a render. Open it through the desktop file library. The existing editor remains the rendering/export surface for procedural scene geometry. The HTTP conversion service converts **uploaded model files**, not arbitrary scene JSON directly into finished video.

Local model files and dependencies must first be imported. Scene `modelURI`/`url` references point to `/api/previs/assets/...`; external URLs, arbitrary local paths and temporary blob URLs are rejected. The store collects dependencies so document packages are portable.

| Operation | Endpoint / details |
| --- | --- |
| Conversion support | `GET /api/previs/capabilities` (inspect Blender availability and format limits) |
| Import model | `upload model.glb --path /api/previs/import` |
| Convert/export model | `upload model.glb --path /api/previs/export --field format=fbx --field fps=24 --field sample_frames=60` |
| Poll/cancel conversion | `GET /api/previs/jobs/JOB_ID`, `POST /api/previs/jobs/JOB_ID/cancel` |
| Package document | `GET /api/previs/documents/ID/package` |
| Import document package | `upload scene.zip --path /api/previs/documents/import` |
| Render supplied PNG frames | `POST /api/previs/render-video`, repeated multipart `frames`, `fps` 1–30; HTTP client required |

Conversion returns HTTP 202 with a `job`. Poll until its terminal state, then use the returned local asset URL. Do not infer completion from upload success. OBJ is static; FBX/ABC material and animation limits are reported by the conversion service. Direct conversion/import/package APIs do not provide the agent document-write idempotency guarantees.

## Maintenance and verification

`scripts/build-agent-catalog.mjs` regenerates the checked-in catalog from the actual local procedural assets. No browser, WebGL or network is needed. Keep `agent-schema.json` consistent when changing HTTP payloads. The live discovery list is generated from Flask's routing table.

```powershell
python -m unittest tests.test_agent_api tests.test_cli tests.test_cli_json
python tests/agent_cli_e2e.py
```

The end-to-end script launches a temporary random-port fixture, calls the real CLI and HTTP routes, exercises upload/preset package/import/board preview+injection/conflict/prefab persistence, and captures actual subprocess exit codes. It never starts the real desktop or submits a model task. The evidence is `diagnostics/agent-cli-acceptance.json`.


### Director boards and sound

The visible workspace is an asset board. `asset_id`/`asset_name` identify a saved asset;
`character_id`/`character_name` identify one character across reference views and Previs
objects. Multiple characters in the same area are **not** the same identity. Explicit
identity IDs (or a legacy `preset_id`) group views. Keep IDs stable when adding references.
`enabled:false` excludes one member reference from conditioning. `asset_enabled:false` excludes the whole asset without changing its member selection; a member participates only when both flags are true. Neither flag removes the source file.

For sound use a text item with `role:"audio"`, `audio_type:"dialogue"|"sfx"|"music"|"ambience"`.
Dialogue can set `speaker_id` to the participating character ID. The compiler preserves the
original dialogue and punctuation. `params.audio_mode:"silent"` removes the final audio
track and audio decoding; the model still performs its joint audio/video sampling internally.
`"generated"` is the default. Video reference sound is included only when `include_audio:true`.

Preview returns `compiled_prompt`, `prompt_sections`, and an `input_packet` containing actual
media sockets and identities. Text-card labels, area lists, and editor arrows are not sent
in the prompt. `<Picture N>`, `<Video N>`, `<Audio N>` retain the real H3 socket numbering;
`<Subject N>` binds an independent character to its views. The compiler deduplicates exact
notes and organizes the user's wording locally; it does not caption media, invent missing
shot descriptions, or perform the optional full English Context-IR language-model rewrite.

Prompt references: [MiniMax reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md),
[ComfyUI native guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native).


### Weighted animation curves (scene version 3)

Legacy track/key `interpolation` stays `linear|smooth|step`. Numeric keyframes can additionally
store `curves` by relative component path: `""` for a scalar, `"0"/"1"/"2"` for XYZ, or a nested
path such as `"leftShoulder.0"` for a pose object. Each value is
`{"mode":"auto|user|break|linear|constant","in":{"dt":0.25,"dv":0.5},"out":{"dt":0.25,"dv":0.5}}`.
`dt` is nonnegative seconds, `dv` is the component's units. Incoming handle is `(time-dt,value-dv)`;
outgoing is `(time+dt,value+dv)`. `user` links slopes, `break` permits independent sides,
`auto` derives monotone slopes. Weighted curves solve Bézier time, and playback/export share
that evaluator. Explicit rotation curves follow authored angle values; legacy rotations keep
shortest-arc interpolation. Quaternion uses slerp, and parent/visibility/hand preset/HDR/clip
tracks hold discrete values; do not add numeric curves to those properties.

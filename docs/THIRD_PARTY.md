# Third-party notices

The MIT license at the repository root applies to original Lumen source and original procedural assets. It does not grant rights to third-party software, model weights or user-created/imported media.

| Component | Source / terms | Distribution |
|---|---|---|
| Three.js 0.180.0 and selected addons | [MIT](../static/vendor/three/LICENSE), [provenance and hashes](../static/vendor/three/provenance.json) | Included locally |
| Four Poly Haven HDR environments | [CC0](https://polyhaven.com/license), [individual authors, sources and hashes](../static/hdri/provenance.json) | Included locally |
| ComfyUI | [GPL-3.0 source](https://github.com/Comfy-Org/ComfyUI) | Separately downloaded by setup, retains upstream license |
| Blender | [GNU GPL](https://www.blender.org/about/license/) | Optional separately installed converter |
| MiniMax H3 and Comfy-Org packaging | [MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), [fixed artifacts](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/e5eb578a89295337b8ff433a035929ce0279e0b6) | Weights excluded; explicit user download |
| H3 Qwen3-VL encoder | Model packaging terms above and applicable [Qwen3-VL terms](https://huggingface.co/Qwen/Qwen3-VL-32B-Instruct/blob/main/LICENSE) | Weights excluded |
| Python/JavaScript dependencies | Each upstream package's license | Installed by the user; not relicensed by Lumen |

MiniMax H3 is a community-licensed open-weight model, not an unrestricted MIT/GPL model. Its applicable-territory and commercial-use conditions must be reviewed at the authoritative license link before download/use. Lumen's app license does not override those terms.

Lumen communicates with the separately installed ComfyUI engine through local HTTP/WebSocket. No ComfyUI source or model weights are included in the Lumen source archive. The installer pins the ComfyUI source revision and each H3 artifact revision/hash; the Python dependency resolver is not a complete binary environment lock.

Pose and expression controls in Lumen are original procedural assets. The repository does not contain extracted proprietary PoseMyArt models or pose libraries. Reference sites informed interaction design only.

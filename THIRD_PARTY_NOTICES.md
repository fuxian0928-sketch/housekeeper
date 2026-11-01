# Third-party components

Dependencies listed in package.json and pnpm-lock.yaml retain their own licenses. This project's LICENSE does not replace third-party licenses.

- Obsidian helper skills: see `skills/obsidian/LICENSE`.
- Pinned BGE-M3 tokenizer: see `server/retrieval/assets/manifest.json` and the adjacent license / upstream metadata files. The file is a tokenizer, not embedding model weights.
- Native speech dependencies and resource manifests: see `scripts/voice-lab/notices/`, `scripts/voice-lab/licenses/`, `model.json`, `runtime-lock.json` and local speech lock manifests. Large runtime binaries and model weights are not included in this source repository.
- MOSS-TTS-Nano adaptation retains its upstream notice at `scripts/voice-lab/licenses/MOSS-TTS-Nano-APACHE-2.0.txt`.
- Xiwei's seated scene and portrait textures are AI-generated fictional artwork. The runtime is a project-specific WebGL art mesh; no Cubism SDK binaries or third-party character model are included.

Before distributing a native voice bundle, review the notices and redistribution terms of every dependency and model included in that bundle.

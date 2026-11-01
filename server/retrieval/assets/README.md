# Retrieval tokenizer assets

Only tokenizer files are vendored; no embedding model weights are included.

Source: https://huggingface.co/BAAI/bge-m3/tree/5617a9f61b028005a4858fdac845db406aefb181

The pinned upstream revision, original names and SHA-256 values are recorded in
`manifest.json`. `scripts/copy-retrieval-assets.mjs` verifies them before copying
assets into the server build.

The upstream model card declares MIT. The FlagEmbedding MIT notice is retained
as `LICENSE-FlagEmbedding.txt`; its source and checksum are also in the manifest.
This notice applies to these upstream assets, not the application's own license.

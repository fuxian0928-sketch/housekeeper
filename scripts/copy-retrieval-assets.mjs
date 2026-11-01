import { cp, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const source = new URL("../server/retrieval/assets/", import.meta.url),
  target = new URL("../build/server/retrieval/assets/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", source), "utf8"),
);
for (const [name, sha256] of Object.entries(manifest.sha256)) {
  const data = await readFile(new URL(name, source));
  if (createHash("sha256").update(data).digest("hex") !== sha256)
    throw new Error("Retrieval tokenizer checksum mismatch: " + name);
}
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

import { randomUUID } from "node:crypto";
import { database, nowIso } from "../db.js";
import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import { rebuildMemorySemanticIndex } from "../domain/memories/memory-service.js";
import { indexRagSemantic } from "./rag-semantic.js";

let rebuilding = false;
/** Completed generations stay live while new vectors are staged. */
export async function rebuildSemanticIndex(
  provider: EmbeddingProvider,
  signal?: AbortSignal,
  onProgress?: (current: number, total: number) => void,
) {
  if (rebuilding)
    throw Object.assign(new Error("语义索引任务正在进行。"), {
      statusCode: 409,
    });
  const id = randomUUID(),
    created = nowIso(),
    documents = database
      .prepare("SELECT id FROM knowledge_documents ORDER BY id")
      .all();
  database
    .prepare(
      "INSERT INTO rag_jobs(id,kind,status,total,created_at,updated_at) VALUES(?,'semantic-rebuild','running',?,?,?)",
    )
    .run(id, documents.length, created, created);
  rebuilding = true;
  let chunks = 0,
    stale = 0;
  try {
    for (let index = 0; index < documents.length; index++) {
      signal?.throwIfAborted();
      const result = await indexRagSemantic(
        provider,
        String(documents[index].id),
        signal,
      );
      chunks += result.chunks;
      if (result.stale) stale++;
      database
        .prepare("UPDATE rag_jobs SET current=?,updated_at=? WHERE id=?")
        .run(index + 1, nowIso(), id);
      onProgress?.(index + 1, documents.length);
    }
    const memoryResult = await rebuildMemorySemanticIndex(provider, signal);
    const result = {
      id,
      chunks,
      stale,
      memories: memoryResult.memories,
      model: provider.model,
      dimension: provider.dimension,
      version: provider.version,
    };
    database
      .prepare(
        "UPDATE rag_jobs SET status='completed',detail_json=?,updated_at=? WHERE id=?",
      )
      .run(JSON.stringify(result), nowIso(), id);
    return result;
  } catch (error) {
    database
      .prepare(
        "UPDATE rag_jobs SET status=?,detail_json=?,updated_at=? WHERE id=?",
      )
      .run(
        signal?.aborted ? "cancelled" : "failed",
        JSON.stringify({
          error: error instanceof Error ? error.message : "语义索引未完成",
        }),
        nowIso(),
        id,
      );
    throw error;
  } finally {
    rebuilding = false;
  }
}
export const indexDocumentSemanticVectors = indexRagSemantic;

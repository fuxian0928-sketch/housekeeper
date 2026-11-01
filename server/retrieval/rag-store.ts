import { database, nowIso } from "../db.js";
import { buildRagDocument } from "./rag-chunker.js";
import { hashVector, lexicalTerms } from "./rag-lexical.js";
import { ragHash, ragTokenizer } from "./rag-tokenizer.js";
import { embeddingIdentity } from "./rag-providers.js";
import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import {
  normalizeRagConfig,
  ragLayout,
  RAG_VERSION,
  type RagBuilt,
  type RagConfig,
  type RagDocument,
} from "./rag-types.js";

export function ragConfig(): RagConfig {
  const row = database
    .prepare("SELECT value FROM app_settings WHERE key='rag_config'")
    .get();
  try {
    return normalizeRagConfig(JSON.parse(String(row?.value ?? "{}")));
  } catch {
    return normalizeRagConfig();
  }
}
export const configHash = (config: RagConfig) =>
  ragHash(JSON.stringify([RAG_VERSION, ragLayout(config), ragTokenizer.id]));
export function ragDocument(documentId: string): RagDocument | null {
  const row = database
    .prepare(
      "SELECT id,title,relative_path,content FROM knowledge_documents WHERE id=?",
    )
    .get(documentId);
  return row
    ? {
        id: String(row.id),
        title: String(row.title),
        relativePath: String(row.relative_path),
        content: String(row.content ?? ""),
      }
    : null;
}
export function activeGeneration(documentId: string) {
  return database
    .prepare(
      "SELECT g.* FROM rag_active a JOIN rag_generations g ON g.id=a.generation_id WHERE a.document_id=?",
    )
    .get(documentId);
}
export function commitRagDocument(
  document: RagDocument,
  built: RagBuilt,
  config: RagConfig,
  activate = true,
) {
  const id = ragHash(
      `${document.id}:${built.sourceHash}:${document.title}:${built.policy}`,
    ),
    timestamp = nowIso();
  database.exec("SAVEPOINT rag_document_write");
  try {
    const current = ragDocument(document.id);
    if (
      !current ||
      ragHash(current.content) !== built.sourceHash ||
      current.title !== document.title
    ) {
      database.exec("RELEASE SAVEPOINT rag_document_write");
      return null;
    }
    if (
      !database.prepare("SELECT id FROM rag_generations WHERE id=?").get(id)
    ) {
      database
        .prepare(
          "INSERT INTO rag_generations(id,document_id,source_hash,title,config_hash,policy,tokenizer_id,semantic,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          document.id,
          built.sourceHash,
          document.title,
          configHash(config),
          built.policy,
          built.tokenizerId,
          Number(built.semantic),
          timestamp,
        );
      const parent = database.prepare(
        "INSERT INTO rag_parents(id,generation_id,position,heading,kind,prefix,core_start,core_end,view_start,view_end,content,token_count,locator_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const item of built.parents)
        parent.run(
          item.id,
          id,
          item.position,
          item.heading,
          item.kind,
          item.prefix,
          item.start,
          item.end,
          item.viewStart,
          item.viewEnd,
          item.content,
          item.tokens,
          JSON.stringify(item.locator),
        );
      const child = database.prepare(
        "INSERT INTO rag_children(id,generation_id,parent_id,position,heading,kind,prefix,start_offset,end_offset,content,token_count,locator_json,hash_vector_json,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const item of built.children) {
        const input = `${item.prefix}\n${item.content}`;
        child.run(
          item.id,
          id,
          item.parentId,
          item.position,
          item.heading,
          item.kind,
          item.prefix,
          item.start,
          item.end,
          item.content,
          item.tokens,
          JSON.stringify(item.locator),
          JSON.stringify(hashVector(input)),
          lexicalTerms(input).join(" "),
        );
      }
    }
    if (activate)
      database
        .prepare(
          "INSERT INTO rag_active(document_id,generation_id) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET generation_id=excluded.generation_id",
        )
        .run(document.id, id);
    database.exec("RELEASE SAVEPOINT rag_document_write");
    return id;
  } catch (error) {
    database.exec(
      "ROLLBACK TO SAVEPOINT rag_document_write; RELEASE SAVEPOINT rag_document_write",
    );
    throw error;
  }
}
export function indexRagDocument(
  document: RagDocument,
  options: Partial<RagConfig> = ragConfig(),
  activate = true,
) {
  const config = normalizeRagConfig(options),
    current = activeGeneration(document.id);
  if (
    activate &&
    current?.source_hash === ragHash(document.content) &&
    current?.title === document.title &&
    current?.config_hash === configHash(config)
  )
    return String(current.id);
  return commitRagDocument(
    document,
    buildRagDocument(document, config),
    config,
    activate,
  );
}
export function indexRagDocumentById(id: string) {
  const document = ragDocument(id);
  return document ? indexRagDocument(document) : null;
}
export function pendingRagDocuments(limit = 20) {
  return database
    .prepare(
      "SELECT d.id FROM knowledge_documents d LEFT JOIN rag_active a ON a.document_id=d.id LEFT JOIN rag_generations g ON g.id=a.generation_id WHERE a.document_id IS NULL OR g.config_hash<>? ORDER BY d.modified_at DESC LIMIT ?",
    )
    .all(configHash(ragConfig()), limit)
    .map((row) => String(row.id));
}
export function pendingRagSemanticDocuments(
  provider: EmbeddingProvider,
  limit = 10000,
) {
  return database
    .prepare(
      "SELECT a.document_id FROM rag_active a JOIN knowledge_documents d ON d.id=a.document_id LEFT JOIN rag_embedding_state es ON es.generation_id=a.generation_id AND es.profile_id=? WHERE es.status IS NULL OR es.status<>'ready' ORDER BY d.modified_at DESC LIMIT ?",
    )
    .all(embeddingIdentity(provider), limit)
    .map((row) => String(row.document_id));
}
export function ensureRagDocuments(limit = 20, deadline = Infinity) {
  let indexed = 0;
  for (const id of pendingRagDocuments(limit)) {
    if (Date.now() >= deadline) break;
    indexRagDocumentById(id);
    indexed++;
  }
  return indexed;
}
export function ragStatus() {
  return {
    version: RAG_VERSION,
    config: ragConfig(),
    tokenizer: ragTokenizer.id,
    documents: Number(
      database.prepare("SELECT COUNT(*) AS n FROM knowledge_documents").get()
        ?.n ?? 0,
    ),
    indexedDocuments: Number(
      database.prepare("SELECT COUNT(*) AS n FROM rag_active").get()?.n ?? 0,
    ),
    pending: pendingRagDocuments(10001).length,
    parents: Number(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM rag_parents p JOIN rag_active a ON a.generation_id=p.generation_id",
        )
        .get()?.n ?? 0,
    ),
    children: Number(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM rag_children c JOIN rag_active a ON a.generation_id=c.generation_id",
        )
        .get()?.n ?? 0,
    ),
    semantic: database
      .prepare(
        "SELECT es.profile_id,es.status,COUNT(*) AS generations FROM rag_embedding_state es JOIN rag_active a ON a.generation_id=es.generation_id GROUP BY es.profile_id,es.status",
      )
      .all(),
    jobs: database
      .prepare("SELECT * FROM rag_jobs ORDER BY created_at DESC LIMIT 8")
      .all(),
  };
}

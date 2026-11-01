import { setImmediate as yieldWork } from "node:timers/promises";
import { database, nowIso } from "../db.js";
import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import { buildRagDocument } from "./rag-chunker.js";
import { parseRagUnits } from "./rag-parser.js";
import {
  boundedSpans,
  ragHash,
  ragTokenizer,
  tokenHead,
} from "./rag-tokenizer.js";
import { embeddingIdentity, bounded } from "./rag-providers.js";
import { finiteVector, cosine } from "./rag-lexical.js";
import {
  activeGeneration,
  commitRagDocument,
  indexRagDocument,
  ragConfig,
  ragDocument,
  configHash,
} from "./rag-store.js";
import type { RagConfig } from "./rag-types.js";

const activeJobs = new Map<
  string,
  Promise<{
    chunks: number;
    semantic: boolean;
    stale: boolean;
    capped: boolean;
  }>
>();
async function sentenceVectors(
  provider: EmbeddingProvider,
  texts: string[],
  signal?: AbortSignal,
) {
  const profile = embeddingIdentity(provider),
    vectors: Array<number[] | null> = texts.map((text) => {
      const row = database
        .prepare(
          "SELECT vector_json FROM rag_sentence_vectors WHERE text_hash=? AND profile_id=?",
        )
        .get(ragHash(text), profile);
      if (!row) return null;
      try {
        const value = JSON.parse(String(row.vector_json));
        return finiteVector(value, provider.dimension) ? value : null;
      } catch {
        return null;
      }
    }),
    missing = vectors.flatMap((value, index) => (value ? [] : [index]));
  for (let offset = 0; offset < missing.length; offset += 16) {
    signal?.throwIfAborted();
    const indexes = missing.slice(offset, offset + 16),
      batch = await bounded(
        (inner) =>
          provider.embed(
            indexes.map((index) => texts[index]),
            inner,
          ),
        180000,
        signal,
      );
    signal?.throwIfAborted();
    if (
      batch.length !== indexes.length ||
      batch.some((vector) => !finiteVector(vector, provider.dimension))
    )
      throw new Error("语义边界向量无效或维度不匹配。");
    const put = database.prepare(
      "INSERT OR REPLACE INTO rag_sentence_vectors(text_hash,profile_id,vector_json,created_at) VALUES(?,?,?,?)",
    );
    indexes.forEach((index, position) => {
      vectors[index] = batch[position];
      put.run(
        ragHash(texts[index]),
        profile,
        JSON.stringify(batch[position]),
        nowIso(),
      );
    });
    await yieldWork();
  }
  // This is an optimization cache, not an authoritative copy of the document.
  database
    .prepare(
      "DELETE FROM rag_sentence_vectors WHERE rowid IN (SELECT rowid FROM rag_sentence_vectors ORDER BY created_at DESC LIMIT -1 OFFSET 2048)",
    )
    .run();
  return vectors as number[][];
}
export async function semanticBoundaries(
  provider: EmbeddingProvider,
  content: string,
  config: RagConfig,
  signal?: AbortSignal,
) {
  if (!config.semantic) return { breaks: [] as number[], capped: false };
  const units = parseRagUnits(content),
    sections = new Map<string, typeof units>();
  for (const unit of units)
    if (unit.kind === "prose") {
      const group = sections.get(unit.section) ?? [];
      group.push(unit);
      sections.set(unit.section, group);
    }
  const breaks: number[] = [];
  let capped = false,
    used = 0;
  for (const group of sections.values()) {
    if (
      ragTokenizer.count(
        group.map((unit) => content.slice(unit.start, unit.end)).join("\n"),
      ) < config.parentMaxTokens
    )
      continue;
    let spans = group.flatMap((unit) =>
      boundedSpans(content, unit.start, unit.end, 80),
    );
    if (used + spans.length > 256) {
      spans = spans.slice(0, Math.max(0, 256 - used));
      capped = true;
    }
    used += spans.length;
    if (spans.length < 3) continue;
    const vectors = await sentenceVectors(
        provider,
        spans.map((span) => content.slice(span.start, span.end)),
        signal,
      ),
      distances = spans
        .slice(1)
        .map((_span, index) => 1 - cosine(vectors[index], vectors[index + 1]));
    const sorted = [...distances].sort((a, b) => a - b),
      threshold =
        sorted[
          Math.min(
            sorted.length - 1,
            Math.floor((sorted.length * config.semanticPercentile) / 100),
          )
        ];
    let previous = spans[0].start;
    for (let index = 1; index < spans.length; index++) {
      const next = content.slice(spans[index].start, spans[index].end).trim();
      if (
        distances[index - 1] <= threshold ||
        /^(?:但|除非|如果|否则|因此|仅|不包括|except\b|unless\b|however\b)/i.test(
          next,
        )
      )
        continue;
      if (
        ragTokenizer.count(content.slice(previous, spans[index].start)) <
        config.parentTokens * 0.5
      )
        continue;
      breaks.push(spans[index].start);
      previous = spans[index].start;
    }
    if (used >= 256) break;
  }
  return { breaks, capped };
}
export async function indexRagSemantic(
  provider: EmbeddingProvider,
  documentId: string,
  signal?: AbortSignal,
) {
  const key = `${documentId}:${embeddingIdentity(provider)}`;
  const pending = activeJobs.get(key);
  if (pending) return pending;
  const work = (async () => {
    const document = ragDocument(documentId);
    if (!document)
      return { chunks: 0, semantic: false, stale: true, capped: false };
    const config = ragConfig();
    indexRagDocument(document, config);
    const before = activeGeneration(documentId),
      hash = ragHash(document.content),
      profile = embeddingIdentity(provider);
    const semantic = await semanticBoundaries(
      provider,
      document.content,
      config,
      signal,
    );
    signal?.throwIfAborted();
    const current = ragDocument(documentId);
    if (
      !current ||
      ragHash(current.content) !== hash ||
      activeGeneration(documentId)?.id !== before?.id ||
      configHash(ragConfig()) !== configHash(config)
    )
      return {
        chunks: 0,
        semantic: false,
        stale: true,
        capped: semantic.capped,
      };
    const built = buildRagDocument(document, config, semantic.breaks),
      generationId = commitRagDocument(document, built, config, false);
    if (!generationId)
      return {
        chunks: 0,
        semantic: false,
        stale: true,
        capped: semantic.capped,
      };
    const ready = database
      .prepare(
        "SELECT 1 FROM rag_embedding_state WHERE generation_id=? AND profile_id=? AND status='ready'",
      )
      .get(generationId, profile);
    if (!ready) {
      database
        .prepare(
          "INSERT INTO rag_embedding_state(generation_id,profile_id,status,updated_at) VALUES(?,?,'indexing',?) ON CONFLICT(generation_id,profile_id) DO UPDATE SET status='indexing',error=NULL,updated_at=excluded.updated_at",
        )
        .run(generationId, profile, nowIso());
      try {
        const chunks = database
          .prepare(
            "SELECT id,prefix,content FROM rag_children WHERE generation_id=? ORDER BY position",
          )
          .all(generationId);
        for (let offset = 0; offset < chunks.length; offset += 16) {
          signal?.throwIfAborted();
          const batch = chunks.slice(offset, offset + 16),
            vectors = await bounded(
              (inner) =>
                provider.embed(
                  batch.map(
                    (row) =>
                      `${tokenHead(String(row.prefix), 180)}\n${String(row.content)}`,
                  ),
                  inner,
                ),
              180000,
              signal,
            );
          signal?.throwIfAborted();
          if (
            vectors.length !== batch.length ||
            vectors.some((vector) => !finiteVector(vector, provider.dimension))
          )
            throw new Error("文档向量无效或维度不匹配。");
          const live = ragDocument(documentId);
          if (
            !live ||
            ragHash(live.content) !== hash ||
            configHash(ragConfig()) !== configHash(config)
          ) {
            database
              .prepare(
                "UPDATE rag_embedding_state SET status='obsolete',updated_at=? WHERE generation_id=? AND profile_id=?",
              )
              .run(nowIso(), generationId, profile);
            return {
              chunks: 0,
              semantic: built.semantic,
              stale: true,
              capped: semantic.capped,
            };
          }
          const insert = database.prepare(
            "INSERT OR REPLACE INTO rag_embeddings(child_id,profile_id,model,dimension,version,embedding_json,created_at) VALUES(?,?,?,?,?,?,?)",
          );
          for (let index = 0; index < batch.length; index++)
            insert.run(
              String(batch[index].id),
              profile,
              provider.model,
              provider.dimension,
              provider.version,
              JSON.stringify(vectors[index]),
              nowIso(),
            );
          await yieldWork();
        }
      } catch (error) {
        database
          .prepare(
            "UPDATE rag_embedding_state SET status='failed',error=?,updated_at=? WHERE generation_id=? AND profile_id=?",
          )
          .run(
            error instanceof Error ? error.message : "索引未完成",
            nowIso(),
            generationId,
            profile,
          );
        throw error;
      }
    }
    const live = ragDocument(documentId);
    if (
      !live ||
      ragHash(live.content) !== hash ||
      activeGeneration(documentId)?.id !== before?.id ||
      configHash(ragConfig()) !== configHash(config)
    ) {
      database
        .prepare(
          "UPDATE rag_embedding_state SET status='obsolete',updated_at=? WHERE generation_id=? AND profile_id=? AND status<>'ready'",
        )
        .run(nowIso(), generationId, profile);
      return {
        chunks: 0,
        semantic: built.semantic,
        stale: true,
        capped: semantic.capped,
      };
    }
    database.exec("SAVEPOINT rag_semantic_activate");
    try {
      database
        .prepare(
          "INSERT INTO rag_embedding_state(generation_id,profile_id,status,updated_at) VALUES(?,?,'ready',?) ON CONFLICT(generation_id,profile_id) DO UPDATE SET status='ready',error=NULL,updated_at=excluded.updated_at",
        )
        .run(generationId, profile, nowIso());
      database
        .prepare(
          "UPDATE rag_active SET generation_id=? WHERE document_id=? AND generation_id=?",
        )
        .run(generationId, documentId, String(before?.id));
      database.exec("RELEASE SAVEPOINT rag_semantic_activate");
    } catch (error) {
      database.exec(
        "ROLLBACK TO SAVEPOINT rag_semantic_activate; RELEASE SAVEPOINT rag_semantic_activate",
      );
      throw error;
    }
    return {
      chunks: built.children.length,
      semantic: built.semantic,
      stale: false,
      capped: semantic.capped,
    };
  })();
  activeJobs.set(key, work);
  try {
    return await work;
  } finally {
    if (activeJobs.get(key) === work) activeJobs.delete(key);
  }
}
